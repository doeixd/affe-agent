import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema
} from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"
import * as Contract from "./AgentClientContract.js"

/**
 * The durable interpreter is judged by the same contract the local one passes
 * — that is the point of `AgentClientContract`. What remains here is what the
 * contract cannot express: two clients sharing stores stand in for two
 * processes; a handle whose scope closed while its work continued; a process
 * that died between persisting intent and acting on it.
 *
 * Everything runs on the in-memory TestRunner engine and stores; the SQL
 * suite repeats the headline cases over a real journal and a runner that
 * disappears.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/**
 * The contract's `elicitation` option is deliberately unused: the durable
 * interpreter builds its own store-projected elicitation, which the contract's
 * HITL test exercises end to end through `pending` / `respond`.
 */
const harness: Contract.Harness = {
  name: "durable-memory",
  layer: ({ agent, turns }) =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const { layer: model } = yield* FakeModel.script(turns)
      return DurableAgentClient.layer("TestAgent", agent, {
        store,
        sessionStore,
        delivery
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))
    })
}

Contract.run(harness)

// -- Fixtures ----------------------------------------------------------------------

/**
 * One durable runtime and any number of client "processes" over it.
 *
 * The runtime is the part a real deployment would run on every node: the
 * engine, the workflow registration, the model. Here it is built once per
 * test and lives for the test, because `TestRunner` keeps its journal in
 * memory — two engine instances would be two clusters that cannot see each
 * other's executions, and the engine ignores a second registration of a
 * workflow it already has.
 *
 * A client process is then what the architecture says it is: an
 * `AgentClient` layer with no memory of its own, sharing only the stores and
 * the engine. `another` builds one; it registers nothing new and holds no
 * model, which is exactly the point — it can only reach the session through
 * durable state. Genuine process loss (a runner dying, another taking its
 * shards) is the SQL suite's job.
 */
const fixture = (
  // `any` requirements: the workflow body supplies the engine context, which
  // an agent that suspends on a durable gate (the replay test) needs.
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  delivery?: DeliveryLog.DeliveryLog
) =>
  Effect.gen(function* () {
    const store = yield* DurableChannels.memoryStore
    const sessionStore = yield* DurableSessionStore.memoryStore
    const log = delivery ?? (yield* DeliveryLog.memoryLog)
    const shared = { store, sessionStore, delivery: log }
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const runtime = yield* Layer.build(
      DurableAgentClient.layer("SharedAgent", agent, shared).pipe(
        Layer.provideMerge(Engine),
        Layer.provideMerge(model)
      )
    )
    const engine = Layer.succeedContext(runtime)
    /** The client living in the runtime's own process. */
    const client: Layer.Layer<
      AgentClient.AgentClient | WorkflowEngine.WorkflowEngine
    > = engine
    /** A client in another process: nothing in common but stores and engine. */
    const another: Layer.Layer<
      AgentClient.AgentClient | WorkflowEngine.WorkflowEngine
    > = DurableAgentClient.layer("SharedAgent", agent, shared).pipe(
      Layer.provideMerge(engine)
    )
    return { ...shared, recorder, client, another }
  })

/** Run `use` against the client service of `layer`. */
const using = <A, E>(
  layer: Layer.Layer<AgentClient.AgentClient | WorkflowEngine.WorkflowEngine>,
  use: (
    client: AgentClient.Service
  ) => Effect.Effect<A, E, AgentClient.AgentClient | WorkflowEngine.WorkflowEngine>
) =>
  Effect.flatMap(Effect.service(AgentClient.AgentClient), use).pipe(
    Effect.provide(layer)
  )

/**
 * Poll a remote observation until it satisfies `predicate`.
 *
 * Polling is what a transport has: there is nothing underneath to wait on.
 */
const until = <A, E>(
  observation: Effect.Effect<A, E>,
  predicate: (value: A) => boolean
): Effect.Effect<A, E> =>
  Effect.repeat(observation, {
    until: predicate,
    schedule: Schedule.spaced(Duration.millis(5))
  })

const roles = (prompt: { readonly content: ReadonlyArray<{ readonly role: string }> }) =>
  prompt.content.map((message) => message.role)

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const Boom = Tool.make("boom", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Schema.String
})

const Wipe = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

