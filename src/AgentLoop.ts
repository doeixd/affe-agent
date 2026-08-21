import { Effect } from "effect"
import type { LanguageModel, Response, Tool } from "effect/unstable/ai"
import type { RunId, SessionId, SubmissionId } from "./internal/ids.js"

/**
 * Everything the continuation policy is allowed to see.
 *
 * The loop is policy, never engine: it decides whether another turn happens, it
 * does not perform one.
 *
 * Follow-up queue state is deliberately absent. Follow-ups are submission
 * orchestration — whether more work is scheduled after this run stops — not a
 * reason for the current run to continue. A loop that consulted them would be
 * making a decision that belongs to `AgentSubmission`.
 */
export interface State<Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>> {
  readonly sessionId: SessionId
  readonly submissionId: SubmissionId
  readonly runId: RunId
  /** 1-based index of the turn that just completed. */
  readonly turnIndex: number
  /**
   * The response as the harness received it.
   *
   * Tool parameters are **encoded**, not decoded. The harness runs with
   * `disableToolCallResolution: true` (§16), and Effect AI deliberately leaves
   * parameters in their encoded schema form in that mode — the handler is what
   * decodes them. For a tool whose parameters are a plain struct the two
   * coincide, but for a transformed schema they do not, so a policy reading
   * `params` must be typed for what is actually there.
   */
  readonly response: LanguageModel.GenerateTextResponse<Tools, true>
  /**
   * The calls this harness must execute.
   *
   * Provider-executed calls are excluded: the provider already ran them, so
   * `untilIdle` must not treat their presence as outstanding work. The full
   * set, including provider-side calls, is on `response.content`.
   */
  readonly toolCalls: ReadonlyArray<Response.ToolCallParts<Tools, true>>
}

export type Decision = Continue | Stop

export interface Continue {
  readonly _tag: "Continue"
}

export interface Stop {
  readonly _tag: "Stop"
}

export const Continue: Decision = { _tag: "Continue" }
export const Stop: Decision = { _tag: "Stop" }

/**
 * `E` and `R` are preserved so a policy can depend on its own services — a
 * token budget, a usage policy, feature flags — without the harness
 * understanding those concepts.
 */
export interface AgentLoop<
  E = never,
  R = never,
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
> {
  readonly decide: (state: State<Tools>) => Effect.Effect<Decision, E, R>
}

export const make = <
  E = never,
  R = never,
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  decide: (state: State<Tools>) => Effect.Effect<Decision, E, R>
): AgentLoop<E, R, Tools> => ({ decide })

/**
 * Continue while the last response requested tool calls.
 *
 * Once the model stops asking for tools it has nothing left to act on, so the
 * run has reached its natural stopping condition.
 */
export const untilIdle = <
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(): AgentLoop<never, never, Tools> =>
  make((state) => Effect.succeed(state.toolCalls.length > 0 ? Continue : Stop))

/** Stop once `max` turns have been executed, whatever the inner policy says. */
export const maxTurns = <Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>>(
  max: number
): AgentLoop<never, never, Tools> =>
  make((state) => Effect.succeed(state.turnIndex >= max ? Stop : Continue))

/**
 * Continue only while every policy continues.
 *
 * Composition is explicit rather than hidden inside `.pipe`, so a reader never
 * has to guess whether combination means conjunction or disjunction.
 *
 * At least one policy is required. An empty conjunction is vacuously true,
 * which here would mean a run that never stops — a footgun worth making
 * unrepresentable rather than documenting.
 */
/**
 * The pieces of a composed policy, extracted per element.
 *
 * Declaring `and` over a single `E` and `R` reads naturally and does not work:
 * TypeScript infers them from the first argument and then rejects every
 * argument that differs. Two policies failing in different ways — the case
 * composition exists for — would not compile at all. Extracting per element
 * and unioning is what makes heterogeneous composition possible, and the
 * distribution happens because `Loop` is a naked type parameter here.
 */
type ErrorOf<Loop> = Loop extends AgentLoop<infer E, infer _R, infer _T>
  ? E
  : never
type ServicesOf<Loop> = Loop extends AgentLoop<infer _E, infer R, infer _T>
  ? R
  : never
type ToolsOf<Loop> = Loop extends AgentLoop<infer _E, infer _R, infer T>
  ? T
  : never

/** At least one, so an empty composition stays unrepresentable. */
type Policies = readonly [
  AgentLoop<any, any, any>,
  ...ReadonlyArray<AgentLoop<any, any, any>>
]

export const and = <const Loops extends Policies>(
  ...loops: Loops
): AgentLoop<
  ErrorOf<Loops[number]>,
  ServicesOf<Loops[number]>,
  ToolsOf<Loops[number]>
> =>
  make((state) =>
    Effect.reduce(loops, () => Continue as Decision, (acc, loop) =>
      acc._tag === "Stop" ? Effect.succeed(acc) : loop.decide(state)
    )
  ) as AgentLoop<
    ErrorOf<Loops[number]>,
    ServicesOf<Loops[number]>,
    ToolsOf<Loops[number]>
  >

/**
 * The usual loop: run until the model stops asking for tools, but never more
 * than `maxTurns`.
 *
 * `and(untilIdle(), maxTurns(n))` is what almost every agent wants, and writing
 * it out invites leaving off the bound — which turns a looping model into an
 * unbounded spend.
 */
export const bounded = <Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>>(
  maxTurns_: number
): AgentLoop<never, never, Tools> =>
  and(untilIdle<Tools>(), maxTurns<Tools>(maxTurns_))

/** Continue if any policy continues. */
export const or = <const Loops extends Policies>(
  ...loops: Loops
): AgentLoop<
  ErrorOf<Loops[number]>,
  ServicesOf<Loops[number]>,
  ToolsOf<Loops[number]>
> =>
  make((state) =>
    Effect.reduce(loops, () => Stop as Decision, (acc, loop) =>
      acc._tag === "Continue" ? Effect.succeed(acc) : loop.decide(state)
    )
  ) as AgentLoop<
    ErrorOf<Loops[number]>,
    ServicesOf<Loops[number]>,
    ToolsOf<Loops[number]>
  >
