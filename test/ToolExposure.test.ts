import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Option, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Principal from "../src/Principal.js"
import * as ToolExposure from "../src/ToolExposure.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { DurableEquivalence } from "../src/testing/index.js"
import { ToolSource } from "../src/toolSource/index.js"
import { withSession } from "./helpers.js"

/**
 * Item 93: which tools the model is shown, as distinct from which it may
 * call. Every row reads the tool list the model was actually *sent*, from the
 * scripted model's recorder -- `toolChoice.oneOf` narrows it before the
 * provider sees it -- not internal state.
 */

/** Forty ordinary tools, plus `read_file` and a `billing_refund` only some callers may see. */
const make = (name: string, description: string) =>
  Tool.make(name, { description, parameters: Schema.Struct({}), success: Schema.String })
const catalog = [
  ...Array.from({ length: 40 }, (_, i) => make(`tool_${i}`, `routine operation number ${i}`)),
  make("read_file", "read a file from the workspace"),
  make("billing_refund", "refund a customer invoice")
]

const setup = (exposure: ToolExposure.ToolExposure) =>
  Effect.gen(function*() {
    const ran = yield* Ref.make<ReadonlyArray<string>>([])
    const agent = Agent.make({
      tools: catalog.map((tool) => Agent.tool(tool, () => Effect.as(Ref.update(ran, (all) => [...all, tool.name]), "ok"))),
      toolExposure: exposure,
      loop: AgentLoop.bounded(4)
    })
    return { agent, ran: Ref.get(ran) }
  })

/** Admins see billing; everyone else does not know it exists. */
const onlyAdminsBill = (tool: string, principal: Option.Option<string>) =>
  tool !== "billing_refund" || Option.getOrElse(principal, () => "") === "admin"

const progressive = ToolExposure.progressive({ pinned: ["read_file", "billing_refund"], maxTools: 6, visible: onlyAdminsBill })

