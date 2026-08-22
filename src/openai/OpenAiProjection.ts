import { Stream } from "effect"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import type * as OpenAiSchema from "./OpenAiSchema.js"

/**
 * The pure projection from agent events to Chat Completions chunks.
 *
 * As with the AG-UI projection (#6): a `transition` from protocol state and
 * one envelope to the next state and the frames it produces, lifted over a
 * stream with `Stream.mapAccum`. Protocol state -- the completion id, whether
 * the role delta went out, whether text has been produced -- lives here and
 * nowhere near the session.
 *
 * What the caller sees is **the assistant's text**. Tools stay inside the
 * harness: the agent runs its own tools and the OpenAI consumer receives the
 * output, the same way it would from a model. Reasoning deltas are not
 * forwarded either; the protocol has no slot for them.
 */

export interface Options {
  readonly id: string
  readonly created: number
  readonly model: string
}

export interface ProjectionState {
  readonly options: Options
  /** The role delta has gone out; it goes out once, before any content. */
  readonly roleSent: boolean
  /** Some text has been streamed from an earlier message of this submission. */
  readonly textBefore: boolean
  /** Text has been streamed from the message currently open. */
  readonly textInMessage: boolean
  /** A terminal frame has gone out; nothing follows it. */
  readonly finished: boolean
}

export const initialState = (options: Options): ProjectionState => ({
  options,
  roleSent: false,
  textBefore: false,
  textInMessage: false,
  finished: false
})

/** A frame on the wire: a chunk, an error, or the `[DONE]` sentinel. */
export type Frame =
  | { readonly _tag: "Chunk"; readonly chunk: OpenAiSchema.ChatCompletionChunk }
  | { readonly _tag: "Error"; readonly error: OpenAiSchema.ErrorBody }
  | { readonly _tag: "Done" }

const base = (options: Options) => ({
  id: options.id,
  object: "chat.completion.chunk" as const,
  created: options.created,
  model: options.model
})

/** Typed constructors for the values the projection emits. Pure. */
export const chunk = {
  role: (options: Options): OpenAiSchema.ChatCompletionChunk => ({
    ...base(options),
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
  }),
  text: (options: Options, content: string): OpenAiSchema.ChatCompletionChunk => ({
    ...base(options),
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  }),
  finish: (
    options: Options,
    reason: OpenAiSchema.FinishReason = "stop"
  ): OpenAiSchema.ChatCompletionChunk => ({
    ...base(options),
    choices: [{ index: 0, delta: {}, finish_reason: reason }]
  })
}

export const response = {
  success: (options: Options, content: string): OpenAiSchema.ChatCompletionResponse => ({
    id: options.id,
    object: "chat.completion",
    created: options.created,
    model: options.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  })
}

export const error = (
  type: OpenAiSchema.ErrorType,
  message: string,
  code: string | null = null,
  param: string | null = null
): OpenAiSchema.ErrorBody => ({ message, type, code, param })

/**
 * Messages within one submission are joined the way the non-streaming text
 * is read: a later message with text follows the earlier one. Two messages'
 * texts are separated so a consumer rendering the concatenation does not
 * see them run together.
 */
export const MESSAGE_SEPARATOR = "\n\n"

/**
 * One step. Session-level events and events of other submissions are not
 * this projection's concern: the caller filters to one submission.
 */
export const transition = (
  state: ProjectionState,
  envelope: AgentEventEnvelope
): readonly [ProjectionState, ReadonlyArray<Frame>] => {
  if (state.finished) return [state, []]
  const { options } = state
  const event = envelope.event
  switch (event._tag) {
    case "MessageStarted":
      return [{ ...state, textInMessage: false }, []]
    case "MessageDelta": {
      if (event.kind !== "text" || event.delta.length === 0) return [state, []]
      const frames: Array<Frame> = []
      if (!state.roleSent) frames.push({ _tag: "Chunk", chunk: chunk.role(options) })
      const separator = state.textBefore && !state.textInMessage ? MESSAGE_SEPARATOR : ""
      frames.push({ _tag: "Chunk", chunk: chunk.text(options, separator + event.delta) })
      return [
        { ...state, roleSent: true, textBefore: true, textInMessage: true },
        frames
      ]
    }
    case "SubmissionCompleted": {
      const frames: Array<Frame> = []
      if (!state.roleSent) frames.push({ _tag: "Chunk", chunk: chunk.role(options) })
      frames.push({ _tag: "Chunk", chunk: chunk.finish(options) }, { _tag: "Done" })
      return [{ ...state, roleSent: true, finished: true }, frames]
    }
    case "SubmissionFailed":
      return [
        { ...state, finished: true },
        [
          {
            _tag: "Error",
            error: error("server_error", event.failure.message, event.failure.tag)
          },
          { _tag: "Done" }
        ]
      ]
    case "SubmissionInterrupted":
      return [
        { ...state, finished: true },
        [
          { _tag: "Error", error: error("server_error", "the run was interrupted", "interrupted") },
          { _tag: "Done" }
        ]
      ]
    default:
      return [state, []]
  }
}

/** The projection lifted over a stream of one submission's events. */
export const project = <E, R>(
  options: Options,
  events: Stream.Stream<AgentEventEnvelope, E, R>
): Stream.Stream<Frame, E, R> =>
  events.pipe(
    Stream.mapAccum(
      () => initialState(options),
      (state, envelope) => transition(state, envelope)
    ),
    Stream.takeUntil((frame) => frame._tag === "Done")
  )
