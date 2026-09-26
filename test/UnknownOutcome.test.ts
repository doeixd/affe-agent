import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import type * as Elicitation from "../src/Elicitation.js"
import * as DurableToolkit from "../src/durable/DurableToolkit.js"
import * as Failpoint from "../src/internal/failpoint.js"
import { DurableEquivalence } from "../src/testing/index.js"

/**
 * Item 133: a call whose outcome is unknown, asked about rather than fatal.
 *
 * The process dies inside the handler, after the start marker. The
 * replacement cannot know whether the charge went out. Without the opt-in it
 * ends the run (`DurableToolCrash.test.ts`). With it, it asks, and an
 * operator's answer, given through the session's ordinary `respond`, is what
 * the model sees. The handler runs once either way.
 */

const inHandler = Failpoint.group("UnknownOutcomeTest", ["in-handler"])

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "unknown-outcome-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

const Receipt = Schema.Struct({ id: Schema.String })

const scenarioFor = (answer: (request: Elicitation.Request) => Elicitation.Response) => {
  let runs = 0
  const asked: Array<Elicitation.Request> = []
  const Charge = DurableToolkit.askWhenUnknown(
    Tool.make("charge", { parameters: Schema.Struct({ amount: Schema.Number }), success: Receipt })
  )
  const scenario = DurableEquivalence.scenario({
    agent: (effects) =>
      Agent.make({
        tools: [
          Agent.tool(Charge, () =>
            Effect.sync(() => {
              runs++
            }).pipe(
              Effect.andThen(effects.record("charged")),
              Effect.andThen(inHandler.hit("in-handler")),
              Effect.as({ id: "never-seen" })
            ))
        ],
        loop: AgentLoop.bounded(3)
      }),
    turns: [{ toolCalls: [{ id: "c1", name: "charge", params: { amount: 500 } }] }, { text: "done" }],
    prompt: "charge it",
    answer: (request) => {
      asked.push(request)
      return answer(request)
    }
  })
  return { scenario, runs: () => runs, asked }
}

/** The tool result the model was shown for the call, from the recovered history. */
const toolResult = (history: unknown) => JSON.stringify(history)

describe("an unknown tool outcome, asked about (item 133)", () => {
  it.live("an operator who says it succeeded supplies the result, and the run carries on", () =>
    Effect.gen(function*() {
      const { asked, runs, scenario } = scenarioFor((request) => ({
        id: request.id,
        granted: true,
        value: { id: "rcpt-42" }
      }))
      const { observation } = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: inHandler.qualified("in-handler")
      })
      assert.strictEqual(runs(), 1, "the handler ran again")
      assert.strictEqual(observation.status, "completed")
      assert.strictEqual(observation.text, "done")
      assert.include(toolResult(observation.history), "rcpt-42")
      assert.notInclude(toolResult(observation.history), "never-seen")
      const question = asked.find((request) => request.kind === DurableToolkit.unknownOutcomeKind)
      assert.isDefined(question)
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(DurableToolkit.UnknownOutcome)(question!.detail),
        { toolName: "charge", toolCallId: "c1", params: { amount: 500 } }
      )
    }), 90_000)

  it.live("an operator who says it failed is what the model sees, and the run carries on", () =>
    Effect.gen(function*() {
      const { runs, scenario } = scenarioFor((request) => ({ id: request.id, granted: false, value: "card declined" }))
      const { observation } = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: inHandler.qualified("in-handler")
      })
      assert.strictEqual(runs(), 1)
      assert.strictEqual(observation.status, "completed")
      assert.include(toolResult(observation.history), "card declined")
    }), 90_000)

  it.live("an answer that is not the tool's result ends the run, as an unknown outcome always did", () =>
    Effect.gen(function*() {
      const { runs, scenario } = scenarioFor((request) => ({ id: request.id, granted: true, value: "not a receipt" }))
      const exit = yield* Effect.exit(
        DurableEquivalence.crashed(scenario, { database, at: inHandler.qualified("in-handler") })
      )
      assert.strictEqual(runs(), 1)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "DurableToolUnresolvedError")
    }), 90_000)
})
