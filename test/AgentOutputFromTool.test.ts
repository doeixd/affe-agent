import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Effect, Exit, Option, Ref, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import type { Prompt } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import * as AgentSession from "../src/AgentSession.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { AgentProbe, DurableEquivalence } from "../src/testing/index.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 92: an ordinary tool's committed result can be the answer, with no
 * model call spent copying it into the output tool.
 */

const CreateProject = Tool.make("create_project", {
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ created: Schema.Boolean, id: Schema.String, href: Schema.String }),
  failure: Schema.String
})

const Created = Schema.Struct({ projectId: Schema.String, url: Schema.String })

const output = AgentOutput.make(Created).pipe(
  AgentOutput.fromTool(CreateProject, ({ params, result }) =>
    result.created ? Option.some({ projectId: `${params.name}:${result.id}`, url: result.href }) : Option.none())
)

/** An agent whose `create_project` answers `created` as scripted, and counts its runs. */
const setup = (created: boolean, fails = false) =>
  Effect.gen(function*() {
    const runs = yield* Ref.make(0)
    const agent = Agent.make({
      output,
      tools: [
        Agent.tool(CreateProject, ({ name }) =>
          Effect.andThen(
            Ref.update(runs, (n) => n + 1),
            fails ? Effect.fail("quota exceeded") : Effect.succeed({ created, id: "p1", href: `https://x/${name}` })
          ))
      ],
      loop: AgentLoop.bounded(4)
    })
    return { agent, runs }
  })

const run = <Tools extends Record<string, Tool.Any>, Value>(
  turns: ReadonlyArray<FakeModel.Turn>,
  agent: Agent.AgentDefinition<Tools, never, never, LanguageModel.LanguageModel, Value>
) =>
  Effect.gen(function*() {
    const { layer, recorder } = yield* FakeModel.layer(turns)
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        const probe = yield* AgentProbe.make(session)
        const result = yield* AgentSession.prompt<Tools, never, Value, Prompt.RawInput>(session, "create it")
        const completed = (yield* probe.events).flatMap((e) => AgentEvent.is("RunCompleted")(e) ? [e.event] : [])
        return { result, calls: yield* recorder.calls, completed }
      }).pipe(Effect.provide(layer))
    )
  })

const createCall: FakeModel.Turn = { toolCalls: [{ id: "c1", name: "create_project", params: { name: "atlas" } }] }

describe("AgentOutput.fromTool (item 92)", () => {
  it("describe names the tools that can complete the run (T4.4)", () => {
    const described = Agent.describe(Agent.make({ output }))
    assert.deepStrictEqual(
      Option.map(described.output, (o) => o.projectedFrom),
      Option.some(["create_project"])
    )
  })

  it.effect("a projecting tool's success is the answer, and the model is not asked again", () =>
    Effect.gen(function*() {
      const { agent, runs } = yield* setup(true)
      const { calls, result } = yield* run([createCall, FakeModel.text("unreachable")], agent)
      assert.strictEqual(calls, 1, "a second model call was spent copying the result")
      assert.strictEqual(yield* Ref.get(runs), 1)
      assert.deepStrictEqual(result.value, Option.some({ projectId: "atlas:p1", url: "https://x/atlas" }))
      assert.strictEqual(result.status, "completed")
    }))

  it.effect("the run says how it was answered: by which projecting call (T4.3)", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup(true)
      const { completed } = yield* run([createCall], agent)
      assert.deepStrictEqual(completed.map((e) => e.answeredBy), [
        { _tag: "Projected", toolName: "create_project", toolCallId: "c1" }
      ])
    }))

  it.effect("None continues the run, and the model can still answer itself", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup(false)
      const { calls, completed, result } = yield* run(
        [createCall, FakeModel.toolCall(output.toolName, { projectId: "manual", url: "https://x/manual" })],
        agent
      )
      assert.strictEqual(calls, 2)
      assert.deepStrictEqual(result.value, Option.some({ projectId: "manual", url: "https://x/manual" }))
      // Answered by the output tool, and the event names its call.
      assert.strictEqual(completed[0]?.answeredBy?._tag, "OutputTool")
    }))

  it.effect("a failed call is not projected: there is no result to be the answer", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup(true, true)
      const { calls, result } = yield* run([createCall, FakeModel.text("it failed")], agent)
      assert.strictEqual(calls, 2)
      assert.isTrue(Option.isNone(result.value))
    }))

  it.effect("a projector that throws is a defect, not a quiet None", () =>
    Effect.gen(function*() {
      const throwing = AgentOutput.make(Created).pipe(
        AgentOutput.fromTool(CreateProject, (): Option.Option<typeof Created.Type> => {
          throw new Error("projector bug")
        })
      )
      const agent = Agent.make({
        output: throwing,
        tools: [Agent.tool(CreateProject, () => Effect.succeed({ created: true, id: "p1", href: "h" }))]
      })
      const exit = yield* Effect.exit(run([createCall, FakeModel.text("unreachable")], agent))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "projector bug")
    }))
})

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "from-tool-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

describe("a projected answer under durability (item 92)", () => {
  it.live("a crash after the tool commits recovers the same answer, with no model call and no second run", () =>
    Effect.gen(function*() {
      // The projector is pure over the journalled result, so the replacement
      // re-derives the answer rather than asking anyone for it.
      const scenario = DurableEquivalence.scenario({
        agent: (effects) =>
          Agent.make({
            output,
            tools: [
              Agent.tool(CreateProject, ({ name }) =>
                Effect.as(effects.record(name), { created: true, id: "p1", href: `https://x/${name}` }))
            ],
            loop: AgentLoop.bounded(4)
          }),
        turns: [createCall, { text: "unreachable" }],
        prompt: "create it"
      })
      const straight = yield* DurableEquivalence.straight(scenario, { database })
      assert.strictEqual(straight.modelCalls, 1)
      assert.deepStrictEqual(straight.value, { projectId: "atlas:p1", url: "https://x/atlas" })

      const recovered = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: turnFailpoints.qualified("after-commit")
      })
      assert.deepStrictEqual(recovered.split, [1, 0])
      assert.deepStrictEqual(recovered.observation, straight)
    }), 90_000)
})

// --- Type assertions -------------------------------------------------------
//
// Each was broken once to confirm it bites.

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

/** The projector's input is the tool's own decoded types -- nothing annotated at the call site. */
export const _inputIsTyped = AgentOutput.fromTool(CreateProject, (input) => {
  type _Params = Assert<Equal<typeof input.params, { readonly name: string }>>
  type _Result = Assert<
    Equal<typeof input.result, { readonly created: boolean; readonly id: string; readonly href: string }>
  >
  return Option.none()
})

/** The agent's value is still the output schema's type after `fromTool`. */
const typedAgent = Agent.make({ output })
export type _ValueSurvives = Assert<Equal<Agent.ValueOf<typeof typedAgent>, typeof Created.Type>>

/** A projector returning the wrong shape does not compile. */
export const _wrongShape = AgentOutput.make(Created).pipe(
  // @ts-expect-error -- `url` is missing, so this is not a `Created`
  AgentOutput.fromTool(CreateProject, ({ result }) => Option.some({ projectId: result.id }))
)
