import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Compaction } from "../src/compaction/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `TestLanguageModel`'s `select: "results"` (item 104): a script that picks
 * its turn by the tool results the prompt ends with, which survive
 * compaction, rather than by counting assistant messages, which do not.
 */

const Lookup = Tool.make("lookup", { parameters: Schema.Struct({ of: Schema.String }), success: Schema.String })

const turns: ReadonlyArray<TestLanguageModel.Turn> = [
  { toolCalls: [{ id: "a", name: "lookup", params: { of: "one" } }] },
  { toolCalls: [{ id: "b", name: "lookup", params: { of: "two" } }] },
  { toolCalls: [{ id: "c", name: "lookup", params: { of: "three" } }] },
  { text: "all three are ok" }
]

/** A run that folds on most turns; returns what the tools did and the reply. */
const compactingRun = (select: "history" | "results") =>
  Effect.gen(function*() {
    const ran: Array<string> = []
    const contextTransform = yield* Compaction.make({
      policy: Compaction.whenLongerThan(2, { retain: 2 }),
      summarise: ({ messages }) => Effect.succeed(`folded ${messages.content.length} messages`)
    })
    const agent = Agent.make({
      contextTransform,
      tools: [Agent.tool(Lookup, ({ of }) => Effect.sync(() => void ran.push(of)).pipe(Effect.as(`${of}: ok`)))],
      loop: AgentLoop.bounded(8)
    })
    const { layer } = yield* TestLanguageModel.script(turns, { select })
    const result = yield* Effect.scoped(
      Effect.flatMap(AgentSession.make(agent), (session) => session.prompt("check all three"))
    ).pipe(Effect.provide(layer))
    return { ran, text: result.text }
  })

describe("TestLanguageModel select: \"results\"", () => {
  it.effect("follows a compacting run turn by turn: each tool runs once", () =>
    Effect.gen(function*() {
      const { ran, text } = yield* compactingRun("results")
      assert.deepStrictEqual(ran, ["one", "two", "three"])
      assert.strictEqual(text, "all three are ok")
    }))

  it.effect("control: counting assistant messages loses its place once compaction folds them", () =>
    Effect.gen(function*() {
      const { ran } = yield* compactingRun("history")
      assert.notDeepEqual(ran, ["one", "two", "three"])
    }))
})
