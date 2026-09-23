/**
 * Starter prompts (W2 `PromptCatalog`): trimmed and capped, offered only on
 * an empty idle conversation, and loaded from the conversation's *pinned*
 * revision -- a later edit to the agent changes what new conversations
 * offer, not this one.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Permission } from "affe-agent"
import type { RevisionInput } from "../src/domain/AgentRevision.js"
import { ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import { sessionIdOf } from "../src/runtime/ConversationSessions.js"
import * as StarterPrompts from "../src/runtime/StarterPrompts.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"
import * as ConversationProjection from "../src/ui-core/ConversationProjection.js"
import * as Starters from "../src/ui-core/Starters.js"

const ada = UserId.make("ada")

const input = (starters?: ReadonlyArray<string>): RevisionInput => ({
  instructions: "",
  modelPolicy: { profile: "scripted" },
  capabilities: [],
  skills: [],
  permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
  maxTurns: 1,
  ...(starters === undefined ? {} : { starters })
})

describe("starters", () => {
  it("are trimmed, deduplicated and capped", () => {
    assert.deepStrictEqual(Starters.normalize([" a ", "", "b", "a", "c", "d", "e"]), ["a", "b", "c", "d"])
  })

  it("are offered on an empty idle conversation only", () => {
    const empty = ConversationProjection.initial(Prompt.empty, [], "idle")
    assert.deepStrictEqual(Starters.offered(empty, ["go"]), ["go"])
    assert.deepStrictEqual(Starters.offered({ ...empty, status: "running" }, ["go"]), [])
    assert.deepStrictEqual(Starters.offered({ ...empty, pending: [{ id: "q", kind: "k", detail: null }] }, ["go"]), [])
    const started = ConversationProjection.initial(Prompt.make("hello"), [], "idle")
    assert.deepStrictEqual(Starters.offered(started, ["go"]), [])
  })

  it.effect("load from the conversation's pinned revision, and none for a revision without them", () =>
    Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(Layer.mergeAll(AgentRegistry.memory, ConversationStore.memory))
      const registry = Context.get(context, AgentRegistry.AgentRegistry)
      const store = Context.get(context, ConversationStore.ConversationStore)
      const { revision, spec } = yield* registry.create({ ownerId: ada, name: "A", revision: input(["Plan my week", "Summarize a PDF"]) })
      const id = ConversationId.make("c1")
      yield* store.create({
        id,
        ownerId: ada,
        agentId: spec.id,
        agentRevisionId: revision.id,
        sessionId: sessionIdOf(id),
        workspaceId: Option.none(),
        title: "C1"
      })
      // The agent changes its starters after the conversation began.
      yield* registry.revise(spec.id, input(["Something else"]), ada)
      const loaded = yield* StarterPrompts.of(id).pipe(Effect.provide(context))
      assert.deepStrictEqual(loaded, ["Plan my week", "Summarize a PDF"])

      const plain = yield* registry.create({ ownerId: ada, name: "B", revision: input() })
      const other = ConversationId.make("c2")
      yield* store.create({
        id: other,
        ownerId: ada,
        agentId: plain.spec.id,
        agentRevisionId: plain.revision.id,
        sessionId: sessionIdOf(other),
        workspaceId: Option.none(),
        title: "C2"
      })
      assert.deepStrictEqual(yield* StarterPrompts.of(other).pipe(Effect.provide(context)), [])
      assert.deepStrictEqual(yield* StarterPrompts.of(ConversationId.make("nope")).pipe(Effect.provide(context)), [])
    })))
})
