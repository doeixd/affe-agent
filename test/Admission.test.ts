import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option } from "effect"
import type { Scope } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as Admission from "../src/internal/admission.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Item 128: admission is one pure transition, and this is its one suite. The
 * table is the whole rule; the rows after it hold each store to it, so a store
 * that grew its own variant again fails here rather than in production.
 */

const none = Option.none<string>()
const key = (value: string) => Option.some(value)

type Row = {
  readonly name: string
  readonly slot: Admission.Slot<"holder">
  readonly key: Option.Option<string>
  readonly expected: Admission.Decision<"holder">
}

const table: ReadonlyArray<Row> = [
  { name: "a missing session", slot: { _tag: "Missing" }, key: none, expected: { _tag: "Missing" } },
  { name: "a missing session, keyed", slot: { _tag: "Missing" }, key: key("k"), expected: { _tag: "Missing" } },
  { name: "a closed session", slot: { _tag: "Closed" }, key: key("k"), expected: { _tag: "Closed" } },
  { name: "a fresh session", slot: { _tag: "Idle", submissionCount: 0 }, key: none, expected: { _tag: "Open", ordinal: 1 } },
  { name: "an idle session", slot: { _tag: "Idle", submissionCount: 4 }, key: key("k"), expected: { _tag: "Open", ordinal: 5 } },
  {
    name: "held, same key: the same request again",
    slot: { _tag: "Held", holder: "holder", key: key("k") },
    key: key("k"),
    expected: { _tag: "Rejoin", holder: "holder" }
  },
  {
    name: "held, another key",
    slot: { _tag: "Held", holder: "holder", key: key("k") },
    key: key("j"),
    expected: { _tag: "Busy", holder: "holder" }
  },
  {
    name: "held under a key, asked without one",
    slot: { _tag: "Held", holder: "holder", key: key("k") },
    key: none,
    expected: { _tag: "Busy", holder: "holder" }
  },
  {
    name: "held without a key, asked with one",
    slot: { _tag: "Held", holder: "holder", key: none },
    key: key("k"),
    expected: { _tag: "Busy", holder: "holder" }
  },
  {
    name: "held without a key, asked without one: two unkeyed requests are two requests",
    slot: { _tag: "Held", holder: "holder", key: none },
    key: none,
    expected: { _tag: "Busy", holder: "holder" }
  },
  {
    name: "the empty string is a key like any other",
    slot: { _tag: "Held", holder: "holder", key: key("") },
    key: key(""),
    expected: { _tag: "Rejoin", holder: "holder" }
  }
]

describe("admission (item 128)", () => {
  for (const row of table) {
    it(row.name, () => {
      assert.deepStrictEqual(Admission.admit(row.slot, row.key), row.expected)
    })
  }
})

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-admission-")), "store.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const stores: ReadonlyArray<readonly [string, Effect.Effect<DurableSessionStore.DurableSessionStore, unknown, Scope.Scope>]> = [
  ["memory", DurableSessionStore.memoryStore],
  [
    "sql",
    Effect.gen(function*() {
      const sql = yield* Layer.build(SqliteClient.layer({ filename: yield* tempDatabase }))
      return yield* DurableSessionStore.sqlStoreWithTables().pipe(Effect.provide(sql))
    })
  ]
]

const empty = Prompt.make([])

