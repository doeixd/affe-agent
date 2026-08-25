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
/**
 * Fail *after* the real operation has run, not instead of it.
 *
 * The previous decorator replaced the operation with a bare `Effect.fail`, so
 * the mutation under test never executed -- and "no claim was left behind" was
 * therefore true of a store nothing had touched. That is a tautology wearing
 * the clothes of a durability test, and it is what made the D7 row in the
 * durability matrix unearned.
 *
 * Running the operation and then failing is the shape that means something: it
 * is the caller seeing a failure while the write has already landed, which is
 * exactly the partial-failure case D7 is about. If the store is transactional
 * the state is unchanged and the assertions hold; if it is not, they fail, and
 * that is the finding.
 */
const failingAfter = (
  inner: DurableSessionStore.DurableSessionStore,
  broken: keyof DurableSessionStore.DurableSessionStore
): DurableSessionStore.DurableSessionStore => ({
  ...inner,
  [broken]: (...args: ReadonlyArray<unknown>) => {
    const operation = inner[broken] as (
      ...rest: ReadonlyArray<unknown>
    ) => Effect.Effect<unknown, unknown>
    return Effect.andThen(
      // Ignored, because what happens to *this* call's result is not the
      // question: the caller is about to be told it failed either way.
      Effect.ignore(operation(...args)),
      Effect.fail(failure(String(broken)))
    )
  }
}) as DurableSessionStore.DurableSessionStore

/** The old shape, kept for the cases that are genuinely about a refused call. */
const failingBefore = (
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
  it.effect("a claim refused before it runs leaves nothing behind", () =>
    Effect.gen(function*() {
      const healthy = yield* DurableSessionStore.memoryStore
      yield* healthy.getOrCreate("orphan", Prompt.fromMessages([]))

      // The store's own transition is one step, so a failure *reaching* it
      // cannot leave a half-claim that a later reader treats as accepted work.
      const before = Option.getOrThrow(yield* healthy.get("orphan"))
      const failed = yield* Effect.result(
        failingBefore(healthy, "claim").claim("orphan", {
          prompt: Prompt.fromMessages([]),
          stream: false
        })
      )
      const after = Option.getOrThrow(yield* healthy.get("orphan"))

      assert.strictEqual(failed._tag, "Failure")
      assert.isTrue(Option.isNone(after.claim))
      assert.strictEqual(after.submissionCount, before.submissionCount)
    }))

  /**
   * R92, R93 -- what happens when the write lands and the caller is still told
   * it failed.
   *
   * This is the case D7 is actually about, and the case the original suite did
   * not test: its decorator replaced the operation with a bare `Effect.fail`,
   * so the mutation never ran and "nothing was left behind" was true of a
   * store nothing had touched.
   *
   * Run for real and then failed, the answer is different, and it is recorded
   * here rather than asserted away: **the claim is left behind.** A store that
   * commits and then loses the acknowledgement -- a connection dropped after
   * `COMMIT`, a process killed between the write and the reply -- leaves the
   * session claimed, and the caller believes it is not. Nothing reconciles
   * that today, so a later prompt sees `Busy` for a submission that will never
   * run.
   *
   * The assertion is the honest one: the failure is reported (the half of D7
   * that holds), and the claim survives (the half that does not). Reversing
   * this test is what closing D7 looks like; until then the durability matrix
   * says so.
   */
  it.effect("a claim that commits before the failure is left behind", () =>
    Effect.gen(function*() {
      const healthy = yield* DurableSessionStore.memoryStore
      yield* healthy.getOrCreate("stranded", Prompt.fromMessages([]))

      const failed = yield* Effect.result(
        failingAfter(healthy, "claim").claim("stranded", {
          prompt: Prompt.fromMessages([]),
          stream: false
        })
      )
      const after = Option.getOrThrow(yield* healthy.get("stranded"))

      // The caller is told, which is the half that holds.
      assert.strictEqual(failed._tag, "Failure")
      // And the claim is there anyway, which is the half that does not.
      assert.isTrue(
        Option.isSome(after.claim),
        "if this now passes as `isNone`, D7 has been closed and this test should"
          + " become the assertion it was originally written as"
      )
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
      // A refused call, deliberately: this is about the *shape* of the error
      // channel rather than about a partial write.
      const broken = failingBefore(healthy, "get")

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
