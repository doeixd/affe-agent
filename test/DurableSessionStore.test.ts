import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Fiber, Layer, Option, Scope } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import type * as Elicitation from "../src/Elicitation.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The store is the durable counterpart of the local session's runtime state,
 * and its transitions are the correctness of the client that will sit on top.
 * The tests here are the ones the memory implementation must never fail:
 * atomicity under concurrency, and persistence of intent at the crash
 * boundaries it exists for.
 */

const historyWith = (text: string): Prompt.Prompt =>
  Prompt.make([{ role: "user", content: [{ type: "text", text }] }])

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-sessions-")),
      "store.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

/**
 * A fresh SQLite-backed store per test, over its own database file.
 *
 * The same contract runs against both implementations: the SQL one earns its
 * place by passing exactly what the memory one passes, transaction for
 * `Ref.modify`.
 */
const sqlStore = Effect.gen(function* () {
  const file = yield* tempDatabase
  // Built into the test's scope, so the connection outlives construction.
  const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
  return yield* DurableSessionStore.sqlStoreWithTables().pipe(
    Effect.provide(sql)
  )
})

/** The stored record, failing loudly if absent. */
const recordOf = (store: DurableSessionStore.DurableSessionStore, sessionId: string) =>
  Effect.flatMap(store.get(sessionId), (found) =>
    Option.isSome(found)
      ? Effect.succeed(found.value)
      : Effect.die(new Error(`session ${sessionId} missing`))
  )

