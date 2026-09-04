import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { isStorageError, StorageError } from "../Errors.js"
import { detailOf } from "../internal/detail.js"
import * as Relay from "./Relay.js"
import { RelayAuthenticator } from "./RelayServer.js"
import { escapeIdentifier } from "../internal/sqlIdentifier.js"

/**
 * Enrollment: which credentials exist, and who they speak for.
 *
 * `RelayServer.bearerTokens` is the whole scheme in its simplest form -- a
 * fixed map, decided at startup. It is honest for a single deployment and
 * useless for anything that has to add a node on a Tuesday, because there is
 * nowhere to write one. This is the same seam with a store behind it, so
 * enrollment, rotation and revocation become writes rather than restarts, and
 * the relay's routing does not change when they do.
 *
 * **Tokens are stored as digests, never as themselves.** A relay's credential
 * table is a list of things that authenticate as somebody, and a reader of
 * that table should not be able to become them. `issue` therefore hands the
 * plaintext back exactly once and keeps only its SHA-256; `resolve` hashes
 * what was presented and looks *that* up. Losing a token means issuing another
 * one, which is the correct amount of inconvenience.
 */

export interface Service {
  /**
   * The peer this token speaks for, or `None` if it speaks for nobody.
   *
   * `None` is "no such credential", which is an answer. A `StorageError` is
   * "the question could not be asked", which is not -- see `authenticator`
   * for why the difference matters more here than it looks.
   */
  readonly resolve: (
    token: string
  ) => Effect.Effect<Option.Option<Relay.PeerId>, StorageError>
  /** Enrol a peer. The returned plaintext is not recoverable afterwards. */
  readonly issue: (peer: Relay.PeerId) => Effect.Effect<string, StorageError>
  /** Withdraw one credential. Silent when it was not there: revoking twice is not an error. */
  readonly revoke: (token: string) => Effect.Effect<void, StorageError>
  /** Every credential a peer holds, as digests. For an operator answering "what can reach this?". */
  readonly issued: (peer: Relay.PeerId) => Effect.Effect<ReadonlyArray<string>, StorageError>
}

export class RelayCredentials extends Context.Service<RelayCredentials, Service>()(
  "@doeixd/effect-agent/relay/RelayCredentials"
) {}

const encoder = new TextEncoder()

/** SHA-256, hex. `crypto.subtle` rather than a host module, so this runs where the relay does. */
const digest = (token: string): Effect.Effect<string> =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", encoder.encode(token))).pipe(
    Effect.map((hash) =>
      Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
    )
  )

/** A token with enough entropy that guessing is not a strategy. */
const mint = (): string => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * An authenticator over whatever store is provided.
 *
 * **A store that cannot answer must not say "unauthorized".** The two are
 * different facts and the relay client treats them very differently: an
 * unauthorized connection is *terminal*, because retrying a wrong credential
 * is a slower way of being wrong, so folding a database blip into that answer
 * would permanently disconnect every node in the fleet over a transient. The
 * `StorageError` is passed through as itself, which the client sees as
 * retryable, and the node comes back when the store does.
 */
export const authenticator: Layer.Layer<RelayAuthenticator, never, RelayCredentials> = Layer.effect(
  RelayAuthenticator,
  Effect.map(RelayCredentials, (credentials) => ({
    authenticate: (headers) => {
      const authorization = headers["authorization"]
      if (authorization === undefined) {
        return Effect.fail(new Relay.RelayUnauthorizedError({ reason: "no authorization header" }))
      }
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : authorization
      return Effect.flatMap(
        credentials.resolve(token),
        Option.match({
          onNone: () =>
            Effect.fail(new Relay.RelayUnauthorizedError({ reason: "unknown credential" })),
          onSome: Effect.succeed
        })
      )
    }
  }))
)

/** Credentials in memory: for tests and single-process development. Dies with the process. */
export const memory: Effect.Effect<Service> = Effect.sync(() => {
  const byDigest = new Map<string, Relay.PeerId>()
  return {
    resolve: (token) => Effect.map(digest(token), (hashed) => Option.fromNullishOr(byDigest.get(hashed))),
    issue: (peer) =>
      Effect.gen(function* () {
        const token = mint()
        byDigest.set(yield* digest(token), peer)
        return token
      }),
    revoke: (token) => Effect.map(digest(token), (hashed) => void byDigest.delete(hashed)),
    issued: (peer) =>
      Effect.sync(() =>
        [...byDigest].filter(([, held]) => held === peer).map(([hashed]) => hashed)
      )
  }
})


export const sqlTable = "relay_credentials"

export interface SqlOptions {
  readonly table?: string | undefined
}

/**
 * Credentials in SQL. The table needs a primary-key `token_digest` and a `peer`.
 *
 * `sqlWithTable` creates it; this one assumes a deployment that manages its
 * own migrations, which is the usual arrangement for anything holding
 * credentials.
 */
export const sql = (
  options?: SqlOptions
): Effect.Effect<Service, never, SqlClient.SqlClient> =>
  Effect.map(SqlClient.SqlClient, (client) => {
    const table = client.literal(escapeIdentifier(options?.table ?? sqlTable))
    const storage =
      (operation: string) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, StorageError> =>
        Effect.mapError(effect, (cause): StorageError =>
          isStorageError(cause)
            ? cause
            : new StorageError({ operation: `RelayCredentials.${operation}`, detail: detailOf(cause) }))
    return {
      resolve: (token) =>
        Effect.gen(function* () {
          const hashed = yield* digest(token)
          const rows = yield* client<{ readonly peer: string }>`
            SELECT peer FROM ${table} WHERE token_digest = ${hashed}
          `.pipe(storage("resolve"))
          const first = rows[0]
          return first === undefined
            ? Option.none()
            : Option.some(Relay.PeerId.make(first.peer))
        }),
      issue: (peer) =>
        Effect.gen(function* () {
          const token = mint()
          const hashed = yield* digest(token)
          yield* client`
            INSERT INTO ${table} ${client.insert({ token_digest: hashed, peer })}
          `.pipe(storage("issue"))
          return token
        }),
      revoke: (token) =>
        Effect.gen(function* () {
          const hashed = yield* digest(token)
          yield* client`DELETE FROM ${table} WHERE token_digest = ${hashed}`.pipe(storage("revoke"))
        }),
      issued: (peer) =>
        client<{ readonly token_digest: string }>`
          SELECT token_digest FROM ${table} WHERE peer = ${peer}
        `.pipe(
          storage("issued"),
          Effect.map((rows) => rows.map((row) => row.token_digest))
        )
    }
  })

/** As `sql`, but creates the table first if it is not there. */
export const sqlWithTable = (
  options?: SqlOptions
): Effect.Effect<Service, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    const table = client.literal(escapeIdentifier(options?.table ?? sqlTable))
    yield* Effect.orDie(client`CREATE TABLE IF NOT EXISTS ${table} (
      token_digest TEXT PRIMARY KEY,
      peer TEXT NOT NULL
    )`)
    yield* Effect.orDie(
      client`CREATE INDEX IF NOT EXISTS ${client.literal(`${escapeIdentifier(options?.table ?? sqlTable)}_peer`)} ON ${table} (peer)`
    )
    return yield* sql(options)
  })