describe("each durable store admits by the table", () => {
  /**
   * Every row whose slot a store can hold: held under `holderKey` (or idle
   * when `holderKey` is absent), then claimed with `asked`. What the store
   * answers must be what `admit` decides for the same slot and key.
   */
  const cases: ReadonlyArray<{ readonly holderKey: Option.Option<Option.Option<string>>; readonly asked: Option.Option<string> }> = [
    { holderKey: Option.none(), asked: none },
    { holderKey: Option.none(), asked: key("k") },
    { holderKey: Option.some(key("k")), asked: key("k") },
    { holderKey: Option.some(key("k")), asked: key("j") },
    { holderKey: Option.some(key("k")), asked: none },
    { holderKey: Option.some(none), asked: key("k") },
    { holderKey: Option.some(none), asked: none }
  ]
  const claimWith = (store: DurableSessionStore.DurableSessionStore, asked: Option.Option<string>) =>
    store.claim("s", {
      prompt: empty,
      stream: false,
      ...Option.match(asked, { onNone: () => ({}), onSome: (k) => ({ key: k }) })
    })

  for (const [name, make] of stores) {
    it.effect(`${name}: a missing session is Missing`, () =>
      Effect.gen(function*() {
        const store = yield* make
        assert.strictEqual((yield* claimWith(store, key("k")))._tag, "Missing")
      }).pipe(Effect.scoped, Effect.orDie))

    for (const entry of cases) {
      const label = Option.match(entry.holderKey, {
        onNone: () => "idle",
        onSome: (k) => Option.match(k, { onNone: () => "held unkeyed", onSome: (v) => `held under ${v}` })
      })
      const asked = Option.getOrElse(entry.asked, () => "no key")
      it.effect(`${name}: ${label}, asked with ${asked}`, () =>
        Effect.gen(function*() {
          const store = yield* make
          yield* store.getOrCreate("s", empty)
          let slot: Admission.Slot<string> = { _tag: "Idle", submissionCount: 0 }
          if (Option.isSome(entry.holderKey)) {
            const first = yield* claimWith(store, entry.holderKey.value)
            assert.strictEqual(first._tag, "Claimed")
            if (first._tag === "Claimed") {
              slot = { _tag: "Held", holder: first.claim.submissionId, key: entry.holderKey.value }
            }
          }
          const answer = yield* claimWith(store, entry.asked)
          const decision = Admission.admit(slot, entry.asked)
          switch (decision._tag) {
            case "Open":
              assert.strictEqual(answer._tag, "Claimed")
              if (answer._tag === "Claimed") assert.strictEqual(answer.claim.submissionId, `s:submission-${decision.ordinal}`)
              break
            case "Rejoin":
              assert.strictEqual(answer._tag, "Claimed")
              if (answer._tag === "Claimed") assert.strictEqual(answer.claim.submissionId, decision.holder)
              break
            case "Busy":
              assert.strictEqual(answer._tag, "Busy")
              if (answer._tag === "Busy") assert.strictEqual(answer.claim.submissionId, decision.holder)
              break
            default:
              assert.fail(`unexpected decision ${decision._tag}`)
          }
          // A rejoin or a refusal moves nothing: the count is still the first claim's.
          const record = yield* store.get("s")
          assert.isTrue(Option.isSome(record))
          if (Option.isSome(record)) {
            assert.strictEqual(record.value.submissionCount, decision._tag === "Open" ? decision.ordinal : 1)
          }
        }).pipe(Effect.scoped, Effect.orDie))
    }
  }
})

describe("the local session admits by the table", () => {
  it.effect("idle opens the next ordinal, running is busy naming the holder, closed refuses", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("one"), TestLanguageModel.text("two")])
      const session = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(Agent.make())
        const first = yield* session.submit("go")
        const busy = yield* Effect.flip(session.submit("again"))
        assert.strictEqual(busy._tag, "AgentBusyError")
        if (busy._tag === "AgentBusyError") assert.strictEqual(busy.submissionId, first.submissionId)
        yield* session.awaitSubmission(first.submissionId)
        const second = yield* session.submit("next")
        assert.notStrictEqual(second.submissionId, first.submissionId)
        yield* session.awaitSubmission(second.submissionId)
        return session
      }).pipe(Effect.scoped, Effect.provide(layer))
      // The handle's scope has closed, and the session with it.
      const closed = yield* Effect.flip(session.submit("late"))
      assert.strictEqual(closed._tag, "AgentClosedError")
    }))
})
