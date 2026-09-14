/**
 * Control plane Phase 1's persistence: one contract for the memory and SQL
 * stores, and the plan's §6 acceptance -- an agent created entirely through
 * data survives a restart and opens a new session on the same revision.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import type { Scope } from "effect"
import { Permission } from "affe-agent"
import { TestLanguageModel } from "affe-agent/testing"
import type { RevisionInput } from "../src/domain/AgentRevision.js"
import { AgentId, AgentRevisionId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentResolver from "../src/runtime/AgentResolver.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")

const input = (instructions: string): RevisionInput => ({
  instructions,
  modelPolicy: { profile: "scripted" },
  capabilities: [],
  skills: [],
  permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
  maxTurns: 2
})

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-")), "workbench.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const sqlite = (file: string) => SqliteClient.layer({ filename: file })

type Stores = AgentRegistry.AgentRegistry | ConversationStore.ConversationStore

const backends: ReadonlyArray<readonly [string, Effect.Effect<Layer.Layer<Stores>, never, Scope.Scope>]> = [
  ["memory", Effect.succeed(Layer.mergeAll(AgentRegistry.memory, ConversationStore.memory))],
  [
    "sqlite",
    Effect.map(tempFile, (file) =>
      Layer.mergeAll(AgentRegistry.layerSql, ConversationStore.layerSql).pipe(Layer.provide(sqlite(file))))
  ]
]

for (const [name, backend] of backends) {
  describe(`workbench stores (${name})`, () => {
    const run = <A, E>(body: Effect.Effect<A, E, Stores>) =>
      Effect.scoped(Effect.flatMap(backend, (layer) => Effect.provide(body, layer)))

    it.effect("an agent's revisions are numbered, kept, and the newest is active", () =>
      run(Effect.gen(function*() {
        const registry = yield* AgentRegistry.AgentRegistry
        const { revision: first, spec } = yield* registry.create({
          ownerId: ada,
          name: "Builder",
          description: "Builds.",
          revision: input("one")
        })
        const second = yield* registry.revise(spec.id, input("two"), grace)
        const third = yield* registry.revise(spec.id, input("three"), ada)

        assert.deepStrictEqual([first.revision, second.revision, third.revision], [1, 2, 3])
        assert.deepStrictEqual(
          (yield* registry.revisions(spec.id)).map((revision) => [revision.revision, revision.instructions]),
          [[1, "one"], [2, "two"], [3, "three"]]
        )
        assert.deepStrictEqual(yield* registry.revision(first.id), Option.some(first))
        assert.strictEqual(second.createdBy, grace)

        const current = yield* registry.get(spec.id)
        assert.deepStrictEqual(Option.map(current, (found) => found.activeRevisionId), Option.some(third.id))
        assert.deepStrictEqual(Option.map(current, (found) => found.description), Option.some(Option.some("Builds.")))
        assert.deepStrictEqual((yield* registry.list(ada)).map((found) => found.id), [spec.id])
        assert.deepStrictEqual(yield* registry.list(grace), [])
      })))

    it.effect("revising or archiving an unknown agent is refused, and archiving is recorded once", () =>
      run(Effect.gen(function*() {
        const registry = yield* AgentRegistry.AgentRegistry
        const nobody = AgentId.make("nobody")
        assert.strictEqual((yield* Effect.flip(registry.revise(nobody, input("x"), ada)))._tag, "AgentNotFoundError")
        assert.strictEqual((yield* Effect.flip(registry.archive(nobody)))._tag, "AgentNotFoundError")
        assert.isTrue(Option.isNone(yield* registry.revision(AgentRevisionId.make("nobody@1"))))

        const { spec } = yield* registry.create({ ownerId: ada, name: "Old", revision: input("one") })
        yield* registry.archive(spec.id)
        const archivedAt = Option.flatMap(yield* registry.get(spec.id), (found) => found.archivedAt)
        assert.isTrue(Option.isSome(archivedAt))
        yield* registry.archive(spec.id)
        assert.deepStrictEqual(Option.flatMap(yield* registry.get(spec.id), (found) => found.archivedAt), archivedAt)
      })))

    // Live: ordering is by the real update time, which it spaces with short sleeps.
    it.live("conversations are created once, listed newest first, archived out of the list, and removed", () =>
      run(Effect.gen(function*() {
        const store = yield* ConversationStore.ConversationStore
        const conversation = (id: string, title: string) => ({
          id: ConversationId.make(id),
          ownerId: ada,
          agentId: AgentId.make("a"),
          agentRevisionId: AgentRevisionId.make("a@1"),
          sessionId: `conversation-${id}`,
          workspaceId: Option.none(),
          title
        })

        const first = yield* store.create(conversation("c1", "First"))
        yield* Effect.sleep("2 millis")
        yield* store.create(conversation("c2", "Second"))
        assert.strictEqual(
          (yield* Effect.flip(store.create(conversation("c1", "Again"))))._tag,
          "ConversationExistsError"
        )
        assert.deepStrictEqual(yield* store.get(first.id), Option.some(first))

        yield* Effect.sleep("2 millis")
        const renamed = yield* store.update(first.id, { title: "Renamed" })
        assert.strictEqual(renamed.title, "Renamed")
        assert.deepStrictEqual((yield* store.list({ ownerId: ada })).map((found) => found.title), ["Renamed", "Second"])

        yield* store.update(first.id, { archived: true })
        assert.deepStrictEqual((yield* store.list({ ownerId: ada })).map((found) => found.title), ["Second"])
        assert.strictEqual((yield* store.list({ ownerId: ada, includeArchived: true })).length, 2)
        assert.deepStrictEqual(yield* store.list({ ownerId: grace }), [])

        yield* store.remove(first.id)
        assert.isTrue(Option.isNone(yield* store.get(first.id)))
        assert.strictEqual(
          (yield* Effect.flip(store.update(first.id, { title: "Gone" })))._tag,
          "ConversationNotFoundError"
        )
      })))
  })
}

describe("workbench persistence", () => {
  it.live("an agent defined as data survives a restart and runs the same revision", () =>
    Effect.scoped(Effect.gen(function*() {
      const file = yield* tempFile

      // The first process: define the agent, edit it once.
      const defined = yield* Effect.scoped(Effect.gen(function*() {
        const context = yield* Layer.build(AgentRegistry.layerSql.pipe(Layer.provide(sqlite(file))))
        const registry = Context.get(context, AgentRegistry.AgentRegistry)
        const { revision, spec } = yield* registry.create({ ownerId: ada, name: "Builder", revision: input("Build.") })
        const edited = yield* registry.revise(spec.id, input("Build better."), ada)
        return { agentId: spec.id, first: revision, edited }
      }))

      // The second: nothing in memory survives but the file.
      const { layer: model, recorder } = yield* TestLanguageModel.script([TestLanguageModel.text("built")])
      const bindings = Layer.succeed(AgentResolver.AgentBindings, { models: { scripted: model }, capabilities: {}, skills: {} })
      const context = yield* Layer.build(
        AgentResolver.layer.pipe(
          Layer.provideMerge(AgentRegistry.layerSql),
          Layer.provide(Layer.mergeAll(sqlite(file), bindings))
        )
      )
      const registry = Context.get(context, AgentRegistry.AgentRegistry)
      const resolver = Context.get(context, AgentResolver.AgentResolver)

      assert.deepStrictEqual(yield* registry.revision(defined.first.id), Option.some(defined.first))
      const spec = yield* registry.get(defined.agentId)
      assert.deepStrictEqual(Option.map(spec, (found) => found.activeRevisionId), Option.some(defined.edited.id))

      const { client } = yield* resolver.resolve(defined.edited.id)
      const result = yield* Effect.scoped(Effect.flatMap(client.createSession(), (session) => session.prompt("go")))
      assert.strictEqual(result.text, "built")
      const system = (yield* recorder.prompts).map((prompt) =>
        prompt.content.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("")
      )
      assert.deepStrictEqual(system, ["Build better."])
    })), 30_000)
})
