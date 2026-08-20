import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as FakeModel from "./FakeModel.js"

/**
 * PLAN §34 and §35: a subagent is a tool that opens another scoped session.
 *
 * There is no subagent abstraction to test — the point is that the ordinary
 * pieces already compose, so these tests exist to prove the claim rather than
 * to exercise harness code.
 */
const Delegate = Tool.make("delegate", {
  parameters: Schema.Struct({ question: Schema.String }),
  success: Schema.String
})

const DelegateToolkit = Toolkit.make(Delegate)

describe("subagents", () => {
  it.effect("a child session runs under a different model", () =>
    Effect.gen(function* () {
      // Two independent scripted models: the child must use its own.
      const child = yield* FakeModel.layer([{ text: "child answer" }])
      const parent = yield* FakeModel.layer([
        { toolCalls: [{ id: "d1", name: "delegate", params: { question: "q" } }] },
        { text: "parent answer" }
      ])

      const ChildAgent = Agent.make({ instructions: "You are the child." })

      const delegating = DelegateToolkit.pipe(
        Effect.provide(
          DelegateToolkit.toLayer({
            delegate: ({ question }) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* AgentSession.make(ChildAgent)
                  const result = yield* AgentSession.prompt(session, question)
                  return result.text
                })
                  // The child's model is provided here, and nowhere else.
                  .pipe(Effect.provide(child.layer))
              ).pipe(Effect.orDie)
          })
        )
      )

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit: delegating })
          )
          return yield* AgentSession.prompt(session, "ask the child")
        }).pipe(Effect.provide(parent.layer))
      )

      assert.strictEqual(result.text, "parent answer")

      // Each model saw only its own conversation: the child never received the
      // parent's history, and the parent never received the child's.
      const childPrompts = yield* child.recorder.prompts
      const parentPrompts = yield* parent.recorder.prompts
      assert.strictEqual(childPrompts.length, 1)
      assert.deepStrictEqual(FakeModel.userTexts(childPrompts[0]!), ["q"])
      assert.deepStrictEqual(FakeModel.roles(childPrompts[0]!), [
        "system",
        "user"
      ])
      assert.strictEqual(parentPrompts.length, 2)
    })
  )

  it.effect("interrupting the parent interrupts the child", () =>
    Effect.gen(function* () {
      const childStarted = yield* Deferred.make<void>()

      // The child hangs; interruption must reach it through the tool's scope.
      const child = yield* FakeModel.layer([
        { hang: true, started: childStarted }
      ])
      const parent = yield* FakeModel.layer([
        { toolCalls: [{ id: "d1", name: "delegate", params: { question: "q" } }] }
      ])

      const ChildAgent = Agent.make({})

      const delegating = DelegateToolkit.pipe(
        Effect.provide(
          DelegateToolkit.toLayer({
            delegate: ({ question }) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* AgentSession.make(ChildAgent)
                  const result = yield* AgentSession.prompt(session, question)
                  return result.text
                }).pipe(Effect.provide(child.layer))
              ).pipe(Effect.orDie)
          })
        )
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ toolkit: delegating })
          )
          const fiber = yield* Effect.forkChild(
            AgentSession.prompt(session, "ask the child")
          )
          yield* Deferred.await(childStarted)
          yield* AgentSession.interrupt(session)

          const result = yield* Fiber.join(fiber)
          // Structured concurrency does the work: no cancellation plumbing
          // crosses the session boundary.
          assert.strictEqual(result.status, "interrupted")
          assert.strictEqual(yield* AgentSession.status(session), "idle")
        }).pipe(Effect.provide(parent.layer))
      )
    })
  )
})
