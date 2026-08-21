import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schema } from "effect"
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
})
