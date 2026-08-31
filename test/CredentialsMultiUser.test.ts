import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { CurrentPrincipal } from "../src/Principal.js"
import { Credentials, OpenApi } from "../src/toolSource/index.js"

/**
 * The multi-user half of the credentials contract
 * (`plan-tool-credentials.md` §6–7), unblocked by `CurrentPrincipal`:
 * per-subject bindings chosen per call, query placements reaching the
 * wire, and methods derived from `securitySchemes` instead of typed by
 * hand.
 */

const orgBinding = Credentials.binding({
  integration: "github",
  method: Credentials.bearer(),
  values: { token: "org-token" }
})

const aliceBinding = Credentials.binding({
  integration: "github",
  method: Credentials.bearer(),
  owner: "user",
  values: { token: "alice-token" }
})

const providers = Layer.mergeAll(
  Credentials.fromValues({
    "org-token": "org-secret",
    "alice-token": "alice-secret"
  }),
  Credentials.bindings([
    { binding: orgBinding },
    { binding: aliceBinding, subject: "user:alice" }
  ])
)

const authorizationOf = (rendered: Credentials.Rendered): string | undefined =>
  rendered.headers["Authorization"]

describe("Credentials.resolveFor", () => {
  it.effect("the subject's own binding wins; everyone else falls back to org", () =>
    Effect.gen(function*() {
      const asAlice = yield* Credentials.resolveFor("github").pipe(
        Effect.provideService(CurrentPrincipal, Option.some("user:alice"))
      )
      assert.strictEqual(authorizationOf(asAlice), "Bearer alice-secret")

      const asBob = yield* Credentials.resolveFor("github").pipe(
        Effect.provideService(CurrentPrincipal, Option.some("user:bob"))
      )
      assert.strictEqual(authorizationOf(asBob), "Bearer org-secret")

      // No subject on the fibre -- a run outside any host -- is the org's.
      const asNobody = yield* Credentials.resolveFor("github")
      assert.strictEqual(authorizationOf(asNobody), "Bearer org-secret")
    }).pipe(Effect.provide(providers))
  )

  it.effect("a subject with nothing to fall back to is asked to connect; a bare misconfiguration is not", () =>
    Effect.gen(function*() {
      // The integration exists nowhere: with a subject present this is
      // "connect your Slack" (reauthRequired), without one it is a
      // configuration gap.
      const forCarol = yield* Effect.flip(
        Credentials.resolveFor("slack").pipe(
          Effect.provideService(CurrentPrincipal, Option.some("user:carol"))
        )
      )
      assert.strictEqual(forCarol.reason, "missing")
      assert.isTrue(forCarol.reauthRequired)

      const forNobody = yield* Effect.flip(Credentials.resolveFor("slack"))
      assert.isFalse(forNobody.reauthRequired)
    }).pipe(Effect.provide(providers))
  )

  it("a user-owned binding without a subject is refused at construction", () => {
    assert.throws(
      () =>
        Effect.runSync(
          Layer.build(Credentials.bindings([{ binding: aliceBinding }])).pipe(
            Effect.scoped
          )
        ),
      /names no subject/
    )
  })
})

const querySpec = {
  openapi: "3.0.0",
  paths: {
    "/search": {
      get: {
        operationId: "search",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" } }
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } }
      }
    }
  }
} as const

describe("query placements on the wire", () => {
  it.effect("a query-carried credential lands on the URL, and a tool argument cannot shadow it", () =>
    Effect.gen(function*() {
      const urls: Array<string> = []
      const fakeFetch: typeof fetch = async (input) => {
        urls.push(String(input))
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      }
      const binding = Credentials.binding({
        integration: "maps",
        method: Credentials.query("api_key"),
        values: { token: "maps-key" }
      })
      const source = OpenApi.makeOpenApiSource("maps", querySpec, {
        endpoint: "https://api.example.com",
        fetchImpl: fakeFetch,
        credentials: Credentials.resolve(binding).pipe(
          Effect.provide(Credentials.fromValues({ "maps-key": "k-123" }))
        )
      })
      yield* source.invoke("search", { q: "coffee" })
      assert.strictEqual(urls.length, 1)
      const url = new URL(urls[0]!)
      assert.strictEqual(url.searchParams.get("q"), "coffee")
      assert.strictEqual(url.searchParams.get("api_key"), "k-123")

      // The model cannot supply api_key itself: the schema refuses unknown
      // parameters, so the only path to that query name is the credential.
      const refused = yield* Effect.flip(
        source.invoke("search", { api_key: "attacker", q: "x" })
      )
      assert.include(String(refused), "unknown parameter")
    })
  )
})

describe("Credentials.methodFromOpenApi", () => {
  it("schemes in one security requirement are required together, variables named by scheme", () => {
    const { method, skipped } = Credentials.methodFromOpenApi({
      components: {
        securitySchemes: {
          apiKeyAuth: { type: "apiKey", in: "header", name: "DD-API-KEY" },
          appKeyAuth: { type: "apiKey", in: "query", name: "application_key" },
          unusedOauth: { type: "oauth2", flows: {} }
        }
      },
      security: [{ apiKeyAuth: [], appKeyAuth: [] }]
    })
    assert.deepStrictEqual(skipped, [])
    assert.deepStrictEqual(
      Credentials.requiredVariables(method).slice().sort(),
      ["apiKeyAuth", "appKeyAuth"]
    )
    assert.strictEqual(method.kind, "apikey")
    if (method.kind === "apikey") {
      assert.deepStrictEqual(method.placements, [
        { carrier: "header", name: "DD-API-KEY", variable: "apiKeyAuth" },
        { carrier: "query", name: "application_key", variable: "appKeyAuth" }
      ])
    }
  })

  it("bearer derives; basic, oauth2 and cookie are refused with reasons; no schemes derives none", () => {
    const bearer = Credentials.methodFromOpenApi({
      components: { securitySchemes: { auth: { type: "http", scheme: "bearer" } } }
    })
    assert.deepStrictEqual(bearer.skipped, [])
    if (bearer.method.kind === "apikey") {
      assert.deepStrictEqual(bearer.method.placements, [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "auth" }
      ])
    } else {
      assert.fail("bearer should derive placements")
    }

    const refused = Credentials.methodFromOpenApi({
      components: {
        securitySchemes: {
          basic: { type: "http", scheme: "basic" },
          oauth: { type: "oauth2", flows: {} },
          cookie: { type: "apiKey", in: "cookie", name: "session" }
        }
      }
    })
    assert.strictEqual(refused.method.kind, "none")
    assert.deepStrictEqual(refused.skipped.map((entry) => entry.name).sort(), [
      "basic",
      "cookie",
      "oauth"
    ])

    assert.deepStrictEqual(Credentials.methodFromOpenApi({}), {
      method: Credentials.none,
      skipped: []
    })
  })
})
