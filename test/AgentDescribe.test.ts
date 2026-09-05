import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import * as Permission from "../src/Permission.js"
import { TestLanguageModel } from "../src/testing/index.js"
import * as ToolExecution from "../src/ToolExecution.js"

/**
 * Item 60h: seams that describe themselves.
 *
 * `Agent.describe` is derived from the composed values, so the rows check two
 * things: that a composed agent reads back as the data a newcomer would want
 * (the first row is one literal), and that a description cannot lie -- a
 * bound's described number is the number its `decide` stops at, driven with
 * synthetic states rather than believed.
 */

const Search = Tool.make("search", {
  description: "Search the index.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})
const search = Agent.tool(Search, () => Effect.succeed("hits"))

const call = (id: string) => ({ id, name: "search", params: { query: id } })

/** Run `agent` against a script of tool-call turns and return how many turns it took. */
const turnsTaken = (agent: Agent.Any, turns: number, during?: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const { layer } = yield* TestLanguageModel.script(
      Array.from({ length: turns }, (_, i) => ({ toolCalls: [call(`c${i}`)], ...(during === undefined ? {} : { during }) }))
    )
    const result = yield* Effect.scoped(
      Effect.flatMap(AgentSession.make(agent), (session) => AgentSession.prompt(session, "go"))
    ).pipe(Effect.provide(layer))
    return result.turns
  })

describe("Agent.describe", () => {
  it("reads a composed agent back as one literal", () => {
    const agent = Agent.make({
      instructions: "Be terse.",
      tools: [search],
      loop: Budget.within(50_000, AgentLoop.limits({ maxTurns: 8, maxToolCalls: 20, maxDuration: "2 minutes", finalTurn: true })),
      permission: Permission.except(
        Permission.rules([{ tool: "search", decision: Permission.allow }], { otherwise: Permission.ask() }),
        [{ resource: /^\/etc\//, decision: Permission.deny("system files") }]
      ),
      toolExecution: ToolExecution.concurrency(2)
    })
    const description = Agent.describe(agent)
    assert.deepStrictEqual(description, {
      instructions: Option.some("Be terse."),
      tools: Option.some([{ name: "search", description: Option.some("Search the index.") }]),
      loop: {
        _tag: "Custom",
        name: "Budget.within",
        details: { limit: 50_000 },
        inner: {
          _tag: "FinalTurn",
          inner: {
            _tag: "And",
            loops: [
              { _tag: "UntilIdle" },
              { _tag: "MaxTurns", max: 8 },
              { _tag: "MaxToolCalls", max: 20 },
              { _tag: "MaxDuration", millis: 120_000 }
            ]
          }
        }
      },
      permission: {
        _tag: "Except",
        base: {
          _tag: "Rules",
          rules: [{ tool: "search", decision: { _tag: "Allow" } }],
          otherwise: { _tag: "Ask" }
        },
        exceptions: [{ resource: "regexp:^\\/etc\\/", decision: { _tag: "Deny", reason: "system files" } }]
      },
      toolExecution: { _tag: "Concurrency", limit: 2 },
      toolFailurePolicy: { _tag: "ReturnToModel" },
      toolDenialPolicy: { _tag: "FailRun" },
      input: { raw: true, schema: AgentInput.prompt.schema },
      output: Option.none()
    })
  })

  it("the defaults of an empty agent, and what an output and a typed input change", () => {
    const plain = Agent.describe(Agent.make({}))
    assert.deepStrictEqual(plain.loop, { _tag: "UntilIdle" })
    assert.deepStrictEqual(plain.permission, { _tag: "AllowAll" })
    assert.deepStrictEqual(plain.tools, Option.some([]))
    assert.deepStrictEqual(plain.toolExecution, { _tag: "Parallel" })
    assert.isTrue(plain.input.raw)

    const Ticket = Schema.Struct({ id: Schema.String })
    const Verdict = Schema.Struct({ ok: Schema.Boolean })
    const output = AgentOutput.make(Verdict)
    const typed = Agent.describe(Agent.make({
      input: AgentInput.make(Ticket, ({ id }) => `Ticket ${id}`),
      output
    }))
    assert.isFalse(typed.input.raw)
    assert.strictEqual(typed.input.schema, Ticket)
    // The output wraps the loop: a stop once the answer is reported.
    assert.deepStrictEqual(typed.loop, {
      _tag: "Custom",
      name: "Agent.outputReported",
      details: { toolName: output.toolName },
      inner: { _tag: "UntilIdle" }
    })
    assert.deepStrictEqual(typed.output, Option.some({ toolName: output.toolName, schema: Verdict }))
  })

  it("a toolkit resolved per turn has no tools to describe, and says None rather than guessing", () => {
    // A toolkit Effect that declares nothing about its tools until it runs.
    const Searching = Toolkit.make(Search)
    const dynamic = Agent.make({
      toolkit: Searching.pipe(Effect.provide(Searching.toLayer({ search: () => Effect.succeed("x") })))
    })
    assert.deepStrictEqual(Agent.describe(dynamic).tools, Option.none())
  })

  it("a loop or policy written by hand is Custom, named when it says so", () => {
    const anonymous = Agent.make({ loop: () => Effect.succeed(AgentLoop.Stop) })
    assert.deepStrictEqual(Agent.describe(anonymous).loop, { _tag: "Custom", name: "anonymous" })
    const named = AgentLoop.make(() => Effect.succeed(AgentLoop.Stop), { _tag: "Custom", name: "stop at once" })
    assert.deepStrictEqual(Agent.describe(Agent.make({ loop: named })).loop, { _tag: "Custom", name: "stop at once" })
    assert.deepStrictEqual(Permission.describe(Permission.make(() => Effect.succeed(Permission.allow))), {
      _tag: "Custom",
      name: "anonymous"
    })
    // A policy object that predates descriptions carries none: still Custom.
    assert.deepStrictEqual(Permission.describe({ evaluate: () => Effect.succeed(Permission.allow) }), {
      _tag: "Custom",
      name: "anonymous"
    })
    assert.deepStrictEqual(Permission.describe(Permission.all(Permission.allowAll, Permission.denyAll)), {
      _tag: "All",
      policies: [{ _tag: "AllowAll" }, { _tag: "DenyAll" }]
    })
    assert.deepStrictEqual(
      Permission.describe(Permission.rules([{ action: (a) => a.startsWith("read"), decision: Permission.allow }], { otherwise: Permission.deny() })),
      { _tag: "Rules", rules: [{ action: "function", decision: { _tag: "Allow" } }], otherwise: { _tag: "Deny" } }
    )
  })

  it.effect("a described bound is the bound: each run stops exactly where its description says", () =>
    Effect.gen(function* () {
      // Real runs, more turns scripted than any bound allows: the turn count
      // the run ends at must be the number the description carries. A
      // description typed beside the bound rather than derived from it could
      // drift; this is the row that would notice. Each model call advances
      // the test clock by a second for the duration bound.
      const turns = AgentLoop.maxTurns(5)
      const calls = AgentLoop.maxToolCalls(7)
      const time = AgentLoop.maxDuration("3 seconds")
      const byTurn = yield* turnsTaken(Agent.make({ tools: [search], loop: turns }), 10)
      const byCalls = yield* turnsTaken(Agent.make({ tools: [search], loop: calls }), 10)
      const byTime = yield* turnsTaken(Agent.make({ tools: [search], loop: time }), 10, TestClock.adjust(Duration.seconds(1)))
      assert.deepStrictEqual(turns.description, { _tag: "MaxTurns", max: byTurn })
      // One call per turn, so the turn the call ceiling bites is the ceiling.
      assert.deepStrictEqual(calls.description, { _tag: "MaxToolCalls", max: byCalls })
      assert.deepStrictEqual(time.description, { _tag: "MaxDuration", millis: byTime * 1000 })
      // And `or` describes as `or`, not as the `and` its arguments came from.
      assert.deepStrictEqual(AgentLoop.or(turns, calls).description, {
        _tag: "Or",
        loops: [{ _tag: "MaxTurns", max: 5 }, { _tag: "MaxToolCalls", max: 7 }]
      })
    })
  )
})
