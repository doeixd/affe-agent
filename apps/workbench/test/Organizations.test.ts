/**
 * Organizations and membership (control plane §5): the store's contract for
 * memory and SQL alike, an agent written before organizations still
 * decoding, and -- over a real server -- a member using a shared agent, an
 * admin managing it, and a stranger seeing none of it.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Permission } from "affe-agent"
import type { RevisionInput } from "../src/domain/AgentRevision.js"
import { AgentId, OrganizationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import { tokens } from "../src/server/Authentication.js"
import { buildReply, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as HttpStores from "../src/store/http.js"
import * as OrganizationStore from "../src/store/OrganizationStore.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")
const linus = UserId.make("linus")

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-orgs-")), "orgs.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

type Stores = OrganizationStore.OrganizationStore | AgentRegistry.AgentRegistry

const backends: ReadonlyArray<readonly [string, Effect.Effect<Layer.Layer<Stores>, never, Scope.Scope>]> = [
  ["memory", Effect.succeed(Layer.mergeAll(OrganizationStore.memory, AgentRegistry.memory))],
  [
    "sqlite",
    Effect.map(tempFile, (file) =>
      Layer.mergeAll(OrganizationStore.layerSql, AgentRegistry.layerSql).pipe(
        Layer.provide(SqliteClient.layer({ filename: file }))
      ))
  ]
]

const input = (instructions: string): RevisionInput => ({
  instructions,
  modelPolicy: { profile: "scripted" },
  capabilities: [],
  skills: [],
  permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
  maxTurns: 2
})

for (const [name, backend] of backends) {
  describe(`organization store (${name})`, () => {
    const run = <A, E>(body: Effect.Effect<A, E, Stores>) =>
      Effect.scoped(Effect.flatMap(backend, (layer) => Effect.provide(body, layer)))

    it.effect("creating makes the creator its owner; members are listed, changed and removed", () =>
      run(Effect.gen(function*() {
        const store = yield* OrganizationStore.OrganizationStore
        const lab = yield* store.create("Lab", ada)
        assert.deepStrictEqual(yield* store.get(lab.id), Option.some(lab))
        assert.deepStrictEqual(yield* store.role(lab.id, ada), Option.some("owner"))
        assert.deepStrictEqual(yield* store.role(lab.id, grace), Option.none())

        const joined = yield* store.setMember(lab.id, grace, "member")
        assert.strictEqual(joined.role, "member")
        const promoted = yield* store.setMember(lab.id, grace, "admin")
        assert.strictEqual(promoted.role, "admin")
        assert.deepStrictEqual(promoted.since, joined.since, "a role change keeps the join date")
        assert.deepStrictEqual(
          (yield* store.members(lab.id)).map((member) => [member.userId, member.role]),
          [[ada, "owner"], [grace, "admin"]]
        )

        const other = yield* store.create("Other", grace)
        assert.deepStrictEqual(
          (yield* store.listFor(grace)).map((entry) => [entry.organization.name, entry.role]),
          [["Lab", "admin"], ["Other", "owner"]]
        )
        assert.deepStrictEqual((yield* store.listFor(ada)).map((entry) => entry.organization.id), [lab.id])
        assert.deepStrictEqual(yield* store.listFor(linus), [])

        yield* store.removeMember(lab.id, grace)
        yield* store.removeMember(lab.id, grace) // and again, changing nothing
        assert.deepStrictEqual((yield* store.members(lab.id)).map((member) => member.userId), [ada])
        assert.deepStrictEqual((yield* store.listFor(grace)).map((entry) => entry.organization.id), [other.id])
      })))

    it.effect("an organization never loses its last owner, and an unknown one is refused by name", () =>
      run(Effect.gen(function*() {
        const store = yield* OrganizationStore.OrganizationStore
        const lab = yield* store.create("Lab", ada)
        assert.strictEqual((yield* Effect.flip(store.removeMember(lab.id, ada)))._tag, "LastOwnerError")
        assert.strictEqual((yield* Effect.flip(store.setMember(lab.id, ada, "admin")))._tag, "LastOwnerError")
        // With a second owner, the first may step down or leave.
        yield* store.setMember(lab.id, grace, "owner")
        yield* store.setMember(lab.id, ada, "member")
        yield* store.removeMember(lab.id, ada)
        assert.deepStrictEqual((yield* store.members(lab.id)).map((member) => member.userId), [grace])
        // And now grace is the last one.
        assert.strictEqual((yield* Effect.flip(store.removeMember(lab.id, grace)))._tag, "LastOwnerError")

        const nowhere = OrganizationId.make("nowhere")
        assert.strictEqual((yield* Effect.flip(store.setMember(nowhere, ada, "member")))._tag, "OrganizationNotFoundError")
        assert.strictEqual((yield* Effect.flip(store.removeMember(nowhere, ada)))._tag, "OrganizationNotFoundError")
        assert.deepStrictEqual(yield* store.members(nowhere), [])
      })))

    it.effect("an agent is shared with one organization and listed for it", () =>
      run(Effect.gen(function*() {
        const registry = yield* AgentRegistry.AgentRegistry
        const lab = OrganizationId.make("lab")
        const other = OrganizationId.make("other")
        const { spec: shared } = yield* registry.create({ ownerId: ada, organizationId: lab, name: "Shared", revision: input("s") })
        const { spec: personal } = yield* registry.create({ ownerId: ada, name: "Personal", revision: input("p") })
        assert.deepStrictEqual(shared.organizationId, Option.some(lab))
        assert.deepStrictEqual(personal.organizationId, Option.none())
        assert.deepStrictEqual((yield* registry.listShared([lab])).map((spec) => spec.id), [shared.id])
        assert.deepStrictEqual(yield* registry.listShared([other]), [])
        assert.deepStrictEqual(yield* registry.listShared([]), [])
        // Sharing changes nothing about ownership.
        assert.deepStrictEqual((yield* registry.list(ada)).map((spec) => spec.id).sort(), [shared.id, personal.id].sort())
      })))
  })
}

describe("organization store (sqlite, existing rows)", () => {
  it.effect("an agent written before organizations existed still decodes, unshared", () =>
    Effect.scoped(Effect.gen(function*() {
      const file = yield* tempFile
      const context = yield* Layer.build(AgentRegistry.layerSql.pipe(Layer.provideMerge(SqliteClient.layer({ filename: file }))))
      const registry = Context.get(context, AgentRegistry.AgentRegistry)
      const client = Context.get(context, SqlClient.SqlClient)
      // The body as the registry wrote it on 2026-09-15: no `organizationId` key at all.
      const id = AgentId.make("old")
      const body = JSON.stringify({
        id,
        ownerId: ada,
        name: "Old",
        description: { _tag: "None" },
        activeRevisionId: "old@1",
        createdAt: "2026-09-15T00:00:00.000Z",
        archivedAt: { _tag: "None" }
      })
      yield* client`INSERT INTO workbench_agents (id, owner_id, body) VALUES (${id}, ${ada}, ${body})`
      const found = yield* registry.get(id)
      assert.isTrue(Option.isSome(found))
      if (Option.isSome(found)) {
        assert.deepStrictEqual(found.value.organizationId, Option.none())
        assert.strictEqual(found.value.name, "Old")
      }
      assert.deepStrictEqual((yield* registry.list(ada)).map((spec) => spec.id), [id])
    })))
})

// -- Over a real server ---------------------------------------------------------------

const port = 8788
const people = tokens({ "ada-token": "ada", "grace-token": "grace", "linus-token": "linus" })

const load = (token: string) => {
  const server = { baseUrl: `http://localhost:${port}`, token }
  return Effect.map(
    Layer.build(
      ConversationSessions.layer.pipe(
        Layer.provideMerge(AgentDirectory.http(server)),
        Layer.provideMerge(
          Layer.mergeAll(
            HttpStores.conversationStore(server),
            HttpStores.agentRegistry(server),
            HttpStores.organizationStore(server)
          )
        ),
        Layer.provideMerge(FetchHttpClient.layer)
      )
    ),
    (context) => ({
      sessions: Context.get(context, ConversationSessions.ConversationSessions),
      registry: Context.get(context, AgentRegistry.AgentRegistry),
      store: Context.get(context, ConversationStore.ConversationStore),
      organizations: Context.get(context, OrganizationStore.OrganizationStore)
    })
  )
}

describe("organizations over the server", () => {
  it.live("a member uses a shared agent, an admin manages it, and a stranger sees none of it", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(people)))
      const adas = yield* load("ada-token")
      const graces = yield* load("grace-token")
      const linuss = yield* load("linus-token")

      // Ada founds the Lab and shares an agent with it. Grace is a member.
      const lab = yield* adas.organizations.create("Lab", ada)
      yield* adas.organizations.setMember(lab.id, grace, "member")
      const { spec: shared } = yield* adas.registry.create({
        ownerId: ada,
        organizationId: lab.id,
        name: "Lab agent",
        revision: {
          instructions: "Shared.",
          modelPolicy: { profile: "scripted" },
          capabilities: [{ id: "build" }, { id: "deleteEverything" }],
          skills: [],
          permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
          maxTurns: 4
        }
      })

      // Grace sees it beside her own, and runs it in a conversation of her own.
      assert.deepStrictEqual((yield* graces.organizations.listFor(grace)).map((j) => [j.organization.id, j.role]), [[lab.id, "member"]])
      assert.isTrue((yield* graces.registry.list(grace)).some((agent) => agent.id === shared.id))
      assert.isTrue(Option.isSome(yield* graces.registry.get(shared.id)))
      assert.strictEqual((yield* graces.registry.revisions(shared.id)).length, 1)
      const { conversation, session } = yield* graces.sessions.create({ ownerId: grace, agentId: shared.id, title: "On the Lab agent" })
      assert.strictEqual(conversation.ownerId, grace)
      assert.strictEqual((yield* session.prompt("build it")).text, buildReply)
      // Her conversation is hers alone, even though the agent is Ada's.
      assert.isTrue(Option.isNone(yield* adas.store.get(conversation.id)))

      // But a member does not manage it, nor the organization.
      assert.strictEqual((yield* Effect.flip(graces.registry.revise(shared.id, { ...(yield* revisionOf(graces, shared.id)), instructions: "Mine" }, grace)))._tag, "AgentNotFoundError")
      assert.strictEqual((yield* Effect.flip(graces.registry.archive(shared.id)))._tag, "AgentNotFoundError")
      assert.strictEqual((yield* Effect.flip(graces.organizations.setMember(lab.id, linus, "member")))._tag, "WorkbenchStorageError")
      assert.strictEqual((yield* Effect.flip(graces.registry.create({ ownerId: grace, organizationId: lab.id, name: "No", revision: yield* revisionOf(graces, shared.id) })))._tag, "WorkbenchStorageError")

      // Linus, in no organization, sees nothing and can use nothing.
      assert.deepStrictEqual(yield* linuss.organizations.listFor(linus), [])
      assert.deepStrictEqual(yield* linuss.organizations.members(lab.id), [])
      assert.isFalse((yield* linuss.registry.list(linus)).some((agent) => agent.id === shared.id))
      assert.isTrue(Option.isNone(yield* linuss.registry.get(shared.id)))
      assert.deepStrictEqual(yield* linuss.registry.revisions(shared.id), [])
      assert.strictEqual((yield* Effect.flip(linuss.sessions.create({ ownerId: linus, agentId: shared.id, title: "No" })))._tag, "AgentNotFoundError")

      // Promoted to admin, Grace manages the agent and the membership -- short of ownership.
      yield* adas.organizations.setMember(lab.id, grace, "admin")
      const revised = yield* graces.registry.revise(shared.id, { ...(yield* revisionOf(graces, shared.id)), instructions: "Revised by Grace" }, grace)
      assert.strictEqual(revised.createdBy, grace)
      assert.strictEqual(revised.revision, 2)
      yield* graces.organizations.setMember(lab.id, linus, "member")
      assert.isTrue(Option.isSome(yield* linuss.registry.get(shared.id)), "linus, now a member, sees it")
      assert.strictEqual((yield* Effect.flip(graces.organizations.setMember(lab.id, linus, "owner")))._tag, "WorkbenchStorageError")
      assert.strictEqual((yield* Effect.flip(graces.organizations.removeMember(lab.id, ada)))._tag, "WorkbenchStorageError")
      const { spec: byGrace } = yield* graces.registry.create({ ownerId: grace, organizationId: lab.id, name: "Grace's Lab agent", revision: yield* revisionOf(graces, shared.id) })
      assert.deepStrictEqual(byGrace.organizationId, Option.some(lab.id))
      assert.isTrue(Option.isSome(yield* adas.registry.get(byGrace.id)), "shared with the owner too")

      // Ownership moves only through an owner, and never leaves the organization without one.
      assert.strictEqual((yield* Effect.flip(adas.organizations.removeMember(lab.id, ada)))._tag, "LastOwnerError")
      yield* adas.organizations.setMember(lab.id, grace, "owner")
      yield* adas.organizations.removeMember(lab.id, ada)
      assert.deepStrictEqual((yield* graces.organizations.members(lab.id)).map((m) => [m.userId, m.role]), [[grace, "owner"], [linus, "member"]])
      // Ada, no longer a member, still owns her agent -- and no longer sees Grace's.
      assert.isTrue(Option.isSome(yield* adas.registry.get(shared.id)))
      assert.isTrue(Option.isNone(yield* adas.registry.get(byGrace.id)))
      assert.deepStrictEqual(yield* adas.organizations.members(lab.id), [])
    })), 60_000)
})

const revisionOf = (page: { readonly registry: AgentRegistry.Service }, id: AgentId) =>
  Effect.flatMap(page.registry.get(id), (found) =>
    Option.match(found, {
      onNone: () => Effect.die(`no agent ${id}`),
      onSome: (spec) =>
        Effect.flatMap(page.registry.revision(spec.activeRevisionId), (revision) =>
          Option.match(revision, {
            onNone: () => Effect.die(`no revision for ${id}`),
            onSome: ({ instructions, modelPolicy, capabilities, skills, permission, maxTurns }): Effect.Effect<RevisionInput> =>
              Effect.succeed({ instructions, modelPolicy, capabilities, skills, permission, maxTurns })
          }))
    }))
