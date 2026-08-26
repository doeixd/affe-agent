import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Deferred, Duration, Effect, Exit, Layer, Option, Ref, Schedule, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { WorkflowEngine } from "effect/unstable/workflow"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import { StorageError } from "../src/Errors.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The headline claim of issue #5, made real: a runner dies mid-conversation
 * and a *different* runner, with a *different* `AgentClient` instance and
 * nothing in common but the database, reacquires the logical session and
 * carries it on.
 *
 * Everything durable is on SQLite here — the workflow journal (`SingleRunner`
 * with SQL runner storage), the channels, the session projection, and the
 * delivery log. The memory suite proves the semantics; this proves they do
 * not depend on process memory.
 */

/** Node's crypto, which `SingleRunner` needs for runner identity. */
const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(
        () =>
          new Uint8Array(
            NodeCrypto.createHash(algorithm.toLowerCase().replace("-", ""))
              .update(data)
              .digest()
          )
      )
  })
)

/**
 * A runner over the given database. The shard lock TTL is shortened so a
 * replacement can take over in seconds rather than the production 35s; see
 * `DurableSql.test.ts` for why production should leave it alone.
 */
const engineFor = (file: string, lockSeconds: number) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      SingleRunner.layer({
        runnerStorage: "sql",
        shardingConfig: {
          shardLockExpiration: Duration.seconds(lockSeconds),
          shardLockRefreshInterval: Duration.millis(200)
        }
      }).pipe(
        Layer.provide(SqliteClient.layer({ filename: file })),
        Layer.provide(CryptoLayer)
      )
    )
  )

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-client-sql-")),
      "agent.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // The database may still be held open; cleanup is best effort.
      }
    })
)

/**
 * One process: its own engine, its own client, its own model script. Built
 * into the enclosing scope, so closing that scope is the process dying.
 */
const process_ = (
  file: string,
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  /**
   * Break the session store this process sees, leaving the shared database
   * intact. The next process reads the same rows through a healthy store,
   * which is what makes a fault here a *partial* failure rather than a broken
   * fixture.
   */
  breakSessionStore?: (
    store: DurableSessionStore.DurableSessionStore
  ) => DurableSessionStore.DurableSessionStore,
  /**
   * Called with each activity's name as this process runs it, *after* the
   * activity has recorded its result.
   *
   * `activityExecute` is the single point every activity passes through, so a
   * decorator here sees every journalled boundary without the workflow bodies
   * knowing anything about it. It exists for SD3's crash-point sweep: a test
   * can kill this process at a boundary it never had to name in advance, so a
   * boundary added later is covered without anyone extending a list.
   *
   * That sweep is not written, and the note in
   * `docs/plan-durability-hardening.md` says why: a runner killed mid-activity
   * did not resume at all in this fixture. The seam is kept because it is what
   * found that out.
   */
  onActivity?: (name: string) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
    const built = yield* Effect.all({
      store: DurableChannels.sqlStoreWithTable(),
      sessionStore: DurableSessionStore.sqlStoreWithTables(),
      delivery: DeliveryLog.sqlLogWithTable()
    }).pipe(Effect.provide(sql))
    const stores = breakSessionStore === undefined
      ? built
      : { ...built, sessionStore: breakSessionStore(built.sessionStore) }
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const runtime = yield* Layer.build(
      DurableAgentClient.layer("SqlAgent", agent, {
        ...stores,
        pollInterval: Duration.millis(50)
      }).pipe(
        Layer.provideMerge(
          onActivity === undefined
            ? engineFor(file, 1)
            : Layer.effect(
              WorkflowEngine.WorkflowEngine,
              Effect.map(WorkflowEngine.WorkflowEngine, (inner) => ({
                ...inner,
                activityExecute: (activity, attempt) =>
                  Effect.tap(
                    inner.activityExecute(activity, attempt),
                    () => onActivity(activity.name)
                  )
              }))
            ).pipe(Layer.provideMerge(engineFor(file, 1)))
        ),
        Layer.provideMerge(model)
      )
    )
    const client = yield* Effect.service(AgentClient.AgentClient).pipe(
      Effect.provide(runtime)
    )
    return { ...stores, client, recorder }
  })

