import { Predicate } from "effect"
import { Response } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"

/**
 * Folds a provider's stream back into a complete response.
 *
 * Streaming and batch generation must be interchangeable everywhere downstream
 * of the model call: the same turn ordering, the same atomic commit, the same
 * canonical history. The way to get that is to keep exactly one shape flowing
 * through the harness — `GenerateTextResponse` — and treat streaming purely as
 * a different way of *arriving* at it.
 *
 * So this is where the two paths converge. A provider emits `text-start`,
 * `text-delta`, `text-end` (and the reasoning equivalents); the harness folds
 * them into the same `text` and `reasoning` parts a batch call would have
 * returned, and passes everything else through untouched.
 *
 * Nothing here is committed. The caller decides what to do with the result,
 * which is what keeps a partial stream out of canonical history when a turn is
 * interrupted part-way.
 *
 * **Provider metadata is folded, not dropped.** A chunk's start, deltas and
 * end may each carry `metadata`, and what they carry can be load-bearing:
 * Anthropic sends a thinking block's signature as an *empty* `reasoning-delta`
 * whose only content is its metadata, and the provider refuses a later
 * request that replays the thinking without it. The assembled part's
 * metadata is the start's, with each delta's and the end's merged in by
 * provider key -- the rule Effect AI's own `Prompt.fromResponseParts` uses
 * for the same fold, so a streamed turn and a batch turn record the same
 * message.
 */

type Metadata = Response.ProviderMetadata

/**
 * Merge provider metadata the way `Prompt.fromResponseParts` does: per
 * provider key, a later object is shallow-merged over an earlier one, and
 * anything else replaces it. (Effect's own helper is module-private.)
 */
const mergeMetadata = (left: Metadata, right: Metadata | undefined): Metadata => {
  if (right === undefined) return left
  const merged: Record<string, Metadata[string]> = { ...left }
  for (const [provider, value] of Object.entries(right)) {
    const previous = merged[provider]
    merged[provider] = Predicate.isObject(previous) && Predicate.isObject(value)
      ? Object.assign({}, previous, value)
      : value
  }
  return merged
}

/** A text or reasoning chunk still being streamed. */
interface Open {
  readonly kind: "text" | "reasoning"
  readonly text: string
  readonly metadata: Metadata
}

/** The part an open chunk becomes once it closes. */
const closedPart = <Tools extends Record<string, Tool.Any>>(chunk: Open): Response.Part<Tools, true> =>
  chunk.kind === "text"
    ? Response.makePart("text", { text: chunk.text, metadata: chunk.metadata })
    : Response.makePart("reasoning", { text: chunk.text, metadata: chunk.metadata })

/** A chunk of output as the harness reports it, normalised across providers. */
export interface Delta {
  readonly kind: "text" | "reasoning"
  readonly delta: string
}

/**
 * A fragment of a tool call's arguments, as the provider produced it.
 *
 * Observational only: the harness never executes, approves or records a
 * partial call. The assembled `tool-call` part that follows is authoritative,
 * and this fragment is the same JSON text, earlier. `name` is absent when the
 * provider sent a delta for an argument stream it never announced.
 */
export interface ToolCallDelta {
  readonly id: string
  readonly name: string | undefined
  readonly delta: string
}

/**
 * Accumulated state, threaded through the fold.
 *
 * `parts` is what will become the response. `open` holds the text and
 * reasoning chunks still being streamed, keyed by the provider's id — several
 * may be in flight at once, which is why this is a map rather than a single
 * buffer.
 */
export interface State<Tools extends Record<string, Tool.Any>> {
  readonly parts: ReadonlyArray<Response.Part<Tools, true>>
  readonly open: ReadonlyMap<string, Open>
  /** Argument streams announced and not yet ended, by the provider's id, to their tool name. */
  readonly openToolCalls: ReadonlyMap<string, string>
}

export const empty = <
  Tools extends Record<string, Tool.Any>
>(): State<Tools> => ({ parts: [], open: new Map(), openToolCalls: new Map() })

const withOpenToolCall = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>,
  id: string,
  name: string | undefined
): State<Tools> => {
  const openToolCalls = new Map(state.openToolCalls)
  if (name === undefined) {
    openToolCalls.delete(id)
  } else {
    openToolCalls.set(id, name)
  }
  return { ...state, openToolCalls }
}

const withOpen = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>,
  id: string,
  value: Open | undefined
): State<Tools> => {
  const open = new Map(state.open)
  if (value === undefined) {
    open.delete(id)
  } else {
    open.set(id, value)
  }
  return { ...state, open }
}

/**
 * The result of taking one stream part.
 *
 * `Failed` exists because a provider may report a failure *inside* the stream
 * rather than by failing it. Folding that into the response would commit a
 * turn the provider had just disowned, so it is surfaced instead and the
 * caller fails the turn — which is what a batch call would have done.
 */
