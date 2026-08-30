import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Option, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Elicitation from "../src/Elicitation.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * `needsApproval` was detected and refused, with no way to satisfy it — a dead
 * end rather than a feature. Elicitation is the general form: execution that
 * needs an answer from outside before continuing, of which tool approval is
 * one instance.
 *
 * It is a *pause*, not a failure. That distinction is why it is not called an
 * interrupt: in Effect, and in `AgentSession.interrupt`, interruption means a
 * fibre being torn down, and a pause that resumes is a different thing.
 */
const Dangerous = Tool.make("deleteEverything", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

const script = [
  { toolCalls: [{ id: "d1", name: "deleteEverything", params: {} }] },
  TestLanguageModel.text("done")
]

describe("elicitation", () => {
  it.effect("approval can be granted, and the tool then runs", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const toolkit = yield* Agent.toolkit([Dangerous], {
        deleteEverything: () =>
          Ref.update(ran, (n) => n + 1).pipe(Effect.as("deleted"))
      })
      const { layer } = yield* TestLanguageModel.script(script)

      const { events, text } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit, loop: AgentLoop.bounded(4) }),
            { elicitation: Elicitation.memory }
          )
          const probe = yield* AgentProbe.make(session)

          // The run pauses here, so the prompt has to be in flight while the
          // answer is given -- which is the whole shape of the feature.
          const running = yield* Effect.forkChild(session.prompt("go"))

          const asked = yield* probe.awaitEvent("ElicitationRequested")
          assert.strictEqual(asked.event._tag, "ElicitationRequested")
          const request = AgentEvent.is("ElicitationRequested")(asked)
            ? asked.event
            : undefined
          assert.isDefined(request)
          assert.strictEqual(request!.kind, "tool-approval")

          const answered = yield* AgentSession.respond(session, {
            id: request!.id,
            granted: true
          })
          assert.isTrue(answered)

          const result = yield* Fiber.join(running)
          return { events: yield* probe.events, text: result.text }
        })
      ).pipe(Effect.provide(layer))

      // The tool actually ran, which is what "satisfiable" means.
      assert.strictEqual(yield* Ref.get(ran), 1)
      assert.strictEqual(text, "done")

      const tags = events.map((entry) => entry.event._tag)
      assert.include(tags, "ElicitationRequested")
      assert.include(tags, "ElicitationResolved")
      assert.include(tags, "ToolCallSucceeded")
    })
  )

  it.effect("a refusal is an answer, and the run reports it as before", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const toolkit = yield* Agent.toolkit([Dangerous], {
        deleteEverything: () =>
          Ref.update(ran, (n) => n + 1).pipe(Effect.as("deleted"))
      })
      const { layer } = yield* TestLanguageModel.script(script)

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit, loop: AgentLoop.bounded(4) }),
            { elicitation: Elicitation.memory }
          )
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(
            session.prompt("go").pipe(
              Effect.map(() => "completed" as const),
              Effect.catchTag("ToolApprovalRequiredError", (error) =>
                Effect.succeed(error.toolName)
              )
            )
          )

          const asked = yield* probe.awaitEvent("ElicitationRequested")
          const id = AgentEvent.is("ElicitationRequested")(asked)
            ? asked.event.id
            : ""
          yield* AgentSession.respond(session, { id, granted: false })
          return yield* Fiber.join(running)
        })
      ).pipe(Effect.provide(layer))

      // Refusal keeps the pre-existing behaviour exactly: the harness declines,
      // the tool does not run, and the model is never told it could retry.
      assert.strictEqual(outcome, "deleteEverything")
      assert.strictEqual(yield* Ref.get(ran), 0)
    })
  )

  it.effect("the default refuses, so nothing starts hanging", () =>
    Effect.gen(function* () {
      // Elicitation arriving must not turn every approval-requiring agent into
      // one that waits forever for an answer nobody is positioned to give.
      const toolkit = yield* Agent.toolkit([Dangerous], {
        deleteEverything: () => Effect.succeed("deleted")
      })
      const { layer } = yield* TestLanguageModel.script(script)

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit, loop: AgentLoop.bounded(4) })
          )
          return yield* session.prompt("go").pipe(
            Effect.map(() => "completed" as const),
            Effect.catchTag("ToolApprovalRequiredError", () =>
              Effect.succeed("refused" as const)
            )
          )
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(outcome, "refused")
    })
  )

  it.effect("reports what is waiting, and a late answer as unmatched", () =>
    Effect.gen(function* () {
      const toolkit = yield* Agent.toolkit([Dangerous], {
        deleteEverything: () => Effect.succeed("deleted")
      })
      const { layer } = yield* TestLanguageModel.script(script)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit, loop: AgentLoop.bounded(4) }),
            { elicitation: Elicitation.memory }
          )
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          const asked = yield* probe.awaitEvent("ElicitationRequested")
          const id = AgentEvent.is("ElicitationRequested")(asked)
            ? asked.event.id
            : ""

          // A UI needs to render what is outstanding.
          const waiting = yield* AgentSession.pending(session)
          assert.deepStrictEqual(waiting.map((request) => request.id), [id])

          yield* AgentSession.respond(session, { id, granted: true })
          yield* Fiber.join(running)

          // Answering again matches nothing. Reported rather than swallowed:
          // from outside, "approved" and "approved too late" are otherwise
          // indistinguishable.
          assert.isFalse(
            yield* AgentSession.respond(session, { id, granted: true })
          )
          assert.deepStrictEqual(yield* AgentSession.pending(session), [])
        })
      ).pipe(Effect.provide(layer))
    })
  )

  it.effect("interrupting a paused run releases the question", () =>
    Effect.gen(function* () {
      // A paused run holds a fibre waiting on a `Deferred`. Interrupting the
      // caller has to unwind that: a session left reporting a question nobody
      // is waiting for, or stuck `running`, would be unusable afterwards and
      // the symptom would appear far from the cause.
      const toolkit = yield* Agent.toolkit([Dangerous], {
        deleteEverything: () => Effect.succeed("deleted")
      })
      // Three turns, because the interrupted submission still consumed one:
      // it reached the model, got the tool call, and paused there.
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "d1", name: "deleteEverything", params: {} }] },
        TestLanguageModel.text("recovered"),
        TestLanguageModel.text("unused")
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit, loop: AgentLoop.bounded(4) }),
            { elicitation: Elicitation.memory }
          )
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          yield* probe.awaitEvent("ElicitationRequested")

          assert.strictEqual(
            (yield* AgentSession.pending(session)).length,
            1,
            "the question was not registered while paused"
          )

          yield* Fiber.interrupt(running)
          yield* Effect.yieldNow
          yield* Effect.yieldNow

          // Nothing outstanding, and the session is usable again.
          assert.deepStrictEqual(yield* AgentSession.pending(session), [])
          assert.strictEqual(yield* session.status, "idle")
          const again = yield* session.prompt("again")
          assert.strictEqual(again.text, "recovered")
        })
      ).pipe(Effect.provide(layer))
    })
  )

  it.effect("a paused run can still be steered and extended", () =>
    Effect.gen(function* () {
      // The realistic shape of a review: whoever is deciding whether to
      // approve is also the person best placed to redirect. A paused run is
      // still *running*, so both are admissible -- and both have to land in
      // the right place, steering at the next turn boundary and the follow-up
      // as a further run.
      const toolkit = yield* Agent.toolkit([Dangerous], {
        deleteEverything: () => Effect.succeed("deleted")
      })
      const { layer, recorder } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "d1", name: "deleteEverything", params: {} }] },
        TestLanguageModel.text("after tool"),
        TestLanguageModel.text("after follow-up")
      ])

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit, loop: AgentLoop.bounded(6) }),
            { elicitation: Elicitation.memory }
          )
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          const asked = yield* probe.awaitEvent("ElicitationRequested")
          const id = AgentEvent.is("ElicitationRequested")(asked)
            ? asked.event.id
            : ""

          yield* session.steer("stay focused")
          yield* session.followUp("then this")
          yield* AgentSession.respond(session, { id, granted: true })
          return yield* Fiber.join(running)
        })
      ).pipe(Effect.provide(layer))

      // The follow-up became a second run, as it would have without the pause.
      assert.strictEqual(result.runs, 2)
      assert.strictEqual(result.text, "after follow-up")

      const prompts = yield* recorder.prompts
      // Turn 1 was already under way when the steer arrived, so it did not see
      // it; turn 2 did. The follow-up arrives after that.
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[0]!), ["go"])
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[1]!), [
        "go",
        "stay focused"
      ])
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[2]!), [
        "go",
        "stay focused",
        "then this"
      ])
    })
  )
})

