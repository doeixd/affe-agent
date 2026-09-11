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
import * as BlobStore from "../src/blob/BlobStore.js"
import { DurableSessionStoreConformance, TestLanguageModel } from "../src/testing/index.js"

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

/**
 * The shipped suite (`DurableSessionStoreConformance`), wired one line per
 * case. What used to be written here is now what a store over another
 * backing is held to as well.
 */
const contract = (
  name: string,
  makeStore: Effect.Effect<DurableSessionStore.DurableSessionStore, never, Scope.Scope>
) =>
  describe(`DurableSessionStore (${name})`, () => {
    for (const entry of DurableSessionStoreConformance.cases({ store: makeStore })) {
      it.effect(entry.name, () => entry.run)
    }
  })

contract("memory", DurableSessionStore.memoryStore)
contract("sqlite", sqlStore)
// Item 116: the same contract with files going to a blob store. The suite's
// histories carry no files, so these rows say only that the option changes
// nothing a caller sees; the rows below put a file through it.
contract("memory, history files to a blob store", Effect.flatMap(BlobStore.memory, (store) =>
  DurableSessionStore.memoryStoreWith({ blobs: { store, maxInlineBytes: 1024 } })))
contract("sqlite, history files to a blob store", Effect.gen(function* () {
  const file = yield* tempDatabase
  const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
  const store = yield* BlobStore.memory
  return yield* DurableSessionStore.sqlStoreWithTables({ blobs: { store, maxInlineBytes: 1024 } }).pipe(Effect.provide(sql))
}))

describe("history files in a blob store (item 116)", () => {
  // 4 KB of deterministic bytes: over the threshold, so it leaves the row.
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => i % 251)
  const withImage = Prompt.make([{
    role: "user",
    content: [
      { type: "text", text: "what is in this screenshot?" },
      { type: "file", mediaType: "image/png", fileName: "screen.png", data: bytes }
    ]
  }])

  it.effect("the row holds a reference, a read is the inline encoding, and a second store reads the same", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const blobs = { store: yield* BlobStore.memory, maxInlineBytes: 1024 }
      const inline = yield* DurableSessionStore.encodeHistory(withImage)
      const open = Effect.gen(function* () {
        const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
        const store = yield* DurableSessionStore.sqlStoreWithTables({ blobs }).pipe(Effect.provide(sql))
        return { sql, store }
      })

      const first = yield* open
      yield* first.store.getOrCreate("s", Prompt.make([]))
      const claimed = yield* first.store.claim("s", { prompt: Prompt.make("go"), stream: false })
      assert.strictEqual(claimed._tag, "Claimed")
      if (claimed._tag !== "Claimed") return
      assert.isTrue(yield* first.store.finish("s", claimed.claim.submissionId, withImage))

      // What is on disk: a reference where the 4 KB were, and far smaller.
      const row = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly history: string }>`SELECT history FROM ${sql.literal(DurableSessionStore.sqlSessionTable)} WHERE session_id = 's'`
        return rows[0]!.history
      }).pipe(Effect.provide(first.sql))
      assert.include(row, "\"Blob\"")
      assert.isBelow(row.length, inline.length - 4000)
      assert.deepStrictEqual(JSON.parse(row), recordedRow())

      // What a caller reads: exactly the inline encoding, so a retry's
      // byte comparison and every decoder see what they always saw.
      const read = yield* first.store.get("s")
      assert.strictEqual(Option.getOrThrow(read).history, inline)

      // Another store over the same database and blobs: the same history.
      const second = yield* open
      assert.strictEqual(Option.getOrThrow(yield* second.store.get("s")).history, inline)
    }).pipe(Effect.scoped))

  it.effect("a file at or under the threshold stays inline, and without the option nothing moves", () =>
    Effect.gen(function* () {
      const small = Prompt.make([{
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: bytes.slice(0, 512) }]
      }])
      const blobStore = yield* BlobStore.memory
      for (const store of [
        yield* DurableSessionStore.memoryStoreWith({ blobs: { store: blobStore, maxInlineBytes: 1024 } }),
        yield* DurableSessionStore.memoryStore
      ]) {
        yield* store.getOrCreate("s", small)
        assert.strictEqual(Option.getOrThrow(yield* store.get("s")).history, yield* DurableSessionStore.encodeHistory(small))
      }
      const withoutOption = yield* DurableSessionStore.memoryStore
      yield* withoutOption.getOrCreate("big", withImage)
      assert.notInclude(Option.getOrThrow(yield* withoutOption.get("big")).history, "\"Blob\"")
    }))
})

/** The recorded shape of an externalised history row (`test/fixtures/history-blob-row.json`). */
const recordedRow = (): unknown => JSON.parse(NodeFs.readFileSync("test/fixtures/history-blob-row.json", "utf8"))

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
        sql`UPDATE affe_session SET status = 'running', submission_count = 2, claim = ${successor} WHERE session_id = 's1'`
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
        sql`UPDATE affe_elicitation SET state = 'answered', payload = ${rival} WHERE session_id = 's1' AND request_id = 'elicit-1'`
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
