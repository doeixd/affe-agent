import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, ExecutionPlan, Metric, Ref, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Observability } from "../src/observability/index.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Provider fallback, as a combinator. See `docs/plan-execution-plan.md`.
 *
 * The design's load-bearing constraint is that a plan wraps the **model call
 * and nothing wider**. A turn is a model call *and the tool calls it asked
 * for*, so a plan around the turn would retry tools -- side effects on the
 * world -- because a different part of the turn failed. X1 below is that
 * property, and it is the reason the scope is what it is.
 */

const Ping = Tool.make("ping", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

describe("Agent.withExecutionPlan", () => {
  it.effect("falls back to the next step when the first model fails", () =>
    Effect.gen(function* () {
      const primaryCalls = yield* Ref.make(0)
      const primaryScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("primary answered")
      ])
      const fallbackScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("fallback answered")
      ])

      // The primary fails every call; the plan moves on.
      const plan = ExecutionPlan.make(
        { provide: TestLanguageModel.failingAfter(primaryScript.layer, { succeedFirst: 0, calls: primaryCalls }), attempts: 1 },
        { provide: fallbackScript.layer }
      )

      const agent = Agent.make({ loop: AgentLoop.bounded(2) }).pipe(
        Agent.withExecutionPlan(plan)
      )

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      )

      assert.strictEqual(result.text, "fallback answered")
      // The primary was genuinely attempted, so this is a fallback and not a
      // test that only ever exercised the second step.
      assert.strictEqual(yield* Ref.get(primaryCalls), 1)
    })
  )

  /**
   * X1 — a plan never re-runs a tool.
   *
   * The primary answers the *first* model call with a tool call, so the tool
   * runs. Its second model call -- the one that reads the tool result -- fails,
   * and the plan falls back. If the plan wrapped the turn rather than the model
   * call, that fallback would re-run the tool.
   */
  it.effect("a tool called before the failure runs exactly once", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const primaryCalls = yield* Ref.make(0)

      const primaryScript = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("ping", {}, { id: "p1" }),
        TestLanguageModel.text("primary should never get here")
      ])
      const fallbackScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("fallback finished the turn")
      ])

      const plan = ExecutionPlan.make(
        { provide: TestLanguageModel.failingAfter(primaryScript.layer, { succeedFirst: 1, calls: primaryCalls }), attempts: 1 },
        { provide: fallbackScript.layer }
      )

      const agent = Agent.make({
        tools: [Agent.tool(Ping, () => Effect.as(Ref.update(ran, (n) => n + 1), "pong"))],
        loop: AgentLoop.bounded(4)
      }).pipe(Agent.withExecutionPlan(plan))

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      )

      assert.strictEqual(result.text, "fallback finished the turn")
      // The whole point. A plan around the turn would make this 2.
      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )

  /**
   * X2 — streaming.
   *
   * A fallback *before* any output is invisible to an observer: `MessageStarted`
   * is emitted once, outside the plan, and the fallback's stream completes the
   * message. That is the case worth having, and the one this asserts.
   *
   * A fallback *after* output is forbidden rather than handled --
   * `preventFallbackOnPartialStream`, set in `AgentTurn.withPlanStream`. Mixing
   * partial output with a retry would show a viewer two `MessageStarted` events
   * for one turn and deltas the transcript will never contain.
   */
  it.effect("a streamed run falls back, and emits exactly one MessageStarted", () =>
    Effect.gen(function* () {
      const primaryCalls = yield* Ref.make(0)
      const primaryScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("primary answered")
      ])
      const fallbackScript = yield* TestLanguageModel.script([
        { text: "fallback streamed", chunks: ["fall", "back", " streamed"] }
      ])

      const plan = ExecutionPlan.make(
        {
          provide: TestLanguageModel.failingAfter(primaryScript.layer, {
            succeedFirst: 0,
            calls: primaryCalls
          }),
          attempts: 1
        },
        { provide: fallbackScript.layer }
      )

      const agent = Agent.make({ loop: AgentLoop.bounded(2) }).pipe(
        Agent.withExecutionPlan(plan)
      )

      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          const probe = yield* AgentProbe.make(session)
          yield* AgentSession.prompt(session, "go", { stream: true })
          return yield* probe.events
        })
      )

      const started = events.filter((e) => e.event._tag === "MessageStarted")
      const deltas = events.filter((e) => e.event._tag === "MessageDelta")

      // The primary was tried on the streaming path too -- otherwise this
      // asserts nothing about streaming.
      assert.strictEqual(yield* Ref.get(primaryCalls), 1)
      // One message, from the fallback. Two would mean a viewer saw a message
      // begin, then begin again.
      assert.strictEqual(started.length, 1)
      assert.isAbove(deltas.length, 0)
    })
  )

  /**
   * X3 — the ladder is observable.
   *
   * "How often are we falling back, and to what" is the question a fallback
   * ladder exists to make answerable, and it is not answerable from the event
   * stream: which provider answered is an infrastructure fact, not something
   * the conversation did, so it is a metric rather than an `AgentEvent`.
   */
  it.effect("records an attempt per step, by outcome", () =>
    Effect.gen(function* () {
      const primaryCalls = yield* Ref.make(0)
      const primaryScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("primary answered")
      ])
      const fallbackScript = yield* TestLanguageModel.script([
        TestLanguageModel.text("fallback answered")
      ])

      const plan = ExecutionPlan.make(
        {
          provide: TestLanguageModel.failingAfter(primaryScript.layer, {
            succeedFirst: 0,
            calls: primaryCalls
          }),
          attempts: 1
        },
        { provide: fallbackScript.layer }
      )

      const agent = Agent.make({ loop: AgentLoop.bounded(2) }).pipe(
        Agent.withExecutionPlan(plan)
      )

      yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      )

      const attempt = (step: string, outcome: string) =>
        Metric.value(
          Metric.withAttributes(Observability.instruments.modelAttempts, {
            step,
            outcome
          })
        )

      // Step 0 was tried and failed; step 1 answered. Both are recorded, and
      // they are distinguishable -- a single "fallbacks happened" counter
      // would not tell an operator which rung is carrying the load.
      assert.strictEqual((yield* attempt("0", "failed")).count, 1)
      assert.strictEqual((yield* attempt("1", "succeeded")).count, 1)
      // The step that failed did not also record a success.
      assert.strictEqual((yield* attempt("0", "succeeded")).count, 0)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
  )

  it.effect("an agent without a plan is unchanged", () =>
    Effect.gen(function* () {
      // The combinator must be inert when absent: no plan, no wrapping, and the
      // model still arrives from the environment as it always did.
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("ordinary")
      ])
      const agent = Agent.make({ loop: AgentLoop.bounded(2) })
      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(agent), (session) =>
          AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(layer))
      assert.strictEqual(result.text, "ordinary")
    })
  )
})

