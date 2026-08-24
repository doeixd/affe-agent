import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { MemorySandbox } from "../src/sandbox/index.js"
import { Skills } from "../src/skills/index.js"
import { Plugins } from "../src/plugins/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `Plugins.load` aggregates the manifest, skills, and mcp.json decoders into one
 * LoadedPlugin over a seeded in-memory sandbox. The headline invariant: only a
 * fatal plugin.json fails the load; a bad skill and a bad server are warnings,
 * and the good components still load.
 */

const S = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
const MCP_S = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nbody`

const load = (seed: Record<string, string>, options?: Plugins.LoadOptions) =>
  Plugins.load(options).pipe(
    Effect.provide(
      Sandbox.currentLayer(Sandbox.workspace("plugin")).pipe(Layer.provide(MemorySandbox.layer({ seed })))
    ),
    Effect.scoped
  )

describe("Plugins.load", () => {
  it.effect("loads a complete plugin: manifest, skills, and mcp servers", () =>
    Effect.gen(function* () {
      const loaded = yield* load({
        "plugin.json": JSON.stringify({ $schema: S, name: "demo", version: "1.0.0" }),
        "skills/greet/SKILL.md": skillMd("greet", "Greet the user."),
        "mcp.json": JSON.stringify({ $schema: MCP_S, mcpServers: { remote: { type: "streamable-http", url: "https://api.example.com/mcp" } } })
      })
      assert.strictEqual(loaded.manifest.name, "demo")
      assert.deepStrictEqual(loaded.skills.map((s) => s.id), ["greet"])
      assert.strictEqual(loaded.mcpServers.length, 1)
      assert.strictEqual(loaded.mcpServers[0]?.name, "remote")
      assert.deepStrictEqual(loaded.warnings, [])
    })
  )

  it.effect("fails only when plugin.json is missing or fatally invalid", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.exit(load({ "skills/x/SKILL.md": skillMd("x", "y") }))
      assert.isTrue(Exit.isFailure(missing))
      const badName = yield* Effect.exit(load({ "plugin.json": JSON.stringify({ $schema: S, name: "BAD" }) }))
      assert.isTrue(Exit.isFailure(badName))
    })
  )

  it.effect("isolates component failures: good skill + good server load, bad ones warn", () =>
    Effect.gen(function* () {
      const loaded = yield* load({
        "plugin.json": JSON.stringify({ $schema: S, name: "mixed" }),
        "skills/good/SKILL.md": skillMd("good", "A good skill."),
        "skills/bad/SKILL.md": skillMd("mismatch", "Name does not match dir."),
        "mcp.json": JSON.stringify({
          $schema: MCP_S,
          mcpServers: {
            ok: { type: "streamable-http", url: "https://ok.example.com" },
            broken: { type: "unknown-transport" }
          }
        })
      })
      assert.deepStrictEqual(loaded.skills.map((s) => s.id), ["good"])
      assert.deepStrictEqual(loaded.mcpServers.map((s) => s.name), ["ok"])
      assert.strictEqual(loaded.warnings.length, 2) // one skill, one server
    })
  )

  it.effect("a manifest with no skills or mcp.json loads with empty components", () =>
    Effect.gen(function* () {
      const loaded = yield* load({ "plugin.json": JSON.stringify({ $schema: S, name: "bare" }) })
      assert.deepStrictEqual(loaded.skills, [])
      assert.deepStrictEqual(loaded.mcpServers, [])
      assert.deepStrictEqual(loaded.warnings, [])
    })
  )

  it.effect("the loaded skills work through skillsLayer and the SkillRegistry", () =>
    Effect.gen(function* () {
      const loaded = yield* load({
        "plugin.json": JSON.stringify({ $schema: S, name: "demo" }),
        "skills/refunds/SKILL.md": "---\nname: refunds\ndescription: How to issue a refund.\n---\nStep 1: verify."
      })
      const { list, body } = yield* Effect.gen(function* () {
        const registry = yield* Skills.SkillRegistry
        return { list: yield* registry.list, body: yield* registry.load("refunds") }
      }).pipe(Effect.provide(Plugins.skillsLayer(loaded)))

      assert.deepStrictEqual(list.map((m) => m.id), ["refunds"])
      assert.strictEqual(list[0]?.description, "How to issue a refund.")
      assert.strictEqual(body._tag === "Some" ? body.value : undefined, "Step 1: verify.")
    })
  )

  it.effect("end-to-end: a plugin installs onto an agent; advertise + load_skill work", () =>
    Effect.gen(function* () {
      const { layer: model, recorder } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "l1", name: "load_skill", params: { skill_id: "refunds" } }] },
        TestLanguageModel.text("refund issued")
      ])
      const seed = {
        "plugin.json": JSON.stringify({ $schema: S, name: "support" }),
        "skills/refunds/SKILL.md": "---\nname: refunds\ndescription: Issuing refunds\n---\nStep 1: verify the order."
      }

      const outcome = yield* Effect.gen(function* () {
        const loaded = yield* Plugins.load()
        const agent = yield* Agent.make({ instructions: "Help.", loop: AgentLoop.bounded(4) }).pipe(Plugins.install(loaded))
        return yield* Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          const result = yield* AgentSession.prompt(session, "issue a refund")
          return { text: result.text, prompts: yield* recorder.prompts }
        }).pipe(Effect.provide(Plugins.skillsLayer(loaded)))
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(
          model,
          Sandbox.currentLayer(Sandbox.workspace("plugin")).pipe(Layer.provide(MemorySandbox.layer({ seed })))
        ))
      )

      // advertise put the skill metadata in the first prompt, not the body...
      assert.include(JSON.stringify(outcome.prompts[0]), "Issuing refunds")
      assert.notInclude(JSON.stringify(outcome.prompts[0]), "verify the order")
      // ...and load_skill returned the body, so the run completed.
      assert.strictEqual(outcome.text, "refund issued")
    })
  )
})
