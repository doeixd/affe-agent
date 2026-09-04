import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Scope } from "effect"
import { Headers } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { StorageError } from "../src/Errors.js"
import { Relay, RelayCredentials, RelayServer } from "../src/relay/index.js"

/**
 * Enrollment (`docs/plan-failure-paths.md` 48e, the last of the relay's
 * original scope).
 *
 * `bearerTokens` is a fixed map decided at startup, which is honest for one
 * deployment and useless for anything that has to add a node on a Tuesday.
 * These hold the store-backed version to the same seam, and to two properties
 * a fixed map never had to think about: what is written down, and what happens
 * when the thing holding it cannot answer.
 */

const NODE = Relay.PeerId.make("node-1")
const OTHER = Relay.PeerId.make("node-2")

const bearer = (token: string) => Headers.fromInput({ authorization: `Bearer ${token}` })

/** Everything a credential store owes, whatever is behind it. */
const cases = (
  name: string,
  store: Effect.Effect<RelayCredentials.Service, never, Scope.Scope>
) => {
  const authenticate = (
    credentials: RelayCredentials.Service,
    headers: Headers.Headers
  ) =>
    Effect.flatMap(
      Effect.service(RelayServer.RelayAuthenticator),
      (auth) => auth.authenticate(headers)
    ).pipe(
      Effect.provide(
        RelayCredentials.authenticator.pipe(
          Layer.provide(Layer.succeed(RelayCredentials.RelayCredentials, credentials))
        )
      )
    )

  describe(`relay credentials (${name})`, () => {
    it.effect("an issued credential authenticates as the peer it was issued to", () =>
      Effect.gen(function* () {
        const credentials = yield* store
        const token = yield* credentials.issue(NODE)
        assert.strictEqual(yield* authenticate(credentials, bearer(token)), NODE)

        // Two peers, two tokens, no confusion between them.
        const other = yield* credentials.issue(OTHER)
        assert.strictEqual(yield* authenticate(credentials, bearer(other)), OTHER)
      }).pipe(Effect.scoped)
    )

    it.effect("the plaintext is not what gets written down", () =>
      Effect.gen(function* () {
        const credentials = yield* store
        const token = yield* credentials.issue(NODE)
        const held = yield* credentials.issued(NODE)

        assert.strictEqual(held.length, 1)
        // The point of the digest: someone who can read the store cannot
        // become the node, because what is stored is not what authenticates.
        assert.notInclude(held, token, "the store kept the token itself")
        assert.strictEqual(held[0]?.length, 64, "not a SHA-256 digest")
      }).pipe(Effect.scoped)
    )

    it.effect("an unknown or absent credential is refused", () =>
      Effect.gen(function* () {
        const credentials = yield* store
        const unknown = yield* Effect.flip(authenticate(credentials, bearer("not-a-token")))
        assert.strictEqual(unknown._tag, "@doeixd/effect-agent/relay/RelayUnauthorizedError")

        const absent = yield* Effect.flip(authenticate(credentials, Headers.empty))
        assert.strictEqual(absent._tag, "@doeixd/effect-agent/relay/RelayUnauthorizedError")
      }).pipe(Effect.scoped)
    )

    it.effect("a revoked credential stops working, and revoking twice is not an error", () =>
      Effect.gen(function* () {
        const credentials = yield* store
        const token = yield* credentials.issue(NODE)
        const keep = yield* credentials.issue(NODE)

        yield* credentials.revoke(token)
        const refused = yield* Effect.flip(authenticate(credentials, bearer(token)))
        assert.strictEqual(refused._tag, "@doeixd/effect-agent/relay/RelayUnauthorizedError")

        // Rotation, which is the reason revocation exists: the other
        // credential for the same peer is untouched.
        assert.strictEqual(yield* authenticate(credentials, bearer(keep)), NODE)
        yield* credentials.revoke(token)
        assert.deepStrictEqual((yield* credentials.issued(NODE)).length, 1)
      }).pipe(Effect.scoped)
    )
  })
}

cases("memory", RelayCredentials.memory)

const database = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "relay-cred-")), "c.db")
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

cases(
  "sqlite",
  Effect.gen(function* () {
    const file = yield* database
    // Built into the *test's* scope rather than provided to one effect: an
    // `Effect.provide` here would close the client the moment the store was
    // constructed, and every later call would meet a database that had been
    // taken away underneath it.
    const client = yield* Layer.build(SqliteClient.layer({ filename: file }))
    return yield* Effect.provide(RelayCredentials.sqlWithTable(), client)
  })
)

describe("relay credentials: a store that cannot answer", () => {
  it.effect("says so, rather than calling the credential bad", () =>
    Effect.gen(function* () {
      /**
       * The distinction the whole design turns on.
       *
       * `RelayClient` treats an unauthorized answer as *terminal* -- retrying
       * a wrong credential is a slower way of being wrong -- so an
       * authenticator that reported a database blip as "unknown credential"
       * would take every node in a fleet permanently offline over a
       * transient, and each would say the operator had misconfigured it.
       */
      const broken: RelayCredentials.Service = {
        resolve: () =>
          Effect.fail(new StorageError({ operation: "RelayCredentials.resolve", detail: "down" })),
        issue: () =>
          Effect.fail(new StorageError({ operation: "RelayCredentials.issue", detail: "down" })),
        revoke: () => Effect.void,
        issued: () => Effect.succeed([])
      }

      const failure = yield* Effect.flip(
        Effect.flatMap(
          Effect.service(RelayServer.RelayAuthenticator),
          (auth) => auth.authenticate(bearer("anything"))
        ).pipe(
          Effect.provide(
            RelayCredentials.authenticator.pipe(
              Layer.provide(Layer.succeed(RelayCredentials.RelayCredentials, broken))
            )
          )
        )
      )

      assert.strictEqual(
        failure._tag,
        "StorageError",
        "a store that could not answer was reported as a bad credential, which the client treats as terminal"
      )
    })
  )
})
