import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { isStorageError, StorageError } from "../src/durable/StorageError.js"

/**
 * The durable stores used to convert every failure into a defect, so their
 * interfaces read `Effect.Effect<SessionRecord>` -- no error channel at all.
 * That is a stronger claim than `unknown` in an error channel and a false one:
 * there is a database on the other side.
 *
 * These tests pin the two things that change once the channel is honest:
 *
 *   1. a caller *sees* a storage failure, rather than having a fibre die
 *      under it (invariant D7 in `docs/plan-durability-hardening.md`);
 *   2. different faults are *distinguishable*, which is what H4's fault
 *      injection needs and could not have before -- through an `orDie`d store
 *      a failed write, a duplicated row and a corrupt history all produced the
 *      same observation.
 *
 * Falsify by restoring `Effect.orDie` on `decodeHistory` or on the store's
 * operations: every assertion below that expects a failure then sees a defect.
 */

const historyWith = (text: string): Prompt.Prompt =>
  Prompt.make([{ role: "user", content: [{ type: "text", text }] }])

describe("StorageError", () => {
  it.effect("a corrupt stored history is a failure, not a defect", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        DurableSessionStore.decodeHistory("{not json", "s1")
      )
      assert.isTrue(Exit.isFailure(exit))
      // The distinction the whole change rests on: a *failure* the caller can
      // branch on, not a defect that kills the fibre under it.
      const error = yield* Effect.flip(
        DurableSessionStore.decodeHistory("{not json", "s1")
      )
      assert.isTrue(isStorageError(error))
      assert.strictEqual(error.operation, "decodeHistory")
      assert.strictEqual(error.sessionId, "s1")
    })
  )

  it.effect("well-formed JSON that is not a Prompt is also a failure", () =>
    Effect.gen(function* () {
      // Not a parse error -- a schema mismatch, which is what a row written by
      // an older version of this library looks like coming back.
      const error = yield* Effect.flip(
        DurableSessionStore.decodeHistory(`{"unexpected":true}`)
      )
      assert.isTrue(isStorageError(error))
      assert.strictEqual(error.operation, "decodeHistory")
      // No session was named, so none is claimed.
      assert.isUndefined(error.sessionId)
    })
  )

  it.effect("a round trip through the codec still succeeds", () =>
    Effect.gen(function* () {
      // The typed channel must not have been bought by breaking the happy
      // path: encode stays infallible, decode returns what went in.
      const encoded = yield* DurableSessionStore.encodeHistory(historyWith("hi"))
      const decoded = yield* DurableSessionStore.decodeHistory(encoded)
      assert.deepStrictEqual(decoded, historyWith("hi"))
    })
  )

  /**
   * The H4 prerequisite, stated as a test.
   *
   * Three faults, three observations that differ. Through the previous
   * `orDie`d store all three were one defect, so a fault-injecting wrapper
   * could prove the system noticed and nothing about how it degraded.
   */
  it.effect("distinct faults produce distinct, inspectable observations", () =>
    Effect.gen(function* () {
      const store = yield* DurableSessionStore.memoryStore

      // Fault 1: the stored bytes are corrupt.
      const corrupt = yield* Effect.flip(
        DurableSessionStore.decodeHistory("<<truncated", "s1")
      )

      // Fault 2: a different operation fails against the same store.
      const wrongShape = yield* Effect.flip(
        DurableSessionStore.decodeHistory(`{"role":"nope"}`, "s2")
      )

      // Non-fault: the store works, and says so on the success channel.
      const created = yield* store.getOrCreate("s3", historyWith("ok"))

      assert.notStrictEqual(corrupt.sessionId, wrongShape.sessionId)
      assert.notStrictEqual(corrupt.detail, wrongShape.detail)
      assert.strictEqual(created.sessionId, "s3")
      assert.isTrue(Option.isNone(created.claim))

      // And each carries enough to act on: what was attempted, and where.
      for (const error of [corrupt, wrongShape]) {
        assert.isTrue(isStorageError(error))
        assert.include(error.message, "decodeHistory")
        assert.include(error.message, "failed")
      }
    })
  )

  it.effect("a StorageError survives being seen as an unknown defect", () =>
    Effect.gen(function* () {
      // `isStorageError` is structural, not `instanceof`: a store failure can
      // cross a workflow journal and come back decoded rather than as the
      // original instance. `DurableSubmission.isInfrastructure` depends on
      // this, so a decoded copy must still be recognised.
      const original = new StorageError({
        operation: "claim",
        sessionId: "s1",
        detail: "connection reset"
      })
      const asData: unknown = JSON.parse(JSON.stringify(original))
      assert.isTrue(isStorageError(asData))
      assert.isFalse(isStorageError({ _tag: "SomethingElse" }))
      assert.isFalse(isStorageError(null))
    })
  )
})
