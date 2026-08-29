import { Effect, Option, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as AgentEvent from "../AgentEvent.js"
import * as ContextTransform from "../ContextTransform.js"
import { positiveInteger } from "../internal/positive.js"
import {
  alignOffToolResults,
  prepare,
  type Preparation
} from "./internal/prepare.js"

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
 *         |
 *         v
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
 *
 * `prefix` identifies the transcript prefix this summary describes.
 *
 * `coveredThrough` alone says a checkpoint *could* fit; it does not say it
 * belongs. Session ids are reused — a server evicts a conversation and hands
 * the same id to a new one — and a checkpoint covering ten messages looks
 * perfectly valid against an unrelated conversation that has reached twelve.
 * The new conversation then receives a summary of a conversation it never
 * had, which is worse than no summary at all: it is confidently wrong.
 */
export const Checkpoint = Schema.Struct({
  coveredThrough: Schema.Natural,
  summary: Schema.String,
  prefix: Schema.String,
  /** Absent for the legacy message-count policy. */
  tokensBefore: Schema.Option(Schema.Natural),
  /** Absent for the legacy message-count policy. */
  tokensAfter: Schema.Option(Schema.Natural),
  /** Usage reported by the summarizer, when it used a model and exposed it. */
  usage: Schema.Option(AgentEvent.ModelUsage)
})
export type Checkpoint = typeof Checkpoint.Type

/** Structured summary output without exposing a provider response. */
export const SummaryResult = Schema.Struct({
  text: Schema.String,
  usage: Schema.Option(AgentEvent.ModelUsage)
})
export type SummaryResult = typeof SummaryResult.Type

export interface MessagesPolicy {
  readonly _tag: "Messages"
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

export interface ContextBudget {
  readonly contextWindow: number
  readonly reserveTokens: number
  readonly keepRecentTokens: number
}

export type ResolveBudget<E = never, R = never> = (
  context: ContextTransform.Context
) => Effect.Effect<ContextBudget, E, R>

export type EstimateTokens<E = never, R = never> = (
  prompt: Prompt.Prompt
) => Effect.Effect<number, E, R>

export interface TokenPolicy<E = never, R = never> {
  readonly _tag: "Tokens"
  readonly budget: ContextBudget | ResolveBudget<E, R>
  readonly estimate: EstimateTokens<E, R>
}

export type Policy<E = never, R = never> = MessagesPolicy | TokenPolicy<E, R>

/** Compaction cannot make progress against the budget. */
export class CompactionCannotHelpError extends Schema.TaggedError<CompactionCannotHelpError>()(
  "CompactionCannotHelpError",
  {
    /**
     * Which of compaction's two dead ends this is.
     *
     * Separate from `reason`, which carries the measured numbers, because they
     * call for different responses and a caller should not have to read English
     * to tell them apart. `nothing-to-fold` says the canonical messages beyond
     * the checkpoint already fit `keepRecentTokens`, so no cut exists -- the
     * excess is the summary's or an earlier transform's, and lowering
     * `keepRecentTokens` cannot help. `summary-too-large` says a cut was made,
     * paid for, and still did not get under the line.
     *
     * Named `kind` rather than `cause`, which on an `Error` already means the
     * wrapped failure.
     */
    kind: Schema.Literals(["nothing-to-fold", "summary-too-large"]),
    reason: Schema.String
  }
) {
  override get message() {
    return `Compaction cannot help: ${this.reason}`
  }
}

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

/**
 * Preserve the original message-count policy as the cheap compatibility path.
 *
 * It counts messages and nothing else, so it has no budget check at all: a
 * conversation of large messages can project past any context window without
 * this policy noticing. That is the trade for needing no tokenizer. A caller
 * who needs the window respected wants `tokens`.
 */
export const whenLongerThan = (
  threshold: number,
  options?: { readonly retain?: number | undefined }
): MessagesPolicy => ({
  _tag: "Messages",
  threshold: positiveInteger("Compaction.whenLongerThan threshold", threshold),
  retain: positiveInteger(
    "Compaction.whenLongerThan retain",
    options?.retain ?? 6
  )
})

const validateBudget = (budget: ContextBudget): ContextBudget => {
  const contextWindow = positiveInteger(
    "Compaction.tokens contextWindow",
    budget.contextWindow
  )
  const reserveTokens = positiveInteger(
    "Compaction.tokens reserveTokens",
    budget.reserveTokens
  )
  const keepRecentTokens = positiveInteger(
    "Compaction.tokens keepRecentTokens",
    budget.keepRecentTokens
  )
  if (reserveTokens >= contextWindow) {
    throw new RangeError(
      "Compaction.tokens reserveTokens must be smaller than contextWindow"
    )
  }
  if (keepRecentTokens >= contextWindow - reserveTokens) {
    throw new RangeError(
      "Compaction.tokens keepRecentTokens must leave room for the summary"
    )
  }
  return { contextWindow, reserveTokens, keepRecentTokens }
}

/** Build a context-window policy without coupling an agent to a model. */
export const tokens = <BE = never, BR = never, EE = never, ER = never>(options: {
  readonly budget: ContextBudget | ResolveBudget<BE, BR>
  readonly estimate: EstimateTokens<EE, ER>
}): TokenPolicy<BE | EE, BR | ER> => ({
  _tag: "Tokens",
  budget: typeof options.budget === "function"
    ? options.budget
    : validateBudget(options.budget),
  estimate: options.estimate
})

const jsonLength = (value: unknown): number => {
  try {
    const rendered = JSON.stringify(value)
    return typeof rendered === "string" ? rendered.length : 0
  } catch {
    return String(value).length
  }
}

const approximate = (prompt: Prompt.Prompt): Effect.Effect<number> =>
  Effect.sync(() => {
    let characters = 0
    for (const message of prompt.content) {
      characters += message.role.length + 8
      if (message.role === "system") {
        characters += message.content.length
        continue
      }
      for (const part of message.content) {
        if (part.type === "file") {
          characters += part.mediaType.length + (part.fileName?.length ?? 0)
          characters += typeof part.data === "string"
            ? part.data.length
            : part.data instanceof Uint8Array
            ? Math.ceil(part.data.byteLength * 4 / 3)
            : part.data.href.length
        } else {
          characters += jsonLength(part)
        }
      }
    }
    return Math.ceil(characters / 4)
  })

/** Built-in estimators. Exact provider tokenizers remain ordinary functions. */
export const estimate: { readonly approximate: EstimateTokens } = {
  approximate
}

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
 *
 * Returns `string` or `SummaryResult` (with optional `usage`) so the compactor
 * can persist model usage without the summariser needing to know about
 * checkpoints.
 */
export type Summarise<E = never, R = never> = (options: {
  readonly messages: Prompt.Prompt
  readonly previous: Option.Option<string>
}) => Effect.Effect<string | SummaryResult, E, R>

const normalizeSummary = (result: string | SummaryResult): SummaryResult =>
  typeof result === "string"
    ? { text: result, usage: Option.none() }
    : result

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
      absorb(String(message.content.length))
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

const nonNegativeInteger = (operation: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${operation} must be a non-negative safe integer`)
  }
  return value
}

const renderUnknown = (value: unknown): string => {
  try {
    const rendered = JSON.stringify(value, undefined, 2)
    return typeof rendered === "string" ? rendered : String(value)
  } catch {
    return String(value)
  }
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n… [${value.length - limit} characters omitted]`

const renderPart = (part: Prompt.Part, maxToolResultChars: number): string => {
  switch (part.type) {
    case "text":
      return part.text
    case "reasoning":
      return `[Reasoning]\n${part.text}`
    case "file": {
      const name = part.fileName === undefined ? "unnamed" : part.fileName
      const source = typeof part.data === "string"
        ? `string data, ${part.data.length} characters`
        : part.data instanceof Uint8Array
        ? `${part.data.byteLength} bytes`
        : part.data.href
      return `[File: ${name}; ${part.mediaType}; ${source}]`
    }
    case "tool-call":
      return `[Tool call: ${part.name}; id=${part.id}]\n${renderUnknown(part.params)}`
    case "tool-result":
      return `[Tool result: ${part.name}; id=${part.id}; ${
        part.isFailure ? "failure" : "success"
      }]\n${truncate(renderUnknown(part.result), maxToolResultChars)}`
    case "tool-approval-request":
      return `[Tool approval requested: ${part.approvalId}; call=${part.toolCallId}]`
    case "tool-approval-response":
      return `[Tool approval ${part.approved ? "granted" : "denied"}: ${
        part.approvalId
      }]${part.reason === undefined ? "" : `\n${part.reason}`}`
  }
}

/**
 * Render a transcript as data for a summarizer rather than as a live model
 * conversation. Tool results are bounded because they routinely dominate the
 * context; file payloads are described rather than copied inline.
 */
export const serialize = (
  prompt: Prompt.Prompt,
  options?: { readonly maxToolResultChars?: number | undefined }
): string => {
  const maxToolResultChars = nonNegativeInteger(
    "Compaction.serialize maxToolResultChars",
    options?.maxToolResultChars ?? 2_000
  )
  const blocks: Array<string> = []
  for (const message of prompt.content) {
    if (message.role === "system") {
      blocks.push(`[System]\n${message.content}`)
      continue
    }
    const label = message.role === "user"
      ? "User"
      : message.role === "assistant"
      ? "Assistant"
      : "Tool"
    blocks.push(
      `[${label}]\n${message.content
        .map((part) => renderPart(part, maxToolResultChars))
        .join("\n\n")}`
    )
  }
  return blocks.join("\n\n")
}

const natural = (operation: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${operation} must return a non-negative safe integer`)
  }
  return value
}

const resolveBudget = <E, R>(
  budget: ContextBudget | ResolveBudget<E, R>,
  context: ContextTransform.Context
): Effect.Effect<ContextBudget, E, R> =>
  (typeof budget === "function" ? budget(context) : Effect.succeed(budget)).pipe(
    Effect.map(validateBudget)
  )

/**
 * Everything except the retained tail is foldable. Computed from canonical
 * history, so it is the same on every turn that sees the same history —
 * including a replay.
 *
 * Never opening on a tool result. `retain` counts messages, and a raw count
 * can land the boundary on a tool message whose call was just folded into the
 * summary; the projection then carries a `tool_result` with no `tool_use`,
 * which providers reject, so every turn fails until the window happens to
 * move. The boundary backs up to the assistant message that issued those
 * calls, keeping the exchange whole. It is deliberately not aligned to a
 * *user* turn: a long agentic run is one user message followed by many
 * assistant/tool exchanges, and a user-aligned boundary could never fold any
 * of it.
 */
const messagePreparation = (
  policy: MessagesPolicy,
  messages: ReadonlyArray<Prompt.Message>,
  existing: Option.Option<Checkpoint>,
  covered: number
): Option.Option<Preparation<Checkpoint>> =>
  prepare({
    messages,
    previous: existing,
    previouslyCovered: covered,
    rawBoundary: Math.max(covered, messages.length - policy.retain)
  }).pipe(
    // The threshold measures the stretch that can actually be *folded*: what
    // lies between the checkpoint and the retained tail.
    //
    // Measuring against total history re-summarises every turn once a
    // conversation crosses the line. Measuring against everything past the
    // checkpoint looks right and is not, because that stretch permanently
    // includes the retained tail — it never falls back below the threshold, so
    // it also compacts every turn. Worse, when `retain` is at least as large
    // as it, the boundary lands on the checkpoint and there is nothing between
    // them at all: the summary is computed from an empty range and overwrites a
    // real one with a meaningless summary, forever. That happened at the
    // default `retain` of 6 for any threshold below it.
    Option.filter(
      (candidate) =>
        candidate.messagesToSummarise.content.length > policy.threshold
    )
  )

/**
 * Token-budget preparation.
 *
 * Two measurements, deliberately of two different things.
 *
 * The *budget* question — are we over the line — is asked of `projectedBefore`,
 * which is the whole prompt, injections from earlier transforms included. That
 * is what the provider will be sent, so it is what "over budget" has to mean.
 *
 * The *cut* question — where does the retained tail begin — is asked only of
 * canonical history, because that is the only thing a cut can move. An earlier
 * transform's dynamic instruction or retrieved-memory block is not in the
 * transcript and cannot be folded into a summary, so measuring it here would
 * shrink the tail to pay for tokens no cut can recover. `keepRecentTokens` is
 * therefore a budget for canonical messages, and `reserveTokens` is where room
 * for injections belongs.
 *
 * The consequence is that a large enough injection puts the projection over
 * budget with nothing compaction can do about it. That is reported, not hidden
 * — as `nothing-to-fold`, whose `reason` names both numbers, so an operator is
 * not sent to lower `keepRecentTokens`, which in that case changes nothing.
 */
const tokenPreparation = <E, R>(
  policy: TokenPolicy<E, R>,
  budget: ContextBudget,
  messages: ReadonlyArray<Prompt.Message>,
  existing: Option.Option<Checkpoint>,
  covered: number,
  projectedBefore: Prompt.Prompt,
  cache: WeakMap<Prompt.Message, number>
): Effect.Effect<Option.Option<Preparation<Checkpoint>>, E | CompactionCannotHelpError, R> =>
  Effect.gen(function* () {
    const tokensBefore = natural(
      "Compaction token estimator",
      yield* policy.estimate(projectedBefore)
    )
    if (tokensBefore <= budget.contextWindow - budget.reserveTokens) {
      return Option.none()
    }

    // Canonical messages are stable objects carried through by identity — that
    // property is already load-bearing for `substitute`. A `WeakMap` keyed on
    // the message makes the walk nearly free after the first turn: the same
    // suffix is not re-tokenized every turn forever. Only the suffix near the
    // cut is measured within a turn, and the cache avoids repeating it across
    // turns.
    const estimateSingle = (msg: Prompt.Message): Effect.Effect<number, E, R> => {
      const cached = cache.get(msg)
      if (cached !== undefined) return Effect.succeed(cached)
      return Effect.flatMap(policy.estimate(Prompt.fromMessages([msg])), (n) => {
        const validated = natural("Compaction token estimator", n)
        cache.set(msg, validated)
        return Effect.succeed(validated)
      })
    }

    // Walk newest-first and always retain at least the newest message. Exact
    // provider tokenizers can be supplied; only the suffix near the cut is
    // measured, rather than repeatedly tokenizing the whole history.
    let rawBoundary = messages.length
    let retainedTokens = 0
    let retainedMessages = 0
    while (rawBoundary > covered) {
      const candidate = rawBoundary - 1
      const cost = yield* estimateSingle(messages[candidate]!)
      if (
        retainedMessages > 0 &&
        retainedTokens + cost > budget.keepRecentTokens
      ) {
        break
      }
      rawBoundary = candidate
      retainedTokens += cost
      retainedMessages += 1
    }

    const firstKept = alignOffToolResults(messages, covered, rawBoundary)
    if (firstKept <= covered) {
      // Everything past the checkpoint fits inside `keepRecentTokens`, so there
      // is no cut to make — and the projection is over budget anyway. The
      // residue is the summary, or messages an earlier transform injected,
      // which are in the projection and not in the transcript. Returning
      // `Option.none()` here would be indistinguishable from "nothing to
      // compact" (`tokensBefore` already under budget), and the caller would
      // hand back a projection still over budget, re-measuring the same suffix
      // every turn with no progress and no signal.
      //
      // The reason quotes what was measured rather than naming a culprit. It
      // used to assert that the retained tail exceeded `keepRecentTokens`,
      // which is the one thing this branch has just established is false: the
      // walk stops here precisely because the tail *fit*.
      return yield* new CompactionCannotHelpError({
        kind: "nothing-to-fold",
        reason: `nothing left to fold: the ${retainedMessages} canonical message(s) past the checkpoint cost ${retainedTokens}, within keepRecentTokens (${budget.keepRecentTokens}), yet the projection is ${tokensBefore} against a limit of ${
          budget.contextWindow - budget.reserveTokens
        }. The excess is not in canonical history — a summary or an earlier transform's injection — so no cut can recover it.`
      })
    }
    const exactRetained = natural(
      "Compaction token estimator",
      yield* policy.estimate(Prompt.fromMessages(messages.slice(firstKept)))
    )
    return prepare({
      messages,
      previous: existing,
      previouslyCovered: covered,
      rawBoundary: firstKept,
      tokensBefore,
      tokensRetained: exactRetained
    })
  })

