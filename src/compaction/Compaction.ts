import { Effect, Option, Ref } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as ContextTransform from "../ContextTransform.js"
import { positiveInteger } from "../internal/positive.js"

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
  /**
   * Identifies the transcript prefix this summary describes.
   *
   * `coveredThrough` alone says a checkpoint *could* fit; it does not say it
   * belongs. Session ids are reused — a server evicts a conversation and hands
   * the same id to a new one — and a checkpoint covering ten messages looks
   * perfectly valid against an unrelated conversation that has reached twelve.
   * The new conversation then receives a summary of a conversation it never
   * had, which is worse than no summary at all: it is confidently wrong.
   */
  readonly prefix: string
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
/**
 * How many sessions' checkpoints to remember.
 *
 * An `Agent` is a value, usually built once and shared, so a transform outlives
 * every session that uses it. Without a bound, each session that ever compacts
 * leaves a checkpoint behind forever.
 *
 * Evicting one is safe: a checkpoint is a cache of work already done, and
 * losing it costs a re-summarisation, not correctness. That is what makes a
 * bound the right answer here rather than a leak with a nicer name.
 */
const defaultMaxSessions = 1024

export const whenLongerThan = (
  threshold: number,
  options?: { readonly retain?: number | undefined }
): Policy => ({
  threshold: positiveInteger("Compaction.whenLongerThan threshold", threshold),
  retain: positiveInteger(
    "Compaction.whenLongerThan retain",
    options?.retain ?? 6
  )
})

/**
 * Summarises a stretch of conversation.
 *
 * An ordinary Effect, so it may call a model, a cheaper model, a heuristic, or
 * a cache — and may fail and require services in its own right. The harness
 * does not care which.
 *
 * That it is ordinary is what makes it work under `/durable` without this
 * module knowing anything about workflows. A transform's requirements reach
 * `AgentSession.make`, which the workflow body satisfies, so a durable
 * deployment wraps its summariser in an `Activity` and the summary is
 * journalled with everything else:
 *
 * ```ts
 * summarise: ({ messages }) =>
 *   Activity.make({
 *     name: "summarise",
 *     success: Schema.String,
 *     execute: summariseWithModel(messages)
 *   })
 * ```
 *
 * Worth doing rather than optional. Checkpoints live in memory, so a process
 * loss starts them empty and the next turn summarises again — which for a real
 * summariser means paying for a model call that was already made.
 */
export type Summarise<E = never, R = never> = (options: {
  /** The messages being summarised. */
  readonly messages: Prompt.Prompt
  /** The previous summary, if this extends one. */
  readonly previous: Option.Option<string>
}) => Effect.Effect<string, E, R>

/**
 * A cheap fingerprint of a transcript prefix.
 *
 * Not cryptographic, and it does not need to be. The question is only "is this
 * the same prefix I summarised?", and the alternative being guarded against is
 * an unrelated conversation, not a forged one. A 32-bit FNV-1a over a stable
 * rendering answers that.
 *
 * Rendering is defensive: message content can hold decoded values a tool
 * produced — a `Date`, a class instance — and a fingerprint that threw on one
 * would fail the whole turn. Falling back to shape alone is weaker but still
 * catches the case that matters.
 */
const fingerprint = (messages: ReadonlyArray<Prompt.Message>): string => {
  let hash = 0x811c9dc5
  const absorb = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  for (const message of messages) {
    absorb(message.role)
    try {
      absorb(JSON.stringify(message.content))
    } catch {
      absorb(String(message.content?.length ?? 0))
    }
  }
  return hash.toString(16)
}

const summaryMessage = (summary: string) =>
  Prompt.systemMessage({
    content: `Summary of the earlier conversation:\n\n${summary}`
  })

/**
 * Replace the conversation inside the derived prompt, keeping everything else.
 *
 * Compaction has to reason about *canonical* history: its checkpoints are
 * positions in the transcript, and those only mean anything if they count the
 * same messages every turn. But a transform composed before this one has
 * already contributed to `prompt` — dynamic instructions, retrieved memory —
 * and rebuilding from canonical history alone threw that away. Silently: the
 * conversation still looked right, and the injected system message simply
 * stopped appearing once the conversation grew long enough to compact.
 *
 * So the canonical messages are substituted in place, at the position of the
 * first of them, and anything an earlier transform added stays where it was
 * put. Identity comparison is what makes that work: `Prompt.concat` carries
 * message objects through unchanged, so a message that is not in canonical
 * history came from somewhere else.
 */
