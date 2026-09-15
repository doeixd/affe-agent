import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Tracer } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Budget from "../src/budget/Budget.js"
import { Observability } from "../src/observability/index.js"
import { Subagent } from "../src/subagent/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * What a delegation's child spent reaches the parent's trace.
 *
 * Before this the child's tokens were counted only by a `Budget` in the
 * parent's context, and only under `inherit.budget`. A host billing on tokens
 * with no ceiling configured under-reported every turn that delegated.
 */

interface Ended {
  readonly name: string
  readonly attributes: Readonly<Record<string, unknown>>
}

/** A tracer that records each span as it ends, with its final attributes. */
const capturing = () => {
  const ended: Array<Ended> = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      const end = span.end.bind(span)
      span.end = (endTime, exit) => {
        end(endTime, exit)
        ended.push({ name: span.name, attributes: Object.fromEntries(span.attributes) })
      }
      return span
    }
  })
  return { ended, tracer }
}

const names = Observability.attributeNames

const delegationSpan = (ended: ReadonlyArray<Ended>): Ended => {
  const found = ended.filter((span) => span.attributes[names.toolName] === "research")
  assert.strictEqual(found.length, 1, "one span for the one delegation")
  return found[0]!
}

const Lookup = Tool.make("lookup", { parameters: Schema.Struct({}), success: Schema.String })

/** A child that spends two turns: 30 + 12, then 50 + 8 -- 100 tokens. */
const childScript = () =>
  TestLanguageModel.script([
    { ...TestLanguageModel.toolCall("lookup", {}, { id: "l1" }), usage: { input: 30, output: 12 } },
    { ...TestLanguageModel.text("child: found it"), usage: { input: 50, output: 8 } }
  ])

const Researcher = Agent.make({
  instructions: "Research.",
  tools: [Agent.tool(Lookup, () => Effect.succeed("a fact"))]
})

describe("a delegation's spend on the parent's trace", () => {
  it.effect("a parent with no Budget still sees what its child spent", () =>
    Effect.gen(function* () {
      const { ended, tracer } = capturing()
      const child = yield* childScript()
      const parent = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "d1", name: "research", params: { prompt: "look it up" } }] },
        TestLanguageModel.text("parent: done")
      ])
      const research = Subagent.tool("research", Researcher, { description: "Research.", provide: child.layer })
      const Lead = Agent.make({ instructions: "You delegate.", tools: [research] })

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Lead), (session) => session.prompt("go"))
      ).pipe(Effect.provide(parent.layer), Effect.withTracer(tracer))

      assert.strictEqual(result.text, "parent: done")
      const span = delegationSpan(ended)
      assert.strictEqual(span.attributes[names.delegatedTokens], 100)
      // Nothing priced the model, so no cost is claimed.
      assert.isUndefined(span.attributes[names.delegatedCost])
    })
  )

  it.effect("under inherit.budget false the parent's Budget is not charged, and the span still counts the child", () =>
    Effect.gen(function* () {
      const { ended, tracer } = capturing()
      const child = yield* childScript()
      const parent = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "d1", name: "research", params: { prompt: "look it up" } }], usage: { input: 1, output: 1 } },
        { ...TestLanguageModel.text("parent: done"), usage: { input: 1, output: 1 } }
      ])
      const research = Subagent.tool("research", Researcher, {
        description: "Research.",
        provide: child.layer,
        inherit: { budget: false }
      })
      const Lead = Agent.make({ instructions: "You delegate.", tools: [research] })

      const spent = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Lead)
          yield* session.prompt("go")
          return yield* Effect.flatMap(Budget.Budget, (budget) => budget.spent)
        })
      ).pipe(Effect.provide([parent.layer, Budget.fresh()]), Effect.withTracer(tracer))

      // The parent's own two turns, and none of the child's.
      assert.strictEqual(spent, 4)
      assert.strictEqual(delegationSpan(ended).attributes[names.delegatedTokens], 100)
    })
  )
})
