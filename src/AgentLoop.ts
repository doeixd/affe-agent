import { Duration, Effect } from "effect"
import type { Pipeable } from "effect/Pipeable"
import type { NoExcessProperties } from "effect/Types"
import { pipeArguments } from "effect/Pipeable"
import type { LanguageModel, Response, Tool } from "effect/unstable/ai"
import type { RunId, SessionId, SubmissionId } from "./internal/ids.js"
import * as Errors from "./Errors.js"
import { positiveInteger } from "./internal/positive.js"

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
   * Tool calls this run has executed so far, this turn's included.
   *
   * Accumulated by the engine rather than by the policy, so a ceiling on it
   * is a pure function of the state -- and holds under a durable replay,
   * where the loop runs again from the journal and a `Ref` a policy kept
   * would start from zero.
   */
  readonly toolCallsTotal: number
  /**
   * Wall-clock time since this run started, read from `Clock`.
   *
   * The one field here that is **not replay-stable**: under `/durable` a
   * resumed submission runs the loop again and measures its own elapsed
   * time, so a duration bound can decide differently on replay than it did
   * live -- and a replay that continues where the live run stopped issues a
   * model call the journal has no answer for. `turnIndex` and
   * `toolCallsTotal` are derived from journalled facts and do not have this
   * property; prefer them for an agent that runs durably.
   */
  readonly elapsed: Duration.Duration
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
   *
   * One call here may not be in `Tools`: an agent that declares an
   * `AgentOutput` has the harness's own reporting tool injected per turn, and
   * that tool never enters the agent's tool record. A policy matching on
   * `call.name` should expect it; a policy matching on the record's keys will
   * simply not recognise it, which is the safe direction.
   */
  readonly toolCalls: ReadonlyArray<Response.ToolCallParts<Tools, true>>
  /**
   * Whether this turn committed a value for the agent's `AgentOutput`.
   *
   * Not the same as "the output tool is among `toolCalls`": a call to it can
   * be refused -- denied under a `ReturnToModel` denial policy, or rejected
   * because it shared its turn (`ToolExecution.Alone`) -- and then the model
   * is expected to answer again, so a policy that stopped on the call's
   * presence would end the run without the answer. Derived from the
   * committed turn, so it is replay-stable like `turnIndex`. Always `false`
   * for an agent without an output.
   */
  readonly outputReported: boolean
}

/**
 * Why a run ran out, when it ran out rather than finished.
 *
 * A classification, not a reason: `stopReason` stays open-ended prose and
 * custom policies keep inventing their own, but the built-in ceilings each
 * carry one of these so a caller can branch on "the budget ran out" without
 * matching strings. `AgentLoop.stop("waiting for supervisor")` has no
 * exhaustion, and that is the point -- it did not run out of anything.
 *
 * The distinction it preserves:
 *
 * ```text
 * model went idle             -> stop, no exhaustion
 * output tool reported        -> stop, no exhaustion
 * a custom policy said stop   -> stop, no exhaustion
 * maxTurns reached            -> stop, exhaustion "turns"
 * token ceiling reached       -> stop, exhaustion "tokens"
 * ```
 */
export type Exhaustion = "turns" | "tool-calls" | "duration" | "tokens" | "cost"

export type Decision = Continue | Stop | Final

export interface Continue {
  readonly _tag: "Continue"
}

/**
 * No further turn.
 *
 * `reason` names the bound or rule that decided it and surfaces as
 * `RunCompleted.stopReason` and `Result.stopReason`; the built-in bounds name
 * theirs. Optional, because "the model went idle" needs no explanation.
 */
export interface Stop {
  readonly _tag: "Stop"
  readonly reason?: string | undefined
  /** Set when a built-in ceiling decided this; absent for an ordinary stop. */
  readonly exhaustion?: Exhaustion | undefined
}

/**
 * Exactly one more turn, with tools withheld, then stop.
 *
 * The turn that follows sees no tools -- or, for an agent with an
 * `AgentOutput`, only the output tool -- so a run that a bound cut short ends
 * in an answer rather than mid-thought. The loop is not consulted after that
 * turn: `Final` is a stop with one turn's notice, not a continue.
 */
export interface Final {
  readonly _tag: "Final"
  readonly reason?: string | undefined
  /** Carried through from the `Stop` a final turn replaced, when there was one. */
  readonly exhaustion?: Exhaustion | undefined
}

