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
 */

/** A chunk of output as the harness reports it, normalised across providers. */
export interface Delta {
  readonly kind: "text" | "reasoning"
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
  readonly open: ReadonlyMap<string, { kind: "text" | "reasoning"; text: string }>
}

export const empty = <
  Tools extends Record<string, Tool.Any>
>(): State<Tools> => ({ parts: [], open: new Map() })

const withOpen = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>,
  id: string,
  value: { kind: "text" | "reasoning"; text: string } | undefined
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
    }
  | { readonly _tag: "Failed"; readonly error: unknown }

const cont = <Tools extends Record<string, Tool.Any>>(
  state: State<Tools>,
  delta?: Delta | undefined
): Step<Tools> => ({ _tag: "Continue", state, delta })

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
      return cont(withOpen(state, part.id, { kind: "text", text: "" }))
    case "reasoning-start":
      return cont(withOpen(state, part.id, { kind: "reasoning", text: "" }))
    case "text-delta":
    case "reasoning-delta": {
      const kind = part.type === "text-delta" ? "text" : "reasoning"
      const current = state.open.get(part.id)
      // A delta with no matching start still counts. Providers are not
      // uniformly careful about emitting one, and dropping output because a
      // structural part was missing would be the worse failure.
      const text = (current?.text ?? "") + part.delta
      return cont(withOpen(state, part.id, { kind, text }), {
        kind,
        delta: part.delta
      })
    }
    case "text-end":
    case "reasoning-end": {
      const current = state.open.get(part.id)
      if (current === undefined) return cont(state)
      const closed = withOpen(state, part.id, undefined)
      const finished =
        current.kind === "text"
          ? Response.makePart("text", { text: current.text })
          : Response.makePart("reasoning", { text: current.text })
      return cont({ ...closed, parts: [...closed.parts, finished] })
    }
    // Tool parameters arrive incrementally and then again as a complete
    // `tool-call`, so the increments are structural noise here: the harness
    // executes the assembled call, never a partial one.
    case "tool-params-start":
    case "tool-params-delta":
    case "tool-params-end":
      return cont(state)
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
  Array.from(state.open.values()).map((chunk) =>
    chunk.kind === "text"
      ? Response.makePart("text", { text: chunk.text })
      : Response.makePart("reasoning", { text: chunk.text })
  )

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
