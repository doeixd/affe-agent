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

  it.effect("every boundary the log declares is reachable, and one retry puts each right", () =>
    Effect.gen(function* () {
      /**
       * Item 60b: a declared crash window with no test that crashes at it is
       * a finding, not a pass. The row iterates the subsystem's own closed
       * tuple (`DeliveryLog.failpoints.all`), so a boundary added to the
       * declaration is a boundary this drives -- `covered` dies by name if the
       * driver never reaches one. Until this row, `before-commit` was declared
       * and never stopped at; the rows above only ever armed `after-commit`.
       *
       * The property asserted after each crash is the one that holds for every
       * boundary of an append: whatever was or was not committed, one retry
       * leaves exactly one row, at sequence 1, and the next event is 2. A crash
       * before the commit leaves nothing and the retry appends; a crash after
       * it leaves the row and the retry is a duplicate -- the row does not care
       * which, and `exit` says which happened for a reader who does.
       */
      const rows = yield* Failpoints.covered(DeliveryLog.failpoints, (location) =>
        Effect.gen(function* () {
          const file = yield* tempDatabase
          return yield* Effect.gen(function* () {
            const log = yield* DeliveryLog.sqlLogWithTable()
            const crashed = yield* log.append("s1", "k1", event(1)).pipe(Effect.exit)
            assert.isTrue(Exit.isFailure(crashed), `the pass did not stop at ${location}`)

            // The next pass: no failpoint, one retry.
            const retry = yield* log.append("s1", "k1", event(1))
            const all = yield* log.read("s1")
            assert.strictEqual(all.length, 1, `after a crash at ${location} and one retry, not exactly one row`)
            assert.strictEqual(all[0]!.sequence, 1)
            const next = yield* log.append("s1", "k2", event(2))
            assert.strictEqual(next._tag, "Appended")
            if (next._tag === "Appended") assert.strictEqual(next.sequence, 2)
            return retry._tag
          }).pipe(Effect.provide(SqliteClient.layer({ filename: file })))
        }).pipe(Effect.scoped))

      assert.deepStrictEqual(rows.map((row) => row.location), [beforeCommit, afterCommit])
      // Reached at least once each -- `covered` would have died otherwise. Not
      // pinned to a count: the driver appends three times, so the count is the
      // driver's shape, not the property (the first draft pinned `[1, 1]` and
      // learned that the duplicate path never reaches `after-commit`).
      assert.isTrue(rows.every((row) => row.reached >= 1))
      // The driver's own assertions held, so each exit is the retry's answer,
      // which differs by boundary in exactly the way the boundaries differ.
      // A driver assertion that failed is inside the row's exit; say which
      // boundary and why, rather than comparing against an opaque marker.
      const answers = rows.map((row) =>
        Exit.isSuccess(row.exit) ? row.exit.value : `${row.location}: ${Cause.pretty(row.exit.cause)}`
      )
      assert.deepStrictEqual(answers, ["Appended", "Duplicate"])
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
