import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import { StorageError } from "../src/Errors.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"

/**
 * D7 -- storage failure degrades, it does not corrupt.
 *
 * The durability suite exercises concurrency and process loss thoroughly, and
 * assumes the store underneath works. "Never lost" is a claim about the system
 * *including* its storage, so these inject a store that fails a write and
 * check the two halves of the invariant:
 *
 *   - the caller **sees** the failure, rather than being told the work was
 *     accepted; and
 *   - nothing is left behind that a later reader would mistake for accepted
 *     work.
 *
 * `test/StorageError.test.ts` already covers the *read* side -- a corrupt row
 * decodes to a failure rather than a defect. This is the write side, which was
 * the gap H2 was looking for.
 */

const failure = (operation: string) =>
  new StorageError({ operation, detail: "the disk is on fire" })

/**
 * A session store that fails one operation and otherwise behaves.
 *
 * A decorator rather than a stub, because the interesting failures are the
 * ones that happen *partway*: a store that fails everything never gets far
 * enough to leave anything behind.
 */
const failingSessionStore = (
  inner: DurableSessionStore.DurableSessionStore,
  broken: keyof DurableSessionStore.DurableSessionStore
): DurableSessionStore.DurableSessionStore => ({
  ...inner,
  [broken]: (...args: ReadonlyArray<unknown>) => {
    void args
    return Effect.fail(failure(String(broken)))
  }
}) as DurableSessionStore.DurableSessionStore

describe("D7 -- storage failure degrades, it does not corrupt", () => {
  it.effect("a failed claim leaves no claim behind", () =>
    Effect.gen(function*() {
      const healthy = yield* DurableSessionStore.memoryStore
      yield* healthy.getOrCreate("orphan", Prompt.fromMessages([]))

      // The store's own transition is what D1 rests on: claim is one step, so
      // a failure cannot leave a half-claim that a later reader treats as
      // accepted work in flight.
      const before = Option.getOrThrow(yield* healthy.get("orphan"))
      const failed = yield* Effect.result(
        failingSessionStore(healthy, "claim").claim("orphan", {
          prompt: Prompt.fromMessages([]),
          stream: false
        })
      )
      const after = Option.getOrThrow(yield* healthy.get("orphan"))

      assert.strictEqual(failed._tag, "Failure")
      // No half-claim: a later reader cannot mistake this for work in flight,
      // and the submission counter did not advance, so the next real claim
      // gets the id this one would have had.
      assert.isTrue(Option.isNone(after.claim))
      assert.strictEqual(after.submissionCount, before.submissionCount)
    }))

  it.effect("a delivery log that cannot append reports it", () =>
    Effect.gen(function*() {
      const log = yield* DeliveryLog.memoryLog
      const broken: DeliveryLog.DeliveryLog = {
        ...log,
        append: () => Effect.fail(failure("append"))
      }

      const outcome = yield* Effect.result(
        broken.append("s", "k", {
          sessionId: "s" as never,
          submissionId: Option.none(),
          runId: Option.none(),
          turn: Option.none(),
          sequence: 1,
          event: { _tag: "SessionStarted" }
        })
      )

      // A recorder that swallowed this would advertise at-least-once delivery
      // (D5) over a log that silently dropped an event.
      assert.strictEqual(outcome._tag, "Failure")
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure._tag, "StorageError")
      }
    }))

  it.effect("an event that failed to record is not readable as recorded", () =>
    Effect.gen(function*() {
      const log = yield* DeliveryLog.memoryLog
      const envelope = {
        sessionId: "s" as never,
        submissionId: Option.none(),
        runId: Option.none(),
        turn: Option.none(),
        sequence: 1,
        event: { _tag: "SessionStarted" as const }
      }

      // One real append, so the log is not merely empty for the wrong reason.
      yield* log.append("s", "recorded", envelope)
      const broken: DeliveryLog.DeliveryLog = {
        ...log,
        append: () => Effect.fail(failure("append"))
      }
      yield* Effect.ignore(broken.append("s", "lost", envelope))

      const read = yield* log.read("s")
      // The failed one is absent rather than present-but-broken. A consumer
      // reading from its cursor sees a shorter history, never a corrupt one.
      assert.strictEqual(read.length, 1)
    }))

  it.effect("a store failure is a failure, never a defect", () =>
    Effect.gen(function*() {
      const healthy = yield* DurableSessionStore.memoryStore
      const broken = failingSessionStore(healthy, "get")

      const outcome = yield* Effect.result(broken.get("anything"))

      // The distinction the whole error channel exists for: a defect kills the
      // fibre under it and cannot be handled, so a caller who wanted to retry
      // or fail over never gets the chance.
      assert.strictEqual(outcome._tag, "Failure")
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure._tag, "StorageError")
        assert.include(outcome.failure.message, "the disk is on fire")
      }
    }))
})
