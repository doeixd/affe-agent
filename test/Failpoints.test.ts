import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import { DeliveryLogConformance, Failpoints } from "../src/testing/index.js"

/**
 * Failpoints (`docs/plan-failure-paths.md` 48b), and the first thing they are
 * pointed at.
 *
 * The seam is a no-op `Context.Reference` called at named durable boundaries.
 * A test provides an implementation that stops the pass at one of them, which
 * is the question `test/DurableStorageFaults.test.ts` cannot ask: that one
 * makes a store *fail*, exercising error handling, where this stops the process
 * *between* two durable writes and asks whether the next pass puts it right.
 *
 * `DeliveryLog.append` is the first call site because our whole durability bet
 * rests on it. We rebuild canonical history by replaying activity results, so
 * an event can be offered twice from different processes and must land once --
 * and the window between committing a row and publishing it to live
 * subscribers is the one both implementations are made uninterruptible to
 * protect. Until now nothing could reach that window on purpose.
 */

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "affe-agent-fp-")), "log.db")
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

/** An envelope as a recorder would offer it; the conformance suite's own shape. */
const event = (sequence: number) => DeliveryLogConformance.envelope(sequence, { _tag: "RunStarted" })

/**
 * Named through the group rather than written out.
 *
 * A test that arms `"DeliveryLog:after-comit"` reads exactly like one that
 * passes, and reports nothing when the boundary it meant is never reached --
 * which is the failure mode the closed location set exists to prevent, walked
 * straight back in through a string literal.
 */
const afterCommit = DeliveryLog.failpoints.qualified("after-commit")
const beforeCommit = DeliveryLog.failpoints.qualified("before-commit")

describe("failpoints", () => {
  it.effect("the seam is a no-op unless a test provides one", () =>
    Effect.gen(function* () {
      // The production path: nothing provided, so `hit` returns immediately and
      // no signature anywhere mentions a failpoint.
      const log = yield* DeliveryLog.memoryLog
      const appended = yield* log.append("s1", "k1", event(1))
      assert.strictEqual(appended._tag, "Appended")
    })
  )

  it.effect("a crash records the boundaries it reached, in order", () =>
    Effect.gen(function* () {
      const crash = yield* Failpoints.at(afterCommit)
      const log = yield* DeliveryLog.memoryLog

      const exit = yield* log.append("s1", "k1", event(1)).pipe(
        Effect.provide(crash.layer),
        Effect.exit
      )

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.isTrue(
          Cause.hasDies(exit.cause),
          "a failpoint must stop the pass as a defect, not as a typed failure the code might already handle"
        )
      }
      // Both boundaries were reached, in the order the code claims: the commit
      // happens before the publication.
      assert.deepStrictEqual(yield* crash.hits, [beforeCommit, afterCommit])
      assert.strictEqual(yield* crash.reached, 1)
    })
  )

  it.effect("a crash between commit and publish leaves the row, and the retry is a duplicate", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      yield* Effect.gen(function* () {
        const log = yield* DeliveryLog.sqlLogWithTable()
        const crash = yield* Failpoints.at(afterCommit)

        // The process stops with the row committed and nothing published.
        const exit = yield* log.append("s1", "k1", event(1)).pipe(
          Effect.provide(crash.layer),
          Effect.exit
        )
        assert.isTrue(Exit.isFailure(exit))

        // A later pass, with no failpoint: the event is there exactly once,
        // holding the sequence the crashed pass assigned it.
        const afterCrash = yield* log.read("s1")
        assert.strictEqual(afterCrash.length, 1, "the committed row did not survive the crash")
        assert.strictEqual(afterCrash[0]!.sequence, 1)

        // Re-offering it is recognised as the replay it is. This is the
        // property our durability bet rests on: emission is replayed, so the
        // same event arrives twice and must land once.
        const again = yield* log.append("s1", "k1", event(1))
        assert.strictEqual(again._tag, "Duplicate")

        // And the sequence has no gap: the next event is 2, not 3. A crash
        // must not burn an offset, because `read({ after })` is how a
        // reconnecting client catches up and a hole in it is not removable.
        const next = yield* log.append("s1", "k2", event(2))
        assert.strictEqual(next._tag, "Appended")
        if (next._tag === "Appended") assert.strictEqual(next.sequence, 2)

        const all = yield* log.read("s1")
        assert.deepStrictEqual(all.map((envelope) => envelope.sequence), [1, 2])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: file })))
    }).pipe(Effect.scoped)
  )

  it.effect("the crash can be aimed at a later occurrence, so the first pass gets through", () =>
    Effect.gen(function* () {
      const crash = yield* Failpoints.at(afterCommit, { occurrence: 2 })
      const log = yield* DeliveryLog.memoryLog

      const first = yield* log.append("s1", "k1", event(1)).pipe(Effect.provide(crash.layer))
      assert.strictEqual(first._tag, "Appended")

      const second = yield* log.append("s1", "k2", event(2)).pipe(
        Effect.provide(crash.layer),
        Effect.exit
      )
      assert.isTrue(Exit.isFailure(second))
      assert.strictEqual(yield* crash.reached, 2)
    })
  )

  it.effect("an unarmed location never stops anything, but is still recorded", () =>
    Effect.gen(function* () {
      const crash = yield* Failpoints.at("DeliveryLog:no-such-boundary")
      const log = yield* DeliveryLog.memoryLog

      const appended = yield* log.append("s1", "k1", event(1)).pipe(Effect.provide(crash.layer))

      assert.strictEqual(appended._tag, "Appended")
      assert.deepStrictEqual(yield* crash.hits, [beforeCommit, afterCommit])
      assert.strictEqual(yield* crash.reached, 0)
    })
  )
})