/** A delivery log that counts how each append was disposed of. */
const auditedLog = (underlying: DeliveryLog.DeliveryLog) =>
  Effect.map(
    Ref.make({ appended: 0, duplicate: 0, conflict: 0 }),
    (counts) => ({
      counts: Ref.get(counts),
      log: {
        ...underlying,
        append: (sessionId: string, key: string, envelope: Parameters<DeliveryLog.DeliveryLog["append"]>[2]) =>
          Effect.tap(underlying.append(sessionId, key, envelope), (outcome) =>
            Ref.update(counts, (current) =>
              outcome._tag === "Appended"
                ? { ...current, appended: current.appended + 1 }
                : outcome._tag === "Duplicate"
                  ? { ...current, duplicate: current.duplicate + 1 }
                  : { ...current, conflict: current.conflict + 1 }
            )
          )
      } satisfies DeliveryLog.DeliveryLog
    })
  )


describe("DurableAgentClient (durability specifics)", () => {
  it.live("reacquires a session another client instance created", () =>
    Effect.gen(function* () {
      const f = yield* fixture(Agent.make({ instructions: "Remember things." }), [
        { text: "noted" }
      ])

      yield* using(f.client, (client) =>
        Effect.scoped(
          Effect.flatMap(client.createSession({ sessionId: "shared-1" }), (s) =>
            s.prompt("remember this")
          )
        )
      )

      // A fresh client, no shared memory beyond the stores.
      const status = yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("shared-1")
          assert.deepStrictEqual(roles(yield* session.history), [
            "system",
            "user",
            "assistant"
          ])
          return yield* session.status
        })
      )
      assert.strictEqual(status, "idle")

      // Ids allocated without a name cannot collide across processes: the
      // local counter's `session-1` would be the same conversation twice.
      const allocated = yield* Effect.forEach([f.client, f.another], (layer) =>
        using(layer, (client) =>
          Effect.scoped(Effect.map(client.createSession(), (s) => s.id))
        )
      )
      assert.notStrictEqual(allocated[0], allocated[1])
      assert.notMatch(allocated[0]!, /^session-\d+$/)

      // And one that was never created is honestly absent, not conjured.
      const missing = yield* using(f.another, (client) =>
        Effect.flip(client.session("nobody"))
      )
      assert.strictEqual(missing._tag, "AgentSessionNotFoundError")
    }).pipe(Effect.scoped)
  )

  it.live("a sequential prompt from another client sees the first prompt's history", () =>
    Effect.gen(function* () {
      const f = yield* fixture(Agent.make({ instructions: "Be brief." }), [
        { text: "first" },
        { text: "second" }
      ])

      yield* using(f.client, (client) =>
        Effect.scoped(
          Effect.flatMap(client.createSession({ sessionId: "seq" }), (s) =>
            s.prompt("remember X")
          )
        )
      )
      const result = yield* using(f.another, (client) =>
        Effect.flatMap(client.session("seq"), (s) => s.prompt("what was X?"))
      )
      assert.strictEqual(result.text, "second")

      // The second submission's model call received the canonical transcript
      // of the first — system, user, assistant — ahead of its own prompt.
      const prompts = yield* f.recorder.prompts
      assert.deepStrictEqual(roles(prompts[1]!), [
        "system",
        "user",
        "assistant",
        "user"
      ])
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[1]!), [
        "remember X",
        "what was X?"
      ])
    }).pipe(Effect.scoped)
  )

  it.live("the initiating caller going away does not stop the submission", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(4) }), [
        { text: "done", started: entered, during: Deferred.await(release) }
      ])

      // The handle's scope closes at once; the prompt is forked and then its
      // fibre is interrupted mid-model-call — the initiator is gone.
      const initiator = yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "orphan" })
          )
          return yield* Effect.forkDetach(session.prompt("go"))
        })
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(initiator)
      assert.strictEqual(
        yield* using(f.another, (c) =>
          Effect.flatMap(c.session("orphan"), (s) => s.status)
        ),
        "running"
      )

      // The workflow is still there. Letting the model finish completes it,
      // and the projection commits with nobody awaiting the result.
      yield* Deferred.succeed(release, void 0)
      yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("orphan")
          assert.strictEqual(
            yield* until(session.status, (status) => status === "idle"),
            "idle"
          )
          assert.deepStrictEqual(roles(yield* session.history), [
            "user",
            "assistant"
          ])
          // Terminal events were delivered by the workflow, not the caller.
          const events = yield* f.delivery.read("orphan")
          assert.strictEqual(
            events[events.length - 1]?.event._tag,
            "SubmissionCompleted"
          )
        })
      )
    }).pipe(Effect.scoped)
  )

  it.live("two clients racing for one idle session: exactly one is accepted", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(4) }), [
        { text: "won", during: Deferred.await(release) }
      ])

      yield* using(f.client, (client) =>
        Effect.scoped(Effect.asVoid(client.createSession({ sessionId: "race" })))
      )
      const attempt = (
        layer: Layer.Layer<AgentClient.AgentClient | WorkflowEngine.WorkflowEngine>
      ) =>
        using(layer, (client) =>
          Effect.flatMap(client.session("race"), (session) =>
            Effect.result(session.prompt("go"))
          )
        )
      const racing = yield* Effect.forkChild(
        Effect.all([attempt(f.client), attempt(f.another)], {
          concurrency: "unbounded"
        })
      )
      // Both reach the claim before the winner's model call is released.
      yield* until(
        using(f.client, (c) => Effect.flatMap(c.session("race"), (s) => s.status)),
        (status) => status === "running"
      )
      yield* Deferred.succeed(release, void 0)
      const outcomes = yield* Fiber.join(racing)

      const accepted = outcomes.filter((o) => o._tag === "Success")
      const refused = outcomes.flatMap((o) =>
        o._tag === "Failure" ? [o.failure] : []
      )
      assert.strictEqual(accepted.length, 1, "exactly one prompt is accepted")
      assert.strictEqual(refused.length, 1, "the other is refused")
      assert.strictEqual(refused[0]!._tag, "AgentBusyError")
      // One submission, one user message: nothing coalesced, nothing dropped.
      const history = yield* using(f.another, (c) =>
        Effect.flatMap(c.session("race"), (s) => s.history)
      )
      assert.deepStrictEqual(roles(history), ["user", "assistant"])
      assert.strictEqual(yield* f.recorder.calls, 1)
    }).pipe(Effect.scoped)
  )

  it.live("steering and follow-up arrive from a client other than the initiator", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Search], {
            search: ({ query }) => Effect.succeed(`hits for ${query}`)
          }),
          loop: AgentLoop.bounded(6)
        }),
        [
          {
            toolCalls: [{ id: "s1", name: "search", params: { query: "a" } }],
            started: entered,
            during: Deferred.await(release)
          },
          { text: "steered" },
          { text: "followed" }
        ]
      )

      const running = yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "multi" })
          )
          return yield* Effect.forkDetach(session.prompt("go"))
        })
      )
      yield* Deferred.await(entered)

      yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("multi")
          yield* session.steer("go left")
          yield* session.followUp("then also this")
        })
      )
      yield* Deferred.succeed(release, void 0)

      const result = yield* Fiber.join(running)
      assert.strictEqual(result.runs, 2)
      assert.strictEqual(result.text, "followed")
      const history = yield* using(f.another, (c) =>
        Effect.flatMap(c.session("multi"), (s) => s.history)
      )
      assert.deepStrictEqual(TestLanguageModel.userTexts(history), [
        "go",
        "go left",
        "then also this"
      ])
    }).pipe(Effect.scoped)
  )

  it.live("a failed submission keeps committed turns and leaves the session idle", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Boom], { boom: () => Effect.fail("declined") }),
          toolFailurePolicy: ToolExecution.FailRun,
          loop: AgentLoop.bounded(4)
        }),
        [
          { text: "turn one" },
          TestLanguageModel.toolCall("boom", {}, { id: "b1" }),
          { text: "still here" }
        ]
      )

      yield* using(f.client, (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "fail" })
            yield* session.prompt("one")
            const failed = yield* Effect.flip(session.prompt("two"))
            assert.strictEqual(failed._tag, "AgentExecutionError")
            if (failed._tag === "AgentExecutionError") {
              assert.include(failed.detail, "declined")
            }
            assert.strictEqual(yield* session.status, "idle")
            // The failed submission's user message and nothing partial after
            // it — exactly what a local session commits.
            assert.deepStrictEqual(roles(yield* session.history), [
              "user",
              "assistant",
              "user"
            ])
          })
        )
      )

      const result = yield* using(f.another, (client) =>
        Effect.flatMap(client.session("fail"), (s) => s.prompt("three"))
      )
      assert.strictEqual(result.text, "still here")
      const prompts = yield* f.recorder.prompts
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[2]!), [
        "one",
        "two",
        "three"
      ])
    }).pipe(Effect.scoped)
  )

  it.live("interrupt from another client commits nothing partial and frees the session", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(4) }), [
        { text: "unused", hang: true, started: entered },
        { text: "after" }
      ])

      const running = yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "int" })
          )
          return yield* Effect.forkDetach(session.prompt("go"))
        })
      )
      yield* Deferred.await(entered)

      yield* using(f.another, (client) =>
        Effect.flatMap(client.session("int"), (s) => s.interrupt())
      )
      const result = yield* Fiber.join(running)
      assert.strictEqual(result.status, "interrupted")

      const next = yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("int")
          assert.strictEqual(yield* session.status, "idle")
          assert.deepStrictEqual(roles(yield* session.history), ["user"])
          // A stale interrupt is refused, not applied to the next prompt.
          const idle = yield* Effect.flip(session.interrupt())
          assert.strictEqual(idle._tag, "AgentIdleError")
          return yield* session.prompt("try again")
        })
      )
      assert.strictEqual(next.text, "after")
      assert.strictEqual(next.status, "completed")
    }).pipe(Effect.scoped)
  )

  it.live("a claim whose dispatch never happened is dispatched on reacquisition", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        Agent.make({ instructions: "Finish what was started." }),
        [{ text: "finished" }]
      )

      // A process died between claiming and dispatching: only the store
      // knows a prompt was accepted.
      yield* using(f.client, (client) =>
        Effect.scoped(Effect.asVoid(client.createSession({ sessionId: "crash" })))
      )
      const claimed = yield* f.sessionStore.claim("crash", {
        prompt: Prompt.make("do it"),
        stream: false
      })
      assert.strictEqual(claimed._tag, "Claimed")

      yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("crash")
          // Busy, not wedged: the claim is live and being carried forward.
          const busy = yield* Effect.flip(session.prompt("again"))
          assert.strictEqual(busy._tag, "AgentBusyError")

          assert.strictEqual(
            yield* until(session.status, (status) => status === "idle"),
            "idle"
          )
          assert.deepStrictEqual(roles(yield* session.history), [
            "system",
            "user",
            "assistant"
          ])
          assert.deepStrictEqual(
            TestLanguageModel.userTexts(yield* session.history),
            ["do it"]
          )
        })
      )
      // Reacquiring again re-dispatches nothing: one model call ever.
      yield* using(f.another, (client) => client.session("crash"))
      assert.strictEqual(yield* f.recorder.calls, 1)
    }).pipe(Effect.scoped)
  )

  it.live("approval asked through one client is answered through another", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Wipe], {
            wipe: () => Ref.update(wiped, (n) => n + 1).pipe(Effect.as("wiped"))
          }),
          loop: AgentLoop.bounded(4)
        }),
        [
          { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
          { text: "done" }
        ]
      )

      const running = yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "hitl" })
          )
          return yield* Effect.forkDetach(session.prompt("go"))
        })
      )

      yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("hitl")
          const waiting = yield* until(session.pending, (p) => p.length > 0)
          assert.strictEqual(waiting[0]!.kind, "tool-approval")
          // Paused for a human is still running, never idle.
          assert.strictEqual(yield* session.status, "running")
          assert.isTrue(
            yield* session.respond({ id: waiting[0]!.id, granted: true })
          )
          // Answered once; a second answer finds nothing waiting.
          assert.isFalse(
            yield* session.respond({ id: waiting[0]!.id, granted: true })
          )
        })
      )

      const result = yield* Fiber.join(running)
      assert.strictEqual(result.text, "done")
      assert.strictEqual(yield* Ref.get(wiped), 1)
      assert.deepStrictEqual(
        yield* using(f.another, (c) =>
          Effect.flatMap(c.session("hitl"), (s) => s.pending)
        ),
        []
      )
      // The parked interval left no spurious terminal events behind.
      const tags = (yield* f.delivery.read("hitl")).map((e) => e.event._tag)
      assert.deepStrictEqual(
        tags.filter((t) => t.startsWith("Submission") || t.startsWith("Run")),
        ["SubmissionStarted", "RunStarted", "RunCompleted", "SubmissionCompleted"]
      )
      assert.include(tags, "ElicitationRequested")
      assert.include(tags, "ElicitationResolved")
    }).pipe(Effect.scoped)
  )

  it.live("interrupting a submission parked on an approval ends it without running the tool", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Wipe], {
            wipe: () => Ref.update(wiped, (n) => n + 1).pipe(Effect.as("wiped"))
          }),
          loop: AgentLoop.bounded(4)
        }),
        // The resumed execution replays turn 1 from the journal and is
        // interrupted before any further call, so the next script entry
        // belongs to the next prompt.
        [
          { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
          { text: "after" }
        ]
      )

      const running = yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "parked" })
          )
          return yield* Effect.forkDetach(session.prompt("go"))
        })
      )
      yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("parked")
          yield* until(session.pending, (p) => p.length > 0)
          // Nothing is executing: the workflow is suspended. Interrupt must
          // still take effect now, not when someone happens to answer.
          yield* session.interrupt()
        })
      )
      const result = yield* Fiber.join(running)
      assert.strictEqual(result.status, "interrupted")
      assert.strictEqual(yield* Ref.get(wiped), 0)

      yield* using(f.another, (client) =>
        Effect.gen(function* () {
          const session = yield* client.session("parked")
          assert.strictEqual(yield* session.status, "idle")
          assert.deepStrictEqual(yield* session.pending, [])
          assert.deepStrictEqual(roles(yield* session.history), ["user"])
          assert.strictEqual((yield* session.prompt("again")).text, "after")
          // One real model call for turn 1, one for the next prompt; the
          // resumption replayed rather than re-issued, and the denial that
          // woke the run never reached the model.
          assert.strictEqual(yield* f.recorder.calls, 2)
        })
      )
    }).pipe(Effect.scoped)
  )

  it.live("an answer recorded by a process that then died is delivered on reacquisition", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Wipe], { wipe: () => Effect.succeed("wiped") }),
          loop: AgentLoop.bounded(4)
        }),
        [
          { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
          { text: "done" }
        ]
      )

      const running = yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "late" })
          )
          return yield* Effect.forkDetach(session.prompt("go"))
        })
      )
      const waiting = yield* until(
        f.sessionStore.pendingRequests("late"),
        (p) => p.length > 0
      )

      // The answering process persisted the answer and died before waking
      // the workflow: the store says "answered", nothing was delivered.
      assert.isTrue(
        yield* f.sessionStore.answerRequest("late", {
          id: waiting[0]!.id,
          granted: true
        })
      )
      assert.deepStrictEqual(yield* f.sessionStore.pendingRequests("late"), [])

      // Any later reacquisition finishes the delivery.
      yield* using(f.another, (client) => client.session("late"))
      const result = yield* Fiber.join(running)
      assert.strictEqual(result.text, "done")
      assert.deepStrictEqual(yield* f.sessionStore.recordedAnswers("late"), [])
    }).pipe(Effect.scoped)
  )

  it.live("admission is closed before the session goes idle, never after", () =>
    Effect.gen(function* () {
      // The marker is per session. If a submission cleared it *after* its
      // terminal projection, the next submission — claimed and opened in
      // that gap by another client — would have its admission wiped and
      // refuse steering while running. Observed at the store: at the moment
      // `finish` is called, the marker must already be gone.
      const store = yield* DurableChannels.memoryStore
      const base = yield* DurableSessionStore.memoryStore
      const observed = yield* Ref.make<Array<number>>([])
      const sessionStore: DurableSessionStore.DurableSessionStore = {
        ...base,
        finish: (sessionId, submissionId, history) =>
          Effect.flatMap(store.size(DurableChannels.openKey(sessionId)), (open) =>
            Ref.update(observed, (all) => [...all, open]).pipe(
              Effect.andThen(base.finish(sessionId, submissionId, history))
            )
          )
      }
      const agent = Agent.make({
        toolkit: Agent.toolkit([Boom], { boom: () => Effect.fail("declined") }),
        toolFailurePolicy: ToolExecution.FailRun,
        loop: AgentLoop.bounded(4)
      })
      const { layer: model } = yield* FakeModel.script([
        { text: "ok" },
        TestLanguageModel.toolCall("boom", {}, { id: "b1" })
      ])
      const layer = DurableAgentClient.layer("Ordered", agent, {
        store,
        sessionStore
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

      yield* using(layer, (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "order" })
            yield* session.prompt("one")
            yield* Effect.flip(session.prompt("two"))
          })
        )
      )
      // Success and failure paths alike: closed first, then idle.
      assert.deepStrictEqual(yield* Ref.get(observed), [0, 0])
    }).pipe(Effect.scoped)
  )

  it.live("a stale answer from a previous submission cannot approve the next one", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Wipe], {
            wipe: () => Ref.update(wiped, (n) => n + 1).pipe(Effect.as("wiped"))
          }),
          loop: AgentLoop.bounded(4)
        }),
        [
          { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
          { text: "one" },
          { toolCalls: [{ id: "w2", name: "wipe", params: {} }] },
          { text: "two" }
        ]
      )
      const approve = (session: AgentClient.RemoteSession) =>
        Effect.gen(function* () {
          const waiting = yield* until(session.pending, (p) => p.length > 0)
          assert.isTrue(yield* session.respond({ id: waiting[0]!.id, granted: true }))
          return waiting[0]!.id
        })

      yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "stale" })
          )
          const first = yield* Effect.forkChild(session.prompt("go"))
          const id = yield* approve(session)
          assert.strictEqual((yield* Fiber.join(first)).text, "one")

          // What a process that died between delivering the answer and
          // taking it leaves behind: the same id, already answered.
          yield* f.sessionStore.addPendingRequest("stale", {
            id,
            kind: "tool-approval",
            detail: undefined
          })
          assert.isTrue(yield* f.sessionStore.answerRequest("stale", { id, granted: true }))

          // The next submission asks under that id again. It must wait for
          // its own answer, not inherit the stale one.
          const second = yield* Effect.forkChild(
            client.session("stale").pipe(Effect.flatMap((s) => s.prompt("again")))
          )
          const secondId = yield* approve(session)
          assert.strictEqual(secondId, id)
          assert.strictEqual((yield* Fiber.join(second)).text, "two")
          assert.strictEqual(yield* Ref.get(wiped), 2)
        })
      )
    }).pipe(Effect.scoped)
  )

  it.live("a store failing under the agent is reported as transport, and the session is freed", () =>
    Effect.gen(function* () {
      // The channels store dies once, the way the SQL stores do on a busy
      // database, during the first submission's steering drain. That is not
      // the agent failing: the caller sees a transport failure it can retry,
      // and the session is idle for the retry rather than wedged behind a
      // claim on an execution the engine has already closed.
      const base = yield* DurableChannels.memoryStore
      const failOnce = yield* Ref.make(true)
      const flaky: DurableChannels.Store = {
        ...base,
        takeAll: (key) =>
          key.endsWith(":steering")
            ? Effect.flatMap(Ref.getAndSet(failOnce, false), (fail) =>
                fail
                  ? Effect.die({ _tag: "SqlError", message: "database is locked" })
                  : base.takeAll(key)
              )
            : base.takeAll(key)
      }
      const sessionStore = yield* DurableSessionStore.memoryStore
      // The failed submission never reaches the model, so one turn serves
      // the retry.
      const { layer: model } = yield* FakeModel.script([{ text: "answer" }])
      const layer = DurableAgentClient.layer("Flaky", Agent.make({}), {
        store: flaky,
        sessionStore
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

      yield* using(layer, (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "flaky" })
            const failed = yield* Effect.flip(session.prompt("one"))
            assert.strictEqual(failed._tag, "AgentTransportError")
            if (failed._tag === "AgentTransportError") {
              assert.include(failed.detail, "locked")
            }
            assert.strictEqual(yield* session.status, "idle")
            assert.strictEqual((yield* session.prompt("two")).text, "answer")
          })
        )
      )
    }).pipe(Effect.scoped)
  )

  it.live("events are delivered through the log with durable ids and a session-wide offset", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Search], {
            search: ({ query }) => Effect.succeed(`hits for ${query}`)
          }),
          loop: AgentLoop.bounded(4)
        }),
        [
          TestLanguageModel.toolCall("search", { query: "x" }, { id: "c1" }),
          { text: "first" },
          { text: "second" }
        ]
      )

      const first = yield* using(f.client, (client) =>
        Effect.scoped(
          Effect.flatMap(client.createSession({ sessionId: "log" }), (s) =>
            s.prompt("go")
          )
        )
      )
      const second = yield* using(f.another, (client) =>
        Effect.flatMap(client.session("log"), (s) => s.prompt("again"))
      )

      const events = yield* f.delivery.read("log")
      const firstTags = [
        "SubmissionStarted",
        "RunStarted",
        "TurnStarted",
        "ToolCallStarted",
        "ToolCallSucceeded",
        "TurnCompleted",
        "TurnStarted",
        "MessageCompleted",
        "TurnCompleted",
        "RunCompleted",
        "SubmissionCompleted"
      ]
      const secondTags = [
        "SubmissionStarted",
        "RunStarted",
        "TurnStarted",
        "MessageCompleted",
        "TurnCompleted",
        "RunCompleted",
        "SubmissionCompleted"
      ]
      assert.deepStrictEqual(
        events.map((e) => e.event._tag),
        [...firstTags, ...secondTags]
      )
      // One offset space for the whole session, contiguous from 1.
      assert.deepStrictEqual(
        events.map((e) => e.sequence),
        events.map((_, i) => i + 1)
      )
      // Correlated with the ids `prompt` returned, not the workflow's own.
      const submissionIds = events.map((e) =>
        Option.getOrElse(e.submissionId, () => "")
      )
      assert.deepStrictEqual(
        new Set(submissionIds.slice(0, firstTags.length)),
        new Set([first.submissionId])
      )
      assert.deepStrictEqual(
        new Set(submissionIds.slice(firstTags.length)),
        new Set([second.submissionId])
      )
      // Tool results on the wire are the encoded form.
      const succeeded = events.find((e) => e.event._tag === "ToolCallSucceeded")
      assert.isDefined(succeeded)
      if (succeeded?.event._tag === "ToolCallSucceeded") {
        assert.strictEqual(succeeded.event.result, succeeded.event.encodedResult)
      }
      // `read` resumes from an offset.
      const tail = yield* f.delivery.read("log", { after: events.length - 2 })
      assert.deepStrictEqual(
        tail.map((e) => e.event._tag),
        ["RunCompleted", "SubmissionCompleted"]
      )
    }).pipe(Effect.scoped)
  )

  it.live("a replayed submission with parallel tools appends no duplicate or conflicting events", () =>
    Effect.gen(function* () {
      const audited = yield* Effect.flatMap(DeliveryLog.memoryLog, auditedLog)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const Gate = DurableDeferred.make("ClientReplayGate", {
        success: Schema.String
      })

      // Turn 1 runs two tools in parallel; the agent then suspends on a
      // durable gate before turn 2, so resuming replays turn 1's emission.
      const suspendOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(suspendOnce, false)) {
            const token = yield* DurableDeferred.token(Gate)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(Gate)
          }
          return context.canonicalPrompt
        })
      )
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Search], {
            search: ({ query }) => Effect.succeed(`hits for ${query}`)
          }),
          contextTransform: gating,
          toolExecution: ToolExecution.Parallel,
          loop: AgentLoop.bounded(4)
        }),
        [
          {
            toolCalls: [
              { id: "p1", name: "search", params: { query: "one" } },
              { id: "p2", name: "search", params: { query: "two" } }
            ]
          },
          { text: "settled" }
        ],
        audited.log
      )

      const result = yield* using(f.client, (client) =>
        Effect.gen(function* () {
          const session = yield* Effect.scoped(
            client.createSession({ sessionId: "replay" })
          )
          const running = yield* Effect.forkChild(session.prompt("go"))
          const token = yield* Deferred.await(gateReady)
          yield* DurableDeferred.succeed(Gate, { token, value: "go" })
          return yield* Fiber.join(running)
        })
      )
      assert.strictEqual(result.text, "settled")

      const counts = yield* audited.counts
      assert.strictEqual(counts.conflict, 0, "a replay must not disagree with itself")
      assert.isTrue(counts.duplicate > 0, "the replay re-offered turn 1's events")
      const tags = (yield* f.delivery.read("replay")).map((e) => e.event._tag)
      assert.strictEqual(tags.filter((t) => t === "ToolCallStarted").length, 2)
      assert.strictEqual(tags.filter((t) => t === "ToolCallSucceeded").length, 2)
      assert.strictEqual(tags.filter((t) => t === "SubmissionStarted").length, 1)
      assert.strictEqual(tags.filter((t) => t === "SubmissionCompleted").length, 1)
      assert.strictEqual(counts.appended, tags.length)
    }).pipe(Effect.scoped)
  )
})
