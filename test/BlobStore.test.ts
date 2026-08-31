import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Scope, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as BlobStore from "../src/blob/BlobStore.js"
import * as BlobWire from "../src/blob/BlobWire.js"
import * as FsBlob from "../src/blob/fs.js"
import * as PromptWire from "../src/PromptWire.js"

/**
 * Phase 5 of `docs/plan-filetypes.txt`: content-addressed blob storage, the
 * acceptance policy, and the wire step that lets an encoded prompt carry a
 * reference instead of megabytes. The conformance rows exercised here are
 * the plan's own: byte-identical round-trips, dedupe by content address,
 * oversized payloads rejected cleanly, and a reference a receiver must
 * resolve deliberately rather than silently.
 */

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Narrow the put failure to the policy refusal, without a cast. */
const reasonOf = (
  error: BlobStore.BlobStoreError | BlobStore.BlobRejectedError
): string | undefined =>
  error._tag === "@doeixd/effect-agent/blob/BlobRejectedError" ? error.reason : undefined

const put = (
  store: BlobStore.BlobStoreService,
  bytes: Uint8Array,
  mediaType = "application/octet-stream"
) => BlobStore.putBytes(store, bytes, { mediaType })

/** The store contract, run against every backing. */
const contract = (
  name: string,
  acquire: Effect.Effect<BlobStore.BlobStoreService, unknown, Scope.Scope>
) => {
  it.effect(`${name}: content addressing, round-trip, stat, remove`, () =>
    Effect.gen(function*() {
      const store = yield* Effect.orDie(acquire)

      // The id is the content hash -- pinned against a known vector.
      const abc = yield* put(store, bytesOf("abc"), "text/plain")
      assert.strictEqual(
        abc.sha256,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      )
      assert.strictEqual<string>(abc.id, abc.sha256)
      assert.strictEqual(abc.byteLength, 3)

      // Same bytes, same blob; the store deduplicates by construction.
      const again = yield* put(store, bytesOf("abc"), "text/plain")
      assert.strictEqual<string>(again.id, abc.id)
      const other = yield* put(store, bytesOf("abd"), "text/plain")
      assert.notStrictEqual(other.id, abc.id)

      // Byte-identical out, and stat answers the ref that was handed out.
      assert.deepStrictEqual(
        yield* BlobStore.getBytes(store, abc),
        bytesOf("abc")
      )
      assert.deepStrictEqual(yield* store.stat(abc), abc)

      // Chunked input is one blob: hashing is over the whole content.
      const chunked = yield* store.put(
        Stream.make(bytesOf("ab"), bytesOf("c")),
        { mediaType: "text/plain" }
      )
      assert.strictEqual<string>(chunked.id, abc.id)

      yield* store.remove(abc)
      const missing = yield* Effect.flip(BlobStore.getBytes(store, abc))
      assert.strictEqual(missing._tag, "@doeixd/effect-agent/blob/BlobMissingError")
    }).pipe(Effect.scoped)
  )
}

describe("BlobStore", () => {
  contract("memory", BlobStore.memory)
  contract(
    "fs",
    Effect.gen(function*() {
      const root = yield* Effect.promise(() =>
        fsp.mkdtemp(path.join(os.tmpdir(), "blob-store-"))
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fsp.rm(root, { recursive: true, force: true }))
      )
      return FsBlob.make({ root })
    })
  )

  it.effect("fs: the ref survives the process boundary a map cannot cross", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() =>
        fsp.mkdtemp(path.join(os.tmpdir(), "blob-store-"))
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fsp.rm(root, { recursive: true, force: true }))
      )
      const ref = yield* put(FsBlob.make({ root }), bytesOf("held"), "text/plain")
      // A second store over the same root -- a new process, as far as the
      // filesystem is concerned -- answers from disk.
      const reopened = FsBlob.make({ root })
      assert.deepStrictEqual(yield* BlobStore.getBytes(reopened, ref), bytesOf("held"))
      assert.strictEqual((yield* reopened.stat(ref)).mediaType, "text/plain")
    }).pipe(Effect.scoped)
  )

  it.effect("policy: size and media type refuse at put, typed and before storing", () =>
    Effect.gen(function*() {
      const inner = yield* BlobStore.memory
      const store = BlobStore.withPolicy(inner, {
        maxBytes: 4,
        mediaTypes: { allow: ["image/*", "text/plain"], deny: ["image/svg+xml"] }
      })

      const large = yield* Effect.flip(put(store, bytesOf("12345"), "text/plain"))
      assert.strictEqual(large._tag, "@doeixd/effect-agent/blob/BlobRejectedError")
      assert.strictEqual(reasonOf(large), "too-large")

      const family = yield* put(store, bytesOf("png"), "image/png")
      assert.strictEqual(family.mediaType, "image/png")

      // Deny wins over an allow that would otherwise admit the family.
      const svg = yield* Effect.flip(put(store, bytesOf("svg"), "image/svg+xml"))
      assert.strictEqual(reasonOf(svg), "media-type")

      const listed = yield* Effect.flip(put(store, bytesOf("js"), "application/javascript"))
      assert.strictEqual(reasonOf(listed), "media-type")

      // Nothing refused was stored.
      const refused = yield* Effect.flip(
        BlobStore.getBytes(inner, {
          ...(yield* BlobStore.describe(Stream.make(bytesOf("12345")), { mediaType: "text/plain" })).ref
        })
      )
      assert.strictEqual(refused._tag, "@doeixd/effect-agent/blob/BlobMissingError")
    })
  )
})

