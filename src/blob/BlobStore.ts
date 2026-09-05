import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import * as Namespace from "../internal/namespace.js"

/**
 * Content-addressed storage for large binary content
 * (`docs/plan-filetypes.txt` phase 5).
 *
 * Inline base64 is right for a 12 KB screenshot and wrong for a 50 MB
 * video: it inflates by a third and then rides *every* boundary -- RPC
 * frame, SQL history row, event stream -- as many times as the
 * conversation is replayed. This service is the alternative: bytes go in
 * once, a small `BlobRef` travels instead, and a receiver fetches the
 * bytes only when it actually needs them.
 *
 * Deliberately boring and deliberately ignorant of agents: put, get, stat,
 * remove. The id *is* the SHA-256 of the content, which buys three things
 * at once -- the same screenshot sent three times stores once, a reference
 * in session history can never have its bytes changed underneath it, and
 * verification is a re-hash. What counts as "too large to inline" is not
 * this module's decision; `BlobWire.externalize` takes the threshold, and
 * `policy` is where an application says what it will accept at all.
 */

/** A blob's identity: the lowercase hex SHA-256 of its content. */
export const BlobId = Schema.String.pipe(
  Schema.brand(Namespace.tag("blob/BlobId"))
)
export type BlobId = typeof BlobId.Type

/**
 * What travels instead of the bytes.
 *
 * `sha256` repeats the id today -- the id *is* the hash -- and is kept as
 * its own field so a reader verifies against a named promise rather than
 * against an id scheme that could change.
 */
export const BlobRef = Schema.Struct({
  id: BlobId,
  mediaType: Schema.String,
  byteLength: Schema.Natural,
  sha256: Schema.String,
  fileName: Schema.optional(Schema.String)
})
export type BlobRef = typeof BlobRef.Type

/** What a store knows about a held blob. The ref is the whole answer. */
export type BlobInfo = BlobRef

/** The storage underneath failed at something that is not "not there". */
export class BlobStoreError extends Schema.TaggedError<BlobStoreError>()(
  Namespace.tag("blob/BlobStoreError"),
  {
    operation: Schema.String,
    id: Schema.optional(Schema.String),
    detail: Schema.String
  }
) {
  override get message() {
    const where = this.id === undefined ? "" : ` for ${this.id}`
    return `Blob store ${this.operation}${where} failed: ${this.detail}`
  }
}

/** The referenced content is not in this store. */
export class BlobMissingError extends Schema.TaggedError<BlobMissingError>()(
  Namespace.tag("blob/BlobMissingError"),
  { id: Schema.String }
) {
  override get message() {
    return `No blob with id ${this.id} in this store`
  }
}

/**
 * The content was refused by policy, before it was stored.
 *
 * Typed and split by reason because the responses differ: `too-large`
 * wants a smaller payload or a raised limit, `media-type` wants a
 * different kind of content or a widened allow list. Distinct from
 * `BlobStoreError`, which is the storage failing at content it would
 * have accepted.
 */
export class BlobRejectedError extends Schema.TaggedError<BlobRejectedError>()(
  Namespace.tag("blob/BlobRejectedError"),
  {
    reason: Schema.Literals(["too-large", "media-type"]),
    detail: Schema.String
  }
) {
  override get message() {
    return `Blob rejected (${this.reason}): ${this.detail}`
  }
}

/** What `put` must be told about the bytes; everything else is derived. */
export interface PutMetadata {
  readonly mediaType: string
  readonly fileName?: string | undefined
}

export interface BlobStoreService {
  /**
   * Store content, returning the reference that stands for it.
   *
   * Content-addressed: putting the same bytes twice returns the same ref
   * and stores once. The ref's `byteLength` and `sha256` are computed from
   * what was actually read, never taken on trust.
   */
  readonly put: (
    content: Stream.Stream<Uint8Array>,
    metadata: PutMetadata
  ) => Effect.Effect<BlobRef, BlobStoreError | BlobRejectedError>
  /** The bytes. A receiver calls this only when it needs them. */
  readonly get: (
    ref: BlobRef
  ) => Stream.Stream<Uint8Array, BlobStoreError | BlobMissingError>
  readonly stat: (
    ref: BlobRef
  ) => Effect.Effect<BlobInfo, BlobStoreError | BlobMissingError>
  readonly remove: (ref: BlobRef) => Effect.Effect<void, BlobStoreError>
}

export class BlobStore extends Context.Service<BlobStore, BlobStoreService>()(
  Namespace.tag("blob/BlobStore")
) {}

/** `put` for bytes already in hand. */
export const putBytes = (
  store: BlobStoreService,
  bytes: Uint8Array,
  metadata: PutMetadata
): Effect.Effect<BlobRef, BlobStoreError | BlobRejectedError> =>
  store.put(Stream.make(bytes), metadata)

/** Everything `get` yields, as one array. */
export const getBytes = (
  store: BlobStoreService,
  ref: BlobRef
): Effect.Effect<Uint8Array, BlobStoreError | BlobMissingError> =>
  Effect.map(Stream.runCollect(store.get(ref)), concat)

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const concat = (chunks: Iterable<Uint8Array>): Uint8Array => {
  const all = Array.from(chunks)
  const total = all.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of all) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * The content hash, via Web Crypto -- present on Node 18+, workerd and
 * browsers alike, which is what keeps this entry platform-clean.
 */
