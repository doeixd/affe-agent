/**
 * What a login is made of, stored (plan-workbench.md "Auth and tenancy").
 *
 * Two records and nothing about how they are computed: a *credential* is a
 * person's password, already hashed, with the salt it was hashed under; a
 * *session* is a token, already hashed, with whose it is and when it stops
 * working. The hashing lives in the server (`Identity`), so this store is as
 * neutral as the others: a browser can hold the type, and no secret is ever
 * in a row.
 */
import { Context, Effect, Layer, Option, Ref } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { UserId } from "../domain/WorkbenchIds.js"
import { UserId as UserIdSchema } from "../domain/WorkbenchIds.js"
import { failedAs } from "./WorkbenchStorageError.js"
import type { WorkbenchStorageError } from "./WorkbenchStorageError.js"

export interface Credential {
  readonly userId: UserId
  /** The password's derived key, base64url. */
  readonly hash: string
  /** The salt it was derived under, base64url. */
  readonly salt: string
}

export interface Session {
  /** The token's digest, base64url. The token itself is only ever the holder's. */
  readonly tokenHash: string
  readonly userId: UserId
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

export interface Service {
  readonly credential: (userId: UserId) => Effect.Effect<Option.Option<Credential>, WorkbenchStorageError>
  /** Set or replace: a new account and a changed password are the same write. */
  readonly setCredential: (credential: Credential) => Effect.Effect<void, WorkbenchStorageError>
  readonly issue: (session: Session) => Effect.Effect<void, WorkbenchStorageError>
  readonly session: (tokenHash: string) => Effect.Effect<Option.Option<Session>, WorkbenchStorageError>
  /** Revoking an unknown token changes nothing. */
  readonly revoke: (tokenHash: string) => Effect.Effect<void, WorkbenchStorageError>
  /** Every session of this person's -- what a password change ends. */
  readonly revokeAll: (userId: UserId) => Effect.Effect<void, WorkbenchStorageError>
}

export class IdentityStore extends Context.Service<IdentityStore, Service>()("workbench/IdentityStore") {}

// -- Memory -----------------------------------------------------------------------------

interface State {
  readonly credentials: ReadonlyMap<UserId, Credential>
  readonly sessions: ReadonlyMap<string, Session>
}

export const memory: Layer.Layer<IdentityStore> = Layer.effect(
  IdentityStore,
  Effect.gen(function*() {
    const state = yield* Ref.make<State>({ credentials: new Map(), sessions: new Map() })
    return IdentityStore.of({
      credential: (userId) => Effect.map(Ref.get(state), (s) => Option.fromNullishOr(s.credentials.get(userId))),
      setCredential: (credential) =>
        Ref.update(state, (s) => ({ ...s, credentials: new Map(s.credentials).set(credential.userId, credential) })),
      issue: (session) => Ref.update(state, (s) => ({ ...s, sessions: new Map(s.sessions).set(session.tokenHash, session) })),
      session: (tokenHash) => Effect.map(Ref.get(state), (s) => Option.fromNullishOr(s.sessions.get(tokenHash))),
      revoke: (tokenHash) =>
        Ref.update(state, (s) => {
          const sessions = new Map(s.sessions)
          sessions.delete(tokenHash)
          return { ...s, sessions }
        }),
      revokeAll: (userId) =>
        Ref.update(state, (s) => ({
          ...s,
          sessions: new Map([...s.sessions].filter(([, session]) => session.userId !== userId))
        }))
    })
  })
)

// -- SQL --------------------------------------------------------------------------------

interface CredentialRow {
  readonly user_id: string
  readonly hash: string
  readonly salt: string
}

interface SessionRow {
  readonly token_hash: string
  readonly user_id: string
  readonly expires_at: number | bigint
}

/** Over existing tables (`sqlWithTables` creates them). Plain columns: there is nothing here to encode. */
export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  return IdentityStore.of({
    credential: (userId) =>
      client<CredentialRow>`SELECT user_id, hash, salt FROM workbench_credentials WHERE user_id = ${userId}`.pipe(
        Effect.mapError(failedAs("IdentityStore.credential")),
        Effect.map((rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row): Credential => ({
            userId: UserIdSchema.make(row.user_id),
            hash: row.hash,
            salt: row.salt
          })))
      ),
    setCredential: (credential) =>
      client`INSERT INTO workbench_credentials (user_id, hash, salt) VALUES (${credential.userId}, ${credential.hash}, ${credential.salt})
        ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt`.pipe(
        Effect.asVoid,
        Effect.mapError(failedAs("IdentityStore.setCredential"))
      ),
    issue: (session) =>
      client`INSERT INTO workbench_sessions (token_hash, user_id, expires_at) VALUES (${session.tokenHash}, ${session.userId}, ${session.expiresAt})`
        .pipe(Effect.asVoid, Effect.mapError(failedAs("IdentityStore.issue"))),
    session: (tokenHash) =>
      client<SessionRow>`SELECT token_hash, user_id, expires_at FROM workbench_sessions WHERE token_hash = ${tokenHash}`.pipe(
        Effect.mapError(failedAs("IdentityStore.session")),
        Effect.map((rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row): Session => ({
            tokenHash: row.token_hash,
            userId: UserIdSchema.make(row.user_id),
            expiresAt: Number(row.expires_at)
          })))
      ),
    revoke: (tokenHash) =>
      client`DELETE FROM workbench_sessions WHERE token_hash = ${tokenHash}`.pipe(
        Effect.asVoid,
        Effect.mapError(failedAs("IdentityStore.revoke"))
      ),
    revokeAll: (userId) =>
      client`DELETE FROM workbench_sessions WHERE user_id = ${userId}`.pipe(
        Effect.asVoid,
        Effect.mapError(failedAs("IdentityStore.revokeAll"))
      )
  })
})

/** As `sql`, creating the tables first if absent. */
export const sqlWithTables: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_credentials (
    user_id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    salt TEXT NOT NULL
  )`.pipe(Effect.orDie)
  yield* client`CREATE TABLE IF NOT EXISTS workbench_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`.pipe(Effect.orDie)
  yield* client`CREATE INDEX IF NOT EXISTS workbench_sessions_by_user ON workbench_sessions (user_id)`.pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<IdentityStore, never, SqlClient.SqlClient> = Layer.effect(IdentityStore, sqlWithTables)
