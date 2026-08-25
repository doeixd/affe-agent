import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { StorageError } from "../src/Errors.js"
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
      // modify's f returns [returnValue, newState]: here [n*2, n], so it
      // returns 30 (from n=15) and leaves the state at 15.
      assert.strictEqual(observed.doubled, 30)
      assert.strictEqual(observed.end, 15)
    })
  )

  it.effect("changes is a live subscription: the current value, then each later update", () =>
    Effect.gen(function* () {
      const collected = yield* Effect.gen(function* () {
        // A handshake makes this deterministic: only set the second value once
        // the subscriber has actually received the first (the current one).
        const gotFirst = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(
            AgentState.changes(Counter).pipe(
              Stream.tap(() => Deferred.succeed(gotFirst, void 0)),
              Stream.take(2)
            )
          )
        )
        yield* Deferred.await(gotFirst)
        yield* AgentState.set(Counter, 2)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(AgentState.layer(Counter, { initial: 1 })))

      assert.deepStrictEqual([...collected], [1, 2])
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
  // Ephemeral state here, so the store failure cannot happen -- but the type
  // says it could, because the same agent must be runnable against a store.
  // `orDie` is the honest way for a caller with no store to say so.
  const bump = Agent.tool(Bump, () =>
    AgentState.update(Counter, (n) => n + 1).pipe(Effect.orDie, Effect.as("bumped"))
  )

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

/**
 * R65 -- a failed save must not leave the live value ahead of the stored one.
 *
 * Every persisted mutation used to swap the `SubscriptionRef` and *then* call
 * the store. On the exact failure path the typed storage errors were added to
 * expose, the operation reported `StorageError` while `get` returned the new
 * value and `changes` had already published it -- with the store still holding
 * the old one. A restart then silently rolled the value back, and any update
 * in between built on something that had never become durable.
 *
 * The permit that the comment credited with keeping them in step orders
 * *writers*; it does not make one writer's two steps into one step.
 */
describe("AgentState under a failing store", () => {
  const refusing = (allow: (key: string, value: string) => boolean): AgentState.Store => ({
    load: () => Effect.succeed(Option.none()),
    save: (key, value) =>
      allow(key, value)
        ? Effect.void
        : Effect.fail(new StorageError({ operation: "save", detail: "the disk is full" }))
  })

  it.effect("a refused save leaves get, changes and the store agreeing", () =>
    Effect.gen(function* () {
      const persistence = {
        schema: Schema.Number,
        store: refusing(() => false),
        key: "counter:refused"
      } as const

      yield* Effect.gen(function* () {
        const published: Array<number> = []
        yield* Effect.forkScoped(
          Stream.runForEach(AgentState.changes(Counter), (value) =>
            Effect.sync(() => {
              published.push(value)
            }))
        )
        yield* Effect.yieldNow

        const failed = yield* Effect.flip(AgentState.set(Counter, 7))
        assert.strictEqual(failed._tag, "StorageError")

        // The value never moved, so nothing downstream was told it had.
        assert.strictEqual(yield* AgentState.get(Counter), 1)
        assert.isFalse(
          published.includes(7),
          "a value the store refused was published to observers"
        )

        // And the same for the read-modify-write forms.
        assert.strictEqual((yield* Effect.flip(AgentState.update(Counter, (n) => n + 1)))._tag, "StorageError")
        assert.strictEqual(yield* AgentState.get(Counter), 1)
        assert.strictEqual(
          (yield* Effect.flip(AgentState.modify(Counter, (n) => ["x", n + 1] as const)))._tag,
          "StorageError"
        )
        assert.strictEqual(yield* AgentState.get(Counter), 1)
      }).pipe(
        Effect.provide(AgentState.layer(Counter, { initial: 1, persistence })),
        Effect.scoped
      )
    })
  )

  it.effect("a save that succeeds still publishes and still stores", () =>
    Effect.gen(function* () {
      // The risk of writing first: refusing, or failing to publish, a change
      // that did land.
      const store = yield* AgentState.memoryStore
      const persistence = { schema: Schema.Number, store, key: "counter:ok" } as const

      const published = yield* Effect.gen(function* () {
        const seen: Array<number> = []
        yield* Effect.forkScoped(
          Stream.runForEach(AgentState.changes(Counter), (value) =>
            Effect.sync(() => {
              seen.push(value)
            }))
        )
        yield* Effect.yieldNow
        yield* AgentState.set(Counter, 7)
        yield* AgentState.update(Counter, (n) => n + 1)
        yield* Effect.yieldNow
        assert.strictEqual(yield* AgentState.get(Counter), 8)
        return seen
      }).pipe(
        Effect.provide(AgentState.layer(Counter, { initial: 1, persistence })),
        Effect.scoped
      )

      assert.include(published, 7)
      assert.include(published, 8)

      // And a fresh layer over the same store reads what was written.
      const reloaded = yield* AgentState.get(Counter).pipe(
        Effect.provide(AgentState.layer(Counter, { initial: 0, persistence }))
      )
      assert.strictEqual(reloaded, 8)
    })
  )
})

/**
 * R76 -- a tag's id is its identity, and two tags cannot share one.
 *
 * A `Context` key is a string, so `Tag<number>("same")` and `Tag<string>("same")`
 * were two values naming one service. Merging their layers typechecked, and
 * reading the number tag could hand back the string service -- with no cast
 * anywhere, which is what made it a library defect rather than caller error.
 * Nothing in the types can prove the two `A`s agree, because the only thing
 * carried across is the text.
 *
 * Refused at construction instead: the mistake is reported where it is made,
 * rather than becoming a value that works until two layers meet.
 */
describe("AgentState tag identity", () => {
  it("refuses a second tag under an id already claimed", () => {
    const id = `test/AgentState/unique-${Math.random()}`
    const first = AgentState.Tag<number>(id)
    assert.isDefined(first)

    assert.throws(
      () => AgentState.Tag<string>(id),
      /already exists/
    )
  })

  it("a different id is an ordinary tag", () => {
    const one = AgentState.Tag<number>(`test/AgentState/one-${Math.random()}`)
    const two = AgentState.Tag<number>(`test/AgentState/two-${Math.random()}`)
    assert.notStrictEqual(one, two)
  })
})