export const Continue: Decision = { _tag: "Continue" }
export const Stop: Decision = { _tag: "Stop" }
export const Final: Decision = { _tag: "Final" }

/** `Stop`, with the reason `RunCompleted.stopReason` will carry. */
export const stop = (reason?: string): Decision =>
  reason === undefined ? Stop : { _tag: "Stop", reason }

/** `Final`, with the reason `RunCompleted.stopReason` will carry. */
export const final = (reason?: string): Decision =>
  reason === undefined ? Final : { _tag: "Final", reason }

/**
 * `Stop`, classified: a built-in ceiling was reached rather than a policy
 * choosing to end.
 *
 * Exported so a custom policy enforcing one of the same ceilings can report it
 * the same way. A policy stopping for its own reasons should use {@link stop}:
 * inventing an exhaustion for something that did not run out would make the
 * classification mean less than the string it replaced.
 */
export const exhausted = (exhaustion: Exhaustion, reason?: string): Decision =>
  reason === undefined ? { _tag: "Stop", exhaustion } : { _tag: "Stop", reason, exhaustion }

/**
 * How much a decision stops. `and` keeps the most, `or` the least.
 *
 * `Final` sits between: it ends the run, but one turn later than `Stop`, so
 * a conjunction that has a `Stop` anywhere stops now, and one that has only
 * `Final`s and `Continue`s takes the final turn.
 */
const rank = (decision: Decision): number =>
  decision._tag === "Continue" ? 0 : decision._tag === "Final" ? 1 : 2

/**
 * `E` and `R` are preserved so a policy can depend on its own services — a
 * token budget, a usage policy, feature flags — without the harness
 * understanding those concepts.
 */
export interface AgentLoop<
  E = never,
  R = never,
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
> extends Pipeable {
  readonly decide: (state: State<Tools>) => Effect.Effect<Decision, E, R>
  /**
   * What this loop is, as data. Built by the constructor that built the
   * loop, so it cannot say something the loop does not do; `and`, `or` and
   * `withFinalTurn` compose descriptions as they compose decisions.
   * `Agent.describe` collects it. A loop made with `make` and no description
   * is `Custom`, named "anonymous".
   */
  readonly description: Description
}

/**
 * A loop described as data (`plan-context-lessons.md` 5.2, item 60h).
 *
 * The first-hour readability of a policy record, without the record: read
 * this and know what the run is bounded by. `Custom` is the escape hatch for
 * a loop written by hand or by a battery -- `Budget.within` describes itself
 * as `Custom` named `Budget.within` with its `limit` in `details`, wrapping
 * the description of the loop it wraps -- so a description is always
 * complete, if not always deep.
 */
export type Description =
  | { readonly _tag: "UntilIdle" }
  | { readonly _tag: "MaxTurns"; readonly max: number }
  | { readonly _tag: "MaxToolCalls"; readonly max: number }
  | { readonly _tag: "MaxDuration"; readonly millis: number }
  | { readonly _tag: "FinalTurn"; readonly inner: Description }
  | { readonly _tag: "And"; readonly loops: ReadonlyArray<Description> }
  | { readonly _tag: "Or"; readonly loops: ReadonlyArray<Description> }
  | {
    readonly _tag: "Custom"
    readonly name: string
    readonly details?: Readonly<Record<string, unknown>> | undefined
    readonly inner?: Description | undefined
  }

const anonymous: Description = { _tag: "Custom", name: "anonymous" }

/**
 * `and(and(a, b), c)` decides as `and(a, b, c)` -- the fold keeps the most
 * stopping decision and the first at that rank keeps its reason, in order --
 * so it is described as one, and `limits` reads as one conjunction rather
 * than a nest. The same for `or`.
 */
const flatten = (tag: "And" | "Or", loops: ReadonlyArray<Description>): ReadonlyArray<Description> =>
  loops.flatMap((description) => (description._tag === tag ? description.loops : [description]))

export const make = <
  E = never,
  R = never,
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  decide: (state: State<Tools>) => Effect.Effect<Decision, E, R>,
  description: Description = anonymous
): AgentLoop<E, R, Tools> => ({
  decide,
  description,
  // Syntax only. `and` and `or` stay explicit function calls, because a policy
  // combined by position would leave a reader guessing which one it was --
  // and the difference between them is the difference between a run that stops
  // and one that does not.
  pipe() {
    return pipeArguments(this, arguments)
  }
})

