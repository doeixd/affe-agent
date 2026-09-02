import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import type { StorageError } from "../src/Errors.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import * as AgentSessionHost from "../src/client/internal/sessionHost.js"
import { SessionDirectory } from "../src/sessions/index.js"
import { SessionDirectoryConformance, TestLanguageModel } from "../src/testing/index.js"

/**
 * `SessionDirectory` (`docs/effect-plan-2.txt` §26): the management/query
 * model over sessions, kept apart from the durable session store.
 *
 * The contract runs against both implementations through the shipped
 * suite; what is here beyond it is the wiring -- `follow` over a host-wide
 * stream, first a fixture's and then a real host's -- and the type-level
 * claims, which a suite of runtime cases cannot make.
 */

const sessionId = (value: string) => AgentEvent.SessionId.make(value)
const submissionId = AgentEvent.SubmissionId.make("submission-1")

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-directory-")), "directory.db")
  ),
  (file) =>
    Effect.sync(() => {
      NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
    })
)

const sqlDirectory = Effect.gen(function* () {
  const file = yield* tempDatabase
  const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
  return yield* SessionDirectory.sqlWithTable().pipe(Effect.provide(sql))
})

const contract = (
  name: string,
  directory: Effect.Effect<SessionDirectory.SessionDirectory, never, Scope.Scope>
) =>
  describe(`SessionDirectory (${name})`, () => {
    for (const entry of SessionDirectoryConformance.cases({ directory })) {
      it.effect(entry.name, () => entry.run)
    }
  })

contract("memory", SessionDirectory.memory)
contract("sqlite", sqlDirectory)

// -- follow, over a fixture ---------------------------------------------------------

const envelope = (
  session: string,
  sequence: number,
  event: AgentEvent.AgentEvent
): AgentProtocol.HostEvent => ({
  _tag: "SessionEvent",
  envelope: {
    sessionId: sessionId(session),
    submissionId: Option.some(submissionId),
    runId: Option.none(),
    turn: Option.none(),
    sequence,
    event
  }
})

describe("SessionDirectory.follow", () => {
  it.effect("observes the inventory, folds each session's events, and keeps stats after unhosting", () =>
    Effect.gen(function* () {
      const directory = yield* SessionDirectory.memory
      const events: ReadonlyArray<AgentProtocol.HostEvent> = [
        { _tag: "HostAttached", sessionIds: [sessionId("a"), sessionId("b")] },
        { _tag: "SessionHosted", sessionId: sessionId("c") },
        // Sequence 2 first, on purpose: `empty` seeds without a gap.
        envelope("a", 2, { _tag: "SubmissionStarted" }),
        envelope("a", 3, { _tag: "TurnCompleted" }),
        envelope("b", 2, { _tag: "SubmissionStarted" }),
        envelope("b", 3, { _tag: "SubmissionCompleted", runs: 1 }),
        { _tag: "SessionUnhosted", sessionId: sessionId("b"), reason: "closed", lastSequence: Option.some(3) }
      ]
      yield* SessionDirectory.follow(directory, Stream.fromIterable(events))

      const all = yield* directory.list()
      assert.deepStrictEqual(all.entries.map((e) => e.sessionId), ["a", "b", "c"])

      const a = yield* directory.stats(sessionId("a"))
      assert.isTrue(Option.isSome(a))
      if (Option.isSome(a)) {
        assert.deepStrictEqual(a.value.activeSubmission, Option.some(submissionId))
        assert.strictEqual(a.value.turns, 1)
        assert.strictEqual(a.value.gaps, 0, "joining at sequence 2 is not a gap")
        assert.deepStrictEqual(a.value.lastSequence, Option.some(3))
      }
      const active = yield* directory.active()
      assert.deepStrictEqual(active.entries.map((e) => e.sessionId), ["a"])

      // Unhosting drops the fold, not the record.
      const b = yield* directory.stats(sessionId("b"))
      assert.deepStrictEqual(Option.map(b, (s) => s.submissions.completed), Option.some(1))
    }))

  it.effect("a session unhosted and rehosted folds from a fresh projection", () =>
    Effect.gen(function* () {
      const directory = yield* SessionDirectory.memory
      yield* SessionDirectory.follow(
        directory,
        Stream.fromIterable<AgentProtocol.HostEvent>([
          envelope("a", 2, { _tag: "SubmissionStarted" }),
          { _tag: "SessionUnhosted", sessionId: sessionId("a"), reason: "closed", lastSequence: Option.some(2) },
          // The same sequence again would be a duplicate to a retained
          // projection; to a fresh one it is the first event seen.
          envelope("a", 2, { _tag: "SubmissionStarted" })
        ])
      )
      const stats = yield* directory.stats(sessionId("a"))
      assert.deepStrictEqual(Option.map(stats, (s) => s.submissions.started), Option.some(1))
    }))
})