// ---------------------------------------------------------------------------
// What the combinator says about the agent it returns.
//
// Compile-time, because these are claims about *types*: a runtime test cannot
// see a requirement that was wrongly struck out or an error channel that was
// quietly dropped. Each assertion below is broken once in the commit that
// introduced it, which is the only way to know it is load-bearing.
// ---------------------------------------------------------------------------

type Assert<T extends true> = T
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

/** A service the plan's layer needs, and one it provides beside the model. */
class PlanConfig extends Context.Service<PlanConfig, { readonly url: string }>()(
  "test/ExecutionPlan/PlanConfig"
) {}
class Sidecar extends Context.Service<Sidecar, { readonly name: string }>()(
  "test/ExecutionPlan/Sidecar"
) {}
/** A service the *agent* needs, which the plan's layer happens to also provide. */
class Shared extends Context.Service<Shared, { readonly value: number }>()(
  "test/ExecutionPlan/Shared"
) {}

declare const fallible: ExecutionPlan.ExecutionPlan<{
  provides: LanguageModel.LanguageModel | Shared
  input: unknown
  error: { readonly _tag: "PlanBroke" }
  requirements: PlanConfig
}>

declare const modelless: ExecutionPlan.ExecutionPlan<{
  provides: Sidecar
  input: unknown
  error: never
  requirements: never
}>

declare const agentNeedingShared: Agent.AgentDefinition<
  Record<string, never>,
  "AgentError",
  Shared
>

/**
 * Never called: its body exists so TypeScript infers the two agent types, and
 * `declare const` erases at runtime -- evaluating this at module scope threw a
 * `ReferenceError` and took the whole suite with it.
 */
const probe = () => {
  const planned = agentNeedingShared.pipe(Agent.withExecutionPlan(fallible))
  const replanned = planned.pipe(Agent.withExecutionPlan(modelless))
  return { planned, replanned }
}

type Planned = ReturnType<typeof probe>["planned"]
type Replanned = ReturnType<typeof probe>["replanned"]

/**
 * R17 -- the plan's own error is the agent's error. A provider layer that can
 * fail to build says so here, or the agent is advertised as infallible.
 */
export type _PlanErrorIsCarried = Assert<
  Equals<
    Planned extends Agent.AgentDefinition<infer _T, infer E, infer _R, infer _M> ? E : never,
    "AgentError" | { readonly _tag: "PlanBroke" }
  >
>

/**
 * R16 -- `Shared` survives. The plan's layer provides it, but the plan is
 * applied around the model call alone, and the agent needs `Shared` in its
 * toolkit resolution, its context transforms and its tool handlers -- none of
 * which run inside that scope. Striking it out promised a service that is not
 * there where it is used.
 *
 * `PlanConfig` is added, because the plan genuinely needs it.
 */
export type _AgentRequirementsSurvive = Assert<
  Equals<
    Planned extends Agent.AgentDefinition<infer _T, infer _E, infer R, infer _M> ? R : never,
    Shared | PlanConfig
  >
>

/** A plan providing the model discharges the ambient model requirement. */
export type _ModelIsDischarged = Assert<
  Equals<
    Planned extends Agent.AgentDefinition<infer _T, infer _E, infer _R, infer M> ? M : never,
    never
  >
>

/**
 * R32 -- and a *replacement* plan that provides no model brings the
 * requirement back.
 *
 * Computed from the model requirement itself rather than from the residual:
 * subtracting from `never` is still `never`, so the second plan left an agent
 * requiring no ambient model while supplying none -- a runtime failure with
 * the types insisting everything was fine.
 */
export type _ReplacementRestoresTheModel = Assert<
  Equals<
    Replanned extends Agent.AgentDefinition<infer _T, infer _E, infer _R, infer M> ? M : never,
    LanguageModel.LanguageModel
  >
>
