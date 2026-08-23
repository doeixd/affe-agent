import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentState } from "../src/state/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Persistent typed agent state (issue #4). The service is exercised directly
 * (get/set/update/modify, the changes stream, persistence round-trips against
 * both stores) and inside a real session (a tool mutates it, a transform
 * surfaces it into the model's prompt each turn), deterministically.
 */

const Counter = AgentState.Tag<number>("test/Counter")

describe("AgentState service", () => {
  it.effect("get, set, update and modify move the value atomically", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.gen(function* () {
        const start = yield* AgentState.get(Counter)
        yield* AgentState.set(Counter, 10)
        yield* AgentState.update(Counter, (n) => n + 5)
        const doubled = yield* AgentState.modify(Counter, (n) => [n * 2, n])
        const end = yield* AgentState.get(Counter)
        return { start, doubled, end }
      }).pipe(Effect.provide(AgentState.layer(Counter, { initial: 1 })))

      assert.strictEqual(observed.start, 1)
      assert.strictEqual(observed.doubled, 30) // read of 15, before modify wrote it back unchanged
      assert.strictEqual(observed.end, 15)
    })
  )

  it.effect("changes reflects the live value", () =>
    Effect.gen(function* () {
      const head = yield* Effect.gen(function* () {
        yield* AgentState.set(Counter, 5)
        // `changes` publishes the current value first, so its head is live state.
        return yield* Stream.runHead(AgentState.changes(Counter))
      }).pipe(Effect.provide(AgentState.layer(Counter, { initial: 1 })))

      assert.deepStrictEqual(head, Option.some(5))
    })
  )
})

describe("AgentState persistence", () => {
  it.effect("a value written under a key is read back by a later layer over the same store", () =>
    Effect.gen(function* () {
      const store = yield* AgentState.memoryStore
      const persistence = { schema: Schema.Number, store, key: "counter:alice" } as const

      // First session writes.
      yield* AgentState.set(Counter, 7).pipe(
        Effect.provide(AgentState.layer(Counter, { initial: 0, persistence }))
      )
      // A brand-new layer over the same store loads what was left, not `initial`.
      const reloaded = yield* AgentState.get(Counter).pipe(
        Effect.provide(AgentState.layer(Counter, { initial: 999, persistence }))
      )
      assert.strictEqual(reloaded, 7)

      // A different key falls back to `initial`.
      const fresh = yield* AgentState.get(Counter).pipe(
        Effect.provide(AgentState.layer(Counter, { initial: 999, persistence: { ...persistence, key: "counter:bob" } }))
      )
      assert.strictEqual(fresh, 999)
    })
  )

  it.effect("sqlStore round-trips the value across processes", () =>
    Effect.gen(function* () {
      const file = NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-state-")), "state.db")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
      )
      const sqlite = SqliteClient.layer({ filename: file })

      const roundTrip = Effect.gen(function* () {
        const store = yield* AgentState.sqlStoreWithTable()
        const persistence = { schema: Schema.Number, store, key: "counter:carol" } as const
        yield* AgentState.set(Counter, 42).pipe(
          Effect.provide(AgentState.layer(Counter, { initial: 0, persistence }))
        )
        return yield* AgentState.get(Counter).pipe(
          Effect.provide(AgentState.layer(Counter, { initial: -1, persistence }))
        )
      }).pipe(Effect.provide(sqlite))

      assert.strictEqual(yield* roundTrip, 42)
    }).pipe(Effect.scoped)
  )
})

describe("AgentState in a session", () => {
  // The state tag is a dependency, exactly like a sandbox: a tool that touches
  // state declares it, and it flows into the agent's requirements.
  const Bump = Tool.make("bump", {
    parameters: Schema.Struct({}),
    success: Schema.String,
    dependencies: [Counter]
  })
  const bump = Agent.tool(Bump, () => AgentState.update(Counter, (n) => n + 1).pipe(Effect.as("bumped")))

  it.effect("a tool mutates the state and the transform shows the model its current value each turn", () =>
    Effect.gen(function* () {
      const { layer, recorder } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "b1", name: "bump", params: {} }] },
        { toolCalls: [{ id: "b2", name: "bump", params: {} }] },
        TestLanguageModel.text("done")
      ])
      const agent = Agent.make({
        instructions: "You count.",
        tools: [bump],
        loop: AgentLoop.bounded(6),
        contextTransform: AgentState.transform(Counter, (n) => `The counter is at ${n}.`)
      })

      const { finalCount, prompts } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("go")
        return { finalCount: yield* AgentState.get(Counter), prompts: yield* recorder.prompts }
      }).pipe(
        Effect.provide(Layer.merge(AgentState.layer(Counter, { initial: 0 }), layer)),
        Effect.scoped
      )

      // Two bumps ran.
      assert.strictEqual(finalCount, 2)
      // Each turn's prompt carried the counter's value *as of that turn*: the
      // transform is recomputed from live state every call.
      assert.include(JSON.stringify(prompts[0]), "The counter is at 0.")
      assert.include(JSON.stringify(prompts[1]), "The counter is at 1.")
      assert.include(JSON.stringify(prompts[2]), "The counter is at 2.")
    })
  )

  it.effect("state a session leaves behind is there for the next session under the same key", () =>
    Effect.gen(function* () {
      const store = yield* AgentState.memoryStore
      const persistence = { schema: Schema.Number, store, key: "session-counter" } as const
      const agent = Agent.make({ instructions: "count", tools: [bump], loop: AgentLoop.bounded(4) })

      const runOnce = (script: TestLanguageModel.Turn) =>
        Effect.gen(function* () {
          const { layer } = yield* TestLanguageModel.script([script, TestLanguageModel.text("ok")])
          return yield* Effect.gen(function* () {
            const session = yield* AgentSession.make(agent)
            yield* session.prompt("go")
            return yield* AgentState.get(Counter)
          }).pipe(
            Effect.provide(Layer.merge(AgentState.layer(Counter, { initial: 0, persistence }), layer)),
            Effect.scoped
          )
        })

      const afterFirst = yield* runOnce({ toolCalls: [{ id: "b", name: "bump", params: {} }] })
      const afterSecond = yield* runOnce({ toolCalls: [{ id: "b", name: "bump", params: {} }] })
      // The second session started from the first's persisted 1, and bumped to 2.
      assert.strictEqual(afterFirst, 1)
      assert.strictEqual(afterSecond, 2)
    })
  )
})
