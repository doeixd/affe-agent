import { assert, describe, it } from "@effect/vitest"
import { expectTypeOf } from "vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { Workflow } from "effect/unstable/workflow"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as Journal from "../src/Journal.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableJournal from "../src/durable/DurableJournal.js"
import type * as DurableToolkit from "../src/durable/DurableToolkit.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { DurableEquivalence } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 129, slice 1: `Journal.step`. Locally the identity; under `/durable`
 * an activity, so a replay reads what the first run recorded instead of
 * doing it again.
 */

describe("Journal.step's types", () => {
  it("the value is the schema's type, and the requirement is the effect's", () => {
    class Clock2 extends Context.Service<Clock2, { readonly now: number }>()("test/Journal/Clock2") {}
    const read = Journal.step("now", Schema.Number, Effect.map(Effect.service(Clock2), (c) => c.now))
    expectTypeOf(read).toEqualTypeOf<Effect.Effect<number, never, Clock2>>()
    const dated = Journal.step("when", Schema.Date, Effect.succeed(new Date(0)))
    expectTypeOf(dated).toEqualTypeOf<Effect.Effect<Date, never, never>>()
  })

  it("a step that could fail is refused: model the failure as a value", () => {
    // @ts-expect-error a step's effect cannot fail
    Journal.step("risky", Schema.String, Effect.fail("no"))
    const handled = Journal.step("risky", Schema.Option(Schema.String), Effect.option(Effect.fail("no")))
    expectTypeOf(handled).toEqualTypeOf<Effect.Effect<Option.Option<string>, never, never>>()
  })
})

describe("Journal, locally", () => {
  it.effect("the default runs every step, and records nothing", () =>
    Effect.gen(function*() {
      const runs = yield* Ref.make(0)
      const counted = Ref.updateAndGet(runs, (n) => n + 1)
      assert.strictEqual(yield* Journal.step("n", Schema.Number, counted), 1)
      assert.strictEqual(yield* Journal.step("n", Schema.Number, counted), 2)
    }))
})

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/** A workflow whose body is `body`, run once. Activities need a real workflow. */
const inWorkflow = <A>(name: string, success: Schema.Codec<A, any>, body: Effect.Effect<A, never, DurableToolkit.WorkflowContext>) => {
  const definition = Workflow.make(name, { payload: Schema.Struct({}), success, idempotencyKey: () => name })
  return definition.execute({}).pipe(
    Effect.exit,
    Effect.provide(Layer.provideMerge(definition.toLayer(() => body), Engine))
  )
}

describe("DurableJournal", () => {
  it.live("occurrences of one name are distinct steps, and values round-trip through the schema", () =>
    Effect.gen(function*() {
      const exit = yield* inWorkflow(
        "JournalOccurrences",
        Schema.Array(Schema.String),
        Effect.gen(function*() {
          const journal = yield* DurableJournal.make("")
          const first = yield* journal.step("ask", Schema.String, Effect.succeed("one"))
          const second = yield* journal.step("ask", Schema.String, Effect.succeed("two"))
          const date = yield* journal.step("when", Schema.Date, Effect.succeed(new Date(0)))
          return [first, second, date.toISOString()]
        })
      )
      assert.isTrue(Exit.isSuccess(exit))
      if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value, ["one", "two", "1970-01-01T00:00:00.000Z"])
    }), 20_000)

  it.live("a step that dies is recorded as a defect, and raised as one", () =>
    Effect.gen(function*() {
      const exit = yield* inWorkflow(
        "JournalDefect",
        Schema.String,
        Effect.gen(function*() {
          const journal = yield* DurableJournal.make("")
          const died = yield* Effect.exit(journal.step("boom", Schema.String, Effect.die(new Error("gone"))))
          return Exit.isFailure(died) && Cause.pretty(died.cause).includes("JournalStepDefect") &&
              Cause.pretty(died.cause).includes("gone")
            ? "defect"
            : "not a defect"
        })
      )
      assert.isTrue(Exit.isSuccess(exit) && exit.value === "defect")
    }), 20_000)
})

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "journal-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

const Lookup = Tool.make("lookup", { parameters: Schema.Struct({ of: Schema.String }), success: Schema.String })

describe("a step in a context transform, under a crash (item 129)", () => {
  /**
   * The transform does something it must not repeat, once per turn, through
   * `Journal.step`. A replacement replays the first turn, and with it the
   * transform: the step reads the recorded value, and the side effect is
   * not repeated. The oracle compares the effects with a run that never
   * crashed.
   */
  const scenario = DurableEquivalence.scenario({
    agent: (effects) =>
      Agent.make({
        tools: [Agent.tool(Lookup, ({ of }) => Effect.as(effects.record(of), `${of}: ok`))],
        contextTransform: ContextTransform.make((context) =>
          Journal.step(
            "recall",
            Schema.String,
            Effect.as(effects.record(`recall-${context.turnIndex}`), `note for turn ${context.turnIndex}`)
          ).pipe(Effect.map((note) => Prompt.concat(context.prompt, Prompt.make([{ role: "system", content: note }]))))
        ),
        loop: AgentLoop.bounded(4)
      }),
    turns: [
      { toolCalls: [{ id: "l1", name: "lookup", params: { of: "orders" } }] },
      { text: "done" }
    ],
    prompt: "look it up"
  })

  it.live("a replayed turn reads the step's recorded value instead of repeating it", () =>
    Effect.gen(function*() {
      const straight = yield* DurableEquivalence.straight(scenario, { database })
      assert.deepStrictEqual(straight.effects, ["orders", "recall-1", "recall-2"])
      const recovered = yield* DurableEquivalence.crashed(scenario, {
        database,
        at: turnFailpoints.qualified("after-commit")
      })
      assert.deepStrictEqual(recovered.observation, straight)
    }), 90_000)
})

describe("DurableAgent's body provides the journal too", () => {
  it.live("a transform in a DurableAgent workflow steps through an activity, not the identity", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<ReadonlyArray<boolean>>([])
      const agent = Agent.make({
        contextTransform: ContextTransform.make((context) =>
          Effect.flatMap(Journal.Journal, (journal) =>
            Ref.update(seen, (all) => [...all, journal !== Journal.direct])).pipe(Effect.as(context.prompt))
        ),
        loop: AgentLoop.bounded(1)
      })
      const { layer: model } = yield* FakeModel.layer([{ text: "hi" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("JournalInDurableAgent", agent, { store })
      yield* Effect.gen(function*() {
        const executionId = yield* DurableAgent.submit(durable, store, "journal-1", "hello")
        yield* DurableAgent.result(durable, executionId)
      }).pipe(Effect.provide(durable.layer.pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))))
      assert.deepStrictEqual(yield* Ref.get(seen), [true])
    }), 30_000)
})