export const sha256 = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.promise(async () =>
    hex(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        // A fresh copy: `digest` wants a plain ArrayBuffer view and the
        // input may be a view over a larger shared buffer.
        bytes.slice().buffer
      )
    )
  )

const brandId = Schema.decodeSync(BlobId)

/** Read the whole stream, hash it, and build the ref `put` will answer. */
export const describe = (
  content: Stream.Stream<Uint8Array>,
  metadata: PutMetadata
): Effect.Effect<{ readonly ref: BlobRef; readonly bytes: Uint8Array }> =>
  Effect.gen(function*() {
    const bytes = concat(yield* Stream.runCollect(content))
    const digest = yield* sha256(bytes)
    const ref: BlobRef = {
      id: brandId(digest),
      mediaType: metadata.mediaType,
      byteLength: bytes.byteLength,
      sha256: digest,
      ...(metadata.fileName === undefined ? {} : { fileName: metadata.fileName })
    }
    return { ref, bytes }
  })

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * What an application will accept at all
 * (`plan-filetypes.txt`, the security rules).
 *
 * `mediaTypes.allow` admits exact types and `type/*` families; `deny`
 * wins over `allow`, so "images, but never SVG" is two lines. A policy
 * wraps a store rather than living inside one, because acceptance is the
 * application's decision and the same backing may serve two callers with
 * different rules.
 */
export interface Policy {
  /** Largest accepted content, in bytes. Absent means unlimited. */
  readonly maxBytes?: number | undefined
  readonly mediaTypes?: {
    readonly allow?: ReadonlyArray<string> | undefined
    readonly deny?: ReadonlyArray<string> | undefined
  } | undefined
}

const matches = (mediaType: string, pattern: string): boolean => {
  if (pattern === mediaType) return true
  if (pattern.endsWith("/*")) {
    return mediaType.startsWith(pattern.slice(0, -1))
  }
  return false
}

/** The refusal a policy would answer with, if any. */
const refusal = (
  policy: Policy,
  ref: BlobRef
): Option.Option<BlobRejectedError> => {
  const deny = policy.mediaTypes?.deny ?? []
  if (deny.some((pattern) => matches(ref.mediaType, pattern))) {
    return Option.some(
      new BlobRejectedError({
        reason: "media-type",
        detail: `${ref.mediaType} is denied by policy`
      })
    )
  }
  const allow = policy.mediaTypes?.allow
  if (allow !== undefined && !allow.some((pattern) => matches(ref.mediaType, pattern))) {
    return Option.some(
      new BlobRejectedError({
        reason: "media-type",
        detail: `${ref.mediaType} is not in the policy's allow list`
      })
    )
  }
  if (policy.maxBytes !== undefined && ref.byteLength > policy.maxBytes) {
    return Option.some(
      new BlobRejectedError({
        reason: "too-large",
        detail: `${ref.byteLength} bytes exceeds the policy's ${policy.maxBytes}`
      })
    )
  }
  return Option.none()
}

/**
 * A store that refuses what the policy refuses, at `put`, before storing.
 *
 * Reads are untouched: content already held is already accepted, and a
 * tightened policy must not make history unreadable.
 */
export const withPolicy = (
  store: BlobStoreService,
  policy: Policy
): BlobStoreService => ({
  ...store,
  put: (content, metadata) =>
    Effect.gen(function*() {
      const described = yield* describe(content, metadata)
      const refused = refusal(policy, described.ref)
      if (Option.isSome(refused)) return yield* refused.value
      return yield* store.put(Stream.make(described.bytes), metadata)
    })
})

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

/**
 * The default: a map from hash to bytes. For tests, for a single process,
 * and as the reference the filesystem backing is measured against.
 */
export const memory: Effect.Effect<BlobStoreService> = Effect.sync(() => {
  const held = new Map<string, { readonly ref: BlobRef; readonly bytes: Uint8Array }>()
  return {
    put: (content, metadata) =>
      Effect.map(describe(content, metadata), ({ bytes, ref }) => {
        // Content-addressed: a second put of the same bytes is the same
        // blob, whatever its metadata said this time. First write wins so
        // a ref already handed out keeps describing what is stored.
        if (!held.has(ref.id)) held.set(ref.id, { ref, bytes })
        return held.get(ref.id)!.ref
      }),
    get: (ref) => {
      const found = held.get(ref.id)
      return found === undefined
        ? Stream.fail(new BlobMissingError({ id: ref.id }))
        : Stream.make(found.bytes)
    },
    stat: (ref) => {
      const found = held.get(ref.id)
      return found === undefined
        ? Effect.fail(new BlobMissingError({ id: ref.id }))
        : Effect.succeed(found.ref)
    },
    remove: (ref) => Effect.sync(() => void held.delete(ref.id))
  }
})

/** The in-memory store as a layer. */
export const layerMemory: Layer.Layer<BlobStore> = Layer.effect(BlobStore, memory)
