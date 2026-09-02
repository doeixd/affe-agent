import { Effect, Option, Schema } from "effect"
import type { Scope } from "effect"
import { SessionId, SubmissionId } from "../AgentEvent.js"
import type { StorageError } from "../Errors.js"
import * as SessionDirectory from "../sessions/SessionDirectory.js"
import { checks, report, type Report } from "./internal/conformance.js"

/**
 * The conformance suite every `SessionDirectory` must pass.
 *
 * A directory is an index over sessions, and what an index owes its readers
 * is that the management operations are idempotent where they say they are,
 * that a page is a page (bounded, stable under keyset resumption, exhaustive
 * when walked), and that `active` is derived from the same stats `stats`
 * returns. The memory and SQL directories run this; one over another
 * backing is held to the same.
 *
 * Framework-agnostic, as the other suites are: a case is a named Effect, a
 * runner wires them with one line each, and `run` reports.
 */

export class Failure extends Schema.TaggedError<Failure>()(
  "SessionDirectoryConformanceFailure",
  { case: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `session directory conformance: ${this.case}: ${this.detail}`
  }
}

export interface Options<E> {
  /** A fresh directory, per case. Scoped, so one over a connection can close it. */
  readonly directory: Effect.Effect<SessionDirectory.SessionDirectory, E, Scope.Scope>
}

export interface Case<E> {
  readonly name: string
  readonly run: Effect.Effect<void, Failure | StorageError | SessionDirectory.SessionNotIndexed | E>
}

const { equal, failureOf, that } = checks((name, detail) => new Failure({ case: name, detail }))

const id = (value: string) => SessionId.make(value)

/** Stats that say "running": one submission started and not settled. */
export const runningStats: SessionDirectory.Stats = {
  ...SessionDirectory.emptyStats,
  started: true,
  activeSubmission: Option.some(SubmissionId.make("submission-1")),
  submissions: { started: 1, completed: 0, failed: 0, interrupted: 0 }
}

/** Stats that say "done": the same submission, completed. */
export const settledStats: SessionDirectory.Stats = {
  ...runningStats,
  activeSubmission: Option.none(),
  submissions: { started: 1, completed: 1, failed: 0, interrupted: 0 },
  turns: 2,
  modelCalls: 2,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 17 }
}