describe("Elicitation.elicitValue and the terminal answer state", () => {
  const AnswerSchema = Schema.Struct({ choice: Schema.String })
  const request: Elicitation.Request = { id: "q1", kind: "pick", detail: {} }

  it.effect("decodes a valid answer value against the schema, typed", () =>
    Effect.gen(function* () {
      const elicitor = yield* Elicitation.memory.make("s")
      const fiber = yield* Effect.forkChild(
        Elicitation.elicitValue(elicitor, request, Effect.void, AnswerSchema)
      )
      yield* Effect.yieldNow // let elicit register before we answer
      const accepted = yield* elicitor.respond({ id: "q1", granted: true, value: { choice: "b" } })
      const answer = yield* Fiber.join(fiber)

      assert.isTrue(accepted)
      assert.strictEqual(answer.granted, true)
      assert.deepStrictEqual(answer.value, Option.some({ choice: "b" }))
    })
  )

  it.effect("fails with a SchemaError when the answer value is malformed", () =>
    Effect.gen(function* () {
      const elicitor = yield* Elicitation.memory.make("s")
      const fiber = yield* Effect.forkChild(
        Elicitation.elicitValue(elicitor, request, Effect.void, AnswerSchema).pipe(Effect.exit)
      )
      yield* Effect.yieldNow
      yield* elicitor.respond({ id: "q1", granted: true, value: { wrong: 1 } })
      const exit = yield* Fiber.join(fiber)
      // The run receives a typed decode failure, not garbage.
      assert.isTrue(Exit.isFailure(exit))
    })
  )

  it.effect("an answer that carries no value yields Option.none", () =>
    Effect.gen(function* () {
      const elicitor = yield* Elicitation.memory.make("s")
      const fiber = yield* Effect.forkChild(
        Elicitation.elicitValue(elicitor, request, Effect.void, AnswerSchema)
      )
      yield* Effect.yieldNow
      yield* elicitor.respond({ id: "q1", granted: false })
      const answer = yield* Fiber.join(fiber)

      assert.strictEqual(answer.granted, false)
      assert.isTrue(Option.isNone(answer.value))
    })
  )

  it.effect("a second respond to an already-answered request is refused (terminal state)", () =>
    Effect.gen(function* () {
      const elicitor = yield* Elicitation.memory.make("s")
      const fiber = yield* Effect.forkChild(elicitor.elicit(request, Effect.void))
      yield* Effect.yieldNow
      const first = yield* elicitor.respond({ id: "q1", granted: true })
      yield* Fiber.join(fiber)
      // The request is answered; a late second answer is refused, not applied.
      const second = yield* elicitor.respond({ id: "q1", granted: true })

      assert.isTrue(first)
      assert.isFalse(second)
    })
  )

  it.effect("two answers racing before the run observes either: exactly one lands, the run sees the first", () =>
    Effect.gen(function* () {
      const elicitor = yield* Elicitation.memory.make("s")
      const fiber = yield* Effect.forkChild(elicitor.elicit(request, Effect.void))
      yield* Effect.yieldNow
      // Both answers arrive before the waiting fiber has run again, so the
      // registration is still present for the second one; the terminal
      // state is the deferred itself, not the registry.
      const first = yield* elicitor.respond({ id: "q1", granted: true })
      const second = yield* elicitor.respond({ id: "q1", granted: false })
      const seen = yield* Fiber.join(fiber)

      assert.isTrue(first)
      assert.isFalse(second)
      assert.strictEqual(seen.granted, true)
      // And an id nobody ever asked about is the same `false`: the seam
      // reports "nothing was waiting", and the two cases are told apart by
      // `pending` and the `ElicitationRequested` / `ElicitationResolved`
      // events, not by the boolean.
      assert.isFalse(yield* elicitor.respond({ id: "never-asked", granted: true }))
    })
  )

  it.effect("one wait's teardown does not unregister another wait on the same id", () =>
    Effect.gen(function* () {
      // `Elicitor` is a public seam and the id comes from the caller, so a
      // reused id is a caller's mistake -- but it must not silently take the
      // *live* question down with it. Removing by id alone did: the first
      // wait's interruption deleted the second's registration, leaving a
      // question nothing reported as pending and `respond` could not answer.
      const elicitor = yield* Elicitation.memory.make("s")
      const first = yield* Effect.forkChild(elicitor.elicit(request, Effect.void))
      yield* Effect.yieldNow
      const second = yield* Effect.forkChild(elicitor.elicit(request, Effect.void))
      yield* Effect.yieldNow

      yield* Fiber.interrupt(first)
      yield* Effect.yieldNow

      assert.deepStrictEqual(yield* elicitor.pending, [request])
      assert.isTrue(yield* elicitor.respond({ id: "q1", granted: true }))
      assert.strictEqual((yield* Fiber.join(second)).granted, true)
    })
  )
})

// Type-level assertion (E1 / CLAUDE.md: assert inference). `elicitValue`'s
// decoded `value` is the schema's type, not `unknown` -- the whole point of the
// typed boundary. Falsified if the value channel is widened back to `unknown`.
const _elicitValueTyped = Elicitation.elicitValue<{ readonly choice: string }, { readonly choice: string }>
type _Ret = ReturnType<typeof _elicitValueTyped>
type _Success = [_Ret] extends [Effect.Effect<infer S, unknown, unknown>] ? S : never
const _assertTypedValue: [_Success["value"]] extends [Option.Option<{ readonly choice: string }>]
  ? ([Option.Option<{ readonly choice: string }>] extends [_Success["value"]] ? true : false)
  : false = true
void _assertTypedValue
