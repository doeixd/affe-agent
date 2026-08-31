import { Array as Arr, Effect, Encoding, Result, Schema, Stream } from "effect"
import * as BlobStore from "./BlobStore.js"

/**
 * Externalise large file parts out of a wire-encoded prompt
 * (`docs/plan-filetypes.txt`, "then the wire can externalize").
 *
 * `PromptWire` encodes a runtime prompt to JSON whose file data is tagged
 * `String` / `Bytes` / `Url`. These helpers operate on *that* form -- the
 * value a boundary is about to write or has just read -- because a
 * `BlobRef` cannot exist in the runtime domain at all: `Prompt.FilePart`
 * data is a string, bytes or a URL, and that is correct. The reference is
 * purely a transport and storage representation:
 *
 * ```text
 * encode (PromptWire)  ->  externalize  ->  store / send
 * receive / load       ->  resolve      ->  decode (PromptWire)
 * ```
 *
 * `resolve` is the receiver's step, taken before decoding and only when
 * the bytes are actually wanted -- the entire point of a reference is that
 * most hops never take it.
 *
 * The walk is over `unknown` and the result is re-validated as JSON at the
 * end, the same way `PromptWire` itself builds its values: no assertion
 * ever claims a shape the compiler was not shown.
 */

/** The tag this module adds beside `PromptWire`'s three. */
const BlobData = Schema.TaggedStruct("Blob", { ref: BlobStore.BlobRef })
const decodeBlobData = Schema.decodeUnknownEffect(BlobData)
const encodeBlobRef = Schema.encodeEffect(BlobStore.BlobRef)
const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.Json)

type Json = Schema.Json
type JsonObject = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Arr.isArray(value)

/**
 * Rebuild the document with every file part's `data` passed through
 * `transform`. Anything that is not a file part travels unchanged.
 */
const mapFileData = <E, R>(
  value: unknown,
  transform: (data: JsonObject, part: JsonObject) => Effect.Effect<unknown, E, R>
): Effect.Effect<unknown, E, R> => {
  if (!isObject(value)) return Effect.succeed(value)
  const data = value["data"]
  if (value["type"] === "file" && isObject(data)) {
    return Effect.map(transform(data, value), (next) => ({ ...value, data: next }))
  }
  const content = value["content"]
  if (Arr.isArray(content)) {
    return Effect.map(
      Effect.forEach(content, (inner) => mapFileData(inner, transform)),
      (next) => ({ ...value, content: next })
    )
  }
  return Effect.succeed(value)
}

/** The one place a rebuilt document becomes `Json` again: by validation. */
const asJson = (value: unknown): Effect.Effect<Json, Schema.SchemaError> =>
  decodeJsonUnknown(value)

export interface ExternalizeOptions {
  readonly store: BlobStore.BlobStoreService
  /**
   * Inline `Bytes` at or under this many bytes stay inline; larger ones
   * move to the store and travel as a `Blob` reference. `String` and `Url`
   * data are never externalised: a data URI is the sender's explicit
   * choice and a URL is already a reference.
   */
  readonly maxInlineBytes: number
  /** Media type recorded on the ref when the part carries none. */
  readonly defaultMediaType?: string | undefined
}

/**
 * Replace oversized inline bytes with references.
 *
 * Takes and returns the `PromptWire`-encoded JSON form, so it composes
 * after `Schema.encode(PromptWire.Prompt)` (or `.Message` / `.Part`) and
 * before whatever writes the wire. Deduplication is the store's: the same
 * screenshot in three messages stores once and yields equal refs.
 */
export const externalize = (
  encoded: Json,
  options: ExternalizeOptions
): Effect.Effect<Json, BlobStore.BlobStoreError | BlobStore.BlobRejectedError | Schema.SchemaError> =>
  mapFileData(encoded, (data, part) =>
    Effect.gen(function*() {
      const base64 = data["base64"]
      if (data["_tag"] !== "Bytes" || typeof base64 !== "string") return data
      const decoded = Encoding.decodeBase64(base64)
      if (Result.isFailure(decoded)) {
        // Not this module's malformation to report: left inline, the codec
        // that eventually decodes it will say what is wrong.
        return data
      }
      const bytes = decoded.success
      if (bytes.byteLength <= options.maxInlineBytes) return data
      const mediaType = part["mediaType"]
      const fileName = part["fileName"]
      const ref = yield* options.store.put(Stream.make(bytes), {
        mediaType: typeof mediaType === "string"
          ? mediaType
          : options.defaultMediaType ?? "application/octet-stream",
        ...(typeof fileName === "string" ? { fileName } : {})
      })
      const wire = yield* encodeBlobRef(ref)
      return { _tag: "Blob", ref: wire }
    })
  ).pipe(Effect.flatMap(asJson))

/**
 * Fetch every reference back into inline bytes.
 *
 * The receiver's step, before `PromptWire` decoding -- a `Blob` tag is not
 * a runtime file-data variant and the codec will refuse it, which is the
 * designed failure for a document decoded without resolving: loud, not a
 * silently empty file. A missing blob is `BlobMissingError` with the id
 * the document named.
 */
export const resolve = (
  encoded: Json,
  store: BlobStore.BlobStoreService
): Effect.Effect<
  Json,
  BlobStore.BlobStoreError | BlobStore.BlobMissingError | Schema.SchemaError
> =>
  mapFileData(encoded, (data) =>
    data["_tag"] !== "Blob"
      ? Effect.succeed(data)
      : Effect.gen(function*() {
        const { ref } = yield* decodeBlobData(data)
        const bytes = yield* BlobStore.getBytes(store, ref)
        return { _tag: "Bytes", base64: Encoding.encodeBase64(bytes) }
      })
  ).pipe(Effect.flatMap(asJson))

/** Every reference an encoded document carries, in document order. */
export const references = (
  encoded: Json
): Effect.Effect<ReadonlyArray<BlobStore.BlobRef>, Schema.SchemaError> =>
  Effect.gen(function*() {
    const found: Array<BlobStore.BlobRef> = []
    yield* mapFileData(encoded, (data) =>
      data["_tag"] !== "Blob"
        ? Effect.succeed(data)
        : Effect.map(decodeBlobData(data), ({ ref }) => {
          found.push(ref)
          return data
        })
    )
    return found
  })
