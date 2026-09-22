/**
 * Real identity (control plane Phase 1's last open item): a password earns
 * a token, the token is the same bearer both APIs accept, and it ends when
 * logged out, when the password changes, or when its time is up. Nothing
 * secret is in a row.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Duration, Effect, Layer, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Permission } from "affe-agent"
import { UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { buildReply, serve } from "../src/server/app.js"
import * as Identity from "../src/server/Identity.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as HttpStores from "../src/store/http.js"
import * as IdentityStore from "../src/store/IdentityStore.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")
const secret = Redacted.make("correct horse battery")

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-identity-")), "identity.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const backends: ReadonlyArray<readonly [string, Effect.Effect<Layer.Layer<IdentityStore.IdentityStore>, never, Scope.Scope>]> = [
  ["memory", Effect.succeed(IdentityStore.memory)],
  ["sqlite", Effect.map(tempFile, (file) => IdentityStore.layerSql.pipe(Layer.provide(SqliteClient.layer({ filename: file }))))]
]

for (const [name, backend] of backends) {
  describe(`identity (${name})`, () => {
    const run = <A, E>(body: Effect.Effect<A, E, Identity.Identity | IdentityStore.IdentityStore>) =>
      Effect.scoped(Effect.flatMap(backend, (layer) =>
        Effect.provide(body, Identity.layer({ sessionTtl: Duration.hours(1) }).pipe(Layer.provideMerge(layer)))))

    it.effect("a password earns a token; the wrong one, or no account, is one refusal", () =>
      run(Effect.gen(function*() {
        const identity = yield* Identity.Identity
        yield* identity.register(ada, secret)
        assert.strictEqual((yield* Effect.flip(identity.register(ada, secret)))._tag, "UserExistsError")

        const wrong = yield* Effect.flip(identity.login(ada, Redacted.make("not it, not it")))
        const nobody = yield* Effect.flip(identity.login(grace, secret))
        assert.strictEqual(wrong._tag, "InvalidCredentialsError")
        assert.strictEqual(nobody._tag, "InvalidCredentialsError")

        const issued = yield* identity.login(ada, secret)
        assert.deepStrictEqual(yield* identity.resolve(issued.token), Option.some(ada))
        assert.deepStrictEqual(yield* identity.resolve(`${issued.token}x`), Option.none())
        // Two logins are two tokens, each its own.
        const again = yield* identity.login(ada, secret)
        assert.notStrictEqual(again.token, issued.token)
        yield* identity.logout(issued.token)
        assert.deepStrictEqual(yield* identity.resolve(issued.token), Option.none())
        assert.deepStrictEqual(yield* identity.resolve(again.token), Option.some(ada))
      })))

    it.effect("a token ends when its time is up, and every token ends when the password changes", () =>
      run(Effect.gen(function*() {
        const identity = yield* Identity.Identity
        yield* identity.register(ada, secret)
        const first = yield* identity.login(ada, secret)
        yield* TestClock.adjust(Duration.minutes(59))
        assert.deepStrictEqual(yield* identity.resolve(first.token), Option.some(ada))
        yield* TestClock.adjust(Duration.minutes(2))
        assert.deepStrictEqual(yield* identity.resolve(first.token), Option.none())

        const second = yield* identity.login(ada, secret)
        const third = yield* identity.login(ada, secret)
        yield* identity.setPassword(ada, Redacted.make("a new one entirely"))
        assert.deepStrictEqual(yield* identity.resolve(second.token), Option.none())
        assert.deepStrictEqual(yield* identity.resolve(third.token), Option.none())
        assert.strictEqual((yield* Effect.flip(identity.login(ada, secret)))._tag, "InvalidCredentialsError")
        const fresh = yield* identity.login(ada, Redacted.make("a new one entirely"))
        assert.deepStrictEqual(yield* identity.resolve(fresh.token), Option.some(ada))
      })))

    it.effect("nothing secret is stored: not the password, not the token", () =>
      run(Effect.gen(function*() {
        const identity = yield* Identity.Identity
        const store = yield* IdentityStore.IdentityStore
        yield* identity.register(ada, secret)
        const issued = yield* identity.login(ada, secret)
        assert.isTrue(Option.isNone(yield* store.session(issued.token)), "the token itself is not a key")
        assert.isTrue(Option.isSome(yield* store.session(yield* Identity.digest(issued.token))))
        const credential = yield* store.credential(ada)
        assert.isTrue(Option.isSome(credential))
        if (Option.isSome(credential)) {
          assert.notInclude(credential.value.hash, Redacted.value(secret))
          assert.notStrictEqual(credential.value.hash, Redacted.value(secret))
          // The same password under a new salt is a different hash.
          yield* identity.setPassword(ada, secret)
          const rehashed = yield* store.credential(ada)
          assert.isTrue(Option.isSome(rehashed) && rehashed.value.hash !== credential.value.hash)
        }
      })))
  })
}

// -- Over a real server ---------------------------------------------------------------

const port = 8786
const bootstrap = tokens({ "local-token": "local" })
const local = UserId.make("local")

const page = (token: string) => {
  const server = { baseUrl: `http://localhost:${port}`, token }
  return Effect.map(
    Layer.build(
      ConversationSessions.layer.pipe(
        Layer.provideMerge(AgentDirectory.http(server)),
        Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore(server), HttpStores.agentRegistry(server))),
        Layer.provideMerge(FetchHttpClient.layer)
      )
    ),
    (context) => ({
      sessions: Context.get(context, ConversationSessions.ConversationSessions),
      registry: Context.get(context, AgentRegistry.AgentRegistry),
      me: Effect.provide(HttpStores.currentUser(server), FetchHttpClient.layer),
      register: (userId: UserId, password: string) =>
        Effect.provide(HttpStores.register(server, userId, password), FetchHttpClient.layer),
      setPassword: (password: string) => Effect.provide(HttpStores.setPassword(server, password), FetchHttpClient.layer),
      logout: Effect.provide(HttpStores.logout(server), FetchHttpClient.layer)
    })
  )
}

const login = (userId: UserId, password: string) =>
  Effect.provide(HttpStores.login({ baseUrl: `http://localhost:${port}` }, userId, password), FetchHttpClient.layer)

describe("identity over the server", () => {
  it.live("a login's token is the bearer both APIs accept, until it is ended", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(bootstrap)))
      const bootstrapped = yield* page("local-token")
      assert.strictEqual(yield* bootstrapped.me, local)

      // Accounts are made by someone signed in; a stranger cannot, and a login needs an account.
      assert.strictEqual((yield* Effect.flip((yield* page("nobody")).register(ada, "correct horse battery")))._tag, "WorkbenchStorageError")
      assert.strictEqual((yield* Effect.flip(login(ada, "correct horse battery")))._tag, "InvalidCredentialsError")
      yield* bootstrapped.register(ada, "correct horse battery")
      assert.strictEqual((yield* Effect.flip(bootstrapped.register(ada, "correct horse battery")))._tag, "UserExistsError")
      // A password too short to be one never reaches an account.
      assert.strictEqual((yield* Effect.flip(bootstrapped.register(grace, "short")))._tag, "WorkbenchStorageError")
      assert.strictEqual((yield* Effect.flip(login(ada, "wrong password!")))._tag, "InvalidCredentialsError")

      // The issued token is ada on the product API and on the agent.
      const issued = yield* login(ada, "correct horse battery")
      const adas = yield* page(issued.token)
      assert.strictEqual(yield* adas.me, ada)
      // An account made after startup is not seeded an agent; ada makes her own.
      const { spec: agent } = yield* adas.registry.create({
        ownerId: ada,
        name: "Ada's",
        revision: {
          instructions: "Mine.",
          modelPolicy: { profile: "scripted" },
          capabilities: [{ id: "build" }, { id: "deleteEverything" }],
          skills: [],
          permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
          maxTurns: 4
        }
      })
      const { session } = yield* adas.sessions.create({ ownerId: ada, agentId: agent.id, title: "As ada" })
      assert.strictEqual((yield* session.prompt("build it")).text, buildReply)

      // Logging out ends that token and no other.
      const other = yield* login(ada, "correct horse battery")
      yield* adas.logout
      assert.strictEqual((yield* Effect.flip(adas.me))._tag, "WorkbenchStorageError")
      assert.strictEqual(yield* (yield* page(other.token)).me, ada)

      // Changing the password ends the rest, and the old password with them.
      yield* (yield* page(other.token)).setPassword("a new one entirely")
      assert.strictEqual((yield* Effect.flip((yield* page(other.token)).me))._tag, "WorkbenchStorageError")
      assert.strictEqual((yield* Effect.flip(login(ada, "correct horse battery")))._tag, "InvalidCredentialsError")
      assert.strictEqual(yield* (yield* page((yield* login(ada, "a new one entirely")).token)).me, ada)

      // The configured token still works beside the issued ones.
      assert.strictEqual(yield* bootstrapped.me, local)
    })), 60_000)
})
