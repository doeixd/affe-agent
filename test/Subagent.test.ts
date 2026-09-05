import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Subagent } from "../src/subagent/index.js"
import { AgentProbe } from "../src/testing/index.js"
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

describe("a cut-short child is a failure carrying what it had", () => {
  /**
   * Decision 2 of `docs/plan-two-decisions.md`. A child session absorbs
   * interruption and returns what it committed with `status: "interrupted"`;
   * before this, `Subagent.tool` handed that to the parent as a finished
   * answer. Now it is a `SubagentInterruptedError` on the tool's failure
   * channel, carrying the partial text, under both `onError` modes -- and
   * the parent's own interruption still takes precedence over `"die"`.
   */
  const Noop = Tool.make("noop", { parameters: Schema.Struct({}), success: Schema.String })
  const noop = Agent.tool(Noop, () => Effect.succeed("ok"))

  /**
   * A child that cuts itself: a tool whose handler interrupts. The child's
   * run fiber absorbs it, so the child's result is `interrupted` with what
   * was committed before -- no cast on a model service needed.
   */
  const Cut = Tool.make("cut", { parameters: Schema.Struct({}), success: Schema.String })
  const cut = Agent.tool(Cut, () => Effect.interrupt)

  it.effect("under return: the parent reads a failure that says interrupted and carries the partial text", () =>
    Effect.gen(function* () {
      // Turn one: text and a tool call, committed. Turn two: the child is cut.
      const child = yield* FakeModel.layer([
        { text: "partial findings", toolCalls: [{ id: "c1", name: "noop", params: {} }] },
        { toolCalls: [{ id: "c2", name: "cut", params: {} }] }
      ])
      const research = Subagent.tool("research", Agent.make({ tools: [noop, cut], loop: AgentLoop.bounded(3) }), {
        description: "Delegate research.",
        provide: child.layer
      })
      const { layer: parentModel } = yield* FakeModel.layer([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "what broke" } }] },
        { text: "the parent carried on" }
      ])
      const { result, events } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ tools: [research], loop: AgentLoop.bounded(3) }))
          const probe = yield* AgentProbe.make(session)
          const result = yield* AgentSession.prompt(session, "go")
          return { result, events: yield* probe.events }
        })
      ).pipe(Effect.provide(parentModel))
      assert.strictEqual(result.text, "the parent carried on")
      const failed = events.flatMap((e) => AgentEvent.is("ToolCallFailed")(e) ? [e.event] : [])
      assert.strictEqual(failed.length, 1)
      assert.strictEqual(failed[0]!.name, "research")
      assert.isTrue(failed[0]!.returnedToModel)
      assert.include(failed[0]!.failure.message, "was interrupted after 1 turn and did not finish")
      assert.include(failed[0]!.failure.message, "it had said: partial findings")
      assert.include(failed[0]!.failure.message, "did run")
      // Not a success: the parent's model never saw the partial text as an answer.
      const succeeded = events.flatMap((e) => AgentEvent.is("ToolCallSucceeded")(e) && e.event.name === "research" ? [e.event] : [])
      assert.deepStrictEqual(succeeded, [])
    })
  )

  it.effect("a child cut before saying anything says so; under die, the parent run dies with the error", () =>
    Effect.gen(function* () {
      const child = yield* FakeModel.layer([{ toolCalls: [{ id: "c1", name: "cut", params: {} }] }])
      const research = Subagent.tool("research", Agent.make({ tools: [cut] }), {
        description: "Delegate research.",
        provide: child.layer,
        onError: "die"
      })
      const { layer: parentModel } = yield* FakeModel.layer([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "what broke" } }] },
        { text: "never reached" }
      ])
      const exit = yield* Effect.scoped(
        Effect.flatMap(
          AgentSession.make(Agent.make({ tools: [research], loop: AgentLoop.bounded(3) })),
          (session) => AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.exit, Effect.provide(parentModel))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.isFalse(Cause.hasInterruptsOnly(exit.cause), "the parent run must fail, not merely be interrupted")
        const defect = Cause.squash(exit.cause)
        assert.instanceOf(defect, Subagent.SubagentInterruptedError, "a die child failure should be a defect of the parent run")
        if (defect instanceof Subagent.SubagentInterruptedError) {
          assert.strictEqual(defect.turns, 0)
          assert.deepStrictEqual(defect.partial, Option.none())
          assert.include(defect.message, "it had said nothing yet")
        }
      }
    })
  )

  it.effect("the parent's own interruption takes precedence over die: an interrupted parent, not a defect", () =>
    Effect.gen(function* () {
      // The child hangs; the parent is interrupted while it waits. The parent
      // result is `interrupted`, and no `SubagentInterruptedError` defect
      // replaces it, though the tool was built with `onError: "die"`.
      const childStarted = yield* Deferred.make<void>()
      const child = yield* FakeModel.layer([{ hang: true, started: childStarted }])
      const research = Subagent.tool("research", Agent.make({}), {
        description: "Delegate research.",
        provide: child.layer,
        onError: "die"
      })
      const { layer: parentModel } = yield* FakeModel.layer([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "what broke" } }] }
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ tools: [research] }))
          const fiber = yield* Effect.forkChild(AgentSession.prompt(session, "go"))
          yield* Deferred.await(childStarted)
          yield* AgentSession.interrupt(session)
          const exit = yield* Fiber.await(fiber)
          assert.isTrue(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
          if (Exit.isSuccess(exit)) assert.strictEqual(exit.value.status, "interrupted")
          assert.strictEqual(yield* AgentSession.status(session), "idle")
        }).pipe(Effect.provide(parentModel))
      )
    })
  )
})
