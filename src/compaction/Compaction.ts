import { Effect, Option, Ref } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as ContextTransform from "../ContextTransform.js"

/**
 * Keeping a long conversation inside a context window, without losing it.
 *
 * This package adds nothing to the kernel. It is a `ContextTransform` — the
 * seam that already exists for exactly this — and that is the point: canonical
 * history is the session's complete record, and what the model sees is derived
 * from it. Compaction lives entirely on the derived side.
 *
 * So the transcript is never rewritten, truncated or summarised in place. What
 * changes is the *projection*:
 *
 * ```text
 * canonical transcript   the whole conversation, always
 *         │
 *         ▼
 * model projection       summary of the head
 *                        + the retained tail
 *                        + anything since
 * ```
 *
 * A destructive alternative — summarising history and discarding the originals
 * — would be simpler and irreversible. Nothing could later re-derive a longer
 * window, audit what the model was told, or change the summarisation strategy
 * for a conversation already in progress.
 */

/**
 * A summary of the conversation up to a point.
 *
 * `coveredThrough` counts messages of canonical history, so a checkpoint knows
 * precisely what it stands in for and what still has to be shown verbatim.
 */
export interface Checkpoint {
  readonly coveredThrough: number
  readonly summary: string
}

/** Decides when the projection needs compacting, and how much to keep whole. */
export interface Policy {
  /**
   * How many *foldable* messages must accumulate before compacting again.
   *
   * Foldable means between the last checkpoint and the retained tail — the
   * messages a new summary would actually absorb. Deliberately not "messages
   * beyond the checkpoint", which permanently includes the tail and therefore
   * never falls back below the threshold.
   */
  readonly threshold: number
  /**
   * How many recent messages are always shown verbatim.
   *
   * The tail is what the model reasons over turn to turn — the last tool
   * result, the last instruction. Summarising it would compact away precisely
   * the part that is still live.
   */
  readonly retain: number
}

/**
 * Compact once a conversation exceeds `threshold` messages, keeping the last
 * `retain` verbatim.
 */
export const whenLongerThan = (
  threshold: number,
  options?: { readonly retain?: number | undefined }
): Policy => ({ threshold, retain: options?.retain ?? 6 })

/**
 * Summarises a stretch of conversation.
 *
 * An ordinary Effect, so it may call a model, a cheaper model, a heuristic, or
 * a cache — and may fail and require services in its own right. The harness
 * does not care which.
 */
export type Summarise<E = never, R = never> = (options: {
  /** The messages being summarised. */
  readonly messages: Prompt.Prompt
  /** The previous summary, if this extends one. */
  readonly previous: Option.Option<string>
}) => Effect.Effect<string, E, R>

const summaryMessage = (summary: string): Prompt.Prompt =>
  Prompt.fromMessages([
    Prompt.systemMessage({
      content: `Summary of the earlier conversation:\n\n${summary}`
    })
  ])

/**
 * Build a compacting `ContextTransform`.
 *
 * Checkpoints are held per session, so one transform can serve many sessions —
 * an `Agent` is a value and may well be shared.
 *
 * ```ts
 * const agent = Agent.make({
 *   contextTransform: yield* Compaction.make({
 *     policy: Compaction.whenLongerThan(40, { retain: 10 }),
 *     summarise: ({ messages }) => summariseWithModel(messages)
 *   })
 * })
 * ```
 */
export const make = <E = never, R = never>(options: {
  readonly policy: Policy
  readonly summarise: Summarise<E, R>
}): Effect.Effect<ContextTransform.ContextTransform<E, R>> =>
  Effect.map(
    Ref.make(new Map<string, Checkpoint>()),
    (checkpoints): ContextTransform.ContextTransform<E, R> =>
      ContextTransform.make((context) =>
        Effect.gen(function* () {
          const messages = context.canonicalPrompt.content
          const existing: Option.Option<Checkpoint> = Option.fromNullishOr(
            (yield* Ref.get(checkpoints)).get(context.sessionId)
          )
          const covered = Option.match(existing, {
            onNone: () => 0,
            onSome: (checkpoint) => checkpoint.coveredThrough
          })

          // Everything except the retained tail is foldable. Computed from
          // canonical history, so it is the same on every turn that sees the
          // same history — including a replay.
          const boundary = Math.max(
            covered,
            messages.length - options.policy.retain
          )

          // The threshold measures the stretch that can actually be *folded*:
          // what lies between the checkpoint and the retained tail.
          //
          // Measuring against total history re-summarises every turn once a
          // conversation crosses the line. Measuring against everything past
          // the checkpoint looks right and is not, because that stretch
          // permanently includes the retained tail — it never falls back below
          // the threshold, so it also compacts every turn. Worse, when `retain`
          // is at least as large as it, the boundary lands on the checkpoint
          // and there is nothing between them at all: the summary is computed
          // from an empty range and overwrites a real one with a meaningless
          // summary, forever. That happened at the default `retain` of 6 for
          // any threshold below it.
          const foldable = boundary - covered
          const shouldCompact = foldable > options.policy.threshold

          if (!shouldCompact) {
            return Option.match(existing, {
              onNone: () => context.prompt,
              onSome: (checkpoint) =>
                Prompt.concat(
                  summaryMessage(checkpoint.summary),
                  Prompt.fromMessages(messages.slice(checkpoint.coveredThrough))
                )
            })
          }

          const summary = yield* options.summarise({
            messages: Prompt.fromMessages(messages.slice(covered, boundary)),
            previous: Option.map(existing, (checkpoint) => checkpoint.summary)
          })

          yield* Ref.update(checkpoints, (all) => {
            const next = new Map(all)
            next.set(context.sessionId, {
              coveredThrough: boundary,
              summary
            })
            return next
          })

          return Prompt.concat(
            summaryMessage(summary),
            Prompt.fromMessages(messages.slice(boundary))
          )
        })
      )
  )
