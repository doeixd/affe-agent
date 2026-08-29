import { Schema } from "effect"

/**
 * The OpenAI Chat Completions wire shapes this adapter speaks.
 *
 * Effect's `@effect/ai-openai-compat` is a *client*; it has no server-side
 * schemas to borrow. These are the subset the endpoint reads and writes,
 * declared loosely where OpenAI is loose -- unknown request fields
 * (`temperature`, `tools`, ...) are accepted and ignored, because an
 * OpenAI-compatible consumer sends them whether or not the agent has a use
 * for them -- and exactly where the protocol is exact.
 */

const TextContentPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

/** An image by URL -- `https:` or a `data:` URL -- as Chat Completions takes it. */
const ImageUrlContentPart = Schema.Struct({
  type: Schema.Literal("image_url"),
  image_url: Schema.Struct({
    url: Schema.String,
    detail: Schema.optional(Schema.String)
  })
})

/** Audio as base64 with its container format (`wav`, `mp3`). */
const InputAudioContentPart = Schema.Struct({
  type: Schema.Literal("input_audio"),
  input_audio: Schema.Struct({
    data: Schema.String,
    format: Schema.String
  })
})

/** A file inline as a `data:` URL (`file_data`) or by reference (`file_id`). */
const FileContentPart = Schema.Struct({
  type: Schema.Literal("file"),
  file: Schema.Struct({
    file_data: Schema.optional(Schema.String),
    file_id: Schema.optional(Schema.String),
    filename: Schema.optional(Schema.String)
  })
})

/** The typed content parts a message may carry. */
export const ContentPart = Schema.Union([
  TextContentPart,
  ImageUrlContentPart,
  InputAudioContentPart,
  FileContentPart
])
export type ContentPart = typeof ContentPart.Type

/** Content as OpenAI accepts it: a string, or an array of typed parts. */
export const MessageContent = Schema.Union([
  Schema.String,
  Schema.Array(ContentPart),
  Schema.Null
])
export type MessageContent = typeof MessageContent.Type

export const Role = Schema.Literals(["system", "developer", "user", "assistant"])
export type Role = typeof Role.Type

export const ChatMessage = Schema.Struct({
  role: Role,
  content: MessageContent,
  name: Schema.optional(Schema.String)
})
export type ChatMessage = typeof ChatMessage.Type

export const ChatCompletionRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(ChatMessage),
  stream: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.String)
})
export type ChatCompletionRequest = typeof ChatCompletionRequest.Type

export const FinishReason = Schema.Literals(["stop", "length", "content_filter"])
export type FinishReason = typeof FinishReason.Type

export const Usage = Schema.Struct({
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  total_tokens: Schema.Number
})
export type Usage = typeof Usage.Type

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.String
})

export const Choice = Schema.Struct({
  index: Schema.Number,
  message: AssistantMessage,
  finish_reason: FinishReason
})

export const ChatCompletionResponse = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(Choice),
  usage: Schema.optional(Usage)
})
export type ChatCompletionResponse = typeof ChatCompletionResponse.Type

export const Delta = Schema.Struct({
  role: Schema.optional(Schema.Literal("assistant")),
  content: Schema.optional(Schema.String)
})

export const ChunkChoice = Schema.Struct({
  index: Schema.Number,
  delta: Delta,
  finish_reason: Schema.NullOr(FinishReason)
})

export const ChatCompletionChunk = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion.chunk"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(ChunkChoice),
  usage: Schema.optional(Usage)
})
export type ChatCompletionChunk = typeof ChatCompletionChunk.Type

export const ErrorType = Schema.Literals([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "rate_limit_error",
  "server_error"
])
export type ErrorType = typeof ErrorType.Type

/** The OpenAI error envelope, for bodies and for in-stream failure frames. */
export const ErrorBody = Schema.Struct({
  message: Schema.String,
  type: ErrorType,
  code: Schema.NullOr(Schema.String),
  param: Schema.NullOr(Schema.String)
})
export type ErrorBody = typeof ErrorBody.Type

export const ErrorResponse = Schema.Struct({ error: ErrorBody })
export type ErrorResponse = typeof ErrorResponse.Type

/** The JSON forms, for encoding responses and frames. */
export const ChatCompletionResponseJson = Schema.toCodecJson(ChatCompletionResponse)
export const ChatCompletionChunkJson = Schema.toCodecJson(ChatCompletionChunk)
export const ErrorResponseJson = Schema.toCodecJson(ErrorResponse)
