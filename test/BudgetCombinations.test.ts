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
  it.live("a child's tokens are not counted against the parent's ceiling", () =>
    Effect.gen(function* () {
      /**
       * Recorded rather than asserted as correct, because it is a real gap
       * and the fix is a design decision.
       *
       * `Budget.within` is a *loop* combinator: it charges the turns of the
       * loop it wraps. A child agent has its own loop, so unless that loop is
       * also budgeted, its turns are spent through a model and charged to
       * nobody. A parent capped at N tokens can therefore spend without limit
       * by delegating -- which is exactly the shape of an agent that is
       * capped *because* it delegates.
       *
       * The `Budget` service itself is shared: the child inherits the
       * parent's context, so a budgeted child would charge the same counter.
       * That is what makes this a footgun rather than an impossibility --
       * everything is in place except anything that makes it happen.
       */
      const childModel = yield* FakeModel.layer([
        { text: "the child's expensive findings", usage: usage(10_000) }
      ])
      const child = Agent.make({ instructions: "child", loop: AgentLoop.bounded(2) })
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })

      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: Budget.within(50_000, AgentLoop.bounded(4))
      })
      const { layer: parentModel } = yield* FakeModel.script([
        {
          toolCalls: [{ id: "r1", name: "research", params: { prompt: "q" } }],
          usage: usage(100)
        },
        { text: "done", usage: usage(100) }
      ])

      const spent = yield* Effect.gen(function* () {
        yield* Agent.run(parent, "go")
        return yield* Effect.flatMap(Budget.Budget, (budget) => budget.spent)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Budget.layer, parentModel))
      )

      // Two parent turns at 100 each. The child's ten thousand are invisible.
      assert.strictEqual(
        spent,
        200,
        "a child's tokens now reach the parent's budget: good, and this test should become an assertion that they do"
      )
    }),
    30_000
  )
})

describe("a budget and a resume", () => {
  it.live("a replayed turn is charged to the budget a second time", () =>
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
       * **This asserts a bug, deliberately.** Two model calls, three turns'
       * worth of spend.
       *
       * The journal did its job: the model was asked exactly twice for a
       * two-turn script, so the pre-suspension call was replayed rather than
       * re-issued. But the *loop* runs again on replay, and `Budget.within`
       * charges whatever response it is handed -- including a replayed one.
       * The turn before the suspension is therefore paid for twice.
       *
       * The direction is what makes it matter. This is not a ceiling that
       * fails to bite; it is one that bites too early, and the more a run
       * suspends the earlier. A long durable conversation can be stopped for
       * exceeding a budget it never spent, and the number it reports is not
       * the money spent either -- wrong as a ledger and wrong as a limit, in
       * the direction that terminates legitimate work.
       *
       * Pinned at the wrong number rather than left failing, so the suite
       * stays honest and this fails loudly the moment someone fixes it.
       * Recorded as item 51: the fix is a decision about where a budget lives
       * under durability, not a line to change here.
       */
      assert.strictEqual(
        yield* Ref.get(modelCalls),
        2,
        "the model was re-asked on replay, which would be a different and much worse bug"
      )
      assert.strictEqual(
        spent,
        3_000,
        "the replayed turn is no longer double-charged: change this to 2,000 and close item 51"
      )
    }),
    30_000
  )
})
