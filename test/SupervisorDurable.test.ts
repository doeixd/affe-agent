import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schedule } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { Supervisor, SupervisorLedger } from "../src/sessions/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Item 138, slice 1: a supervisor that survives its own death. Its ledger
 * remembers each child's in-flight submission, which children finished, and
 * the restart history; `remoteTask` is the child that asks a session through
 * an `AgentClient` and waits on the recorded submission rather than asking
 * again.
 *
 * A supervisor's death is simulated by what it leaves behind: a ledger
 * recording a submission already under way, as the dead one would have
 * recorded it before waiting.
 */

/** An in-process client over a scripted model that counts its calls. */
const clientWith = (answers: ReadonlyArray<string>, calls: Ref.Ref<number>) =>
  Effect.map(TestLanguageModel.script(answers.map((text) => TestLanguageModel.text(text))), ({ layer }) =>
    AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(
      Layer.provide(TestLanguageModel.counting(layer, calls))
    ))

describe("Supervisor.remoteTask with a ledger (item 138)", () => {
  it.effect("without a ledger, a remote task submits, waits, and exits normally", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const layer = yield* clientWith(["done"], calls)
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession()
        const report = yield* Supervisor.run({
          name: "plain",
          children: [Supervisor.remoteTask("a", { session: client.session(session.id), prompt: "go" })]
        })
        assert.deepStrictEqual(report.children, [{ id: "a", starts: 1 }])
        assert.strictEqual(yield* Ref.get(calls), 1)
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.effect("a restarted supervisor waits on the submission its predecessor recorded, and does not ask again", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const layer = yield* clientWith(["the first life's answer", "a second, unwanted answer"], calls)
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession()
        const ledger = yield* SupervisorLedger.memory
        // What the dead supervisor left: attempt 1, submitted and recorded.
        const receipt = yield* session.submit("go")
        yield* ledger.update("durable", "a", () => ({
          attempts: 1,
          current: Option.some({ attempt: 1, submissionId: Option.some(receipt.submissionId) }),
          finished: false
        }))
        const report = yield* Supervisor.run({
          name: "durable",
          ledger,
          children: [Supervisor.remoteTask("a", { session: client.session(session.id), prompt: "go" })]
        })
        assert.deepStrictEqual(report.children, [{ id: "a", starts: 1 }])
        assert.strictEqual(yield* Ref.get(calls), 1, "the child's prompt was submitted a second time")
        // The life finished, so it leaves nothing to resume.
        assert.deepStrictEqual(yield* ledger.child("durable", "a"), SupervisorLedger.empty)
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.effect("a fresh attempt is counted and recorded before its wait", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const layer = yield* clientWith(["done"], calls)
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession()
        const ledger = yield* SupervisorLedger.memory
        const seen = yield* Ref.make<ReadonlyArray<SupervisorLedger.ChildRecord>>([])
        // Watches the ledger as the child writes to it.
        const watched: SupervisorLedger.SupervisorLedger = {
          ...ledger,
          update: (supervisor, id, f) =>
            Effect.tap(ledger.update(supervisor, id, f), (record) => Ref.update(seen, (all) => [...all, record]))
        }
        yield* Supervisor.run({
          name: "counted",
          ledger: watched,
          children: [Supervisor.remoteTask("a", { session: client.session(session.id), prompt: "go" })]
        })
        const writes = yield* Ref.get(seen)
        const submitted = (r: SupervisorLedger.ChildRecord) =>
          Option.isSome(r.current) && Option.isSome(r.current.value.submissionId)
        assert.deepStrictEqual(writes.map((r) => [r.attempts, Option.isSome(r.current), submitted(r), r.finished]), [
          [1, true, false, false], // the attempt is opened, before anything is submitted
          [1, true, true, false], // its submission is recorded before the wait
          [1, false, false, true], // it finished
          [0, false, false, false] // and the life that ended forgets it
        ])
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.effect("a child a previous life saw finish is not run again, unless it is permanent", () =>
    Effect.gen(function*() {
      const ledger = yield* SupervisorLedger.memory
      yield* ledger.update("done-before", "a", (r) => ({ ...r, attempts: 1, finished: true }))
      const ran = yield* Ref.make(0)
      const report = yield* Supervisor.run({
        name: "done-before",
        ledger,
        children: [Supervisor.child("a", Ref.update(ran, (n) => n + 1))]
      })
      assert.deepStrictEqual(report.children, [{ id: "a", starts: 0 }])
      assert.strictEqual(yield* Ref.get(ran), 0)
    }))

  it.effect("restart intensity counts the restarts a previous life made", () =>
    Effect.gen(function*() {
      const ledger = yield* SupervisorLedger.memory
      // Three restarts just now, by a supervisor that then died.
      yield* ledger.setRestarts("looping", [0, 0, 0])
      const runs = yield* Ref.make(0)
      const exit = yield* Effect.exit(Supervisor.run({
        name: "looping",
        ledger,
        classify: () => "restart",
        children: [Supervisor.child("a", Effect.andThen(Ref.update(runs, (n) => n + 1), Effect.fail("boom")))]
      }))
      // No restart was left: the first failure is the last. A supervisor that
      // forgot its predecessor's restarts would run it four times.
      assert.strictEqual(yield* Ref.get(runs), 1)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0]
        assert.isTrue(reason?._tag === "Fail" && reason.error.reason === "intensity")
      }
    }))

  it.effect("a restart is recorded as it happens, so a life that dies after it leaves it counted", () =>
    Effect.gen(function*() {
      const ledger = yield* SupervisorLedger.memory
      const written = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([])
      const attempts = yield* Ref.make(0)
      yield* Supervisor.run({
        name: "recorded",
        ledger: {
          ...ledger,
          setRestarts: (supervisor, at) => Effect.andThen(Ref.update(written, (all) => [...all, at]), ledger.setRestarts(supervisor, at))
        },
        classify: () => "restart",
        children: [
          Supervisor.child("a", Effect.flatMap(Ref.updateAndGet(attempts, (n) => n + 1), (n) => n === 1 ? Effect.fail("once") : Effect.void))
        ]
      })
      // One restart written when it happened, then cleared when the life ended.
      assert.deepStrictEqual((yield* Ref.get(written)).map((at) => at.length), [1, 0])
    }))

  it.effect("a life that ends forgets its ledger, so the next run under the name starts afresh", () =>
    Effect.gen(function*() {
      const ledger = yield* SupervisorLedger.memory
      const ran = yield* Ref.make(0)
      const spec = { name: "nightly", ledger, children: [Supervisor.child("a", Ref.update(ran, (n) => n + 1))] }
      yield* Supervisor.run(spec)
      yield* Supervisor.run(spec)
      assert.strictEqual(yield* Ref.get(ran), 2, "the second night skipped a child the first night finished")
    }))

  it.effect("an escalation forgets the ledger too", () =>
    Effect.gen(function*() {
      const ledger = yield* SupervisorLedger.memory
      yield* Effect.exit(Supervisor.run({ name: "gave-up", ledger, children: [Supervisor.child("a", Effect.fail("boom"))] }))
      assert.deepStrictEqual(yield* ledger.child("gave-up", "a"), SupervisorLedger.empty)
      assert.deepStrictEqual(yield* ledger.restarts("gave-up"), [])
    }))
})

describe("SupervisorLedger.keyValue", () => {
  it.effect("round-trips records and restart history over a KeyValueStore", () =>
    Effect.gen(function*() {
      const kv = yield* KeyValueStore.KeyValueStore
      const ledger = SupervisorLedger.keyValue(kv)
      assert.deepStrictEqual(yield* ledger.child("s", "a"), SupervisorLedger.empty)
      yield* ledger.update("s", "a", (r) => ({
        ...r,
        attempts: 2,
        current: Option.some({ attempt: 2, submissionId: Option.some("x") })
      }))
      // A second ledger over the same backing: another process.
      const again = SupervisorLedger.keyValue(kv)
      assert.deepStrictEqual(yield* again.child("s", "a"), {
        attempts: 2,
        current: Option.some({ attempt: 2, submissionId: Option.some("x") }),
        finished: false
      })
      assert.deepStrictEqual(yield* again.child("s", "b"), SupervisorLedger.empty)
      yield* ledger.setRestarts("s", [1, 2])
      assert.deepStrictEqual(yield* again.restarts("s"), [1, 2])
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
})

describe("a durable child rejoined by its attempt's key (item 138)", () => {
  /**
   * The window between submitting and recording the submission. The dead
   * supervisor opened attempt 1 and submitted under its key, then died
   * before writing down what it submitted. The next life finds attempt 1
   * still open and submits under the same key, and the durable client, still
   * holding that claim, hands back the same submission. Counting a new attempt
   * instead would submit under another key and be refused as busy.
   */
  it.live("a restarted supervisor rejoins the claim its predecessor took, not a second one", () =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      const { layer: model } = yield* TestLanguageModel.script([
        { text: "done", during: Deferred.await(release) }
      ])
      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const runtime = yield* Layer.build(
        DurableAgentClient.layer("RejoinedClient", Agent.make({ loop: AgentLoop.bounded(1) }), { store, sessionStore }).pipe(
          Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))),
          Layer.provideMerge(TestLanguageModel.counting(model, calls))
        )
      )
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession()
        const ledger = yield* SupervisorLedger.memory
        // What the dead supervisor did: opened attempt 1, then submitted.
        yield* ledger.update("dur", "a", () => ({
          attempts: 1,
          current: Option.some({ attempt: 1, submissionId: Option.none() }),
          finished: false
        }))
        const first = yield* session.submit("go", { idempotencyKey: "dur:a:1" })

        const supervising = yield* Effect.forkChild(Supervisor.run({
          name: "dur",
          ledger,
          children: [Supervisor.remoteTask("a", { session: client.session(session.id), prompt: "go" })]
        }))
        // The next life has rejoined when it records the claim's submission;
        // a supervisor that ends first (refused as busy, say) fails the test.
        yield* Effect.raceFirst(
          Effect.repeat(ledger.child("dur", "a"), {
            until: (r) => Option.isSome(r.current) && Option.isSome(r.current.value.submissionId),
            schedule: Schedule.spaced("10 millis")
          }),
          Effect.flatMap(Fiber.await(supervising), (exit) =>
            Effect.die(new Error(`the supervisor ended before rejoining: ${String(exit)}`)))
        )
        const rejoined = yield* ledger.child("dur", "a")
        assert.deepStrictEqual(
          Option.flatMap(rejoined.current, (c) => c.submissionId),
          Option.some(first.submissionId),
          "the next life submitted a second time instead of rejoining"
        )
        yield* Deferred.succeed(release, undefined)
        const report = yield* Fiber.join(supervising)
        assert.deepStrictEqual(report.children, [{ id: "a", starts: 1 }])
        assert.strictEqual(yield* Ref.get(calls), 1)
        assert.deepStrictEqual(yield* ledger.child("dur", "a"), SupervisorLedger.empty)
      }).pipe(Effect.provide(runtime))
    }).pipe(Effect.scoped), 30_000)
})

describe("a supervisor that is stopped, not killed", () => {
  /**
   * Interrupting the supervisor stops its remote children's runs. The attempt
   * each was waiting on is abandoned, so a later life opens a new one rather
   * than waiting on a run that was stopped and failing on it.
   */
  it.live("interrupting the supervisor abandons the remote attempt it stopped", () =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      const { layer: model } = yield* TestLanguageModel.script([
        { text: "never", started: entered, during: Deferred.await(release) }
      ])
      const layer = AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(1) })).pipe(
        Layer.provide(TestLanguageModel.counting(model, calls))
      )
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession()
        const ledger = yield* SupervisorLedger.memory
        const supervising = yield* Effect.forkChild(Supervisor.run({
          name: "stopped",
          ledger,
          children: [Supervisor.remoteTask("a", { session: client.session(session.id), prompt: "go" })]
        }))
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(supervising)
        const record = yield* ledger.child("stopped", "a")
        assert.isTrue(Option.isNone(record.current), "the stopped attempt was left open, to be waited on again")
        assert.strictEqual(record.attempts, 1)
        assert.isFalse(record.finished)
      }).pipe(Effect.scoped, Effect.provide(layer))
    }), 30_000)
})