type PersistenceError =
  | KeyValueStore.KeyValueStoreError
  | Schema.SchemaError

interface MakeOptions<PE, PR, SE, SR> {
  readonly policy: Policy<PE, PR>
  readonly summarise: Summarise<SE, SR>
  /** Bound for the default in-memory LRU. Not used with a persistent store. */
  readonly maxSessions?: number | undefined
}

/** Persistent checkpoints over Effect's existing schema-aware key/value store. */
export function make<PE = never, PR = never, SE = never, SR = never>(
  options: MakeOptions<PE, PR, SE, SR> & {
    readonly checkpointStore: KeyValueStore.KeyValueStore
    /** Prefix applied verbatim. Defaults to `effect-agent:compaction:`. */
    readonly checkpointPrefix?: string | undefined
    readonly maxSessions?: undefined
  }
): Effect.Effect<
  ContextTransform.ContextTransform<PE | SE | PersistenceError | CompactionCannotHelpError, PR | SR>
>
/** Default bounded in-memory checkpoints. */
export function make<PE = never, PR = never, SE = never, SR = never>(
  options: MakeOptions<PE, PR, SE, SR> & {
    readonly checkpointStore?: undefined
    readonly checkpointPrefix?: undefined
  }
): Effect.Effect<ContextTransform.ContextTransform<PE | SE | CompactionCannotHelpError, PR | SR>>
/** A value with an optional store has the honest union of both possibilities. */
export function make<PE = never, PR = never, SE = never, SR = never>(
  options: MakeOptions<PE, PR, SE, SR> & {
    readonly checkpointStore?: KeyValueStore.KeyValueStore | undefined
    readonly checkpointPrefix?: string | undefined
  }
): Effect.Effect<
  ContextTransform.ContextTransform<PE | SE | PersistenceError | CompactionCannotHelpError, PR | SR>