/**
 * Continue while the last response requested tool calls.
 *
 * Once the model stops asking for tools it has nothing left to act on, so the
 * run has reached its natural stopping condition.
 */
export const untilIdle = <
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(): AgentLoop<never, never, Tools> =>
  make((state) => Effect.succeed(state.toolCalls.length > 0 ? Continue : Stop), { _tag: "UntilIdle" })

/** Stop once `max` turns have been executed, whatever the inner policy says. */
export const maxTurns = <
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  max: number
): AgentLoop<never, never, Tools> => {
  const bound = positiveInteger("AgentLoop.maxTurns", max)
  const decision = exhausted("turns", "max turns")
  return make((state) => Effect.succeed(state.turnIndex >= bound ? decision : Continue), {
    _tag: "MaxTurns",
    max: bound
  })
}

/**
 * Stop once the run has executed `max` tool calls.
 *
 * Checked after the turn, as every loop bound is, so the turn that crosses
 * the ceiling is the last one and is not cut short: `maxToolCalls(3)` on a
 * turn that requested five calls runs all five, then stops. A per-call
 * refusal -- the fourth call denied and the model told -- is a `Permission`
 * decision, not a loop's.
 */
export const maxToolCalls = <
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  max: number
): AgentLoop<never, never, Tools> => {
  const bound = positiveInteger("AgentLoop.maxToolCalls", max)
  const decision = exhausted("tool-calls", "max tool calls")
  return make((state) => Effect.succeed(state.toolCallsTotal >= bound ? decision : Continue), {
    _tag: "MaxToolCalls",
    max: bound
  })
}

/**
 * Stop once the run has been going for `duration`.
 *
 * Checked after the turn: the turn in flight when the deadline passes
 * completes and commits, and no further one starts. That is the difference
 * from `Effect.timeout` on the prompt, which interrupts the run where it
 * stands and reports `status: "interrupted"`; both are legitimate, and this
 * is the one that ends cleanly. Reads `State.elapsed`, and inherits its
 * caveat: not replay-stable under `/durable`.
 *
 * Throws at construction on a non-positive or non-finite duration, as
 * `maxTurns` does on a bad count: a bound that could never bite is a
 * misconfiguration, not a policy.
 */
export const maxDuration = <
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  duration: Duration.Input
): AgentLoop<never, never, Tools> => {
  const bound = Duration.fromInputUnsafe(duration)
  const millis = Duration.toMillis(bound)
  if (!(millis > 0) || !Number.isFinite(millis)) {
    throw new RangeError(
      `AgentLoop.maxDuration: expected a positive finite duration, got ${String(duration)}`
    )
  }
  const decision = exhausted("duration", "max duration")
  return make(
    (state) => Effect.succeed(Duration.toMillis(state.elapsed) >= millis ? decision : Continue),
    { _tag: "MaxDuration", millis }
  )
}

/**
 * Turn an inner policy's cut-off into one final, tool-less turn.
 *
 * When `inner` says `Stop` while the model was still asking for tools, the
 * run was cut short rather than finished, and the decision becomes `Final`
 * with the same reason: one more turn with tools withheld, so the run ends
 * in an answer. A `Stop` on an idle model -- the model was done -- is left
 * alone, as is `Continue`. That is the "exhausted" case read straight off
 * the state, with nothing to keep track of.
 */
export const withFinalTurn = <
  E = never,
  R = never,
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  inner: AgentLoop<E, R, Tools>
): AgentLoop<E, R, Tools> =>
  make(
    (state) =>
      Effect.map(inner.decide(state), (decision) =>
        decision._tag === "Stop" && state.toolCalls.length > 0
          // The classification survives the conversion: a run that ran out of
          // turns and then took a final one still ran out of turns, and a
          // caller asking why should not get a different answer because the
          // agent was configured to answer politely on the way out.
          ? {
            _tag: "Final",
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            ...(decision.exhaustion === undefined ? {} : { exhaustion: decision.exhaustion })
          }
          : decision
      ),
    { _tag: "FinalTurn", inner: inner.description }
  )

