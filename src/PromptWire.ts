/**
 * JSON-safe codecs for Effect AI prompts.
 *
 * `Prompt.Prompt` remains the in-memory domain type. These codecs only define
 * its process-boundary representation, where a file part must preserve whether
 * its data was a string, bytes, or a URL. Effect AI's own schema intentionally
 * accepts all three runtime values, but that union is ambiguous after ordinary
 * JSON serialization.
 */
import { Array as Arr, Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import * as AiPrompt from "effect/unstable/ai/Prompt"

const FileDataWire = Schema.Union([
  Schema.TaggedStruct("String", {
    value: Schema.String
  }),
  Schema.TaggedStruct("Bytes", {
    base64: Schema.toEncoded(Schema.Uint8ArrayFromBase64)
  }),
  Schema.TaggedStruct("Url", {
    value: Schema.toEncoded(Schema.URLFromString)
  })
])

// Before this codec existed, Effect AI's prompt schema could leave both bytes
// and URLs as strings after JSON persistence. Accept those rows as strings so
// upgrading does not make existing sessions unreadable. Their original runtime
// variant cannot be recovered because the old representation never recorded it.
const FileDataWireRead = Schema.Union([FileDataWire, Schema.String])

type FileDataWire = typeof FileDataWire.Type

type JsonObject = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Arr.isArray(value)

const issueOf = (error: Schema.SchemaError) => error.issue

const decodeFileDataWireRead = Schema.decodeUnknownEffect(FileDataWireRead)
const decodeBase64 = Schema.decodeEffect(Schema.Uint8ArrayFromBase64)
const decodeUrl = Schema.decodeEffect(Schema.URLFromString)
const encodeBase64 = Schema.encodeEffect(Schema.Uint8ArrayFromBase64)
const encodeUrl = Schema.encodeEffect(Schema.URLFromString)
const decodePromptUnknown = Schema.decodeUnknownEffect(AiPrompt.Prompt)
const encodePrompt = Schema.encodeEffect(AiPrompt.Prompt)
const decodeMessageUnknown = Schema.decodeUnknownEffect(AiPrompt.Message)
const encodeMessageEffect = Schema.encodeEffect(AiPrompt.Message)
const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.Json)

const decodeFileData = (
  value: unknown
): Effect.Effect<string | Uint8Array | URL, SchemaIssue.Issue> => {
  const decoded = decodeFileDataWireRead(value).pipe(Effect.mapError(issueOf))
  return Effect.flatMap(
    decoded,
    (wire): Effect.Effect<string | Uint8Array | URL, SchemaIssue.Issue> => {
      if (typeof wire === "string") {
        return Effect.succeed(wire)
      }
      switch (wire._tag) {
        case "String":
          return Effect.succeed(wire.value)
        case "Bytes":
          return decodeBase64(wire.base64).pipe(Effect.mapError(issueOf))
        case "Url":
          return decodeUrl(wire.value).pipe(Effect.mapError(issueOf))
      }
    }
  )
}

const decodePart = (part: unknown): Effect.Effect<unknown, SchemaIssue.Issue> =>
  isObject(part) && part["type"] === "file"
    ? decodeFileData(part["data"]).pipe(
        Effect.map((data) => ({ ...part, data }))
      )
    : Effect.succeed(part)

const decodeMessageValue = (
  message: unknown
): Effect.Effect<unknown, SchemaIssue.Issue> => {
  if (!isObject(message) || !Arr.isArray(message["content"])) {
    return Effect.succeed(message)
  }
  return Effect.map(
    Effect.forEach(message["content"], decodePart),
    (content) => ({ ...message, content })
  )
}

const decodePromptValue = (
  prompt: Schema.Json
): Effect.Effect<AiPrompt.Prompt, SchemaIssue.Issue> => {
  if (!isObject(prompt) || !Arr.isArray(prompt["content"])) {
    return decodePromptUnknown(prompt).pipe(Effect.mapError(issueOf))
  }
  return Effect.flatMap(
    Effect.forEach(prompt["content"], decodeMessageValue),
    (content) => decodePromptUnknown({ ...prompt, content }).pipe(Effect.mapError(issueOf))
  )
}

const encodeFileData = (
  data: string | Uint8Array | URL
): Effect.Effect<FileDataWire, SchemaIssue.Issue> => {
  if (typeof data === "string") {
    return Effect.succeed({ _tag: "String" as const, value: data })
  }
  if (data instanceof Uint8Array) {
    return encodeBase64(data).pipe(
      Effect.map((base64) => ({ _tag: "Bytes" as const, base64 })),
      Effect.mapError(issueOf)
    )
  }
  return encodeUrl(data).pipe(
    Effect.map((value) => ({ _tag: "Url" as const, value })),
    Effect.mapError(issueOf)
  )
}

const encodePart = (
  part:
    | AiPrompt.UserMessagePartEncoded
    | AiPrompt.AssistantMessagePartEncoded
    | AiPrompt.ToolMessagePartEncoded
): Effect.Effect<unknown, SchemaIssue.Issue> =>
  part.type === "file"
    ? encodeFileData(part.data).pipe(
        Effect.map((data) => ({ ...part, data }))
      )
    : Effect.succeed(part)

const encodeMessageValue = (
  message: AiPrompt.MessageEncoded
): Effect.Effect<unknown, SchemaIssue.Issue> => {
  if (
    (message.role !== "user" && message.role !== "assistant") ||
    typeof message.content === "string"
  ) {
    return Effect.succeed(message)
  }
  return Effect.map(
    Effect.forEach(message.content, encodePart),
    (content) => ({ ...message, content })
  )
}

const encodePromptValue = (
  prompt: AiPrompt.Prompt
): Effect.Effect<Schema.Json, SchemaIssue.Issue> =>
  encodePrompt(prompt).pipe(
    Effect.mapError(issueOf),
    Effect.flatMap((encoded) => Effect.forEach(encoded.content, encodeMessageValue)),
    Effect.flatMap((content) => decodeJsonUnknown({ content }).pipe(Effect.mapError(issueOf)))
  )

const decodeMessage = (
  message: Schema.Json
): Effect.Effect<AiPrompt.Message, SchemaIssue.Issue> =>
  decodeMessageValue(message).pipe(
    Effect.flatMap((value) => decodeMessageUnknown(value).pipe(Effect.mapError(issueOf)))
  )

const encodeMessage = (
  message: AiPrompt.Message
): Effect.Effect<Schema.Json, SchemaIssue.Issue> =>
  encodeMessageEffect(message).pipe(
    Effect.mapError(issueOf),
    Effect.flatMap(encodeMessageValue),
    Effect.flatMap((value) => decodeJsonUnknown(value).pipe(Effect.mapError(issueOf)))
  )

/** A JSON-safe codec whose decoded type is exactly `Prompt.Message`. */
export const Message = Schema.Json.pipe(
  Schema.decodeTo(Schema.toType(AiPrompt.Message), {
    decode: SchemaGetter.transformOrFail(decodeMessage),
    encode: SchemaGetter.transformOrFail(encodeMessage)
  })
)

/** A JSON-safe codec whose decoded type is exactly `Prompt.Prompt`. */
export const Prompt = Schema.Json.pipe(
  Schema.decodeTo(Schema.toType(AiPrompt.Prompt), {
    decode: SchemaGetter.transformOrFail(decodePromptValue),
    encode: SchemaGetter.transformOrFail(encodePromptValue)
  })
)
