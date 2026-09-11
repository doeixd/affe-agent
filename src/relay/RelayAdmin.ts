import { Effect, Layer, Schema } from "effect"
import type { Headers } from "effect/unstable/http"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Relay from "./Relay.js"
import { RelayCredentials } from "./RelayCredentials.js"

/**
 * Credential administration for a relay, over HTTP (item 117, relay phase 13).
 *
 * Enrolment and revocation already exist (`RelayCredentials`); what an
 * operator lacked was a way to do them without code on the relay's machine.
 * Three routes, under `path` (default `/relay-admin`):
 *
 * - `POST {path}/peers/:peer/tokens` issues a credential for a peer and
 *   answers `{ token }` -- the only time the plaintext is ever shown, since
 *   the store keeps digests;
 * - `GET {path}/peers/:peer/tokens` answers `{ count }`: how many credentials
 *   speak for that peer, never the secrets;
 * - `POST {path}/tokens/revoke` with `{ token }` withdraws one. In the body,
 *   not the path: a credential in a URL ends up in access logs.
 *
 * Not here, by design: the peer directory, which any authenticated peer
 * already reads through the relay's own `peers` call, and the counters,
 * which `RelayServer.metrics` hands to whatever exporter the deployment runs.
 *
 * `authorize` is required, as the relay's routing rule is: this surface
 * mints credentials, and an open one is an open relay. `operatorToken` is
 * the simplest honest answer.
 */

export interface Options {
  /** Decides whether a request may administer the relay. `false` answers 401. */
  readonly authorize: (headers: Headers.Headers) => Effect.Effect<boolean>
  /** Where the routes are mounted. Default `/relay-admin`. */
  readonly path?: `/${string}` | undefined
}

const encoder = new TextEncoder()
const digest = (value: string) =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", encoder.encode(value))).pipe(
    Effect.map((hash) => new Uint8Array(hash))
  )

/**
 * One operator credential, presented as `Authorization: Bearer <token>`.
 * Compared as digests of equal length, so the comparison does not leak how
 * much of a guess was right.
 */
export const operatorToken = (token: string): Options["authorize"] => {
  const expected = digest(token)
  return (headers) =>
    Effect.gen(function* () {
      const presented = headers["authorization"]
      if (presented === undefined || !presented.startsWith("Bearer ")) return false
      const [a, b] = yield* Effect.all([expected, digest(presented.slice("Bearer ".length))])
      let difference = 0
      for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!
      return difference === 0
    })
}

const PeerPath = Schema.Struct({ peer: Relay.PeerId })
const RevokeBody = Schema.Struct({ token: Schema.String })

const status = (code: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status: code })

/** The routes, over the `RelayCredentials` the relay authenticates with. */
export const layer = (options: Options): Layer.Layer<never, never, HttpRouter.HttpRouter | RelayCredentials> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const credentials = yield* RelayCredentials
      const base = (options.path ?? "/relay-admin").replace(/\/+$/, "") as `/${string}`
      const guarded = (
        handle: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          never,
          HttpRouter.RouteContext | HttpServerRequest.HttpServerRequest
        >
      ) =>
      (request: HttpServerRequest.HttpServerRequest) =>
        Effect.flatMap(options.authorize(request.headers), (allowed) =>
          allowed ? handle(request) : Effect.succeed(status(401, "not an operator")))

      const peerOf = HttpRouter.schemaPathParams(PeerPath).pipe(
        Effect.mapError(() => status(400, "not a peer id"))
      )
      const unavailable = () => status(503, "the credential store could not answer")

      yield* router.add("POST", `${base}/peers/:peer/tokens`, guarded(() =>
        Effect.gen(function* () {
          const { peer } = yield* peerOf
          const token = yield* credentials.issue(peer).pipe(Effect.mapError(unavailable))
          return HttpServerResponse.jsonUnsafe({ token }, { status: 201 })
        }).pipe(Effect.catch(Effect.succeed))))

      yield* router.add("GET", `${base}/peers/:peer/tokens`, guarded(() =>
        Effect.gen(function* () {
          const { peer } = yield* peerOf
          const issued = yield* credentials.issued(peer).pipe(Effect.mapError(unavailable))
          return HttpServerResponse.jsonUnsafe({ count: issued.length })
        }).pipe(Effect.catch(Effect.succeed))))

      yield* router.add("POST", `${base}/tokens/revoke`, guarded(() =>
        Effect.gen(function* () {
          const { token } = yield* HttpServerRequest.schemaBodyJson(RevokeBody).pipe(
            Effect.mapError(() => status(400, "expected { token }"))
          )
          yield* credentials.revoke(token).pipe(Effect.mapError(unavailable))
          return HttpServerResponse.jsonUnsafe({ revoked: true })
        }).pipe(Effect.catch(Effect.succeed))))
    }))
