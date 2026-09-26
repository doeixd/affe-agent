import { Context, Effect } from "effect"
import type { Schema } from "effect"
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
 * nondeterminism is (`PLAN.md` §30.1, amended 2026-09-26). The seam is this
 * one operation, on purpose.
 *
 * **Slice 1 (item 129).** Available to anything that runs inside a submission:
 * a context transform, a hook, an `Effect`-valued input renderer. The model
 * call, tools, permission decisions and the rest are still made durable by
 * `/durable`'s substitutions. Moving them onto `step` is the later slices'.
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
   *   questions.
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
   */
  readonly step: <A, I, R>(
    name: string,
    schema: Schema.Codec<A, I>,
    effect: Effect.Effect<A, never, R>
  ) => Effect.Effect<A, never, R>
}

/** The identity journal: every step runs, and nothing is recorded. */
export const direct: Service = { step: (_name, _schema, effect) => effect }

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
