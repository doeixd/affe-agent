import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Admission is one store operation, not two.
 *
 * The durable counterpart of core's `Session.inputGate`. A sender that checked
 * the marker and then wrote separately could have its write land after the
 * submission's closing drain had already looked — accepted by the caller,
 * never drained. `offerIfOpen` makes check-and-insert inseparable, so an
 * offered input is either in the queue before that drain or refused outright.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-admission-")),
      "store.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

const withSqlStore = <A, E>(
  use: (store: DurableChannels.Store) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const file = yield* tempDatabase
    return yield* DurableChannels.sqlStoreWithTable().pipe(
      Effect.flatMap(use),
      Effect.provide(SqliteClient.layer({ filename: file }))
    )
  }).pipe(Effect.scoped)

const offerIfOpenContract = (store: DurableChannels.Store) =>
  Effect.gen(function* () {
    const gate = DurableChannels.openKey("s")

    // Gate closed: refused, and nothing written under the channel key.
    assert.strictEqual(yield* store.offerIfOpen("s:followUps", "late", gate), false)
    assert.strictEqual(yield* store.size("s:followUps"), 0)

    // Gate open: admitted and retrievable.
    yield* store.offer(gate, "open")
    assert.strictEqual(yield* store.offerIfOpen("s:followUps", "one", gate), true)
    assert.strictEqual(yield* store.offerIfOpen("s:followUps", "two", gate), true)
    assert.deepStrictEqual(yield* store.takeAll("s:followUps"), ["one", "two"])

    // Draining the gate closes it: admission follows, not precedes, the close.
    yield* store.takeAll(gate)
    assert.strictEqual(yield* store.offerIfOpen("s:steering", "v", gate), false)
    assert.strictEqual(yield* store.size("s:steering"), 0)
  })

describe("offerIfOpen", () => {
  it.effect("memoryStore admits or refuses in one step", () =>
    Effect.map(DurableChannels.memoryStore, offerIfOpenContract)
  )

  it.effect("sqlStore admits or refuses in one step", () =>
    withSqlStore(offerIfOpenContract)
  )

  it.effect("sqlStore keeps a refused value out of every concurrent drain", () =>
    withSqlStore((store) =>
      Effect.gen(function* () {
        // The gate is closed for all of these; whatever interleaving the
        // transaction picks, a refusal must leave no row behind for a later
        // drain to hand out.
        yield* Effect.forEach(
          Array.from({ length: 20 }, (_, i) => i),
          (i) => store.offerIfOpen(`s:${i}`, "v", DurableChannels.openKey("s")),
          { concurrency: "unbounded", discard: true }
        )
        for (const size of [
          yield* store.size("s:x"),
          yield* store.size("s:y")
        ]) {
          assert.strictEqual(size, 0)
        }
      })
    )
  )
})

describe("durable admission after quiescence", () => {
  it.live("a follow-up or steer after the submission ends is refused, not stored", () =>
    Effect.gen(function* () {
      // The caller must be told the session is idle, and nothing may be
      // written to a queue nobody will drain. Accepted-and-dropped is the one
      // outcome this module exists to prevent.
      const store = yield* DurableChannels.memoryStore
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const durable = DurableAgent.workflow("Admission", Agent.make({}), { store })

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "adm-1", "go")
        yield* DurableAgent.result(durable, executionId)

        const idleFollowUp = yield* Effect.flip(
          DurableAgent.followUp(store, "adm-1", "late")
        )
        assert.strictEqual(idleFollowUp._tag, "AgentIdleError")
        const idleSteer = yield* Effect.flip(
          DurableAgent.steer(store, "adm-1", "focus")
        )
        assert.strictEqual(idleSteer._tag, "AgentIdleError")

        assert.strictEqual(yield* store.size(`adm-1:followUps`), 0)
        assert.strictEqual(yield* store.size(`adm-1:steering`), 0)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )
    })
  )

  it.live("a follow-up during a suspended submission is still accepted", () =>
    Effect.gen(function* () {
      // Atomicity must not have closed the open case: while the run is parked,
      // the marker is present and input is admitted.
      const store = yield* DurableChannels.memoryStore
      const { layer: modelLayer } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])
      const durable = DurableAgent.workflow("AdmissionOpen", Agent.make({}), {
        store
      })

      yield* Effect.gen(function* () {
        // Opened by submit, before the workflow has begun draining anything.
        yield* DurableAgent.submit(durable, store, "adm-2", "go")
        const admitted = yield* DurableChannels.offerIfAdmitting(
          store,
          "adm-2",
          "followUps",
          "in flight"
        )
        assert.strictEqual(admitted, true)
        assert.strictEqual(yield* store.size("adm-2:followUps"), 1)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )
    })
  )
})