const substitute = (
  prompt: Prompt.Prompt,
  canonical: ReadonlyArray<Prompt.Message>,
  replacement: ReadonlyArray<Prompt.Message>
): Prompt.Prompt => {
  const isCanonical = new Set<Prompt.Message>(canonical)
  const out: Array<Prompt.Message> = []
  let placed = false
  for (const message of prompt.content) {
    if (isCanonical.has(message)) {
      if (!placed) {
        out.push(...replacement)
        placed = true
      }
      continue
    }
    out.push(message)
  }
  if (!placed) out.push(...replacement)
  return Prompt.fromMessages(out)
}

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
  /**
   * How many sessions' checkpoints to keep. Defaults to 1024.
   *
   * The oldest is dropped past the limit, and that session simply summarises
   * again next time it compacts.
   */
  readonly maxSessions?: number | undefined
}): Effect.Effect<ContextTransform.ContextTransform<E, R>> =>
  Effect.map(
    Effect.sync(() =>
      positiveInteger(
        "Compaction.make maxSessions",
        options.maxSessions ?? defaultMaxSessions
      )
    ).pipe(Effect.andThen(Ref.make(new Map<string, Checkpoint>()))),
    (checkpoints): ContextTransform.ContextTransform<E, R> =>
      ContextTransform.make((context) =>
        Effect.gen(function* () {
          const messages = context.canonicalPrompt.content
          const stored = (yield* Ref.get(checkpoints)).get(context.sessionId)

          // A checkpoint is used only if it still describes *this* transcript.
          //
          // Session ids are reused: a snapshot is restored, a durable
          // submission replays, a server hands the same id to a new
          // conversation after evicting the old one. The transform outlives all
          // of that.
          //
          // Length is the necessary condition — a checkpoint claiming more
          // messages than exist sliced past the end of history and produced a
          // prompt of nothing but a summary, every actual message dropped. The
          // fingerprint is the sufficient one: an unrelated conversation that
          // happens to be longer would otherwise look like a perfect match and
          // receive a summary it never earned.
          const existing: Option.Option<Checkpoint> =
            stored === undefined ||
              stored.coveredThrough > messages.length ||
              stored.prefix !==
                fingerprint(messages.slice(0, stored.coveredThrough))
              ? Option.none()
              : Option.some(stored)
          const covered = Option.match(existing, {
            onNone: () => 0,
            onSome: (checkpoint) => checkpoint.coveredThrough
          })

          // Everything except the retained tail is foldable. Computed from
          // canonical history, so it is the same on every turn that sees the
          // same history — including a replay.
          //
          // Aligned to a user turn. `retain` counts messages, and a raw count
          // can land the boundary on a tool result whose call was just folded
          // into the summary — or on an assistant message mid-exchange. The
          // projection then carries a `tool_result` with no `tool_use`, which
          // providers reject, so every turn fails until the window happens to
          // move. The tail therefore starts at the nearest user message at or
          // before the raw boundary: `retain` is a minimum, never a cut
          // through an exchange. If no user turn lies between the checkpoint
          // and the raw boundary, nothing is foldable yet.
          const boundary = alignToUserTurn(
            messages,
            covered,
            Math.max(covered, messages.length - options.policy.retain)
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
                substitute(context.prompt, messages, [
                  summaryMessage(checkpoint.summary),
                  ...messages.slice(checkpoint.coveredThrough)
                ])
            })
          }

          const summary = yield* options.summarise({
            messages: Prompt.fromMessages(messages.slice(covered, boundary)),
            previous: Option.map(existing, (checkpoint) => checkpoint.summary)
          })

          yield* Ref.update(checkpoints, (all) => {
            const next = new Map(all)
            // Delete before set, so an updated checkpoint moves to the end and
            // eviction drops genuinely stale sessions rather than busy ones.
            next.delete(context.sessionId)
            next.set(context.sessionId, {
              coveredThrough: boundary,
              summary,
              prefix: fingerprint(messages.slice(0, boundary))
            })
            const limit = options.maxSessions ?? defaultMaxSessions
            while (next.size > limit) {
              const oldest = next.keys().next().value
              if (oldest === undefined) break
              next.delete(oldest)
            }
            return next
          })

          return substitute(context.prompt, messages, [
            summaryMessage(summary),
            ...messages.slice(boundary)
          ])
        })
      )
  )

/**
 * The nearest index at or before `raw` (and not before `floor`) that begins
 * a user turn, so a retained tail never opens mid-exchange.
 */
const alignToUserTurn = (
  messages: ReadonlyArray<Prompt.Message>,
  floor: number,
  raw: number
): number => {
  let index = raw
  while (index > floor && messages[index]?.role !== "user") {
    index = index - 1
  }
  return index
}