export const cases = <E>(options: Options<E>): ReadonlyArray<Case<E>> => {
  type Directory = SessionDirectory.SessionDirectory
  const make = (
    name: string,
    body: (directory: Directory) => Effect.Effect<void, Failure | StorageError | SessionDirectory.SessionNotIndexed | E>
  ): Case<E> => ({ name, run: Effect.scoped(Effect.flatMap(options.directory, body)) })

  return [
    make("observe creates once and never resets what a later mutation set", (directory) =>
      Effect.gen(function* () {
        const name = "observe creates once and never resets what a later mutation set"
        const created = yield* directory.observe(id("s1"))
        yield* equal(name)(created.name, Option.none(), "name at creation")
        yield* equal(name)(created.namespace, SessionDirectory.defaultNamespace, "namespace at creation")
        yield* equal(name)(created.stats, SessionDirectory.emptyStats, "stats at creation")
        yield* directory.rename(id("s1"), Option.some("support thread"))
        const again = yield* directory.observe(id("s1"))
        yield* equal(name)(again.name, Option.some("support thread"), "a second observe keeps the name")
        yield* equal(name)(again.createdAt, created.createdAt, "a second observe keeps createdAt")
        yield* that(name)(Option.isNone(yield* directory.get(id("missing"))), "an unknown session should be None")
      })),

    make("rename, move and annotate fail on an unindexed session, by name", (directory) =>
      Effect.gen(function* () {
        const name = "rename, move and annotate fail on an unindexed session, by name"
        const renamed = yield* failureOf(name)(directory.rename(id("ghost"), Option.some("x")))
        yield* equal(name)(renamed._tag, "SessionNotIndexed", "rename's error")
        const moved = yield* failureOf(name)(directory.move(id("ghost"), "ns"))
        yield* equal(name)(moved._tag, "SessionNotIndexed", "move's error")
        const annotated = yield* failureOf(name)(directory.annotate(id("ghost"), { k: Option.some("v") }))
        yield* equal(name)(annotated._tag, "SessionNotIndexed", "annotate's error")
        if (annotated._tag === "SessionNotIndexed") {
          yield* equal(name)(annotated.sessionId, "ghost", "the error names the session")
          yield* equal(name)(annotated.operation, "annotate", "the error names the operation")
        }
      })),

    make("annotate merges, and a None value removes the key", (directory) =>
      Effect.gen(function* () {
        const name = "annotate merges, and a None value removes the key"
        yield* directory.observe(id("s1"))
        yield* directory.annotate(id("s1"), { owner: Option.some("ops"), ticket: Option.some("T-1") })
        const merged = yield* directory.annotate(id("s1"), { ticket: Option.some("T-2"), priority: Option.some("high") })
        yield* equal(name)(merged.attributes, { owner: "ops", ticket: "T-2", priority: "high" }, "after the merge")
        const removed = yield* directory.annotate(id("s1"), { owner: Option.none() })
        yield* equal(name)(removed.attributes, { ticket: "T-2", priority: "high" }, "after the removal")
        const read = yield* directory.get(id("s1"))
        yield* equal(name)(Option.map(read, (e) => e.attributes), Option.some({ ticket: "T-2", priority: "high" }), "what get returns")
      })),

    make("rename to None clears the name; move changes what list by namespace sees", (directory) =>
      Effect.gen(function* () {
        const name = "rename to None clears the name; move changes what list by namespace sees"
        yield* directory.observe(id("s1"))
        yield* directory.rename(id("s1"), Option.some("first"))
        const cleared = yield* directory.rename(id("s1"), Option.none())
        yield* equal(name)(cleared.name, Option.none(), "the cleared name")
        yield* directory.move(id("s1"), "team-a")
        const inA = yield* directory.list({ namespace: "team-a" })
        yield* equal(name)(inA.entries.map((e) => e.sessionId), ["s1"], "team-a after the move")
        const inDefault = yield* directory.list({ namespace: SessionDirectory.defaultNamespace })
        yield* equal(name)(inDefault.entries.length, 0, "the default namespace after the move")
        const everywhere = yield* directory.list()
        yield* equal(name)(everywhere.entries.length, 1, "an unfiltered list")
      })),

    make("record creates the entry, and active follows the stats", (directory) =>
      Effect.gen(function* () {
        const name = "record creates the entry, and active follows the stats"
        yield* directory.record(id("s1"), runningStats)
        yield* equal(name)(yield* directory.stats(id("s1")), Option.some(runningStats), "stats after record")
        const active = yield* directory.active()
        yield* equal(name)(active.entries.map((e) => e.sessionId), ["s1"], "active while running")
        yield* directory.record(id("s1"), settledStats)
        const settled = yield* directory.active()
        yield* equal(name)(settled.entries.length, 0, "active once settled")
        yield* equal(name)(yield* directory.stats(id("s1")), Option.some(settledStats), "stats after settling")
        // Stats do not touch what a human set.
        yield* directory.rename(id("s1"), Option.some("kept"))
        yield* directory.record(id("s1"), runningStats)
        const entry = yield* directory.get(id("s1"))
        yield* equal(name)(Option.map(entry, (e) => e.name), Option.some(Option.some("kept")), "the name after a record")
      })),

    make("stats survive a round trip exactly, Options included", (directory) =>
      Effect.gen(function* () {
        const name = "stats survive a round trip exactly, Options included"
        const withSequence: SessionDirectory.Stats = {
          ...settledStats,
          lastSequence: Option.some(41),
          closed: true,
          gaps: 2,
          tools: { started: 3, succeeded: 1, failed: 2, interrupted: 0, returnedToModel: 1 }
        }
        yield* directory.record(id("s1"), withSequence)
        yield* equal(name)(yield* directory.stats(id("s1")), Option.some(withSequence), "the stats read back")
      })),

    make("list pages by sessionId with a keyset cursor and walks every entry once", (directory) =>
      Effect.gen(function* () {
        const name = "list pages by sessionId with a keyset cursor and walks every entry once"
        const ids = Array.from({ length: 7 }, (_, i) => id(`s${String(i).padStart(2, "0")}`))
        // Observed out of order, so order comes from the directory, not insertion.
        for (const sessionId of [...ids].reverse()) yield* directory.observe(sessionId)
        const first = yield* directory.list({ limit: 3 })
        yield* equal(name)(first.entries.map((e) => e.sessionId), ids.slice(0, 3), "the first page")
        yield* equal(name)(first.next, Option.some(ids[2]), "the first cursor")
        const second = yield* directory.list({ limit: 3, after: Option.getOrUndefined(first.next) })
        yield* equal(name)(second.entries.map((e) => e.sessionId), ids.slice(3, 6), "the second page")
        const third = yield* directory.list({ limit: 3, after: Option.getOrUndefined(second.next) })
        yield* equal(name)(third.entries.map((e) => e.sessionId), ids.slice(6), "the last page")
        yield* equal(name)(third.next, Option.none(), "no cursor after the last page")
        // A page that is exactly full is not followed by an empty page.
        const exact = yield* directory.list({ limit: 7 })
        yield* equal(name)(exact.next, Option.none(), "an exactly full page has no cursor")
      })),

    make("limit is bounded: zero becomes one, and the maximum is a ceiling", (directory) =>
      Effect.gen(function* () {
        const name = "limit is bounded: zero becomes one, and the maximum is a ceiling"
        yield* directory.observe(id("a"))
        yield* directory.observe(id("b"))
        const one = yield* directory.list({ limit: 0 })
        yield* equal(name)(one.entries.length, 1, "limit 0")
        const huge = yield* directory.list({ limit: SessionDirectory.maxLimit * 10 })
        yield* equal(name)(huge.entries.length, 2, "an oversized limit still returns everything that fits")
        yield* equal(name)(SessionDirectory.limitOf({ limit: SessionDirectory.maxLimit * 10 }), SessionDirectory.maxLimit, "the ceiling")
      })),

    make("active filters by namespace and pages the same way as list", (directory) =>
      Effect.gen(function* () {
        const name = "active filters by namespace and pages the same way as list"
        for (const i of [1, 2, 3, 4]) {
          const sessionId = id(`s${i}`)
          yield* directory.record(sessionId, i % 2 === 0 ? runningStats : settledStats)
          yield* directory.move(sessionId, i <= 2 ? "x" : "y")
        }
        const inX = yield* directory.active({ namespace: "x" })
        yield* equal(name)(inX.entries.map((e) => e.sessionId), ["s2"], "active in x")
        const all = yield* directory.active({ limit: 1 })
        yield* equal(name)(all.entries.map((e) => e.sessionId), ["s2"], "the first active page")
        const rest = yield* directory.active({ limit: 1, after: Option.getOrUndefined(all.next) })
        yield* equal(name)(rest.entries.map((e) => e.sessionId), ["s4"], "the second active page")
        yield* equal(name)(rest.next, Option.none(), "the end")
      })),

    make("updatedAt moves on a mutation and createdAt does not", (directory) =>
      Effect.gen(function* () {
        const name = "updatedAt moves on a mutation and createdAt does not"
        const created = yield* directory.observe(id("s1"))
        const renamed = yield* directory.rename(id("s1"), Option.some("n"))
        yield* equal(name)(renamed.createdAt, created.createdAt, "createdAt")
        yield* that(name)(renamed.updatedAt >= created.updatedAt, "updatedAt is monotone")
      }))
  ]
}

/** Run every case and report which held. */
export const run = <E>(options: Options<E>): Effect.Effect<Report> => report(cases(options))
