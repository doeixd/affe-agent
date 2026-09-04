import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import { AgentClient } from "../src/client/index.js"
import { Budget } from "../src/budget/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * A budget is a ceiling on money. These press it against the two features most
 * able to walk around one: a delegation, which spends through a *second*
 * agent's loop, and a resume, which starts the loop again.
 *
 * Both were covered alone. `test/Budget.test.ts` proves a ceiling stops a run
 * and that both axes accumulate; the subagent and durable suites prove their
 * own halves. What a ceiling is *for* is the pair.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const usage = (tokens: number) => ({ input: tokens, output: 0 })

describe("a budget and a delegation", () => {
  /**
   * Item 52, decided: a child's turns are charged to the parent's budget.
   *
   * `Budget.within` is a *loop* combinator: it charges the turns of the loop
   * it wraps. A child agent has its own loop, so until `plan-seams.md` B its
   * turns were spent through a model and charged to nobody, and a parent
   * capped at N tokens could spend without limit by delegating -- exactly
   * the shape of an agent that is capped *because* it delegates.
   *
   * `Subagent.tool` now wraps the child's loop with `Budget.charge` by
   * default, so the child's turns land on the parent's counter. The child is
   * counted, not capped: the parent's ceiling sees the spend when the
   * delegating turn ends, which is why the parent below stops right there.
   */
  const delegating = (inherit: Subagent.Inherit | undefined) =>
    Effect.gen(function* () {
      const childModel = yield* FakeModel.layer([
        { text: "the child's expensive findings", usage: usage(10_000) }
      ])
      const child = Agent.make({ instructions: "child", loop: AgentLoop.bounded(2) })
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer,
        inherit
      })
      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        // A ceiling the child's spend alone crosses, so whether the parent
        // stops after the delegation is the observable.
        loop: Budget.within(5_000, AgentLoop.bounded(4))
      })
      const { layer: parentModel, recorder } = yield* FakeModel.script([
        {
          toolCalls: [{ id: "r1", name: "research", params: { prompt: "q" } }],
          usage: usage(100)
        },
        { text: "done", usage: usage(100) },
        { text: "never reached under the default", usage: usage(100) }
      ])

      return yield* Effect.gen(function* () {
        const result = yield* Agent.run(parent, "go")
        const spent = yield* Effect.flatMap(Budget.Budget, (budget) => budget.spent)
        return { spent, text: result.text, parentCalls: (yield* recorder.prompts).length }
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Budget.layer, parentModel))
      )
    })

  it.live("a child's tokens are charged to the parent's budget, and the parent's ceiling sees them", () =>
    Effect.gen(function* () {
      const { parentCalls, spent } = yield* delegating(undefined)
      // The parent's first turn at 100 and the child's ten thousand. The loop
      // decides after the turn's tools have run, so the parent's ceiling sees
      // the child's spend at the end of the very turn that delegated, and
      // there is no second parent call.
      assert.strictEqual(spent, 10_100, "the child's tokens are charged to nobody again")
      assert.strictEqual(parentCalls, 1, "the parent's ceiling did not see the child's spend")
    }),
    30_000
  )

  it.live("`inherit: { budget: false }` is the old behaviour, chosen rather than fallen into", () =>
    Effect.gen(function* () {
      const { parentCalls, spent } = yield* delegating({ budget: false })
      assert.strictEqual(spent, 200)
      assert.strictEqual(parentCalls, 2)
    }),
    30_000
  )

  it.live("a child capped by its own `within` shares the counter, so the cap is on the whole", () =>
    Effect.gen(function* () {
      /**
       * The corollary the `Inherit.budget` doc promises: the child is counted
       * rather than capped by the parent, and a child that should stop on its
       * own uses `Budget.within` -- which now reads the parent's counter. So
       * the child's ceiling is against everything spent so far, not its own
       * spend from zero.
       */
      const childModel = yield* FakeModel.layer([
        { text: "first", usage: usage(1_000) },
        { text: "never reached", usage: usage(1_000) }
      ])
      const child = Agent.make({
        instructions: "child",
        // Would allow two child turns from zero; the parent has already
        // spent 2_500 on the same counter, so the first child turn crosses.
        loop: Budget.within(3_000, AgentLoop.bounded(3))
      })
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })
      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: Budget.within(100_000, AgentLoop.bounded(4))
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "q" } }], usage: usage(2_500) },
        { text: "done", usage: usage(100) }
      ])
      const spent = yield* Effect.gen(function* () {
        yield* Agent.run(parent, "go")
        return yield* Effect.flatMap(Budget.Budget, (budget) => budget.spent)
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(Budget.layer, parentModel)))

      // 2_500 + one child turn of 1_000 (which crossed 3_000) + 100.
      assert.strictEqual(spent, 3_600, "the child's ceiling counted from zero: it does not share the parent's counter")
    }),
    30_000
  )
})