>
/**
 * Build a compacting `ContextTransform`.
 *
 * Checkpoints are held per session, so one transform can serve many sessions —
 * an `Agent` is a value and may well be shared. Checkpoints are isolated per
 * session.
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
export function make<PE = never, PR = never, SE = never, SR = never>(
  options: MakeOptions<PE, PR, SE, SR> & {
    readonly checkpointStore?: KeyValueStore.KeyValueStore | undefined
    readonly checkpointPrefix?: string | undefined
  }
): Effect.Effect<
  ContextTransform.ContextTransform<PE | SE | PersistenceError | CompactionCannotHelpError, PR | SR>
> {
  return Effect.gen(function* () {
    const maxSessions = yield* Effect.sync(() => {
      if (
        options.checkpointStore !== undefined &&
        options.maxSessions !== undefined
      ) {
        throw new RangeError(
          "Compaction.make maxSessions applies only to the in-memory checkpoint cache"
        )
      }
      return positiveInteger(
        "Compaction.make maxSessions",
        options.maxSessions ?? defaultMaxSessions
      )
    })
    const checkpoints = yield* Ref.make(new Map<string, Checkpoint>())
    // Canonical messages are stable by identity, so a per-transform `WeakMap`
    // avoids re-tokenizing the same suffix every turn. The cache is per
    // `Compaction.make` instance (not per session) because the policy's
    // `estimate` is per instance, and the messages are the same objects across
    // sessions' histories only when they are the same canonical objects.
    const singleMessageCache = new WeakMap<Prompt.Message, number>()
    const persisted = options.checkpointStore === undefined
      ? undefined
      : KeyValueStore.toSchemaStore(
          KeyValueStore.prefix(
            options.checkpointStore,
            options.checkpointPrefix ?? "effect-agent:compaction:"
          ),
          Checkpoint
        )

    const load = (sessionId: string) =>
      persisted === undefined
        ? Ref.get(checkpoints).pipe(
            Effect.map((all) => Option.fromUndefinedOr(all.get(sessionId)))
          )
        : persisted.get(sessionId)

    const save = (sessionId: string, checkpoint: Checkpoint) =>
      persisted === undefined
        ? Ref.update(checkpoints, (all) => {
            const next = new Map(all)
            // Delete before set, so an updated checkpoint moves to the end and
            // eviction drops genuinely stale sessions rather than busy ones.
            next.delete(sessionId)
            next.set(sessionId, checkpoint)
            while (next.size > maxSessions) {
              const oldest = next.keys().next().value
              if (oldest === undefined) break
              next.delete(oldest)
            }
            return next
          })
        : persisted.set(sessionId, checkpoint)

    return ContextTransform.make((context) =>
      Effect.gen(function* () {
        const messages = context.canonicalPrompt.content
        const stored = yield* load(context.sessionId)
        // A checkpoint is used only if it still describes *this* transcript.
        //
        // Session ids are reused: a snapshot is restored, a durable submission
        // replays, a server hands the same id to a new conversation after
        // evicting the old one. The transform outlives all of that.
        //
        // Length is the necessary condition — a checkpoint claiming more
        // messages than exist sliced past the end of history and produced a
        // prompt of nothing but a summary, every actual message dropped. The
        // fingerprint is the sufficient one: an unrelated conversation that
        // happens to be longer would otherwise look like a perfect match and
        // receive a summary it never earned.
        const existing: Option.Option<Checkpoint> =
          Option.isNone(stored) ||
            stored.value.coveredThrough > messages.length ||
            stored.value.prefix !==
              fingerprint(messages.slice(0, stored.value.coveredThrough))
            ? Option.none()
            : stored
        const covered = Option.match(existing, {
          onNone: () => 0,
          onSome: (checkpoint) => checkpoint.coveredThrough
        })
        const projectedBefore = Option.match(existing, {
          onNone: () => context.prompt,
          onSome: (checkpoint) =>
            substitute(context.prompt, messages, [
              summaryMessage(checkpoint.summary),
              ...messages.slice(checkpoint.coveredThrough)
            ])
        })

        // Resolved once per turn, not once per question asked of it. A
        // `ResolveBudget` is an ordinary Effect -- it may read configuration or
        // ask a provider -- so resolving it a second time after summarising
        // both paid twice and let the check at the end be made against a budget
        // that is not the one the cut was chosen against.
        const policy = options.policy
        let budget = Option.none<ContextBudget>()
        let preparation: Option.Option<Preparation<Checkpoint>>
        if (policy._tag === "Messages") {
          preparation = messagePreparation(policy, messages, existing, covered)
        } else {
          const resolved = yield* resolveBudget(policy.budget, context)
          budget = Option.some(resolved)
          preparation = yield* tokenPreparation(
            policy,
            resolved,
            messages,
            existing,
            covered,
            projectedBefore,
            singleMessageCache
          )
        }

        if (Option.isNone(preparation)) {
          return projectedBefore
        }

        const summary = normalizeSummary(yield* options.summarise({
          messages: preparation.value.messagesToSummarise,
          previous: Option.map(
            preparation.value.previous,
            (checkpoint) => checkpoint.summary
          )
        }))
        const projected = substitute(context.prompt, messages, [
          summaryMessage(summary.text),
          ...preparation.value.retained.content
        ])
        const tokensAfter = policy._tag === "Tokens"
          ? Option.some(
              natural(
                "Compaction token estimator",
                yield* policy.estimate(projected)
              )
            )
          : Option.none<number>()
        // A summariser that returns something large can leave the next turn still
        // over budget, so it would re-summarise and pay another model call every
        // turn. `validateBudget` only checks that `keepRecentTokens` leaves room
        // for *some* summary, not that this summary actually fit. Check the
        // measured `tokensAfter` against the budget and surface when compaction
        // did not get under the line, so the caller can observe that the summary
        // was too large rather than silently paying forever.
        if (Option.isSome(budget) && Option.isSome(tokensAfter)) {
          const limit = budget.value.contextWindow - budget.value.reserveTokens
          if (tokensAfter.value > limit) {
            return yield* new CompactionCannotHelpError({
              kind: "summary-too-large",
              reason: `summary still over budget: tokensAfter ${tokensAfter.value} > ${limit}`
            })
          }
        }

        const checkpoint: Checkpoint = {
          coveredThrough: preparation.value.coveredThrough,
          summary: summary.text,
          prefix: fingerprint(
            messages.slice(0, preparation.value.coveredThrough)
          ),
          tokensBefore: preparation.value.tokensBefore,
          tokensAfter,
          usage: summary.usage
        }

        yield* save(context.sessionId, checkpoint)
        return projected
      })
    )
  })
}
