import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import * as Manifest from "../src/plugins/internal/manifest.js"

/**
 * plugin.json validation. The spec's failure split is the contract: only an
 * unknown top-level field and a non-object `extensions` are non-fatal (reported,
 * then ignored); every other violation rejects the plugin. These pin exactly
 * that boundary.
 */

const S = Manifest.SCHEMA_ID
const decode = (value: object | string) =>
  Manifest.decodeManifest(typeof value === "string" ? value : JSON.stringify(value))

const expectFail = (value: object | string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(decode(value))
    assert.isTrue(Exit.isFailure(exit), `expected rejection of ${JSON.stringify(value)}`)
  })

describe("plugin.json — fatal manifest validation", () => {
  it.effect("accepts a minimal valid manifest with no warnings", () =>
    Effect.gen(function* () {
      const { manifest, warnings } = yield* decode({ $schema: S, name: "my-plugin" })
      assert.strictEqual(manifest.name, "my-plugin")
      assert.deepStrictEqual(warnings, [])
    })
  )

  it.effect("rejects invalid JSON and a non-object document", () =>
    Effect.gen(function* () {
      yield* expectFail("{ not json")
      yield* expectFail("[]")
      yield* expectFail("\"a string\"")
    })
  )

  it.effect("rejects a missing or wrong $schema", () =>
    Effect.gen(function* () {
      yield* expectFail({ name: "x" })
      yield* expectFail({ $schema: "https://example.com/other", name: "x" })
    })
  )

  it.effect("rejects a missing or malformed name", () =>
    Effect.gen(function* () {
      yield* expectFail({ $schema: S })
      for (const bad of ["My-Plugin", "-start", "end-", "has--double", "has..dots", "", "a".repeat(65), 42]) {
        yield* expectFail({ $schema: S, name: bad })
      }
    })
  )

  it.effect("accepts valid names at the edges", () =>
    Effect.gen(function* () {
      for (const good of ["a", "acme.tools", "lint3r", "my-plugin", "a".repeat(64)]) {
        const { manifest } = yield* decode({ $schema: S, name: good })
        assert.strictEqual(manifest.name, good)
      }
    })
  )

  it.effect("rejects typed optional fields of the wrong shape", () =>
    Effect.gen(function* () {
      yield* expectFail({ $schema: S, name: "x", version: 1 })
      yield* expectFail({ $schema: S, name: "x", keywords: "not-an-array" })
      yield* expectFail({ $schema: S, name: "x", keywords: ["ok", 2] })
      yield* expectFail({ $schema: S, name: "x", author: "nope" })
      yield* expectFail({ $schema: S, name: "x", author: { name: "a", extra: "field" } })
      yield* expectFail({ $schema: S, name: "x", author: { email: 5 } })
    })
  )
})

describe("plugin.json — non-fatal exceptions", () => {
  it.effect("reports and ignores an unknown top-level field", () =>
    Effect.gen(function* () {
      const { manifest, warnings } = yield* decode({ $schema: S, name: "x", surprise: true })
      assert.strictEqual(warnings.length, 1)
      assert.strictEqual(warnings[0]?.component, "manifest")
      assert.include(warnings[0]?.detail ?? "", "surprise")
      assert.notProperty(manifest, "surprise")
    })
  )

  it.effect("reports and ignores a non-object extensions field", () =>
    Effect.gen(function* () {
      const { manifest, warnings } = yield* decode({ $schema: S, name: "x", extensions: "nope" })
      assert.strictEqual(warnings.length, 1)
      assert.include(warnings[0]?.detail ?? "", "extensions")
      assert.isUndefined(manifest.extensions)
    })
  )

  it.effect("keeps an extensions object without inspecting unknown namespaces", () =>
    Effect.gen(function* () {
      const extensions = { "com.example.client": { setting: true } }
      const { manifest, warnings } = yield* decode({ $schema: S, name: "x", extensions })
      assert.deepStrictEqual(warnings, [])
      assert.deepStrictEqual(manifest.extensions, extensions)
    })
  )

  it.effect("carries valid optional metadata through", () =>
    Effect.gen(function* () {
      const { manifest } = yield* decode({
        $schema: S,
        name: "x",
        version: "1.2.3",
        author: { name: "a", email: "a@b.c" },
        keywords: ["ai", "agent"]
      })
      assert.strictEqual(manifest.version, "1.2.3")
      assert.deepStrictEqual(manifest.author, { name: "a", email: "a@b.c" })
      assert.deepStrictEqual(manifest.keywords, ["ai", "agent"])
    })
  )
})
