import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as Failpoint from "../src/internal/failpoint.js"
import { DurableEquivalence } from "../src/testing/index.js"

/**
 * A process that dies *inside* a tool's handler (item 98's durable half).
 *
 * Interruption was already handled: a non-idempotent call records
 * `Unresolved` rather than running again. A death records nothing, and a
 * replacement used to run the handler a second time -- the side effect
 * twice, under a history that read as one clean call. The start marker
 * `DurableToolkit` journals first closes that: a replacement that finds it
 * and no outcome refuses to guess.
 */

const inHandler = Failpoint.group("DurableToolCrashTest", ["in-handler"])

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "tool-crash-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

/** A tool that counts its runs, then dies at the failpoint if one is armed there. */
const scenarioFor = (idempotent: boolean) => {
  let runs = 0
  const Charge = Tool.make("charge", { parameters: Schema.Struct({}), success: Schema.String })
    .annotate(Tool.Idempotent, idempotent)
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
              Effect.as("ok")
            ))
        ],
        loop: AgentLoop.bounded(3)
      }),
    turns: [{ toolCalls: [{ id: "c1", name: "charge", params: {} }] }, { text: "done" }],
    prompt: "go"
  })
  return { scenario, runs: () => runs }
}

describe("a process that dies inside a tool handler", () => {
  it.live("a non-idempotent call is not run again: the submission ends unresolved, the side effect once", () =>
    Effect.gen(function*() {
      const { runs, scenario } = scenarioFor(false)
      const exit = yield* Effect.exit(
        DurableEquivalence.crashed(scenario, { database, at: inHandler.qualified("in-handler") })
      )
      assert.strictEqual(runs(), 1, "the replacement ran the handler again")
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "DurableToolUnresolvedError")
    }), 90_000)

  it.live("an idempotent call is run again, and the submission completes as if nothing happened", () =>
    Effect.gen(function*() {
      const { runs, scenario } = scenarioFor(true)
      const { observation } = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: inHandler.qualified("in-handler")
      })
      assert.strictEqual(runs(), 2)
      assert.strictEqual(observation.status, "completed")
      assert.strictEqual(observation.text, "done")
    }), 90_000)
})
