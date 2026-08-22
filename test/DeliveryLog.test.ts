import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import type { AgentEventEnvelope } from "../src/AgentEvent.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as Ids from "../src/internal/ids.js"

/**
 * The delivery log is what a client observes, and the two things it must get
 * right are the two numbers it keeps apart: the key (identity, for replay)
 * and the sequence (the session-wide offset, for reconnection). Both
 * implementations run the same contract.
 */

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-delivery-")),
      "log.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

const sqlLog = Effect.gen(function* () {
  const file = yield* tempDatabase
  const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
  return yield* DeliveryLog.sqlLogWithTable().pipe(Effect.provide(sql))
})

/** An envelope as the recorder would offer it: its own per-process sequence. */
const envelope = (
  sequence: number,
  event: AgentEventEnvelope["event"]
): AgentEventEnvelope => ({
  sessionId: Ids.sessionId("s"),
  submissionId: Option.some(Ids.submissionId("s:submission-1")),
  runId: Option.some(Ids.runId("run-1")),
  turn: Option.some(1),
  sequence,
  event
})

const contract = (
  name: string,
  makeLog: Effect.Effect<DeliveryLog.DeliveryLog, never, Scope.Scope>
) =>
  describe(`DeliveryLog (${name})`, () => {
    it.live("assigns a session-wide offset and reads back from one", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog

          const first = yield* log.append("s", "k1", envelope(1, { _tag: "SubmissionStarted" }))
          const second = yield* log.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
          // Another submission's recorder starts its own count at 1 again; the
          // log's offset does not.
          const third = yield* log.append("s", "k3", envelope(1, { _tag: "TurnStarted" }))
          assert.deepStrictEqual(first, { _tag: "Appended", sequence: 1 })
          assert.deepStrictEqual(second, { _tag: "Appended", sequence: 2 })
          assert.deepStrictEqual(third, { _tag: "Appended", sequence: 3 })

          const all = yield* log.read("s")
          assert.deepStrictEqual(all.map((e) => e.sequence), [1, 2, 3])
          assert.deepStrictEqual(
            (yield* log.read("s", { after: 2 })).map((e) => e.event._tag),
            ["TurnStarted"]
          )
          // Sessions do not share an offset space.
          assert.deepStrictEqual(
            yield* log.append("other", "k1", envelope(7, { _tag: "RunStarted" })),
            { _tag: "Appended", sequence: 1 }
          )
          assert.deepStrictEqual(yield* log.read("missing"), [])
        })
      )
    )

    it.live("a replayed event is a duplicate; a disagreeing one is a conflict", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog
          yield* log.append("s", "k1", envelope(1, { _tag: "RunStarted" }))

          // Same key, same payload, different local sequence: the replay it is.
          assert.deepStrictEqual(
            yield* log.append("s", "k1", envelope(9, { _tag: "RunStarted" })),
            { _tag: "Duplicate" }
          )
          // Same key, different payload: not hidden.
          assert.deepStrictEqual(
            yield* log.append("s", "k1", envelope(1, { _tag: "TurnStarted" })),
            { _tag: "Conflict" }
          )
          // Neither changed what is recorded.
          const all = yield* log.read("s")
          assert.deepStrictEqual(all.map((e) => [e.sequence, e.event._tag]), [
            [1, "RunStarted"]
          ])
        })
      )
    )

    it.live("stores the wire projection of tool results", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog
          const when = new Date("2026-01-01T00:00:00Z")
          yield* log.append(
            "s",
            "tool",
            envelope(1, {
              _tag: "ToolCallSucceeded",
              id: "c1",
              name: "clock",
              result: when,
              encodedResult: when.toISOString()
            })
          )
          const [stored] = yield* log.read("s")
          assert.isDefined(stored)
          if (stored?.event._tag === "ToolCallSucceeded") {
            // A `Date` cannot cross; the encoded form is what both fields hold.
            assert.strictEqual(stored.event.result, when.toISOString())
            assert.strictEqual(stored.event.encodedResult, when.toISOString())
          } else {
            assert.fail("expected the tool event back")
          }
        })
      )
    )

    it.live("live carries only what is appended after subscribing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* makeLog
          yield* log.append("s", "before", envelope(1, { _tag: "SubmissionStarted" }))

          const collected = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(log.live("s"), 2))
          )
          yield* Effect.yieldNow
          yield* log.append("s", "a", envelope(2, { _tag: "RunStarted" }))
          // Duplicates are not republished either.
          yield* log.append("s", "a", envelope(2, { _tag: "RunStarted" }))
          yield* log.append("s", "b", envelope(3, { _tag: "TurnStarted" }))

          const seen = yield* Fiber.join(collected)
          assert.deepStrictEqual(
            seen.map((e) => [e.sequence, e.event._tag]),
            [
              [2, "RunStarted"],
              [3, "TurnStarted"]
            ]
          )
        })
      )
    )
  })

contract("memory", DeliveryLog.memoryLog)
contract("sqlite", sqlLog)
