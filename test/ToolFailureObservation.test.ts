import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import * as FakeModel from "./FakeModel.js"

/**
 * The audit `plan-run-stream-start.md` §8.1 asks for, as tests.
 *
 * > Can application telemetry currently receive the original local `Cause` of a
 * > recovered tool failure exactly once per attempt without changing run
 * > semantics?
 *
 * The case that matters is the one where nothing looks wrong afterwards: a tool
 * handler fails, the failure policy returns it to the model, the model recovers,
 * and the submission succeeds. The run is fine; an operator still wants to know
 * the tool broke, and wants the `Cause` rather than a rendered string.
 *
 * These record the answer rather than argue it, so the decision not to add a
 * seam is falsifiable: if the route stops working, this file fails.
 */

class Broken extends Schema.TaggedError<Broken>()("Broken", {
  detail: Schema.String
}) {}

const Flaky = Tool.make("flaky", {
  description: "fails once",
  parameters: Schema.Struct({}),
  success: Schema.String,
  // Declared, so the handler may fail with it rather than dying.
  failure: Broken
})

/** The model calls the tool, is told it failed, and answers anyway. */
const recovers: ReadonlyArray<FakeModel.Turn> = [
  { toolCalls: [{ id: "f1", name: "flaky", params: {} }] },
  { text: "recovered" }
]

describe("observing a recovered tool failure (plan §8.1 audit)", () => {
  /**
   * The route that exists today: the handler is an ordinary `Effect`, so an
   * application can tap its cause on the way past.
   */
  it.effect("a handler can hand its own Cause to telemetry, and the run is unchanged", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<Array<Cause.Cause<unknown>>>([])
      const { layer } = yield* FakeModel.layer(recovers)

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(
            Agent.make({
              tools: [
                Agent.tool(Flaky, () =>
                  Effect.fail(new Broken({ detail: "socket closed" })).pipe(
                    // The whole route, in one combinator: the cause is observed
                    // and re-raised, so the harness still sees the failure it
                    // would have seen.
                    Effect.tapCause((cause) => Ref.update(seen, (all) => [...all, cause]))
                  ))
              ],
              toolFailurePolicy: ToolExecution.ReturnToModel,
              loop: AgentLoop.bounded(4)
            })
          )
          return yield* AgentSession.prompt(session, "go")
        }).pipe(Effect.provide(layer))
      )

      // Run semantics unchanged: the model recovered and the submission
      // completed, exactly as it would with no observer at all.
      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.text, "recovered")

      const causes = yield* Ref.get(seen)
      assert.strictEqual(causes.length, 1, "exactly once per attempt")

      // And it is the *Cause*, not a rendering of it: the typed error is still
      // in there, with its fields.
      const error = Option.getOrUndefined(Cause.findErrorOption(causes[0]!))
      assert.isTrue(error instanceof Broken)
      assert.strictEqual((error as Broken).detail, "socket closed")
    }))

  /**
   * What the stable stream carries instead, and why the route above is not
   * redundant with it. `ToolCallFailed.failure` is a projection -- a name, a
   * message and whether it was a defect -- because it has to survive a wire and
   * a journal. The structure an operator would group by is gone by then.
   */
  it.effect("the event stream carries a projection, not the cause", () =>
    Effect.gen(function*() {
      const { layer } = yield* FakeModel.layer(recovers)

      const events = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(
            Agent.make({
              tools: [Agent.tool(Flaky, () => Effect.fail(new Broken({ detail: "socket closed" })))],
              toolFailurePolicy: ToolExecution.ReturnToModel,
              loop: AgentLoop.bounded(4)
            })
          )
          const collecting = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.takeUntil(
                AgentSession.events(session),
                (envelope) => envelope.event._tag === "SubmissionCompleted"
              )
            )
          )
          yield* AgentSession.prompt(session, "go")
          return yield* Fiber.join(collecting)
        }).pipe(Effect.provide(layer))
      )

      const failed = events.find((envelope) => envelope.event._tag === "ToolCallFailed")
      assert.isDefined(failed)
      if (failed?.event._tag !== "ToolCallFailed") return

      // It was returned to the model, so the run recovered -- the case §8 is
      // about.
      assert.isTrue(failed.event.returnedToModel)
      // And what it carries is a rendering: a name, a message, a flag. The
      // typed error's own fields, and the cause's structure, are gone.
      assert.strictEqual(failed.event.failure.isDefect, false)
      assert.notProperty(failed.event.failure, "cause")
      assert.notProperty(failed.event.failure, "detail")
    }))

  /**
   * What makes the route complete rather than partial.
   *
   * The handler sees the `Cause` and its own `toolCallId`; it does not see the
   * submission, run, turn, or what the failure policy decided to do about it.
   * The event carries all four. They join on the call id, and this asserts that
   * the two ids are in fact the same one -- which is the only thing the join
   * depends on.
   */
  it.effect("the handler's toolCallId is the event's, so the two views join", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<Array<{ readonly id: string; readonly cause: Cause.Cause<unknown> }>>([])
      const { layer } = yield* FakeModel.layer(recovers)

      const events = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(
            Agent.make({
              tools: [
                Agent.tool(Flaky, (_input, context) =>
                  Effect.fail(new Broken({ detail: "socket closed" })).pipe(
                    Effect.tapCause((cause) =>
                      Ref.update(seen, (all) => [...all, { id: context.toolCallId ?? "(none)", cause }]))
                  ))
              ],
              toolFailurePolicy: ToolExecution.ReturnToModel,
              loop: AgentLoop.bounded(4)
            })
          )
          const collecting = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.takeUntil(
                AgentSession.events(session),
                (envelope) => envelope.event._tag === "SubmissionCompleted"
              )
            )
          )
          yield* AgentSession.prompt(session, "go")
          return yield* Fiber.join(collecting)
        }).pipe(Effect.provide(layer))
      )

      const observed = yield* Ref.get(seen)
      assert.strictEqual(observed.length, 1)
      const failed = events.find((envelope) => envelope.event._tag === "ToolCallFailed")
      assert.isDefined(failed)
      if (failed?.event._tag !== "ToolCallFailed") return

      // The join key.
      assert.strictEqual(observed[0]!.id, failed.event.id)
      // And what each side contributes: the cause from the handler, the
      // correlation and the disposition from the event.
      assert.isTrue(Option.isSome(Cause.findErrorOption(observed[0]!.cause)))
      assert.isTrue(Option.isSome(failed.submissionId))
      assert.isTrue(Option.isSome(failed.runId))
      assert.isTrue(failed.event.returnedToModel)
    }))
})
