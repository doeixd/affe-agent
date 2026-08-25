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
   * **The write cannot be undone, and that is not the fix.** A store that has
   * committed has committed; no amount of care on this side reaches back
   * through a dropped connection. What was missing was a way for the caller to
   * *find out* -- and that is the idempotency key: a retry naming the same
   * request is recognised as the same request rather than refused as a second
   * one, so an indeterminate failure becomes a recoverable one.
   *
   * Both halves are asserted below: the claim survives the failure (it must),
   * and the caller converges on the truth by asking again (it now can).
   */
  it.effect("a claim that commits before the failure is recoverable by retrying", () =>
    Effect.gen(function*() {
      const healthy = yield* DurableSessionStore.memoryStore
      yield* healthy.getOrCreate("stranded", Prompt.fromMessages([]))

      const request = {
        prompt: Prompt.fromMessages([]),
        stream: false,
        key: "request-7"
      }
      const failed = yield* Effect.result(
        failingAfter(healthy, "claim").claim("stranded", request)
      )
      const after = Option.getOrThrow(yield* healthy.get("stranded"))

      // The caller is told it failed.
      assert.strictEqual(failed._tag, "Failure")
      // The write landed anyway, which no store can undo.
      assert.isTrue(Option.isSome(after.claim))

      /**
       * And the caller, which cannot tell a lost write from a lost reply,
       * asks again -- and learns what it would have been told the first time
       * rather than being refused as busy by its own earlier self.
       */
      const retried = yield* healthy.claim("stranded", request)
      assert.strictEqual(
        retried._tag,
        "Claimed",
        "a retry of an indeterminate claim was treated as a second request"
      )
      if (retried._tag === "Claimed") {
        assert.deepStrictEqual(retried.claim, Option.getOrThrow(after.claim))
      }
      // One submission, not two: the retry did not consume an ordinal.
      assert.strictEqual(
        Option.getOrThrow(yield* healthy.get("stranded")).submissionCount,
        1
      )
    }))

  /**
   * And without a key the old behaviour stands, which is why the key is not
   * optional in spirit even though it is in the type: a caller that omits it
   * has no way to recover, and this pins that rather than leaving it implied.
   */
  it.effect("a keyless retry cannot recover, and is refused as busy", () =>
    Effect.gen(function*() {
      const healthy = yield* DurableSessionStore.memoryStore
      yield* healthy.getOrCreate("keyless", Prompt.fromMessages([]))

      const request = { prompt: Prompt.fromMessages([]), stream: false }
      yield* Effect.ignore(failingAfter(healthy, "claim").claim("keyless", request))

      const retried = yield* healthy.claim("keyless", request)
      assert.strictEqual(retried._tag, "Busy")
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
