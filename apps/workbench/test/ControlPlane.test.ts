/**
 * Control plane Phase 0 (plan-agent-product-control-plane.md §47): an agent
 * defined entirely as data resolves into the kernel through public APIs, two
 * revisions of one agent both stay resolvable, and a run on revision N is
 * unaffected by creating N+1 while it is going.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import { Tool } from "effect/unstable/ai"
import { Agent, Permission } from "affe-agent"
import { Skills } from "affe-agent/skills"
import { TestLanguageModel } from "affe-agent/testing"
import type { RevisionInput } from "../src/domain/AgentRevision.js"
import { AgentRevisionId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as AgentResolver from "../src/runtime/AgentResolver.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"

const owner = UserId.make("ada")
const Build = Tool.make("build", { parameters: Schema.Struct({}), success: Schema.String })

const recorded = (policy: Permission.Policy) => ({ recorded: JSON.stringify(Permission.describe(policy)) })

const input = (overrides: Partial<RevisionInput> = {}): RevisionInput => ({
  instructions: "You are revision one.",
  modelPolicy: { profile: "scripted" },
  capabilities: [{ id: "builder" }],
  skills: [],
  permission: recorded(Permission.allowAll),
  maxTurns: 4,
  ...overrides
})

/** The system instruction each model call saw, in order. */
const instructionsSeen = (prompts: ReadonlyArray<Prompt.Prompt>) =>
  prompts.map((prompt) => prompt.content.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("\n"))

/**
 * A registry built first, so a script can edit the agent mid-run, and a
 * resolver over it whose bindings count the tool's executions.
 */
const harness = Effect.fn("harness")(function*(
  turns: (registry: AgentRegistry.Service) => ReadonlyArray<TestLanguageModel.Turn>
) {
  const registryContext = yield* Layer.build(AgentRegistry.memory)
  const registry = Context.get(registryContext, AgentRegistry.AgentRegistry)
  const builds = yield* Ref.make(0)
  const { layer: model, recorder } = yield* TestLanguageModel.script(turns(registry))
  const bindings = Layer.succeed(AgentResolver.AgentBindings, {
    models: { scripted: model },
    capabilities: {
      builder: [Agent.tool(Build, () => Ref.update(builds, (n) => n + 1).pipe(Effect.as("built")))],
      // A second capability binding a tool of the same name.
      rebuilder: [Agent.tool(Build, () => Effect.succeed("rebuilt"))]
    },
    skills: { style: Skills.skill({ id: "style", name: "House style", description: "How we write.", body: "Be terse." }) }
  })
  const resolverContext = yield* Layer.build(
    AgentResolver.layer.pipe(Layer.provide(bindings), Layer.provide(Layer.succeedContext(registryContext)))
  )
  return { registry, resolver: Context.get(resolverContext, AgentResolver.AgentResolver), recorder, builds }
})

describe("agent directory", () => {
  it.effect("a revision that failed to resolve resolves once its binding exists", () =>
    Effect.scoped(Effect.gen(function*() {
      const { layer: model } = yield* TestLanguageModel.script([TestLanguageModel.text("ok")])
      // Registered late, as a deployment might after the first request.
      const models: Record<string, Layer.Layer<LanguageModel.LanguageModel>> = {}
      const bindings = Layer.succeed(AgentResolver.AgentBindings, { models, capabilities: {}, skills: {} })
      const context = yield* Layer.build(
        AgentDirectory.layer.pipe(
          Layer.provideMerge(AgentResolver.layer),
          Layer.provideMerge(AgentRegistry.memory),
          Layer.provide(bindings)
        )
      )
      const registry = Context.get(context, AgentRegistry.AgentRegistry)
      const directory = Context.get(context, AgentDirectory.AgentDirectory)
      const { revision } = yield* registry.create({
        ownerId: owner,
        name: "Late",
        revision: input({ capabilities: [] })
      })

      const refused = yield* Effect.flip(directory.client(revision.id))
      assert.strictEqual(refused.reason, "unknown-model")

      models["scripted"] = model
      const client = yield* directory.client(revision.id)
      const result = yield* Effect.scoped(Effect.flatMap(client.createSession(), (session) => session.prompt("hi")))
      assert.strictEqual(result.text, "ok")
    })))
})