const until = <A, E>(
  observation: Effect.Effect<A, E>,
  predicate: (value: A) => boolean
): Effect.Effect<A, E> =>
  Effect.repeat(observation, {
    until: predicate,
    schedule: Schedule.spaced(Duration.millis(50))
  })

const Wipe = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

describe("DurableAgentClient on SQL storage", () => {
  it.live(
    "after process loss a replayed turn's text arrives as one delta, a new turn's streams live, and the model is called once per turn",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const agent = Agent.make({
          toolkit: Agent.toolkit([Wipe], { wipe: () => Effect.succeed("wiped") }),
          loop: AgentLoop.bounded(4)
        })

        // ---- Process A: stream turn 1 live, park on approval, vanish -------
        const { requestId, live } = yield* Effect.gen(function* () {
          const a = yield* process_(file, agent, [
            { text: "thinking", chunks: ["thin", "king"], toolCalls: [{ id: "w1", name: "wipe", params: {} }] }
          ])
          const session = yield* Effect.scoped(a.client.createSession({ sessionId: "replay-stream" }))
          yield* Effect.forkDetach(session.prompt("wipe it", { stream: true }))
          const waiting = yield* until(session.pending, (p) => p.length > 0)
          // Poll the delivery log until turn 1's two streamed chunks have
          // landed, rather than sleeping a fixed interval and reading once.
          const recorded = yield* until(
            a.delivery.read("replay-stream"),
            (events) => events.filter((e) => e.event._tag === "MessageDelta").length >= 2
          )
          return {
            requestId: waiting[0]!.id,
            live: recorded.flatMap((e) => (e.event._tag === "MessageDelta" ? [e.event.delta] : []))
          }
        }).pipe(Effect.scoped)
        // Turn 1 streamed live, chunk by chunk, into the shared log.
        assert.deepStrictEqual(live, ["thin", "king"])

        yield* Effect.sleep(Duration.seconds(2))

        // ---- Process B: replay turn 1 from the journal, stream turn 2 live -
        yield* Effect.gen(function* () {
          const b = yield* process_(file, agent, [
            { text: "all done", chunks: ["all ", "done"] }
          ])
          const session = yield* b.client.session("replay-stream")
          assert.isTrue(yield* session.respond({ id: requestId, granted: true }))
          yield* until(session.status, (status) => status === "idle")
          // B's model answered turn 2 only: turn 1 came from the journal.
          assert.strictEqual(yield* b.recorder.calls, 1)
          const recorded = yield* b.delivery.read("replay-stream")
          const deltas = recorded.flatMap((e) => (e.event._tag === "MessageDelta" ? [e.event.delta] : []))
          // Turn 1's live chunks were recorded by A under their keys; B's
          // replay re-offered turn 1 as one lump, which the keyed log did
          // not duplicate; turn 2 streamed live from B.
          assert.deepStrictEqual(deltas, ["thin", "king", "all ", "done"])
          assert.strictEqual(
            (yield* session.history).content.filter((m) => m.role === "assistant").length,
            2
          )
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "a session parked for approval in a lost runner is answered and finished from another",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const wiped = yield* Ref.make(0)
        const agent = Agent.make({
          instructions: "Ask before wiping.",
          toolkit: Agent.toolkit([Wipe], {
            wipe: () => Ref.update(wiped, (n) => n + 1).pipe(Effect.as("wiped"))
          }),
          loop: AgentLoop.bounded(4)
        })

        // ---- Process A: start the prompt, reach the approval, vanish --------
        const requestId = yield* Effect.gen(function* () {
          const a = yield* process_(file, agent, [
            { toolCalls: [{ id: "w1", name: "wipe", params: {} }] }
          ])
          const session = yield* Effect.scoped(
            a.client.createSession({ sessionId: "customer-123" })
          )
          yield* Effect.forkDetach(session.prompt("wipe it"))
          const waiting = yield* until(session.pending, (p) => p.length > 0)
          // The request is projected before the workflow suspends; give the
          // suspension itself time to reach the journal. Tearing the runner
          // down earlier interrupts a live execution rather than losing a
          // parked one, which is a different (and already tested) event.
          yield* Effect.sleep(Duration.millis(500))
          return waiting[0]!.id
        }).pipe(Effect.scoped)

        // Process A is gone; its shard lock outlives it briefly.
        yield* Effect.sleep(Duration.seconds(2))

        // ---- Process B: a different runner, a different client -------------
        yield* Effect.gen(function* () {
          const b = yield* process_(file, agent, [
            { text: "wiped, as asked" },
            { text: "and that too" }
          ])
          const session = yield* b.client.session("customer-123")

          // What A projected is what B sees: the session is still running,
          // still waiting on the same question.
          assert.strictEqual(yield* session.status, "running")
          assert.deepStrictEqual(
            (yield* session.pending).map((r) => [r.id, r.kind]),
            [[requestId, "tool-approval"]]
          )

          assert.isTrue(yield* session.respond({ id: requestId, granted: true }))
          assert.strictEqual(
            yield* until(session.status, (status) => status === "idle"),
            "idle"
          )

          // Turn 1 was journalled under A and replayed under B; the tool ran
          // once; B's model made only turn 2's call.
          assert.strictEqual(yield* Ref.get(wiped), 1)
          assert.strictEqual(yield* b.recorder.calls, 1)
          const history = yield* session.history
          assert.deepStrictEqual(
            history.content.map((m) => m.role),
            ["system", "user", "assistant", "tool", "assistant"]
          )

          // The conversation continues on the same logical session.
          const next = yield* session.prompt("now the other one")
          assert.strictEqual(next.text, "and that too")
          assert.deepStrictEqual(
            TestLanguageModel.userTexts(yield* session.history),
            ["wipe it", "now the other one"]
          )

          // Delivery survived the process boundary with one offset space and
          // nothing duplicated across the replay.
          const events = yield* b.delivery.read("customer-123")
          assert.deepStrictEqual(
            events.map((e) => e.sequence),
            events.map((_, i) => i + 1)
          )
          const tags = events.map((e) => e.event._tag)
          assert.strictEqual(tags.filter((t) => t === "ElicitationRequested").length, 1)
          assert.strictEqual(tags.filter((t) => t === "ElicitationResolved").length, 1)
          assert.strictEqual(tags.filter((t) => t === "ToolCallSucceeded").length, 1)
          assert.strictEqual(tags.filter((t) => t === "SubmissionCompleted").length, 2)
          assert.notInclude(tags, "SubmissionInterrupted")
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "a claim left undispatched by a lost process is carried out by the next one",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const agent = Agent.make({ loop: AgentLoop.bounded(4) })

        // Process A: claims (the store records the request) and dies before
        // dispatching anything. Nothing ever reached an engine.
        yield* Effect.gen(function* () {
          const a = yield* process_(file, agent, [])
          yield* Effect.scoped(
            Effect.asVoid(a.client.createSession({ sessionId: "claimed" }))
          )
          const outcome = yield* a.sessionStore.claim("claimed", {
            prompt: Prompt.make("do it"),
            stream: false
          })
          assert.strictEqual(outcome._tag, "Claimed")
        }).pipe(Effect.scoped)

        yield* Effect.sleep(Duration.seconds(2))

        // Process B reacquires the session: the recorded claim is dispatched
        // exactly once, and the session settles.
        yield* Effect.gen(function* () {
          const b = yield* process_(file, agent, [{ text: "carried out" }])
          const session = yield* b.client.session("claimed")
          assert.strictEqual(
            yield* until(session.status, (status) => status === "idle"),
            "idle"
          )
          assert.deepStrictEqual(
            TestLanguageModel.userTexts(yield* session.history),
            ["do it"]
          )
          assert.strictEqual(
            (yield* session.history).content.map((m) => m.role).at(-1),
            "assistant"
          )
          // Reacquiring again dispatches nothing new.
          yield* b.client.session("claimed")
          yield* Effect.sleep(Duration.millis(300))
          assert.strictEqual(yield* b.recorder.calls, 1)
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live(
    "two processes racing for one idle session agree on a single winner",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const agent = Agent.make({ loop: AgentLoop.bounded(4) })

        // Whichever runner owns the shard executes, so both carry the same
        // script; the claim race is between two clients over the same rows,
        // which is where SQL has to hold the invariant.
        const a = yield* process_(file, agent, [{ text: "won" }])
        const b = yield* process_(file, agent, [{ text: "won" }])
        yield* Effect.scoped(
          Effect.asVoid(a.client.createSession({ sessionId: "race" }))
        )

        const attempt = (client: AgentClient.Service) =>
          Effect.flatMap(client.session("race"), (session) =>
            Effect.result(session.prompt("go"))
          )
        const outcomes = yield* Effect.all([attempt(a.client), attempt(b.client)], {
          concurrency: "unbounded"
        })
        const accepted = outcomes.filter((o) => o._tag === "Success")
        const refused = outcomes.flatMap((o) =>
          o._tag === "Failure" ? [o.failure._tag] : []
        )
        assert.strictEqual(accepted.length, 1)
        assert.deepStrictEqual(refused, ["AgentBusyError"])
        assert.strictEqual(
          accepted[0]?._tag === "Success" ? accepted[0].success.text : "",
          "won"
        )

        const history = yield* Effect.flatMap(b.client.session("race"), (s) => s.history)
        assert.deepStrictEqual(
          history.content.map((m) => m.role),
          ["user", "assistant"]
        )
        // Once the session is idle it is reusable from either process, but
        // the race itself produced one submission.
        const record = yield* b.sessionStore.get("race")
        assert.strictEqual(record._tag === "Some" ? record.value.submissionCount : 0, 1)
      }).pipe(Effect.scoped),
    30_000
  )

  it.live("a claim whose execution ended without its finish is freed on reacquisition (R173)", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase
      const agent = Agent.make({
        toolkit: Agent.toolkit([], {}),
        loop: AgentLoop.bounded(2)
      })

      /**
       * R173 -- the wedge, and why it had no exit.
       *
       * `finishProjection` clears the admission and interrupt channels and
       * then finishes the claim. Those are two stores, so they are one
       * `Activity` but not one transaction. Here the clear succeeds and the
       * finish cannot: the catch path retries it, fails the same way, and the
       * workflow ends terminally with the claim still `running`.
       *
       * Admission is closed and nothing is executing, so every later prompt
       * was refused as `Busy` -- forever. Reconciliation looked only for a
       * claim that had never been dispatched, and this one had.
       *
       * The failure is injected into *this process's* view of the store, not
       * into the database, so process B below reads the same rows through a
       * healthy store. That is what makes this a partial failure rather than
       * a broken fixture.
       */
      yield* Effect.gen(function* () {
        const a = yield* process_(file, agent, [{ text: "done" }], (store) => ({
          ...store,
          finish: () =>
            Effect.fail(
              new StorageError({ operation: "finish", detail: "the disk is on fire" })
            )
        }))
        const session = yield* Effect.scoped(
          a.client.createSession({ sessionId: "wedged" })
        )
        // The prompt fails: the caller is told, which is the other half of
        // D7. `exit` rather than `ignore`, because a `StorageError` escaping
        // the workflow body cannot be encoded as the declared
        // `DurableAgentFailure` and reaches the caller as a defect.
        const attempt = yield* Effect.exit(session.prompt("go"))
        assert.isTrue(Exit.isFailure(attempt))

        // The claim is stranded -- running, dispatched, and nothing to run it.
        const stranded = yield* until(
          a.sessionStore.get("wedged"),
          (found) =>
            Option.isSome(found) &&
            Option.isSome(found.value.claim) &&
            found.value.claim.value.executionId !== undefined
        )
        assert.isTrue(Option.isSome(stranded))
        if (Option.isSome(stranded)) {
          assert.strictEqual(stranded.value.status, "running")
        }
      }).pipe(Effect.scoped)

      // ---- Process B: a healthy store over the same database --------------
      yield* Effect.gen(function* () {
        const b = yield* process_(file, agent, [{ text: "second" }])
        // Acquiring reconciles: the execution is over, so the claim is freed.
        const session = yield* b.client.session("wedged")
        assert.strictEqual(yield* session.status, "idle")

        // And the session is usable again, which is the point of freeing it.
        const answer = yield* session.prompt("again")
        assert.strictEqual(answer.text, "second")
      }).pipe(Effect.scoped)
    })
  )

})
