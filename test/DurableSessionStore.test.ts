import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Fiber, Layer, Option, Scope } from "effect"
import { Prompt } from "effect/unstable/ai"
import { SqlClient } from "effect/unstable/sql"
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

  /**
   * All three file-data variants, not just bytes.
   *
   * `PromptWire` exists because the three are ambiguous once serialized, and
   * the URL case is the one whose failure is silent: `FileDataWireRead`
   * deliberately accepts a bare string on read, so a URL that failed to encode
   * as `{_tag:"Url"}` comes back as a **string** rather than as an error --
   * and `string` is a legal `FilePart.data`, so nothing downstream notices.
   * A test that only exercised bytes could never see that.
   */
  it.effect("preserves every file-data variant in persisted history", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      const bytes = new Uint8Array([51, 52, 53])
      const url = new URL("https://cdn.example.com/asset.png")
      const inline = "inline string payload"
      const created = yield* store.getOrCreate(
        "multimodal",
        Prompt.make([{
          role: "user",
          content: [
            { type: "file", mediaType: "application/octet-stream", data: bytes },
            { type: "file", mediaType: "image/png", data: url },
            { type: "file", mediaType: "text/plain", data: inline }
          ]
        }])
      )
      const history = yield* DurableSessionStore.decodeHistory(created.history)
      const message = history.content[0]
      assert.strictEqual(message?.role, "user")
      if (message?.role !== "user") return
      const data = message.content.flatMap((part) =>
        part.type === "file" ? [part.data] : []
      )
      assert.strictEqual(data.length, 3)

      assert.isTrue(data[0] instanceof Uint8Array, "bytes must stay bytes")
      if (data[0] instanceof Uint8Array) {
        assert.deepStrictEqual(Array.from(data[0]), Array.from(bytes))
      }

      assert.isTrue(
        data[1] instanceof URL,
        "a URL must stay a URL, not decay to a string"
      )
      if (data[1] instanceof URL) {
        assert.strictEqual(data[1].href, url.href)
      }

      assert.strictEqual(data[2], inline, "a string must stay that exact string")
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

  /**
   * R92 -- a `StorageError` from `claim` means "unknown", not "did not
   * happen".
   *
   * The write can commit and the acknowledgement be lost: a connection
   * dropped after the transaction, a process killed between the commit and
   * the reply. No store can tell the caller which happened. Without a key the
   * retry is a *second* request -- it finds the first claim in place, is
   * refused as `Busy`, and the caller believes nothing started while the
   * session is claimed and will later run work it was told had failed.
   *
   * The key makes the retry recognisable as the same request. That is what
   * turns an indeterminate failure into a safe one.
   */
  it.effect("a retry under the same key is the same claim, not a busy session", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))

      const first = yield* store.claim("s1", {
        prompt: Prompt.make("do the thing"),
        stream: false,
        key: "request-7"
      })
      assert.strictEqual(first._tag, "Claimed")

      // The caller never learned that. It asks again, naming the same request.
      const retry = yield* store.claim("s1", {
        prompt: Prompt.make("do the thing"),
        stream: false,
        key: "request-7"
      })
      assert.strictEqual(retry._tag, "Claimed", "the retry was treated as a second request")
      if (retry._tag === "Claimed" && first._tag === "Claimed") {
        // The *same* claim, so the caller resumes where it left off rather
        // than starting a second submission.
        assert.deepStrictEqual(retry.claim, first.claim)
      }

      // And the ordinal did not move: a retry is not a submission.
      const record = Option.getOrThrow(yield* store.get("s1"))
      assert.strictEqual(record.submissionCount, 1)
    })))

  it.effect("a different key on a claimed session is still Busy", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))

      yield* store.claim("s1", {
        prompt: Prompt.make("mine"),
        stream: false,
        key: "request-7"
      })
      // Somebody else's request, which must not be coalesced into the first.
      const other = yield* store.claim("s1", {
        prompt: Prompt.make("theirs"),
        stream: false,
        key: "request-8"
      })
      assert.strictEqual(other._tag, "Busy")

      // And a caller with no key at all gets the old answer, which is the
      // documented behaviour rather than an oversight.
      const keyless = yield* store.claim("s1", {
        prompt: Prompt.make("anon"),
        stream: false
      })
      assert.strictEqual(keyless._tag, "Busy")
    })))

  /**
   * And the key's window is the claim's lifetime, which is a boundary rather
   * than an oversight.
   *
   * `finish` takes the key with the claim it belonged to, so a key reused long
   * afterwards cannot coalesce into a submission that has ended. The cost is
   * that a retry arriving after completion is a new request -- pinned here so
   * the guarantee is not read as broader than it is.
   */
  it.effect("a key reused after its submission finished starts a new one", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.getOrCreate("s1", historyWith("system"))
      const request = { prompt: Prompt.make("go"), stream: false, key: "k1" }

      const first = yield* store.claim("s1", request)
      assert.strictEqual(first._tag, "Claimed")
      if (first._tag !== "Claimed") return
      yield* store.finish("s1", first.claim.submissionId, historyWith("system"))

      const again = yield* store.claim("s1", request)
      assert.strictEqual(again._tag, "Claimed")
      if (again._tag !== "Claimed") return
      assert.notStrictEqual(again.claim.submissionId, first.claim.submissionId)
    })))

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

  it.effect("an id that is already pending keeps the request it was created with", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore
      yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: "first" })
      // A replay asking under the same id with a different payload. First
      // write wins, as everywhere else in the store; the memory store used to
      // overwrite here while the SQL store kept the original.
      yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: "second" })
      const pending = yield* store.pendingRequests("s1")
      assert.strictEqual(pending.length, 1)
      assert.strictEqual(pending[0]?.detail, "first")
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