// -- follow, over a real host -------------------------------------------------------

const withHost = <A, E>(
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  use: (host: AgentSessionHost.Host<void>) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.gen(function* () {
    const { layer: model } = yield* TestLanguageModel.script(turns)
    return yield* Effect.scoped(
      Effect.flatMap(
        AgentSessionHost.make({
          authorization: AgentSessionHost.allowAll<void>(),
          maxSessions: 4,
          maxRequestsPerSession: 8
        }),
        use
      )
    ).pipe(
      Effect.provide(AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(Layer.provide(model)))
    )
  })

describe("SessionDirectory over AgentSessionHost", () => {
  it.effect("a hosted session's lifecycle keeps the directory current without the host knowing", () =>
    withHost([TestLanguageModel.text("one"), TestLanguageModel.text("two")], (host) =>
      Effect.gen(function* () {
        const directory = yield* SessionDirectory.memory
        const events = yield* host.hostEvents(undefined)
        const pump = yield* Effect.forkChild(SessionDirectory.follow(directory, events))
        yield* Effect.yieldNow

        yield* host.createSession(undefined, { requestId: AgentProtocol.RequestId.make("c1"), sessionId: sessionId("hosted") })
        yield* host.prompt(undefined, {
          requestId: AgentProtocol.RequestId.make("p1"),
          sessionId: sessionId("hosted"),
          input: Prompt.make("hello")
        })
        yield* Effect.yieldNow

        const entry = yield* directory.get(sessionId("hosted"))
        assert.isTrue(Option.isSome(entry), "the session is indexed")
        if (Option.isSome(entry)) {
          assert.strictEqual(entry.value.stats.submissions.completed, 1)
          assert.strictEqual(entry.value.stats.modelCalls, 1)
          assert.isFalse(SessionDirectory.isActive(entry.value.stats))
          assert.strictEqual(entry.value.stats.gaps, 0)
        }
        yield* Fiber.interrupt(pump)
      })))
})

// -- Type-level ------------------------------------------------------------------------

/**
 * What the compiler is asked to guarantee, and was asked to refuse once
 * each: the error channels are exactly the named ones, and the record's
 * absence is `Option`, not `null`.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

declare const directory: SessionDirectory.SessionDirectory
type _RenameError = Assert<
  Equals<Effect.Error<ReturnType<typeof directory.rename>>, SessionDirectory.SessionNotIndexed | StorageError>
>
type _GetError = Assert<Equals<Effect.Error<ReturnType<typeof directory.get>>, StorageError>>
type _GetSuccess = Assert<
  Equals<Effect.Success<ReturnType<typeof directory.get>>, Option.Option<SessionDirectory.Entry>>
>
type _NameIsOption = Assert<Equals<SessionDirectory.Entry["name"], Option.Option<string>>>
type _FollowNeedsNothing = Assert<Equals<Effect.Services<ReturnType<typeof SessionDirectory.follow>>, never>>
