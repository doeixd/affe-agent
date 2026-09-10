import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentRun from "../src/AgentRun.js"
import * as AgentSession from "../src/AgentSession.js"
import * as AgentSubmission from "../src/AgentSubmission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { Compaction } from "../src/compaction/index.js"
import * as ToolContracts from "../src/durable/ToolContracts.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { DurableEquivalence } from "../src/testing/index.js"

/**
 * Item 107: a durable tool contract is part of the persisted program. A replay
 * under a changed contract is refused by name rather than misread, and a
 * recorded control-tool request that no longer decodes is an error rather
 * than an absence.
 */

const lookup = <const Fields extends Schema.Struct.Fields>(parameters: Fields, description = "look something up") =>
  Tool.make("lookup", { description, parameters: Schema.Struct(parameters), success: Schema.String })

describe("tool contract digests", () => {
  it.effect("follow what decoding depends on, not what the model reads", () =>
    Effect.gen(function*() {
      const base = yield* ToolContracts.digestOf(lookup({ of: Schema.String }))
      // Rewording the description is not a contract change.
      assert.strictEqual(yield* ToolContracts.digestOf(lookup({ of: Schema.String }, "find a thing")), base)
      // A parameter change is.
      assert.notStrictEqual(yield* ToolContracts.digestOf(lookup({ of: Schema.String, limit: Schema.Number })), base)
      // So is the execution-relevant annotation: an `Alone` tool replays differently.
      assert.notStrictEqual(
        yield* ToolContracts.digestOf(lookup({ of: Schema.String }).annotate(ToolExecution.Alone, true)),
        base
      )
    }))
})

describe("a recorded new_context request that no longer decodes", () => {
  it.effect("is refused, not read as no request", () =>
    Effect.gen(function*() {
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(50, { retain: 4 }),
        summarise: () => Effect.succeed("unused")
      })
      // A new_context result recorded under a contract whose shape differed:
      // no `handoff`, a field the current `RolloverRequest` does not know.
      const prompt = Prompt.fromMessages([
        Prompt.userMessage({ content: [Prompt.textPart({ text: "go" })] }),
        Prompt.assistantMessage({
          content: [Prompt.toolCallPart({ id: "n1", name: "new_context", params: {}, providerExecuted: false })]
        }),
        Prompt.toolMessage({
          content: [
            Prompt.toolResultPart({ id: "n1", name: "new_context", isFailure: false, result: 42, providerExecuted: false })
          ]
        })
      ])
      const exit = yield* Effect.exit(
        compaction.transform.transform({
          sessionId: AgentSession.Id.make("contracts"),
          submissionId: AgentSubmission.Id.make("contracts"),
          runId: AgentRun.Id.make("contracts"),
          turnIndex: 1,
          canonicalPrompt: prompt,
          prompt
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.include(Cause.pretty(exit.cause), "does not decode as a rollover request")
      }
    }))
})

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "contracts-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

/**
 * A run that dies after the model asked for `lookup` and before it ran, then
 * is finished by a process whose tools are `second`'s.
 */
const recovery = (second: (effects: DurableEquivalence.Effects) => ReadonlyArray<Agent.BoundTool<Tool.Any>>) =>
  DurableEquivalence.scenario({
    agent: (effects, process) =>
      Agent.make({
        tools: process === "first"
          ? [Agent.tool(lookup({ of: Schema.String }), ({ of }) => Effect.as(effects.record(of), `found ${of}`))]
          : second(effects),
        loop: AgentLoop.bounded(4)
      }),
    turns: [{ toolCalls: [{ id: "l1", name: "lookup", params: { of: "orders" } }] }, { text: "done" }],
    prompt: "look it up"
  })

describe("a durable replay under changed tool contracts (item 107)", () => {
  it.live("is refused by name when a recorded tool changed", () =>
    Effect.gen(function*() {
      const scenario = recovery((effects) => [
        Agent.tool(lookup({ of: Schema.String, limit: Schema.Number }), ({ of }) =>
          Effect.as(effects.record(`changed:${of}`), `found ${of}`))
      ])
      const exit = yield* Effect.exit(
        DurableEquivalence.crashed(scenario, { database, at: turnFailpoints.qualified("after-model-response") })
      )
      assert.isTrue(Exit.isFailure(exit), "the replay ran under a contract it was not recorded with")
      if (Exit.isFailure(exit)) {
        const text = Cause.pretty(exit.cause)
        assert.include(text, "ToolContractChangedError")
        assert.include(text, "lookup changed")
      }
    }), 90_000)

  it.live("proceeds when the changed tool declares the recorded contract compatible (Q7)", () =>
    Effect.gen(function*() {
      // The author knows an added optional field reads what was recorded;
      // the library cannot tell that from a rename, so the author says so,
      // by the exact digest the refusal would print.
      const recorded = yield* ToolContracts.digestOf(lookup({ of: Schema.String }))
      const widened = lookup({ of: Schema.String, limit: Schema.optional(Schema.Number) })
        .annotate(ToolContracts.CompatibleWith, [recorded])
      const scenario = recovery((effects) => [
        Agent.tool(widened, ({ of }) => Effect.as(effects.record(of), `found ${of}`))
      ])
      const recovered = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: turnFailpoints.qualified("after-model-response")
      })
      assert.strictEqual(recovered.observation.text, "done")
      assert.deepStrictEqual(recovered.observation.effects, ["orders"])
    }), 90_000)

  it.live("proceeds when the replacement only added a tool: nothing recorded refers to it", () =>
    Effect.gen(function*() {
      const Extra = Tool.make("extra", { parameters: Schema.Struct({}), success: Schema.String })
      const scenario = recovery((effects) => [
        Agent.tool(lookup({ of: Schema.String }), ({ of }) => Effect.as(effects.record(of), `found ${of}`)),
        Agent.tool(Extra, () => Effect.succeed("unused"))
      ])
      const recovered = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: turnFailpoints.qualified("after-model-response")
      })
      assert.strictEqual(recovered.observation.text, "done")
      assert.deepStrictEqual(recovered.observation.effects, ["orders"])
    }), 90_000)
})
