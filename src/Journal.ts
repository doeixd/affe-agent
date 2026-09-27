import { Context, Effect } from "effect"
import type { Schema, Stream } from "effect"
import type { LanguageModel, Response } from "effect/unstable/ai"
import * as Namespace from "./internal/namespace.js"

/**
 * Where a run records the outcome of something it must not do twice.
 *
 * A durable run is replayed after a crash, and anything nondeterministic it
 * did on the way, such as a model call, a lookup or a clock read that changed
 * a decision, happens again unless its first outcome was recorded. `step`
 * names such a place. Locally it is the identity: the effect runs, and nothing
 * is recorded. Under `/durable` the outcome is journalled as a workflow
 * `Activity`, and a replay returns the recorded value instead of running the
 * effect again.
 *
 * The kernel still does not know durability exists. It knows only where its
 * nondeterminism is (`PLAN.md` §30.1, amended 2026-09-26). The seam is `step`
 * and two commit points, `modelCall` and `modelStream`, on purpose.
 *
 * **Slices 1 and 2 (item 129).** `step` is available to anything that runs
 * inside a submission: a context transform, a hook, an `Effect`-valued input
 * renderer. `modelCall` and `modelStream` are the kernel's, for a model call
 * under an `ExecutionPlan`. Other model calls, tools, permission decisions and the
 * rest are still made durable by `/durable`'s substitutions.
 *
 * ```ts
 * const recall = ContextTransform.make((context) =>
 *   Journal.step("recall", Schema.Array(Schema.String), searchMemory(context)).pipe(
 *     Effect.map((notes) => withNotes(context.prompt, notes))
 *   )
 * )
 * ```
 */
export interface Service {
  /**
   * Run `effect`, or return what it returned the first time this step ran.
   *
   * - **`name`** identifies the step within a submission. Calling the same
   *   name again is the next occurrence of it (`recall`, `recall`, ... are
   *   occurrences 1, 2, ...), so a replay that makes the same calls in the
   *   same order reads the same values. Use distinct names for distinct
   *   questions, and for steps that run concurrently: two concurrent steps
   *   under one name take their occurrences in whatever order the scheduler
   *   picks, and a replay may pick the other. Parallel tool calls are the
   *   usual case, so name a step there by its call.
   * - **`schema`** encodes the value for the journal. It must round-trip.
   * - **`effect`** cannot fail. Model a failure as a value (a `Result`, an
   *   `Option`) so that the replay receives the same failure the first run
   *   did. A typed error could not be rebuilt from a journal without its
   *   schema, and a durable run would then fail differently from the one it
   *   replays. A defect stays a defect: it is recorded, and a replay dies too.
   *
   * A step interrupted before its value is recorded may run again, as a tool
   * marked `Tool.Idempotent` may. Nothing is recorded for it until it
   * completes.
   *
   * Inside a durable tool call, the call's own activity already records the
   * call's outcome, so a replay never re-enters the handler. A step there
   * matters only to a `Tool.Idempotent` tool, whose handler may run again.
   */
  readonly step: <A, I, R>(
    name: string,
    schema: Schema.Codec<A, I>,
    effect: Effect.Effect<A, never, R>
  ) => Effect.Effect<A, never, R>
  /**
   * A commit point: a model call the kernel makes under an `ExecutionPlan`,
   * the whole fallback ladder at once (item 129, slice 2).
   *
   * Not a `step`, for two reasons. The response's schema depends on the
   * turn's tools, which only the durable model wrapper knows how to encode.
   * And a model call can fail, where a step cannot: a provider failure is
   * recorded as a value and raised again on replay, as `DurableModel`
   * already does for every other model call.
   *
   * Why only under a plan: without one, `/durable` journals the call by
   * substituting the `LanguageModel`. A plan's steps provide their own
   * `LanguageModel`, which shadows that substitution, so the kernel commits
   * the ladder's outcome here instead. Locally it is the identity.
   */
  readonly modelCall: <A extends LanguageModel.GenerateTextResponse<any, any>, E, R>(
    call: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
  /**
   * The same commit point for a streamed call under a plan (item 129, slice
   * 2). The parts reach the caller as they arrive on a first run, while the
   * journal records only the completed response. A replay re-expresses that
   * response as the parts that would have produced it. Locally it is the
   * identity.
   */
  readonly modelStream: <A extends Response.StreamPart<any, any>, E, R>(
    stream: Stream.Stream<A, E, R>
  ) => Stream.Stream<A, E, R>
}

/** The identity journal: every step runs, and nothing is recorded. */
export const direct: Service = {
  step: (_name, _schema, effect) => effect,
  modelCall: (call) => call,
  modelStream: (stream) => stream
}

/**
 * The journal the current submission records into. The default is `direct`,
 * so code calling `step` needs no setup in a run that is not durable.
 */
export const Journal = Context.Reference<Service>(Namespace.tag("Journal"), {
  defaultValue: () => direct
})

/** `step` on the current journal. See `Service.step`. */
export const step = <A, I, R>(
  name: string,
  schema: Schema.Codec<A, I>,
  effect: Effect.Effect<A, never, R>
): Effect.Effect<A, never, R> => Effect.flatMap(Journal, (journal) => journal.step(name, schema, effect))
