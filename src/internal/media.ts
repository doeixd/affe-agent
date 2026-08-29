import { Encoding, Option, Result } from "effect"
import { Prompt } from "effect/unstable/ai"

/**
 * The little that the protocol adapters share when a file crosses in: base64
 * and `data:` URLs become bytes with their declared media type, and a prompt
 * file part becomes what a protocol can carry back out.
 *
 * Deliberately not a "media" abstraction. Each adapter keeps its own
 * vocabulary -- OpenAI's `image_url`, A2A's `raw`/`url`, AG-UI's `binary` --
 * and only the byte-level plumbing is here.
 */

/** A `data:<type>;base64,<payload>` URL, taken apart; `None` for anything else. */
export const dataUrl = (
  url: string
): Option.Option<{ readonly mediaType: string; readonly base64: string }> => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match === null || match[1] === undefined || match[2] === undefined
    ? Option.none()
    : Option.some({ mediaType: match[1], base64: match[2] })
}

/** Base64 to bytes, or the reason it is not base64. */
export const bytesFromBase64 = (base64: string): Result.Result<Uint8Array, string> =>
  Result.mapError(Encoding.decodeBase64(base64), (error) => error.message)

/** A file part from base64 content. */
export const fileFromBase64 = (options: {
  readonly mediaType: string
  readonly base64: string
  readonly fileName?: string | undefined
}): Result.Result<Prompt.FilePart, string> =>
  Result.map(bytesFromBase64(options.base64), (data) =>
    Prompt.filePart({
      mediaType: options.mediaType,
      data,
      ...(options.fileName === undefined ? {} : { fileName: options.fileName })
    })
  )

/** A file part from a URL string, or the reason it is not one. */
export const fileFromUrl = (options: {
  readonly mediaType: string
  readonly url: string
  readonly fileName?: string | undefined
}): Result.Result<Prompt.FilePart, string> => {
  const parsed = dataUrl(options.url)
  if (Option.isSome(parsed)) {
    return fileFromBase64({
      mediaType: parsed.value.mediaType,
      base64: parsed.value.base64,
      fileName: options.fileName
    })
  }
  let url: URL
  try {
    url = new URL(options.url)
  } catch {
    return Result.fail(`not a URL: ${options.url}`)
  }
  return Result.succeed(
    Prompt.filePart({
      mediaType: options.mediaType,
      data: url,
      ...(options.fileName === undefined ? {} : { fileName: options.fileName })
    })
  )
}

/**
 * A prompt file part's data as either bytes or a URL, for a protocol that
 * carries one or the other. String data is base64 -- that is what Effect AI's
 * `FilePart` documents for the string variant -- so it is decoded here rather
 * than sent as text.
 */
export const outgoing = (
  part: Prompt.FilePart
): Result.Result<{ readonly _tag: "bytes"; readonly bytes: Uint8Array } | { readonly _tag: "url"; readonly url: URL }, string> =>
  typeof part.data === "string"
    ? Result.map(bytesFromBase64(part.data), (bytes) => ({ _tag: "bytes" as const, bytes }))
    : part.data instanceof Uint8Array
    ? Result.succeed({ _tag: "bytes" as const, bytes: part.data })
    : Result.succeed({ _tag: "url" as const, url: part.data })