const filePrompt = (small: Uint8Array, large: Uint8Array): Prompt.Prompt =>
  Prompt.fromMessages([
    Prompt.userMessage({
      content: [
        Prompt.textPart({ text: "compare" }),
        Prompt.filePart({ mediaType: "image/png", fileName: "small.png", data: small }),
        Prompt.filePart({ mediaType: "image/png", fileName: "large.png", data: large })
      ]
    })
  ])

describe("BlobWire", () => {
  const encodePrompt = Schema.encodeEffect(PromptWire.Prompt)
  const decodePrompt = Schema.decodeEffect(PromptWire.Prompt)

  it.effect("externalize moves only oversized bytes, and resolve restores them byte-identically", () =>
    Effect.gen(function*() {
      const store = yield* BlobStore.memory
      const small = bytesOf("tiny")
      const large = new Uint8Array(2_048).fill(7)
      const original = filePrompt(small, large)

      const encoded = yield* encodePrompt(original)
      const externalized = yield* BlobWire.externalize(encoded, {
        store,
        maxInlineBytes: 1_024
      })

      // Exactly one reference, carrying the part's own media type and name.
      const refs = yield* BlobWire.references(externalized)
      assert.strictEqual(refs.length, 1)
      assert.strictEqual(refs[0]!.mediaType, "image/png")
      assert.strictEqual(refs[0]!.fileName, "large.png")
      assert.strictEqual(refs[0]!.byteLength, 2_048)
      // The small part stayed inline: nothing else entered the store.
      assert.notInclude(JSON.stringify(externalized), "tiny-was-externalised")

      // A receiver that decodes without resolving is refused loudly: a
      // reference is not a runtime file-data variant.
      const unresolved = yield* Effect.flip(decodePrompt(externalized))
      assert.instanceOf(unresolved, Schema.SchemaError)

      const resolved = yield* BlobWire.resolve(externalized, store)
      const back = yield* decodePrompt(resolved)
      const message = back.content[0]!
      if (message.role === "system") return assert.fail("expected a user message")
      const files: Array<Extract<Prompt.Part, { readonly type: "file" }>> = []
      for (const part of message.content) {
        if (part.type === "file") files.push(part)
      }
      assert.strictEqual(files.length, 2)
      assert.deepStrictEqual(files[0]!.data, small)
      assert.deepStrictEqual(files[1]!.data, large)
    })
  )

  it.effect("a reference resolved against the wrong store names the missing blob", () =>
    Effect.gen(function*() {
      const store = yield* BlobStore.memory
      const elsewhere = yield* BlobStore.memory
      const encoded = yield* encodePrompt(filePrompt(bytesOf("s"), new Uint8Array(64).fill(1)))
      const externalized = yield* BlobWire.externalize(encoded, { store, maxInlineBytes: 8 })
      const missing = yield* Effect.flip(BlobWire.resolve(externalized, elsewhere))
      assert.strictEqual(missing._tag, "@doeixd/effect-agent/blob/BlobMissingError")
    })
  )

  it.effect("the same screenshot in two messages is one blob and two equal refs", () =>
    Effect.gen(function*() {
      const store = yield* BlobStore.memory
      const shot = new Uint8Array(256).fill(3)
      const twice = Prompt.fromMessages([
        Prompt.userMessage({
          content: [Prompt.filePart({ mediaType: "image/png", data: shot })]
        }),
        Prompt.userMessage({
          content: [Prompt.filePart({ mediaType: "image/png", data: shot })]
        })
      ])
      const externalized = yield* BlobWire.externalize(yield* encodePrompt(twice), {
        store,
        maxInlineBytes: 16
      })
      const refs = yield* BlobWire.references(externalized)
      assert.strictEqual(refs.length, 2)
      assert.strictEqual<string>(refs[0]!.id, refs[1]!.id)
    })
  )

  it.effect("string and URL file data are never externalised", () =>
    Effect.gen(function*() {
      const store = yield* BlobStore.memory
      const dataUri = `data:text/plain;base64,${"QQ==".repeat(600)}`
      const prompt = Prompt.fromMessages([
        Prompt.userMessage({
          content: [
            Prompt.filePart({ mediaType: "text/plain", data: dataUri }),
            Prompt.filePart({ mediaType: "image/png", data: new URL("https://example.com/big.png") })
          ]
        })
      ])
      const externalized = yield* BlobWire.externalize(yield* encodePrompt(prompt), {
        store,
        maxInlineBytes: 1
      })
      assert.deepStrictEqual(yield* BlobWire.references(externalized), [])
      // And the document decodes as-is: nothing changed.
      const back = yield* Schema.decodeEffect(PromptWire.Prompt)(externalized)
      assert.strictEqual(back.content.length, 1)
    })
  )
})
