import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { Headers } from "effect/unstable/http"
import { Credentials, OpenApi } from "../src/toolSource/index.js"

/**
 * `docs/plan-tool-credentials.md`: method, binding and provider kept apart;
 * the value exists in the clear only inside `render`; a failure is typed
 * and says whether reauth would help; the whole thing plugs into a source's
 * per-invocation `headers` hook unchanged.
 */
describe("Credentials", () => {
  it("render is total: placements, prefixes, literals, and a missing variable skipped", () => {
    const method: Credentials.Method = {
      kind: "apikey",
      placements: [
        { carrier: "header", name: "DD-API-KEY", variable: "apiKey" },
        { carrier: "header", name: "DD-APPLICATION-KEY", variable: "appKey" },
        { carrier: "header", name: "X-Client", literal: "affe-agent" },
        { carrier: "query", name: "site", variable: "site" }
      ]
    }
    // Two variables are two inputs; the literal is none; a repeated variable would be one.
    assert.deepStrictEqual(Credentials.requiredVariables(method), ["apiKey", "appKey", "site"])
    const rendered = Credentials.render(method, {
      apiKey: Redacted.make("a-1"),
      appKey: Redacted.make("b-2")
      // `site` deliberately absent
    })
    assert.deepStrictEqual(rendered, {
      headers: { "DD-API-KEY": "a-1", "DD-APPLICATION-KEY": "b-2", "X-Client": "affe-agent" },
      query: {}
    })
    assert.deepStrictEqual(Credentials.render(Credentials.none, {}), { headers: {}, query: {} })
    assert.deepStrictEqual(
      Credentials.render(Credentials.bearer(), { token: Redacted.make("t") }).headers,
      { Authorization: "Bearer t" }
    )
    assert.deepStrictEqual(Credentials.render(Credentials.query("key"), { token: Redacted.make("q") }).query, { key: "q" })
  })

  it.effect("a binding holds handles, the provider holds values, and resolve joins them per call", () =>
    Effect.gen(function* () {
      const github = Credentials.binding({
        integration: "github",
        method: Credentials.bearer(),
        values: { token: "github/pat" }
      })
      assert.strictEqual(github.owner, "org")
      const headers = yield* Credentials.headers(github)
      assert.strictEqual(Option.getOrUndefined(Headers.get(headers, "authorization")), "Bearer ghp_first")

      // Per call: a rotated value is what the next call sees.
      const provider = yield* Credentials.Provider
      yield* provider.set!("github/pat", Redacted.make("ghp_second"))
      const again = yield* Credentials.headers(github)
      assert.strictEqual(Option.getOrUndefined(Headers.get(again, "authorization")), "Bearer ghp_second")
    }).pipe(Effect.provide(Credentials.fromValues({ "github/pat": "ghp_first" })))
  )

  it.effect("a missing handle and an empty provider are typed failures that say whether reauth helps", () =>
    Effect.gen(function* () {
      const unbound = Credentials.binding({ integration: "github", method: Credentials.bearer() })
      const noHandle = yield* Effect.flip(Credentials.resolve(unbound))
      assert.strictEqual(noHandle.reason, "missing")
      assert.isFalse(noHandle.reauthRequired)

      const bound = Credentials.binding({ integration: "github", method: Credentials.bearer(), values: { token: "github/pat" } })
      const gone = yield* Effect.flip(Credentials.resolve(bound))
      assert.strictEqual(gone.reason, "missing")
      assert.strictEqual(gone.handle, "github/pat")
      assert.isTrue(gone.reauthRequired)
    }).pipe(Effect.provide(Credentials.fromValues()))
  )

  it.effect("fromConfig reads handles as Config keys and is read-only", () =>
    Effect.gen(function* () {
      const provider = yield* Credentials.Provider
      assert.isFalse(provider.writable)
      const binding = Credentials.binding({ integration: "brave", method: Credentials.header("X-Subscription-Token"), values: { token: "BRAVE_KEY" } })
      const headers = yield* Credentials.headers(binding)
      assert.strictEqual(Option.getOrUndefined(Headers.get(headers, "x-subscription-token")), "brave-secret")
      const absent = yield* provider.get("NOT_SET")
      assert.isTrue(Option.isNone(absent))
    }).pipe(
      // The provider reads `Config` where `get` runs, so the config source is
      // provided to the caller, not to the provider layer's construction.
      Effect.provide(
        Layer.mergeAll(Credentials.fromConfig, ConfigProvider.layer(ConfigProvider.fromUnknown({ BRAVE_KEY: "brave-secret" })))
      )
    )
  )

  it.effect("readOnly refuses writes and keeps reads", () =>
    Effect.gen(function* () {
      const inner = yield* Credentials.Provider
      const guarded = Credentials.readOnly(inner)
      const refused = yield* Effect.flip(guarded.set!("h", Redacted.make("v")))
      assert.strictEqual(refused.reason, "readOnly")
      assert.deepStrictEqual(Option.map(yield* guarded.get("h"), Redacted.value), Option.some("kept"))
    }).pipe(Effect.provide(Credentials.fromValues({ h: "kept" })))
  )

  it("a Redacted value does not leak through printing", () => {
    const value = Redacted.make("hunter2")
    assert.notInclude(String(value), "hunter2")
    assert.notInclude(JSON.stringify({ value }), "hunter2")
  })

  it.effect("the sources' headers hook takes it unchanged: the credential reaches the wire and nothing else", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; headers: Record<string, string> }> = []
      const fetchImpl: typeof fetch = async (input, init) => {
        const headers: Record<string, string> = {}
        new globalThis.Headers(init?.headers).forEach((value, key) => {
          headers[key] = value
        })
        seen.push({ url: String(input), headers })
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
      }
      const spec = {
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: { "/me": { get: { operationId: "me", responses: { "200": { description: "ok" } } } } }
      }
      const github = Credentials.binding({ integration: "github", method: Credentials.bearer(), values: { token: "github/pat" } })
      const source = OpenApi.makeOpenApiSource("github", spec, {
        endpoint: "https://api.example.test",
        fetchImpl,
        headers: Credentials.headers(github).pipe(Effect.provide(Credentials.fromValues({ "github/pat": "ghp_wire" })))
      })
      const extraction = yield* source.extract
      // The tool the model sees carries no credential in any form.
      assert.notInclude(JSON.stringify(extraction), "ghp_wire")
      assert.notInclude(JSON.stringify(extraction), "github/pat")
      yield* source.invoke("me", {})
      assert.strictEqual(seen[0]?.headers["authorization"], "Bearer ghp_wire")
    })
  )
})