/**
 * Exhaustion kinds for which one more model call does not contradict the bound
 * that was reached.
 *
 * A run that used its turn or tool-call allowance can still afford to speak. A
 * run that used its *time* cannot: a final turn is another provider call, and
 * spending it is the one thing `maxDuration` was there to prevent. The same
 * argument applies to a token or cost ceiling, which is why `Budget`'s bounds
 * are not on this list either.
 *
 * `plan-run-stream-start.md` §7.3 asks for exactly this judgement -- "do not
 * blindly make every ceiling final-answer capable" -- rather than a final turn
 * that fires wherever it can.
 */
const canAnswerAfter: ReadonlySet<Exhaustion> = new Set<Exhaustion>(["turns", "tool-calls"])

/**
 * One more tool-less turn when a bound cut the run short, where that does not
 * contradict the bound.
 *
 * `withFinalTurn` gives every cut-short stop a final turn, which is right when
 * a caller asks for it by name. This is the form `limits` uses, and it declines
 * for a ceiling whose whole point was to stop spending -- see
 * {@link canAnswerAfter}. A stop that exhausted nothing is left alone, as it is
 * there: the model was done, or a policy decided, and neither wants a turn it
 * did not ask for.
 */
export const withFinalAnswer = <
  E = never,
  R = never,
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  inner: AgentLoop<E, R, Tools>
): AgentLoop<E, R, Tools> =>
  make(
    (state) =>
      Effect.map(inner.decide(state), (decision) =>
        decision._tag === "Stop" &&
          decision.exhaustion !== undefined &&
          canAnswerAfter.has(decision.exhaustion) &&
          state.toolCalls.length > 0
          ? {
            _tag: "Final",
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            exhaustion: decision.exhaustion
          }
          : decision),
    { _tag: "FinalTurn", inner: inner.description }
  )

/**
 * Fail the run when a built-in ceiling ends it.
 *
 * The classification is what makes this expressible without parsing anything:
 * only a `Stop` that names an exhaustion fails, so an idle model, an output
 * tool's answer and a custom policy's own decision all still stop normally.
 *
 * Failing is not the default and should not be. A run that spent its whole
 * allowance and answered has done what it was asked; this is for the caller who
 * cannot use a partial result and would rather be told than remember to check
 * `Result.exhaustion`.
 */
export const failOnExhaustion = <
  E = never,
  R = never,
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  inner: AgentLoop<E, R, Tools>
): AgentLoop<E | Errors.AgentExhaustedError, R, Tools> =>
  make(
    (state) =>
      Effect.flatMap(inner.decide(state), (decision) =>
        decision._tag === "Stop" && decision.exhaustion !== undefined
          ? new Errors.AgentExhaustedError({
            exhaustion: decision.exhaustion,
            ...(decision.reason === undefined ? {} : { reason: decision.reason })
          })
          : Effect.succeed(decision)),
    // Described as `Custom` rather than widening the public `Description`
    // union for one combinator: it already has a shape for "a policy with a
    // name and an inner", which is exactly what this is.
    { _tag: "Custom", name: "failOnExhaustion", inner: inner.description }
  )

/** The bounds `limits` accepts. At least one must be given; see `limits`. */
export interface Limits {
  /** Stop after this many turns. */
  readonly maxTurns?: number | undefined
  /** Stop after this many tool calls, counted across the run. */
  readonly maxToolCalls?: number | undefined
  /** Stop once the run has been going this long. */
  readonly maxDuration?: Duration.Input | undefined
  /**
   * What happens when one of these bounds is reached.
   *
   * - `"stop"` (default): the run ends where it is. A bound is a spend
   *   ceiling, and anything else spends past it.
   * - `"final-answer"`: one more turn with tools withheld, so the run ends in
   *   an answer rather than mid-thought. That turn is one more model call and
   *   is *outside* the ordinary allowance -- `maxTurns: 5` may run six -- 
   *   because it is a terminal recovery action rather than part of the work.
   *   It is declined for `maxDuration`, where another call is the one thing
   *   the bound existed to prevent; see `withFinalAnswer`.
   * - `"fail"`: the run fails with `AgentExhaustedError` instead of returning
   *   a result whose `exhaustion` the caller has to remember to check.
   */
  readonly onExhaustion?: "stop" | "final-answer" | "fail" | undefined
}

/**
 * At least one bound, so `limits({})` and `limits({ onExhaustion: "fail" })` do
 * not compile: an unbounded `untilIdle` is what a caller reaching for
 * `limits` was trying not to write.
 */
type AtLeastOneBound =
  | { readonly maxTurns: number }
  | { readonly maxToolCalls: number }
  | { readonly maxDuration: Duration.Input }