export type Step<Tools extends Record<string, Tool.Any>> =
  | {
      readonly _tag: "Continue"
      readonly state: State<Tools>
      readonly delta: Delta | undefined
      readonly toolCallDelta: ToolCallDelta | undefined
    }
  | { readonly _tag: "Failed"; readonly error: unknown }

const cont = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>,
  delta?: Delta | undefined,
  toolCallDelta?: ToolCallDelta | undefined
): Step<Tools> => ({ _tag: "Continue", state, delta, toolCallDelta })

/**
 * Take one stream part.
 *
 * Parts that carry output produce a delta; tool call assembly, metadata and
 * finish parts are structural and produce none — they are not output a
 * consumer would render.
 */
export const step = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>,
  part: Response.StreamPart<Tools, true>
): Step<Tools> => {
  switch (part.type) {
    case "text-start":
      return cont(withOpen(state, part.id, { kind: "text", text: "", metadata: mergeMetadata({}, part.metadata) }))
    case "reasoning-start":
      return cont(withOpen(state, part.id, { kind: "reasoning", text: "", metadata: mergeMetadata({}, part.metadata) }))
    case "text-delta":
    case "reasoning-delta": {
      const kind = part.type === "text-delta" ? "text" : "reasoning"
      const current = state.open.get(part.id)
      // A delta with no matching start still counts. Providers are not
      // uniformly careful about emitting one, and dropping output because a
      // structural part was missing would be the worse failure.
      const text = (current?.text ?? "") + part.delta
      // An empty delta may exist only to carry metadata (Anthropic's
      // signature), so its metadata is folded like any other's.
      const metadata = mergeMetadata(current?.metadata ?? {}, part.metadata)
      return cont(withOpen(state, part.id, { kind, text, metadata }), {
        kind,
        delta: part.delta
      })
    }
    case "text-end":
    case "reasoning-end": {
      const current = state.open.get(part.id)
      if (current === undefined) return cont(state)
      const closed = withOpen(state, part.id, undefined)
      const finished = closedPart<Tools>({ ...current, metadata: mergeMetadata(current.metadata, part.metadata) })
      return cont({ ...closed, parts: [...closed.parts, finished] })
    }
    // Tool parameters arrive incrementally and then again as a complete
    // `tool-call`. The increments contribute nothing to the response -- the
    // harness executes the assembled call, never a partial one -- but they
    // are reported, so a consumer can show a call forming. The open map only
    // carries the name from the start part to its deltas.
    case "tool-params-start":
      return cont(withOpenToolCall(state, part.id, part.name))
    case "tool-params-delta":
      return cont(state, undefined, {
        id: part.id,
        name: state.openToolCalls.get(part.id),
        delta: part.delta
      })
    case "tool-params-end":
      return cont(withOpenToolCall(state, part.id, undefined))
    case "error":
      return { _tag: "Failed", error: part.error }
    case "finish":
      // A provider saying it has finished closes anything still open, so the
      // flushed chunks are appended *before* the finish part. A batch response
      // always ends with finish, and a reconstructed one should be
      // indistinguishable -- otherwise anything downstream that reasonably
      // treats finish as terminal sees parts arrive after it.
      return cont({
        ...state,
        parts: [...state.parts, ...flushOpen(state), part],
        open: new Map()
      })
    default:
      // Everything a batch response would have carried -- tool calls, files,
      // sources, metadata, finish -- passes through as it arrives.
      return cont({ ...state, parts: [...state.parts, part] })
  }
}

/** Chunks still open, as the parts they would have become. */
const flushOpen = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>
): ReadonlyArray<Response.Part<Tools, true>> =>
  Array.from(state.open.values()).map((chunk) => closedPart<Tools>(chunk))

/**
 * Close the accumulation.
 *
 * Chunks still open are flushed rather than dropped. A provider that ends its
 * stream without a closing part has still produced that text, and discarding
 * it would lose output the model actually generated.
 */
export const finish = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>
): ReadonlyArray<Response.Part<Tools, true>> => {
  // The fallback for a stream that ended with no finish part at all; a stream
  // that did finish has already flushed.
  if (state.open.size === 0) return state.parts
  return [...state.parts, ...flushOpen(state)]
}

/** An error part carries an unconstrained payload; render it for the message. */
export const describeStreamError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const described = error as { message?: unknown }
    if (typeof described.message === "string" && described.message.length > 0) {
      return described.message
    }
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

/**
 * Run the model call as a stream, folding it back into the response the rest
 * of the turn expects.
 *
 * Everything after this point is identical to the batch path — the same tool
 * execution, the same single atomic commit. Streaming changes when output is
 * *observed*, never what is recorded.
 *
 * `MessageInterrupted` is emitted from a finalizer rather than after the fold,
 * because on interruption the continuation never runs. A consumer that had a
 * message open needs it closed, and the turn's own interruption handling takes
 * care of history: nothing partial is committed.
 */
