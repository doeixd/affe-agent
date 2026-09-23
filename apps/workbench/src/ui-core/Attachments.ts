/**
 * Attachments (plan-workbench.md W2): files a person sends with a message.
 *
 * They travel inline, as file parts of the prompt -- the path the kernel
 * already carries intact through every client and the durable journal
 * (`PromptWire`). Sending them by reference is remaining-work item 116 and
 * is not reached for here; the cost of inline is size, so there is a cap:
 * a file over `maxBytes`, or more than `maxFiles`, is refused before
 * anything is sent, with a reason a person can act on.
 *
 * UI-neutral and pure: reading a `File` is the adapter's job; this takes
 * bytes and gives a prompt.
 */
import type { Prompt } from "effect/unstable/ai"

export interface Attachment {
  readonly fileName: string
  readonly mediaType: string
  readonly data: Uint8Array
}

export interface Limits {
  readonly maxBytes: number
  readonly maxFiles: number
}

/** 5 MB a file, 5 files a message: inline is fine at that size, and past it is item 116's job. */
export const defaultLimits: Limits = { maxBytes: 5 * 1024 * 1024, maxFiles: 5 }

export type Refusal =
  | { readonly _tag: "TooLarge"; readonly fileName: string; readonly bytes: number; readonly maxBytes: number }
  | { readonly _tag: "TooMany"; readonly count: number; readonly maxFiles: number }
  | { readonly _tag: "Empty"; readonly fileName: string }

/** Add files to those already attached: the ones that fit, and why any did not. */
export const add = (
  current: ReadonlyArray<Attachment>,
  incoming: ReadonlyArray<Attachment>,
  limits: Limits = defaultLimits
): { readonly attached: ReadonlyArray<Attachment>; readonly refused: ReadonlyArray<Refusal> } => {
  const attached = [...current]
  const refused: Array<Refusal> = []
  for (const file of incoming) {
    if (file.data.byteLength === 0) refused.push({ _tag: "Empty", fileName: file.fileName })
    else if (file.data.byteLength > limits.maxBytes) {
      refused.push({ _tag: "TooLarge", fileName: file.fileName, bytes: file.data.byteLength, maxBytes: limits.maxBytes })
    } else if (attached.length >= limits.maxFiles) {
      refused.push({ _tag: "TooMany", count: attached.length + 1, maxFiles: limits.maxFiles })
    } else attached.push(file)
  }
  return { attached, refused }
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

export const describeRefusal = (refusal: Refusal): string => {
  switch (refusal._tag) {
    case "TooLarge":
      return `${refusal.fileName} is ${megabytes(refusal.bytes)}; the limit is ${megabytes(refusal.maxBytes)}.`
    case "TooMany":
      return `A message can carry ${refusal.maxFiles} files at most.`
    case "Empty":
      return `${refusal.fileName} is empty.`
  }
}

/** The message as a prompt: the text, then each file as a file part. Text alone stays a plain string. */
export const promptOf = (text: string, attachments: ReadonlyArray<Attachment>): Prompt.RawInput =>
  attachments.length === 0
    ? text
    : [{
      role: "user",
      content: [
        ...(text === "" ? [] : [{ type: "text" as const, text }]),
        ...attachments.map((file) => ({
          type: "file" as const,
          mediaType: file.mediaType,
          fileName: file.fileName,
          data: file.data
        }))
      ]
    }]

/** A browser's `File.type` is empty for kinds it does not know; the model still needs a media type. */
export const mediaTypeOf = (declared: string): string => (declared === "" ? "application/octet-stream" : declared)