/**
 * The usual bounded loop, in one object.
 *
 * `and(untilIdle(), ...)` over the bounds given -- exactly what `bounded` is
 * for `maxTurns` alone -- with `onExhaustion` wrapping the result in
 * `withFinalAnswer` or `failOnExhaustion`. It exists because the first policy most agents want is
 * "stop when the model is done, but never past these", and writing that as
 * three combinators invites leaving one off; it lowers into them rather than
 * adding a second way to say it.
 *
 * Tokens and cost are deliberately not here. `Budget.within` and
 * `Budget.cost` need a `Layer` for their scope -- per session or per
 * application -- and a pure loop cannot carry one; wrap this in them.
 */
/**
 * The error a `limits` loop can raise, which is none unless it was asked to
 * fail. Conditional rather than always-widened: a caller who did not choose
 * `"fail"` should not find an unreachable branch in their error channel.
 */
type ExhaustionError<Options> = Options extends { readonly onExhaustion: "fail" }
  ? Errors.AgentExhaustedError
  : never

export const limits = <
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>,
  const Options extends Limits = Limits
>(
  // `NoExcessProperties` rather than the bare constraint: a generic parameter
  // turns off excess-property checking, and an option that is quietly ignored
  // is worse than one that does not compile -- a caller would read the name
  // they wrote and believe it.
  options: NoExcessProperties<Limits, Options> & AtLeastOneBound
): AgentLoop<ExhaustionError<Options>, never, Tools> => {
  let loop: AgentLoop<never, never, Tools> = untilIdle<Tools>()
  if (options.maxTurns !== undefined) {
    loop = and(loop, maxTurns<Tools>(options.maxTurns)) as AgentLoop<never, never, Tools>
  }
  if (options.maxToolCalls !== undefined) {
    loop = and(loop, maxToolCalls<Tools>(options.maxToolCalls)) as AgentLoop<never, never, Tools>
  }
  if (options.maxDuration !== undefined) {
    loop = and(loop, maxDuration<Tools>(options.maxDuration)) as AgentLoop<never, never, Tools>
  }
  const bounded: AgentLoop<any, never, Tools> = options.onExhaustion === "final-answer"
    ? withFinalAnswer(loop)
    : options.onExhaustion === "fail"
    ? failOnExhaustion(loop)
    : loop
  return bounded
}

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
    // Folded from the first policy's own decision rather than a neutral
    // seed, so a single policy's reason survives the fold unchanged.
    Effect.flatMap(loops[0].decide(state), (first) =>
      Effect.reduce(loops.slice(1), () => first as Decision, (acc, loop) =>
        // A `Stop` is final and short-circuits; a `Final` keeps looking,
        // since a later policy may want to stop *now*. The first decision
        // at the winning rank keeps its reason.
        acc._tag === "Stop"
          ? Effect.succeed(acc)
          : Effect.map(loop.decide(state), (next) => (rank(next) > rank(acc) ? next : acc))
      )
    ),
    { _tag: "And", loops: flatten("And", loops.map((loop) => loop.description)) }
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
export const bounded = <
  Tools extends Record<string, Tool.Any> = Record<string, Tool.Any>
>(
  maxTurns_: number
): AgentLoop<never, never, Tools> =>
  and(untilIdle<Tools>(), maxTurns<Tools>(maxTurns_)) as AgentLoop<
    never,
    never,
    Tools
  >

/** Continue if any policy continues. */
export const or = <const Loops extends Policies>(
  ...loops: Loops
): AgentLoop<
  ErrorOf<Loops[number]>,
  ServicesOf<Loops[number]>,
  ToolsOf<Loops[number]>
> =>
  make((state) =>
    Effect.flatMap(loops[0].decide(state), (first) =>
      Effect.reduce(loops.slice(1), () => first as Decision, (acc, loop) =>
        // The mirror of `and`: a `Continue` wins outright; otherwise the
        // least stopping decision so far is kept, with its reason.
        acc._tag === "Continue"
          ? Effect.succeed(acc)
          : Effect.map(loop.decide(state), (next) => (rank(next) < rank(acc) ? next : acc))
      )
    ),
    { _tag: "Or", loops: flatten("Or", loops.map((loop) => loop.description)) }
  ) as AgentLoop<
    ErrorOf<Loops[number]>,
    ServicesOf<Loops[number]>,
    ToolsOf<Loops[number]>
  >