describe("control plane phase 0", () => {
  it.effect("two revisions of one agent both resolve, each running its own configuration", () =>
    Effect.scoped(Effect.gen(function*() {
      const { recorder, registry, resolver } = yield* harness(() => [
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two")
      ])
      const { revision: first, spec } = yield* registry.create({ ownerId: owner, name: "Builder", revision: input() })
      const second = yield* registry.revise(spec.id, input({ instructions: "You are revision two." }), owner)

      assert.strictEqual(second.revision, 2)
      assert.deepStrictEqual(
        Option.map(yield* registry.get(spec.id), (current) => current.activeRevisionId),
        Option.some(second.id)
      )

      for (const id of [first.id, second.id]) {
        const { client } = yield* resolver.resolve(id)
        const session = yield* client.createSession()
        yield* session.prompt("hello")
      }
      assert.deepStrictEqual(instructionsSeen(yield* recorder.prompts), ["You are revision one.", "You are revision two."])
    })))

  it.effect("creating revision N+1 mid-run leaves the run on revision N", () =>
    Effect.scoped(Effect.gen(function*() {
      const created = yield* Ref.make(Option.none<AgentRevisionId>())
      const { builds, recorder, registry, resolver } = yield* harness((registry) => [
        {
          toolCalls: [{ id: "b1", name: "build", params: {} }],
          // Runs while the first model call is in flight.
          during: Effect.gen(function*() {
            const [spec] = yield* registry.list(owner)
            if (spec === undefined) return yield* Effect.die("no agent to revise")
            const next = yield* Effect.orDie(
              registry.revise(spec.id, input({ instructions: "You are revision two.", capabilities: [] }), owner)
            )
            yield* Ref.set(created, Option.some(next.id))
          })
        },
        TestLanguageModel.text("done")
      ])
      const { revision } = yield* registry.create({ ownerId: owner, name: "Builder", revision: input() })

      const { client } = yield* resolver.resolve(revision.id)
      const result = yield* (yield* client.createSession()).prompt("build")

      assert.strictEqual(result.text, "done")
      assert.isTrue(Option.isSome(yield* Ref.get(created)), "the edit happened during the run")
      // Both calls of the run saw revision one, and its tool still ran.
      assert.deepStrictEqual(instructionsSeen(yield* recorder.prompts), ["You are revision one.", "You are revision one."])
      assert.strictEqual(yield* Ref.get(builds), 1)
      // And revision one is still there to resolve again.
      assert.isTrue(Option.isSome(yield* registry.revision(revision.id)))
    })))

  it.effect("the recorded permission policy is the one the run is held to", () =>
    Effect.scoped(Effect.gen(function*() {
      const { builds, registry, resolver } = yield* harness(() => [
        { toolCalls: [{ id: "b1", name: "build", params: {} }] },
        TestLanguageModel.text("unreachable")
      ])
      const { revision } = yield* registry.create({
        ownerId: owner,
        name: "Locked",
        revision: input({ permission: recorded(Permission.denyAll) })
      })
      const { client } = yield* resolver.resolve(revision.id)
      yield* Effect.flip((yield* client.createSession()).prompt("build"))
      assert.strictEqual(yield* Ref.get(builds), 0)
    })))

  it.effect("a skill reference installs the skill", () =>
    Effect.scoped(Effect.gen(function*() {
      const { recorder, registry, resolver } = yield* harness(() => [TestLanguageModel.text("ok")])
      const { revision } = yield* registry.create({
        ownerId: owner,
        name: "Writer",
        revision: input({ capabilities: [], skills: [{ id: "style" }] })
      })
      const { client } = yield* resolver.resolve(revision.id)
      yield* (yield* client.createSession()).prompt("write")
      assert.deepStrictEqual(yield* recorder.tools, [["load_skill"]])
    })))

  it.effect("a reference that does not bind is refused by name", () =>
    Effect.scoped(Effect.gen(function*() {
      const { registry, resolver } = yield* harness(() => [])
      const refusal = (overrides: Partial<RevisionInput>) =>
        Effect.gen(function*() {
          const { revision } = yield* registry.create({ ownerId: owner, name: "Broken", revision: input(overrides) })
          const error = yield* Effect.flip(resolver.resolve(revision.id))
          return [error.reason, error.ref]
        })

      assert.deepStrictEqual(yield* refusal({ modelPolicy: { profile: "nope" } }), ["unknown-model", "nope"])
      assert.deepStrictEqual(yield* refusal({ capabilities: [{ id: "builder" }, { id: "rocket" }] }), [
        "unknown-capability",
        "rocket"
      ])
      assert.deepStrictEqual(yield* refusal({ capabilities: [{ id: "builder" }, { id: "rebuilder" }] }), [
        "conflicting-capability",
        "build"
      ])
      assert.deepStrictEqual(yield* refusal({ skills: [{ id: "poetry" }] }), ["unknown-skill", "poetry"])
      assert.deepStrictEqual(yield* refusal({ permission: { recorded: "not json" } }), [
        "permission-not-recreatable",
        undefined
      ])
      const missing = yield* Effect.flip(resolver.resolve(AgentRevisionId.make("nobody@1")))
      assert.strictEqual(missing.reason, "unknown-revision")
    })))
})
