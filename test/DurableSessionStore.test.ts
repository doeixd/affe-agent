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