const contract = (
  name: string,
  makeStore: Effect.Effect<
    DurableSessionStore.DurableSessionStore,
    never,
    Scope.Scope
  >
) =>
  describe(`DurableSessionStore (${name})`, () => {
  it.effect("creates once and returns the same record afterwards", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore

      const created = yield* store.getOrCreate("s1", historyWith("hello"))
      assert.strictEqual(created.status, "idle")
      assert.strictEqual(created.submissionCount, 0)

      const again = yield* store.getOrCreate("s1", historyWith("ignored"))
      // The initial history is not reapplied: a session that already exists
      // keeps whatever its conversations committed.
      assert.deepStrictEqual(again, created)

      assert.isTrue(Option.isNone(yield* store.get("missing")))
    }))
  )

  it.effect("claim on a missing session reports Missing", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore

      const outcome = yield* store.claim("ghost", {
        prompt: Prompt.make("go"),
        stream: false
      })
      assert.strictEqual(outcome._tag, "Missing")
    }))
  )

  it.effect("claims atomically and persists the request", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))

      const outcome = yield* store.claim("s1", {
        prompt: historyWith("do the thing"),
        stream: true
      })
      if (outcome._tag !== "Claimed") {
        return assert.fail(`expected Claimed, got ${outcome._tag}`)
      }
      // The id derives from the session-local ordinal.
      assert.include(outcome.claim.submissionId, "s1")
      assert.strictEqual(outcome.claim.stream, true)

      // The claim is on the record: a later process can see what was asked
      // even if this one died before dispatching the workflow.
      const record = yield* recordOf(store, "s1")
      assert.strictEqual(record.status, "running")
      if (Option.isNone(record.claim)) {
        return assert.fail("expected a live claim on the record")
      }
      assert.deepStrictEqual(
        TestLanguageModel.userTexts(
          yield* DurableSessionStore.decodeHistory(record.claim.value.prompt)
        ),
        ["do the thing"]
      )
    }))
  )

  it.effect("two concurrent claims produce one Claimed and one Busy", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))

      // Forked together on purpose: whichever order they run in, exactly one
      // may take an idle session. That is the whole point of claim being one
      // transition rather than read-then-write.
      const first = yield* Effect.forkChild(
        store.claim("s1", { prompt: Prompt.make("one"), stream: false })
      )
      const second = yield* Effect.forkChild(
        store.claim("s1", { prompt: Prompt.make("two"), stream: false })
      )
      const outcomes = [
        yield* Fiber.join(first),
        yield* Fiber.join(second)
      ]

      const claimed = outcomes.filter((o) => o._tag === "Claimed")
      const busy = outcomes.filter((o) => o._tag === "Busy")
      assert.strictEqual(claimed.length, 1)
      assert.strictEqual(busy.length, 1)

      // The loser is told who holds the session, not just refused.
      if (busy[0]?._tag !== "Busy") {
        return assert.fail("expected one Busy outcome")
      }
      assert.deepStrictEqual(busy[0].claim, claimed[0]?.claim)

      // And exactly one submission was consumed from the ordinal.
      const record = yield* recordOf(store, "s1")
      assert.strictEqual(record.submissionCount, 1)
    }))
  )

  it.effect("attachExecution records the workflow behind a live claim", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))
      const outcome = yield* store.claim("s1", {
        prompt: Prompt.make("go"),
        stream: false
      })
      if (outcome._tag !== "Claimed") {
        return assert.fail("expected Claimed")
      }

      const executionIdOf = (record: DurableSessionStore.SessionRecord) => {
        if (Option.isNone(record.claim)) {
          return assert.fail("expected a live claim")
        }
        return record.claim.value.executionId
      }

      yield* store.attachExecution(
        "s1",
        outcome.claim.submissionId,
        "execution-7"
      )
      let record = yield* recordOf(store, "s1")
      assert.strictEqual(executionIdOf(record), "execution-7")

      // A stale submission id must not touch the live claim.
      yield* store.attachExecution("s1", "someone-else", "wrong")
      record = yield* recordOf(store, "s1")
      assert.strictEqual(executionIdOf(record), "execution-7")
    }))
  )

  it.effect("finish restores idle, advances history, and refuses a replay", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))
      const claimed = yield* store.claim("s1", {
        prompt: Prompt.make("go"),
        stream: false
      })
      if (claimed._tag !== "Claimed") {
        return assert.fail("expected Claimed")
      }

      const done = yield* store.finish(
        "s1",
        claimed.claim.submissionId,
        historyWith("committed turn")
      )
      assert.isTrue(done)

      const record = yield* recordOf(store, "s1")
      assert.strictEqual(record.status, "idle")
      assert.strictEqual(record.submissionCount, 1)
      assert.deepStrictEqual(
        TestLanguageModel.userTexts(
          yield* DurableSessionStore.decodeHistory(record.history)
        ),
        ["committed turn"]
      )

      // A second terminal event for the same submission finds no active
      // claim and changes nothing.
      const replayed = yield* store.finish(
        "s1",
        claimed.claim.submissionId,
        historyWith("should not land")
      )
      assert.isFalse(replayed)
    }))
  )

  it.effect("the pending projection moves waiting -> answered atomically", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      const request: Elicitation.Request = {
        id: "elicit-1",
        kind: "tool-approval",
        detail: "wipe the database"
      }
      const response: Elicitation.Response = { id: "elicit-1", granted: true }

      // Answering before anything was asked is a false, not a failure — the
      // same contract `Elicitation.respond` keeps.
      assert.isFalse(yield* store.answerRequest("s1", response))

      yield* store.addPendingRequest("s1", request)
      assert.deepStrictEqual(yield* store.pendingRequests("s1"), [request])

      // One answer lands; a retry finds nothing waiting and reports false.
      assert.isTrue(yield* store.answerRequest("s1", response))
      assert.isFalse(yield* store.answerRequest("s1", response))
      assert.deepStrictEqual(yield* store.pendingRequests("s1"), [])

      // The recorded answer survives until the run takes it, then it is gone.
      assert.deepStrictEqual(
        yield* store.takeAnswer("s1", "elicit-1"),
        Option.some(response)
      )
      assert.isTrue(Option.isNone(yield* store.takeAnswer("s1", "elicit-1")))
    }))
  )

  it.effect("claim and finish both clear the elicitation projection", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))

      // Leftovers from a submission whose process died between delivering
      // an answer and taking it. Request ids restart per execution, so if
      // these survived into the next claim they would be mistaken for its
      // own `elicit-1`.
      yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: undefined })
      assert.isTrue(yield* store.answerRequest("s1", { id: "elicit-1", granted: true }))
      yield* store.addPendingRequest("s1", { id: "elicit-2", kind: "input", detail: undefined })

      const claimed = yield* store.claim("s1", { prompt: Prompt.make("go"), stream: false })
      assert.strictEqual(claimed._tag, "Claimed")
      assert.deepStrictEqual(yield* store.pendingRequests("s1"), [])
      assert.deepStrictEqual(yield* store.recordedAnswers("s1"), [])
      assert.isTrue(Option.isNone(yield* store.takeAnswer("s1", "elicit-1")))

      // And the same at the other end of the submission.
      if (claimed._tag !== "Claimed") return
      yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: undefined })
      yield* store.answerRequest("s1", { id: "elicit-1", granted: false })
      assert.isTrue(yield* store.finish("s1", claimed.claim.submissionId, historyWith("done")))
      assert.deepStrictEqual(yield* store.recordedAnswers("s1"), [])
      assert.deepStrictEqual(yield* store.pendingRequests("s1"), [])
    }))
  )

  it.effect("an answered request is not re-registered as pending by a replay", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      const request: Elicitation.Request = { id: "elicit-1", kind: "input", detail: undefined }
      yield* store.addPendingRequest("s1", request)
      yield* store.answerRequest("s1", { id: "elicit-1", granted: true })
      // The resumed run asks again under the same id on its way to finding
      // the answer already there.
      yield* store.addPendingRequest("s1", request)
      assert.deepStrictEqual(yield* store.pendingRequests("s1"), [])
      assert.strictEqual((yield* store.recordedAnswers("s1")).length, 1)
    }))
  )

  it.effect("removing a request forgets it without recording an answer", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.addPendingRequest("s1", {
        id: "elicit-2",
        kind: "input",
        detail: undefined
      })

      // The run consumed the request itself (for instance because the turn
      // was interrupted); no answer ever existed.
      yield* store.removeRequest("s1", "elicit-2")
      assert.deepStrictEqual(yield* store.pendingRequests("s1"), [])
      assert.isTrue(Option.isNone(yield* store.takeAnswer("s1", "elicit-2")))
    }))
  )
})

contract("memory", DurableSessionStore.memoryStore)
contract("sqlite", sqlStore)
