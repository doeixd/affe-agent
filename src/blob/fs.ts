import { Effect, Layer, Schema, Stream } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as BlobStore from "./BlobStore.js"

/**
 * A filesystem-backed blob store, at `@doeixd/effect-agent/blob/fs` so the
 * portable `/blob` entry never pulls in `node:*` -- the same split as
 * `/sandbox` and `/sandbox/local`.
 *
 * Layout under `root`: `<id>` holds the bytes, `<id>.json` the ref. The id
 * is the content hash, so a write is naturally idempotent and a re-put of
 * held content touches nothing. Ids come from this package's own hashing
 * and are hex; nothing user-supplied is ever used as a path segment --
 * `fileName` lives inside the metadata JSON, never on disk
 * (`plan-filetypes.txt`'s "never trust fileName as a filesystem path").
 */

const decodeRef = Schema.decodeUnknownEffect(BlobStore.BlobRef)

const failure = (operation: string, id?: string) => (cause: unknown) =>
  new BlobStore.BlobStoreError({
    operation,
    ...(id === undefined ? {} : { id }),
    detail: cause instanceof Error ? cause.message : String(cause)
  })

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null &&
  (cause as { readonly code?: unknown }).code === "ENOENT"

/** A store rooted at a directory it creates on first use. */
export const make = (options: {
  readonly root: string
}): BlobStore.BlobStoreService => {
  const bytesPath = (id: string) => path.join(options.root, id)
  const refPath = (id: string) => path.join(options.root, `${id}.json`)

  const ready = Effect.tryPromise({
    try: () => fs.mkdir(options.root, { recursive: true }),
    catch: failure("prepare")
  })

  const readRef = (
    id: string
  ): Effect.Effect<BlobStore.BlobRef, BlobStore.BlobStoreError | BlobStore.BlobMissingError> =>
    Effect.tryPromise({
      try: () => fs.readFile(refPath(id), "utf8"),
      catch: (cause) =>
        isMissing(cause)
          ? new BlobStore.BlobMissingError({ id })
          : failure("stat", id)(cause)
    }).pipe(
      Effect.flatMap((raw) =>
        Effect.try({
          try: (): unknown => JSON.parse(raw),
          catch: failure("stat", id)
        })
      ),
      // Through the schema, not an assertion: a corrupt sidecar is a typed
      // storage failure, never a ref-shaped lie.
      Effect.flatMap((parsed) =>
        decodeRef(parsed).pipe(Effect.mapError(failure("stat", id)))
      )
    )

  return {
    put: (content, metadata) =>
      Effect.gen(function*() {
        const { bytes, ref } = yield* BlobStore.describe(content, metadata)
        yield* ready
        // Bytes first, ref second: a ref present on disk promises the bytes
        // are. A crash between the writes leaves an orphaned byte file --
        // re-put heals it -- never a ref that dangles.
        yield* Effect.tryPromise({
          try: () => fs.writeFile(bytesPath(ref.id), bytes),
          catch: failure("write", ref.id)
        })
        yield* Effect.tryPromise({
          try: () => fs.writeFile(refPath(ref.id), JSON.stringify(ref)),
          catch: failure("write", ref.id)
        })
        return ref
      }),

    get: (ref) =>
      Stream.fromEffect(
        readRef(ref.id).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => fs.readFile(bytesPath(ref.id)),
              catch: (cause) =>
                isMissing(cause)
                  ? new BlobStore.BlobMissingError({ id: ref.id })
                  : failure("read", ref.id)(cause)
            })
          ),
          Effect.map((buffer) => new Uint8Array(buffer))
        )
      ),

    stat: (ref) => readRef(ref.id),

    remove: (ref) =>
      Effect.tryPromise({
        try: async () => {
          await fs.rm(refPath(ref.id), { force: true })
          await fs.rm(bytesPath(ref.id), { force: true })
        },
        catch: failure("remove", ref.id)
      })
  }
}

/** The filesystem store as a layer. */
export const layer = (options: { readonly root: string }): Layer.Layer<BlobStore.BlobStore> =>
  Layer.sync(BlobStore.BlobStore, () => make(options))