/**
 * The races SQLite cannot show us (R66).
 *
 * Every transition that guards an invariant is one transaction, and for a long
 * time that was described as though it settled the question. It does not: a
 * transaction gives atomicity, not serialisability. Under read-committed --
 * the default nearly everywhere except SQLite -- another transaction can
 * commit between this one's `SELECT` and its `UPDATE`, so a decision taken
 * from the read is already stale when the write lands.
 *
 * The suite above runs on SQLite, which serialises writers at the file level
 * and therefore *cannot produce* the interleaving. Passing tests there were
 * never evidence for the portable claim, which is why the module carried a
 * paragraph admitting it. This block replaces the paragraph with a test.
 *
 * The seam is a `SqlClient` that runs an injected statement immediately after
 * a nominated one resolves. Because the injection runs on the same connection
 * inside the same transaction, the transition sees exactly what it would see
 * if a concurrent transaction had committed there -- which is the whole of
 * what read-committed permits. No production code learns about this; the
 * wrapper stands in front of the real client and the store is built on it
 * unchanged.
 */
describe("DurableSessionStore (interleaved writes)", () => {
  const interleaving = Effect.gen(function* () {
    const file = yield* tempDatabase
    const built = yield* Layer.build(SqliteClient.layer({ filename: file }))
    const base = yield* Effect.provide(SqlClient.SqlClient, built)

    let armed: { readonly match: string; readonly run: Effect.Effect<unknown, any> } | undefined

    const wrapped: any = (strings: TemplateStringsArray, ...args: ReadonlyArray<unknown>) => {
      const result = (base as any)(strings, ...args)
      if (armed !== undefined && strings.join("?").includes(armed.match)) {
        const injected = armed.run
        // One shot: the injected statements must not re-arm themselves.
        armed = undefined
        return Effect.tap(result, () => injected)
      }
      return result
    }
    // The service is a callable object whose methods -- `literal`, `insert`,
    // `withTransaction` -- are own properties, so a function carrying copies
    // of them is a faithful stand-in.
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(base))
    Object.assign(wrapped, base)

    const store = yield* DurableSessionStore.sqlStoreWithTables().pipe(
      Effect.provideService(SqlClient.SqlClient, wrapped as SqlClient.SqlClient)
    )
    return {
      store,
      sql: base,
      /** Run `run` right after the next statement containing `match`. */
      arm: (match: string, run: Effect.Effect<unknown, any>) => {
        armed = { match, run }
      }
    }
  })

  it.effect("a finish whose read went stale cannot wipe a live claim", () =>
    Effect.scoped(Effect.gen(function* () {
      const { arm, sql, store } = yield* interleaving
      yield* store.getOrCreate("s1", historyWith("hello"))
      const first = yield* store.claim("s1", {
        prompt: historyWith("one"),
        stream: false
      })
      assert.strictEqual(first._tag, "Claimed")
      const submissionId = first._tag === "Claimed" ? first.claim.submissionId : ""

      /**
       * Between this `finish`'s read and its write: another process finishes
       * the same submission, and a fresh claim is admitted. That is an
       * ordinary sequence -- it is only a problem because *this* caller
       * already decided, from a read that is now out of date, that clearing
       * the claim is the right thing to do.
       */
      const otherPrompt = yield* DurableSessionStore.encodeHistory(historyWith("two"))
      const successor = JSON.stringify({
        submissionId: "s1:submission-2",
        prompt: otherPrompt,
        stream: false
      })
      arm(
        "SELECT * FROM",
        sql`UPDATE effect_agent_session SET status = 'running', submission_count = 2, claim = ${successor} WHERE session_id = 's1'`
      )

      const finished = yield* store.finish("s1", submissionId, historyWith("done"))

      // Truthfully false: this finish did not happen.
      assert.isFalse(finished)
      // And -- the part that matters -- submission 2 is still running.
      const after = yield* recordOf(store, "s1")
      assert.strictEqual(after.status, "running")
      assert.isTrue(Option.isSome(after.claim))
      if (Option.isSome(after.claim)) {
        assert.strictEqual(after.claim.value.submissionId, "s1:submission-2")
      }
    }))
  )

  it.effect("an answer that lost the race is not reported as accepted", () =>
    Effect.scoped(Effect.gen(function* () {
      const { arm, sql, store } = yield* interleaving
      yield* store.getOrCreate("s1", historyWith("hello"))
      yield* store.addPendingRequest("s1", {
        id: "elicit-1",
        kind: "input",
        detail: undefined
      })

      // Between the read that found it pending and the write that answers it,
      // somebody else answers it.
      const rival = JSON.stringify({ id: "elicit-1", granted: false })
      arm(
        "SELECT id FROM",
        sql`UPDATE effect_agent_elicitation SET state = 'answered', payload = ${rival} WHERE session_id = 's1' AND request_id = 'elicit-1'`
      )

      const accepted = yield* store.answerRequest("s1", {
        id: "elicit-1",
        granted: true
      })

      // Reported honestly, and the answer that got there first is intact.
      assert.isFalse(accepted)
      const taken = yield* store.takeAnswer("s1", "elicit-1")
      assert.isTrue(Option.isSome(taken))
      if (Option.isSome(taken)) assert.isFalse(taken.value.granted)
    }))
  )
})
