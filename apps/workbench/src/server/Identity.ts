/**
 * Real identity (plan-workbench.md "Auth and tenancy"; control plane §5):
 * a person is someone who knows a password, and a bearer token is one the
 * server issued to them and has not ended.
 *
 * Nothing secret is stored. A password becomes a PBKDF2 key under a fresh
 * salt; a token is 32 random bytes the holder keeps and the store knows
 * only by digest. Web Crypto does both, so this runs wherever the server
 * does. Configured tokens (`Tokens`) keep working beside issued ones -- the
 * local deployment is the same code path with one constant token, and it
 * is how the first account gets made.
 */
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Redacted } from "effect"
import { UserId } from "../domain/WorkbenchIds.js"
import { InvalidCredentialsError, UserExistsError } from "../protocol/Authentication.js"
import { IdentityStore } from "../store/IdentityStore.js"
import type { Credential } from "../store/IdentityStore.js"
import type { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"
import { TokenResolver, Tokens } from "./Authentication.js"

export interface Issued {
  readonly token: string
  readonly expiresAt: DateTime.Utc
}

export interface Service {
  /** A token for whoever proves the password. Wrong person and wrong password are one answer. */
  readonly login: (
    userId: UserId,
    password: Redacted.Redacted
  ) => Effect.Effect<Issued, InvalidCredentialsError | WorkbenchStorageError>
  readonly register: (userId: UserId, password: Redacted.Redacted) => Effect.Effect<void, UserExistsError | WorkbenchStorageError>
  /** Replace the password and end every session it had opened. */
  readonly setPassword: (userId: UserId, password: Redacted.Redacted) => Effect.Effect<void, WorkbenchStorageError>
  readonly logout: (token: string) => Effect.Effect<void, WorkbenchStorageError>
  /** Whose an issued token is, if it was issued and has not ended. */
  readonly resolve: (token: string) => Effect.Effect<Option.Option<UserId>, WorkbenchStorageError>
}

export class Identity extends Context.Service<Identity, Service>()("workbench/Identity") {}

export interface Options {
  /** How long an issued token works. Default 30 days. */
  readonly sessionTtl?: Duration.Duration | undefined
}

export const defaultSessionTtl = Duration.days(30)

// -- Crypto ---------------------------------------------------------------------------------

const encoder = new TextEncoder()

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const randomBytes = (size: number): Effect.Effect<Uint8Array> =>
  Effect.sync(() => globalThis.crypto.getRandomValues(new Uint8Array(size)))

/** The digest a token is stored under. */
export const digest = (token: string): Effect.Effect<string> =>
  Effect.promise(async () => base64url(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(token)))))

/** PBKDF2-SHA256, 210k rounds (OWASP's 2023 floor), 32-byte key. */
export const derive = (password: string, salt: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await globalThis.crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
    const bits = await globalThis.crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 210_000 },
      key,
      256
    )
    return base64url(new Uint8Array(bits))
  })

/** Constant-time on equal lengths; lengths differ only when the stored hash is not this module's. */
const same = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// -- The service ----------------------------------------------------------------------------

export const layer = (options?: Options): Layer.Layer<Identity, never, IdentityStore> =>
  Layer.effect(
    Identity,
    Effect.gen(function*() {
      const store = yield* IdentityStore
      const ttl = options?.sessionTtl ?? defaultSessionTtl

      const credentialOf = Effect.fn("Identity.credentialOf")(function*(userId: UserId, password: Redacted.Redacted) {
        const salt = base64url(yield* randomBytes(16))
        const hash = yield* derive(Redacted.value(password), salt)
        const credential: Credential = { userId, hash, salt }
        return credential
      })

      const login = Effect.fn("Identity.login")(function*(userId: UserId, password: Redacted.Redacted) {
        const found = yield* store.credential(userId)
        // Derive against a throwaway salt when there is no account, so the
        // answer takes as long either way.
        const salt = Option.match(found, { onNone: () => "no-such-account", onSome: (c) => c.salt })
        const hash = yield* derive(Redacted.value(password), salt)
        if (Option.isNone(found) || !same(hash, found.value.hash)) {
          return yield* new InvalidCredentialsError({ userId })
        }
        const token = base64url(yield* randomBytes(32))
        const now = yield* Clock.currentTimeMillis
        const expiresAt = now + Duration.toMillis(ttl)
        yield* store.issue({ tokenHash: yield* digest(token), userId, expiresAt })
        return { token, expiresAt: DateTime.makeUnsafe(expiresAt) }
      })

      const register = Effect.fn("Identity.register")(function*(userId: UserId, password: Redacted.Redacted) {
        if (Option.isSome(yield* store.credential(userId))) {
          return yield* new UserExistsError({ userId })
        }
        yield* store.setCredential(yield* credentialOf(userId, password))
      })

      const setPassword = Effect.fn("Identity.setPassword")(function*(userId: UserId, password: Redacted.Redacted) {
        yield* store.setCredential(yield* credentialOf(userId, password))
        yield* store.revokeAll(userId)
      })

      const logout = Effect.fn("Identity.logout")(function*(token: string) {
        yield* store.revoke(yield* digest(token))
      })

      const resolve = Effect.fn("Identity.resolve")(function*(token: string) {
        const session = yield* store.session(yield* digest(token))
        if (Option.isNone(session)) return Option.none<UserId>()
        const now = yield* Clock.currentTimeMillis
        if (session.value.expiresAt <= now) {
          // Ended: forget it, and answer as for a token never issued.
          yield* store.revoke(session.value.tokenHash)
          return Option.none<UserId>()
        }
        return Option.some(session.value.userId)
      })

      return Identity.of({ login, register, setPassword, logout, resolve })
    })
  )

/** Configured tokens first, then issued ones. */
export const tokenResolver: Layer.Layer<TokenResolver, never, Tokens | Identity> = Layer.effect(
  TokenResolver,
  Effect.gen(function*() {
    const known = yield* Tokens
    const identity = yield* Identity
    return TokenResolver.of((token) => {
      const configured = known.get(token)
      return configured === undefined ? identity.resolve(token) : Effect.succeed(Option.some(configured))
    })
  })
)
