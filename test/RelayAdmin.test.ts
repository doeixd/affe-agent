import { assert, describe, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { Relay, RelayAdmin, RelayCredentials } from "../src/relay/index.js"

/**
 * Item 117, relay phase 13: credential administration over HTTP. The
 * operator mints a peer's credential, it authenticates, the operator counts
 * and withdraws it, and it stops authenticating -- and nobody but the
 * operator gets in.
 */

const OPERATOR = "operator-secret"
const NODE = Relay.PeerId.make("node-1")

const serve = Effect.gen(function* () {
  const credentials = yield* RelayCredentials.memory
  const built = yield* Layer.build(
    HttpRouter.serve(RelayAdmin.layer({ authorize: RelayAdmin.operatorToken(OPERATOR) }), {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provide(Layer.succeed(RelayCredentials.RelayCredentials, credentials)),
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
    )
  )
  const address = HttpServer.formatAddress((yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(built))).address)
  const call = (method: string, path: string, options?: { readonly token?: string; readonly body?: unknown }) =>
    Effect.promise(async () => {
      const response = await fetch(`${address}${path}`, {
        method,
        headers: {
          ...(options?.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          ...(options?.body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) })
      })
      return { status: response.status, body: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await response.json()) }
    })
  return { credentials, call }
})

describe("relay credential administration (item 117, phase 13)", () => {
  it.live("an operator issues a credential that authenticates, counts it, and revokes it", () =>
    Effect.gen(function* () {
      const { call, credentials } = yield* serve
      const issued = yield* call("POST", `/relay-admin/peers/${NODE}/tokens`, { token: OPERATOR })
      assert.strictEqual(issued.status, 201)
      const token = issued.body["token"]
      assert.isString(token)
      if (typeof token !== "string") return
      assert.deepStrictEqual(yield* credentials.resolve(token), Option.some(NODE))

      const counted = yield* call("GET", `/relay-admin/peers/${NODE}/tokens`, { token: OPERATOR })
      assert.deepStrictEqual(counted, { status: 200, body: { count: 1 } })

      const revoked = yield* call("POST", "/relay-admin/tokens/revoke", { token: OPERATOR, body: { token } })
      assert.strictEqual(revoked.status, 200)
      assert.isTrue(Option.isNone(yield* credentials.resolve(token)))
      assert.deepStrictEqual((yield* call("GET", `/relay-admin/peers/${NODE}/tokens`, { token: OPERATOR })).body, { count: 0 })
    }).pipe(Effect.scoped))

  it.live("no route answers anyone but the operator, and nothing is minted for them", () =>
    Effect.gen(function* () {
      const { call, credentials } = yield* serve
      for (const token of [undefined, "a-peer-token", `${OPERATOR}x`]) {
        const attempt = yield* call("POST", `/relay-admin/peers/${NODE}/tokens`, token === undefined ? {} : { token })
        assert.strictEqual(attempt.status, 401, `minted for ${token ?? "no credential"}`)
      }
      assert.deepStrictEqual(yield* credentials.issued(NODE), [])
      assert.strictEqual((yield* call("GET", `/relay-admin/peers/${NODE}/tokens`)).status, 401)
      assert.strictEqual((yield* call("POST", "/relay-admin/tokens/revoke", { body: { token: "x" } })).status, 401)
    }).pipe(Effect.scoped))

  it.live("a malformed revoke is refused, not read as revoking nothing", () =>
    Effect.gen(function* () {
      const { call } = yield* serve
      const refused = yield* call("POST", "/relay-admin/tokens/revoke", { token: OPERATOR, body: { nope: 1 } })
      assert.strictEqual(refused.status, 400)
    }).pipe(Effect.scoped))
})