describe("a budget and a resume", () => {
  it.live("a replayed turn is charged once, not twice", () =>
    Effect.gen(function* () {
      /**
       * The question a ceiling has to answer under durability: what happens
       * to it across a suspension?
       *
       * The budget is provided outside the workflow, which is what "cap this
       * session" has to mean -- inside, it would be rebuilt on every replay
       * and a run that suspends often enough would never reach any ceiling.
       * That much works. What does not is below.
       */
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const Gate = DurableDeferred.make("BudgetResumeGate", { success: Schema.String })
      const suspendOnce = yield* Ref.make(true)
      const turns = yield* Ref.make(0)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(turns)) > 0 && (yield* Ref.getAndSet(suspendOnce, false))) {
            const token = yield* DurableDeferred.token(Gate)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(Gate)
          }
          yield* Ref.update(turns, (n) => n + 1)
          return context.canonicalPrompt
        })
      )

      // A real tool, so the first turn continues to a second one and the
      // suspension has somewhere to land.
      const ping = Agent.tool(
        Tool.make("ping", { parameters: Schema.Struct({}), success: Schema.String }),
        () => Effect.succeed("pong")
      )
      const agent = Agent.make({
        instructions: "Answer twice.",
        tools: [ping],
        loop: Budget.within(50_000, AgentLoop.bounded(3)),
        contextTransform: gating
      })
      const modelCalls = yield* Ref.make(0)
      const { layer: baseModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "n1", name: "ping", params: {} }], usage: usage(1_000) },
        { text: "done", usage: usage(1_000) }
      ])
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.map(LanguageModel.LanguageModel, (inner): LanguageModel.Service => ({
          ...inner,
          generateText: ((o: Parameters<LanguageModel.Service["generateText"]>[0]) =>
            Effect.andThen(Ref.update(modelCalls, (n) => n + 1), inner.generateText(o))) as LanguageModel.Service["generateText"]
        }))
      ).pipe(Layer.provide(baseModel))

      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const budget = Budget.layer
      const runtime = DurableAgentClient.layer("BudgetResume", agent, {
        store,
        sessionStore,
        delivery
      }).pipe(
        Layer.provideMerge(Engine),
        Layer.provideMerge(model),
        // Outside the workflow, so one counter spans the suspension.
        Layer.provideMerge(budget)
      )

      const spent = yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "budget-resume" })
            const running = yield* Effect.forkChild(Effect.exit(session.prompt("go")))
            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(Gate, { token, value: "go" })
            yield* Fiber.join(running)
          })
        )
        return yield* Effect.flatMap(Budget.Budget, (b) => b.spent)
      }).pipe(Effect.provide(runtime))

      // The turn before the suspension is still on the counter afterwards. A
      /**
       * Two model calls, two turns of spend -- item 51, closed.
       *
       * This asserted `3_000` until the fix landed, deliberately, so the suite
       * stayed green while recording a bug it could not yet fix. The journal
       * was always right: the model is asked exactly twice for a two-turn
       * script, which is asserted separately because the model being re-asked
       * would be a different and much worse bug. What charged twice was the
       * *loop*, which runs again on replay and handed `Budget.within` a
       * response already paid for.
       *
       * The fix keys each charge by `(runId, turnIndex)`, and this number is
       * also the evidence that a run keeps its identity across a suspension --
       * had the replay minted a new `runId`, the key would differ and the
       * charge would land again.
       */
      assert.strictEqual(
        yield* Ref.get(modelCalls),
        2,
        "the model was re-asked on replay, which would be a different and much worse bug"
      )
      assert.strictEqual(
        spent,
        2_000,
        "a replayed turn is being charged again: the occurrence key is not recognising it"
      )
    }),
    30_000
  )
})