describe("progressive tool exposure (item 93)", () => {
  it.effect("the first request carries the pinned tools and discovery, not forty-two schemas", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup(progressive)
      const { recorder } = yield* withSession([{ text: "hi" }], agent, ({ session }) => AgentSession.prompt(session, "go"))
      const [first] = yield* recorder.tools
      // `billing_refund` is pinned but hidden from this caller: pinning never
      // brings back what visibility hid.
      assert.deepStrictEqual([...first!].sort(), ["discover_tools", "read_file"])
    }))

  it.effect("discovery searches only what the caller may see, and its picks are on the next request", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup(progressive)
      const { events, recorder } = yield* withSession(
        [
          { toolCalls: [{ id: "d1", name: "discover_tools", params: { query: "refund routine operation 7" } }] },
          { toolCalls: [{ id: "t1", name: "tool_7", params: {} }] },
          { text: "done" }
        ],
        agent,
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const discovery = events.flatMap((e) =>
        AgentEvent.is("ToolCallSucceeded")(e) && e.event.name === "discover_tools"
          ? [Schema.decodeUnknownSync(ToolExposure.Discovery)(e.event.result)]
          : []
      )[0]!
      // Hidden means absent: the query names a refund, and none comes back.
      assert.notInclude(discovery.tools.map((t) => t.name), "billing_refund")
      assert.include(discovery.selected, "tool_7")
      // Each found tool is callable as returned: its parameters are there.
      assert.isDefined(discovery.tools[0]!.parameters)

      const offered = yield* recorder.tools
      assert.notInclude(offered[0]!, "tool_7", "exposed before it was discovered")
      assert.include(offered[1]!, "tool_7", "not exposed after it was discovered")
      // Bounded: never more than maxTools on a request.
      assert.isAtMost(offered[1]!.length, 6)
    }))

  it.effect("a call to a tool that was not exposed is refused by name and never runs", () =>
    Effect.gen(function*() {
      const { agent, ran } = yield* setup(progressive)
      const { events } = yield* withSession(
        [{ toolCalls: [{ id: "x1", name: "tool_3", params: {} }] }, { text: "ok" }],
        agent,
        ({ session }) => AgentSession.prompt(session, "go")
      )
      assert.deepStrictEqual(yield* ran, [])
      const failed = events.flatMap((e) => AgentEvent.is("ToolCallFailed")(e) ? [e.event] : [])
      assert.strictEqual(failed[0]!.failure.tag, "ToolNotExposedError")
      assert.isTrue(failed[0]!.returnedToModel)
    }))

  it.effect("an admin sees the pinned billing tool: visibility is decided per caller", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup(progressive)
      const { recorder } = yield* withSession([{ text: "hi" }], agent, ({ session }) => AgentSession.prompt(session, "go"))
        .pipe(Effect.provideService(Principal.CurrentPrincipal, Option.some("admin")))
      assert.include((yield* recorder.tools)[0]!, "billing_refund")
    }))

  it.effect("eager exposure with a visibility rule hides only what the caller may not see", () =>
    Effect.gen(function*() {
      const { agent, ran } = yield* setup(ToolExposure.eager({ visible: onlyAdminsBill }))
      const { recorder } = yield* withSession(
        [{ toolCalls: [{ id: "b1", name: "billing_refund", params: {} }] }, { text: "ok" }],
        agent,
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const [first] = yield* recorder.tools
      assert.strictEqual(first!.length, 41)
      assert.notInclude(first!, "billing_refund")
      // And a guessed name is refused, not run.
      assert.deepStrictEqual(yield* ran, [])
    }))

  it.effect("an unchanged selection sends a byte-identical tool list, so a provider's prompt cache survives (item 101)", () =>
    Effect.gen(function*() {
      // A tool list that changes between requests can cost a provider's
      // prefix cache. Two requests after one discovery, with no new search
      // between them, must carry the same tools in the same order. The order
      // is the toolkit's -- Effect AI filters the toolkit by `oneOf` rather
      // than following `oneOf`'s order -- so it is stable by construction;
      // this pins it.
      const { agent } = yield* setup(progressive)
      const { recorder } = yield* withSession(
        [
          { toolCalls: [{ id: "d1", name: "discover_tools", params: { query: "routine operation" } }] },
          { toolCalls: [{ id: "t1", name: "tool_1", params: {} }] },
          { toolCalls: [{ id: "t2", name: "tool_2", params: {} }] },
          { text: "done" }
        ],
        agent,
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const offered = yield* recorder.tools
      assert.strictEqual(offered.length, 4)
      assert.notDeepEqual(offered[1], offered[0], "discovery did not change the list")
      assert.deepStrictEqual(offered[2], offered[1])
      assert.deepStrictEqual(offered[3], offered[1])
      assert.strictEqual(JSON.stringify(offered[3]), JSON.stringify(offered[1]))
    }))

  it.effect("maxSchemaBytes bounds what discovery selects by size, skipping one too large to fit", () =>
    Effect.gen(function*() {
      // One match whose schema outweighs the budget on its own, ranked first,
      // and small ones behind it: the big one is skipped, the small ones fit.
      const huge = Tool.make("report_huge", {
        description: "report on everything",
        parameters: Schema.Struct(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field_${i}`, Schema.String]))),
        success: Schema.String
      })
      const small = Array.from({ length: 3 }, (_, i) => make(`report_${i}`, `report number ${i}`))
      const all = [huge, ...small]
      const budget = 400
      const agent = Agent.make({
        tools: all.map((tool) => Agent.tool(tool, () => Effect.succeed("ok"))),
        toolExposure: ToolExposure.progressive({ maxSchemaBytes: budget }),
        loop: AgentLoop.bounded(3)
      })
      const { events, recorder } = yield* withSession(
        [
          { toolCalls: [{ id: "d1", name: "discover_tools", params: { query: "report everything" } }] },
          { text: "done" }
        ],
        agent,
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const discovery = events.flatMap((e) =>
        AgentEvent.is("ToolCallSucceeded")(e) && e.event.name === "discover_tools"
          ? [Schema.decodeUnknownSync(ToolExposure.Discovery)(e.event.result)]
          : []
      )[0]!
      assert.isAbove(ToolExposure.schemaBytes(Tool.getJsonSchema(huge)), budget, "the fixture's big tool must not fit")
      assert.notInclude(discovery.selected, "report_huge")
      assert.isAbove(discovery.selected.length, 0, "the small matches behind it still get in")
      assert.isTrue(discovery.more, "something was left out, and discovery says so")
      // The next request carries only what fit.
      const byName = new Map(all.map((tool) => [tool.name, ToolExposure.schemaBytes(Tool.getJsonSchema(tool))]))
      const sent = (yield* recorder.tools)[1]!.reduce((sum, name) => sum + (byName.get(name) ?? 0), 0)
      assert.isAtMost(sent, budget)
    }))

  it("a byte budget that is not a positive integer is refused", () => {
    assert.throws(() => ToolExposure.progressive({ maxSchemaBytes: 0 }), RangeError)
  })

  it.effect("eager with no rule leaves requests exactly as they were", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup(ToolExposure.eager())
      const { recorder } = yield* withSession([{ text: "hi" }], agent, ({ session }) => AgentSession.prompt(session, "go"))
      assert.strictEqual((yield* recorder.tools)[0]!.length, 42)
    }))
})

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "exposure-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

describe("progressive exposure under durability (item 93)", () => {
  it.live("a crash after discovery recovers the selection from history, without discovering again", () =>
    Effect.gen(function*() {
      const scenario = DurableEquivalence.scenario({
        agent: (effects) =>
          Agent.make({
            tools: catalog.map((tool) => Agent.tool(tool, () => Effect.as(effects.record(tool.name), "ok"))),
            toolExposure: progressive,
            loop: AgentLoop.bounded(4)
          }),
        turns: [
          { toolCalls: [{ id: "d1", name: "discover_tools", params: { query: "routine operation 7" } }] },
          { toolCalls: [{ id: "t1", name: "tool_7", params: {} }] },
          { text: "done" }
        ],
        prompt: "go"
      })
      const straight = yield* DurableEquivalence.straight(scenario, { database })
      assert.deepStrictEqual(straight.effects, ["tool_7"])
      // Dies after the discovery turn committed: the next turn's exposure
      // must come from the recorded result, or `tool_7` would be refused.
      const recovered = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: turnFailpoints.qualified("after-commit")
      })
      assert.deepStrictEqual(recovered.split, [1, 2])
      assert.deepStrictEqual(recovered.observation, straight)
    }), 90_000)
})

describe("progressive exposure over a tool source (item 93, T3.7)", () => {
  it.effect("tools a source discovers at runtime are exposed by discovery and called through the source", () =>
    Effect.gen(function*() {
      // What an MCP server or an OpenAPI spec produces: many tools, schemas as
      // JSON Schema, known only when the source is read -- the case
      // progressive exposure exists for.
      const invoked = yield* Ref.make<ReadonlyArray<string>>([])
      const source: ToolSource.ToolSource = {
        id: "remote",
        extract: Effect.succeed({
          tools: Array.from({ length: 30 }, (_, i) => ({
            name: `op_${i}`,
            description: `remote operation number ${i}`,
            input: { type: "object", properties: { id: { type: "string" } } }
          })),
          skipped: []
        }),
        invoke: (name) => Effect.as(Ref.update(invoked, (all) => [...all, name]), { ok: true })
      }
      // Bound before the agent is made, as an MCP toolkit usually is; the
      // agent sees only what the source declared.
      const toolkit = yield* ToolSource.bindDiscovered(source)
      const agent = Agent.make({
        toolkit,
        toolExposure: ToolExposure.progressive({ maxTools: 6 }),
        loop: AgentLoop.bounded(4)
      })
      const { recorder } = yield* withSession(
        [
          { toolCalls: [{ id: "d1", name: "discover_tools", params: { query: "remote operation 7" } }] },
          { toolCalls: [{ id: "c1", name: "op_7", params: { id: "x" } }] },
          { text: "done" }
        ],
        agent,
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const offered = yield* recorder.tools
      assert.deepStrictEqual([...offered[0]!], ["discover_tools"])
      assert.include(offered[1]!, "op_7")
      assert.isAtMost(offered[1]!.length, 6)
      assert.deepStrictEqual(yield* Ref.get(invoked), ["op_7"])
    }))
})
