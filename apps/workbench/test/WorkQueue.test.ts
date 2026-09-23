/**
 * The operational queue (control plane §9): the store's leases and order
 * on both backends; the worker's retries, backoff and give-up under the
 * test clock with an attempts service that refuses; two workers over one
 * queue never both start a task; and, over a real server, a queued task
 * is started by the server's own worker and completes.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, DateTime, Duration, Effect, Layer, Option, Ref, Schedule } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import type { HttpClient } from "effect/unstable/http"
import { AgentClient } from "affe-agent/client"
import type * as Conversation from "../src/domain/Conversation.js"
import type * as Task from "../src/domain/Task.js"
import { AgentId, AgentRevisionId, ConversationId, TaskId, UserId } from "../src/domain/WorkbenchIds.js"
import * as TaskRunner from "../src/runtime/TaskRunner.js"
import * as TaskWorker from "../src/runtime/TaskWorker.js"
import { tokens } from "../src/server/Authentication.js"
import { serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as HttpStores from "../src/store/http.js"
import * as TaskStore from "../src/store/TaskStore.js"
import * as WorkQueue from "../src/store/WorkQueue.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-queue-")), "queue.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const backends: ReadonlyArray<readonly [string, Effect.Effect<Layer.Layer<WorkQueue.WorkQueue>, never, Scope.Scope>]> = [
  ["memory", Effect.succeed(WorkQueue.memory)],
  ["sqlite", Effect.map(tempFile, (file) => WorkQueue.layerSql.pipe(Layer.provide(SqliteClient.layer({ filename: file }))))]
]

const enqueue = (taskId: string, ownerId: UserId, priority: number, now: number): WorkQueue.Enqueue => ({
  taskId: TaskId.make(taskId),
  ownerId,
  priority,
  maxClaims: 3,
  availableAt: now,
  now
})

for (const [name, backend] of backends) {
  describe(`work queue (${name})`, () => {
    it.effect("claims by priority then age, under a lease that runs out, and once per task", () =>
      Effect.scoped(Effect.gen(function*() {
        const queue = Context.get(yield* Layer.build(yield* backend), WorkQueue.WorkQueue)
        yield* queue.enqueue(enqueue("low-old", ada, 0, 100))
        yield* queue.enqueue(enqueue("high", ada, 5, 200))
        yield* queue.enqueue(enqueue("low-new", ada, 0, 300))
        yield* queue.enqueue(enqueue("later", ada, 9, 100))
        yield* queue.enqueue(enqueue("graces", grace, 0, 150))
        // Queued twice is the same item.
        const again = yield* queue.enqueue(enqueue("high", ada, 1, 999))
        assert.strictEqual(again.priority, 5)
        assert.deepStrictEqual((yield* queue.listFor(ada)).map((item) => item.taskId), ["later", "high", "low-old", "low-new"])

        // Not yet due: `later` becomes available at 1000.
        yield* queue.release(again.id, 200)
        const laterItem = yield* queue.forTask(TaskId.make("later"))
        if (Option.isNone(laterItem)) return yield* Effect.die("later was not queued")
        yield* queue.release(laterItem.value.id, 1000)

        const first = yield* queue.claim({ worker: "w1", now: 500, leaseMillis: 100, limit: 2 })
        assert.deepStrictEqual(first.map((item) => [item.taskId, item.claims, Option.getOrUndefined(item.leaseOwner)]), [
          ["high", 1, "w1"],
          ["low-old", 1, "w1"]
        ])
        // Leased items are not claimable by anyone, including w1, until the lease is over.
        const second = yield* queue.claim({ worker: "w2", now: 550, leaseMillis: 100, limit: 10 })
        assert.deepStrictEqual(second.map((item) => item.taskId), ["graces", "low-new"])
        assert.deepStrictEqual(yield* queue.claim({ worker: "w1", now: 560, leaseMillis: 100, limit: 10 }), [])
        // The lease ran out: w2 takes over `high` with a second claim; `later` is due too.
        const third = yield* queue.claim({ worker: "w2", now: 1000, leaseMillis: 100, limit: 10 })
        assert.deepStrictEqual(third.map((item) => [item.taskId, item.claims]), [["later", 1], ["high", 2], ["low-old", 2], ["graces", 2], ["low-new", 2]])

        const high = third.find((item) => item.taskId === "high")
        if (high === undefined) return yield* Effect.die("high was not claimed")
        yield* queue.complete(high.id)
        yield* queue.complete(high.id)
        assert.isTrue(Option.isNone(yield* queue.forTask(TaskId.make("high"))))
        const lowOld = third.find((item) => item.taskId === "low-old")
        if (lowOld === undefined) return yield* Effect.die("low-old was not claimed")
        yield* queue.release(lowOld.id, 2000)
        const released = yield* queue.forTask(TaskId.make("low-old"))
        assert.deepStrictEqual(Option.map(released, (item) => [item.availableAt, Option.getOrUndefined(item.leaseOwner), item.claims]), Option.some([2000, undefined, 2]))
      })))
  })
}

// -- The worker, under the test clock -------------------------------------------------

const conversationOf = (task: Task.Record, n: number): Conversation.Record => ({
  id: ConversationId.make(`c-${task.id}-${n}`),
  ownerId: task.ownerId,
  agentId: task.agentId,
  agentRevisionId: AgentRevisionId.make("a@1"),
  sessionId: `conversation-c-${task.id}-${n}`,
  workspaceId: Option.none(),
  modelProfile: Option.none(),
  title: task.title,
  archived: false,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0)
})

/** Attempts that refuse the first `failures` submits, then accept. */
const flaky = (failures: number) =>
  Effect.gen(function*() {
    const submits = yield* Ref.make(0)
    const attempts = TaskRunner.TaskAttempts.of({
      begin: (task) => Effect.map(Ref.get(submits), (n) => conversationOf(task, n)),
      submit: (task) =>
        Effect.flatMap(Ref.updateAndGet(submits, (n) => n + 1), (n) =>
          n <= failures
            ? Effect.fail(new AgentClient.AgentTransportError({ sessionId: task.id, detail: `refused #${n}` }))
            : Effect.succeed(`submission-${n}`)),
      interrupt: () => Effect.void
    })
    return { attempts, submits }
  })

const stores = Layer.mergeAll(TaskStore.memory, WorkQueue.memory)

describe("task worker", () => {
  it.effect("retries a failed start with backoff, then starts it; a queued task is ready until then", () =>
    Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(stores)
      const tasks = Context.get(context, TaskStore.TaskStore)
      const queue = Context.get(context, WorkQueue.WorkQueue)
      const { attempts, submits } = yield* flaky(2)
      const provided = <A, E>(effect: Effect.Effect<A, E, TaskStore.TaskStore | WorkQueue.WorkQueue | TaskRunner.TaskAttempts>) =>
        effect.pipe(Effect.provide(context), Effect.provideService(TaskRunner.TaskAttempts, attempts))
      const options: TaskWorker.Options = { worker: "w1", lease: "10 seconds", backoff: () => Duration.seconds(1) }

      const task = yield* tasks.create({ ownerId: ada, agentId: AgentId.make("a"), title: "Queued", description: "go" })
      yield* provided(TaskWorker.enqueue(task))
      assert.strictEqual(Option.map(yield* tasks.get(task.id), (t) => t.status).pipe(Option.getOrUndefined), "ready")
      // Queued twice is refused only while it is being attempted; a ready task re-queued is the same item.
      const ready = yield* tasks.get(task.id)
      if (Option.isNone(ready)) return yield* Effect.die("gone")
      yield* provided(TaskWorker.enqueue(ready.value))
      assert.strictEqual((yield* queue.listFor(ada)).length, 1)

      // First tick: claimed, start refused, released with backoff. Ready again, not failed: a retry is pending.
      assert.strictEqual(yield* provided(TaskWorker.tick(options)), 1)
      assert.strictEqual(yield* Ref.get(submits), 1)
      assert.strictEqual(Option.map(yield* tasks.get(task.id), (t) => t.status).pipe(Option.getOrUndefined), "ready")
      // Nothing due before the backoff.
      assert.strictEqual(yield* provided(TaskWorker.tick(options)), 0)
      yield* TestClock.adjust("1 second")
      assert.strictEqual(yield* provided(TaskWorker.tick(options)), 1)
      assert.strictEqual(yield* Ref.get(submits), 2)
      yield* TestClock.adjust("1 second")
      // Third try succeeds: the attempt is in flight and the item is gone.
      assert.strictEqual(yield* provided(TaskWorker.tick(options)), 1)
      assert.strictEqual(yield* Ref.get(submits), 3)
      assert.strictEqual(Option.map(yield* tasks.get(task.id), (t) => t.status).pipe(Option.getOrUndefined), "running")
      assert.deepStrictEqual(yield* queue.listFor(ada), [])
      const recorded = yield* tasks.attempts(task.id)
      assert.deepStrictEqual(recorded.map((a) => [a.attempt, Option.getOrUndefined(a.submissionId), Option.getOrUndefined(a.outcome)]), [
        [1, undefined, "failed"],
        [2, undefined, "failed"],
        [3, "submission-3", undefined]
      ])
    })))

  it.effect("a queued task taken back is canceled, never attempted; one not queued is left alone", () =>
    Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(stores)
      const tasks = Context.get(context, TaskStore.TaskStore)
      const queue = Context.get(context, WorkQueue.WorkQueue)
      const task = yield* tasks.create({ ownerId: ada, agentId: AgentId.make("a"), title: "Held", description: "go" })
      yield* TaskWorker.enqueue(task).pipe(Effect.provide(context))
      const ready = yield* tasks.get(task.id)
      if (Option.isNone(ready)) return yield* Effect.die("gone")
      assert.isTrue(yield* TaskWorker.dequeue(ready.value).pipe(Effect.provide(context)))
      assert.deepStrictEqual(yield* queue.listFor(ada), [])
      assert.strictEqual(Option.map(yield* tasks.get(task.id), (t) => t.status).pipe(Option.getOrUndefined), "canceled")
      assert.deepStrictEqual(yield* tasks.attempts(task.id), [])
      const canceled = yield* tasks.get(task.id)
      if (Option.isNone(canceled)) return yield* Effect.die("gone")
      assert.isFalse(yield* TaskWorker.dequeue(canceled.value).pipe(Effect.provide(context)))
    })))

  it.effect("gives up after maxClaims, leaving the task failed and the queue empty", () =>
    Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(stores)
      const tasks = Context.get(context, TaskStore.TaskStore)
      const queue = Context.get(context, WorkQueue.WorkQueue)
      const { attempts, submits } = yield* flaky(99)
      const provided = <A, E>(effect: Effect.Effect<A, E, TaskStore.TaskStore | WorkQueue.WorkQueue | TaskRunner.TaskAttempts>) =>
        effect.pipe(Effect.provide(context), Effect.provideService(TaskRunner.TaskAttempts, attempts))
      const options: TaskWorker.Options = { worker: "w1", backoff: () => Duration.millis(1) }
      const task = yield* tasks.create({ ownerId: ada, agentId: AgentId.make("a"), title: "Doomed", description: "go" })
      yield* provided(TaskWorker.enqueue(task, { maxClaims: 2 }))
      for (let i = 0; i < 4; i++) {
        yield* provided(TaskWorker.tick(options))
        yield* TestClock.adjust("1 millis")
      }
      assert.strictEqual(yield* Ref.get(submits), 2, "two claims, two tries, no more")
      assert.deepStrictEqual(yield* queue.listFor(ada), [])
      assert.strictEqual(Option.map(yield* tasks.get(task.id), (t) => t.status).pipe(Option.getOrUndefined), "failed")
    })))

  it.effect("two workers over one queue start a task once; a lease that ran out is taken over, and a task already running is left alone", () =>
    Effect.scoped(Effect.gen(function*() {
      const context = yield* Layer.build(stores)
      const tasks = Context.get(context, TaskStore.TaskStore)
      const queue = Context.get(context, WorkQueue.WorkQueue)
      const { attempts, submits } = yield* flaky(0)
      const provided = <A, E>(effect: Effect.Effect<A, E, TaskStore.TaskStore | WorkQueue.WorkQueue | TaskRunner.TaskAttempts>) =>
        effect.pipe(Effect.provide(context), Effect.provideService(TaskRunner.TaskAttempts, attempts))
      const task = yield* tasks.create({ ownerId: ada, agentId: AgentId.make("a"), title: "Once", description: "go" })
      yield* provided(TaskWorker.enqueue(task))
      const [a, b] = yield* Effect.all(
        [provided(TaskWorker.tick({ worker: "w1", lease: "10 seconds" })), provided(TaskWorker.tick({ worker: "w2", lease: "10 seconds" }))],
        { concurrency: 2 }
      )
      assert.strictEqual(a + b, 1, "one of them claimed it")
      assert.strictEqual(yield* Ref.get(submits), 1)

      // A claim whose lease ran out before the item was completed: the next worker finds the task running and completes the item.
      const other = yield* tasks.create({ ownerId: ada, agentId: AgentId.make("a"), title: "Stalled", description: "go" })
      const item = yield* provided(TaskWorker.enqueue(other))
      yield* queue.claim({ worker: "crashed", now: yield* Effect.clockWith((c) => c.currentTimeMillis), leaseMillis: 10, limit: 1 })
      yield* tasks.startAttempt({ taskId: other.id, agentRevisionId: AgentRevisionId.make("a@1"), conversationId: ConversationId.make("c"), sessionId: "conversation-c" })
      yield* TestClock.adjust("11 millis")
      assert.strictEqual(yield* provided(TaskWorker.tick({ worker: "w3", lease: "10 seconds" })), 1)
      assert.strictEqual(yield* Ref.get(submits), 1, "not started twice")
      assert.isTrue(Option.isNone(yield* queue.forTask(item.taskId)))
    })))
})

// -- Over a real server ---------------------------------------------------------------

const port = 8781

describe("work queue over the server", () => {
  it.live("a queued task is started by the server's worker and completes", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(tokens({ "ada-token": "ada" }))))
      const server = { baseUrl: `http://localhost:${port}`, token: "ada-token" }
      const http = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.provide(effect, FetchHttpClient.layer)
      const registry = Context.get(yield* Layer.build(HttpStores.agentRegistry(server).pipe(Layer.provideMerge(FetchHttpClient.layer))), AgentRegistry.AgentRegistry)
      const [agent] = yield* registry.list(ada)
      if (agent === undefined) return yield* Effect.die("no seeded agent")

      const build = yield* http(HttpStores.createTask(server, { ownerId: ada, agentId: agent.id, title: "Queued build", description: "build it" }))
      const queued = yield* http(HttpStores.queueTask(server, build.id))
      assert.strictEqual(queued.status, "ready")
      const statusOf = (id: TaskId) => http(HttpStores.task(server, id)).pipe(Effect.map((found) => Option.map(found, ({ task }) => task.status).pipe(Option.getOrUndefined)))
      const settled = yield* statusOf(build.id).pipe(
        Effect.repeat({ until: (status) => status === "completed", schedule: Schedule.spaced("100 millis") }),
        Effect.timeout("20 seconds")
      )
      assert.strictEqual(settled, "completed")
      const done = yield* http(HttpStores.task(server, build.id))
      assert.deepStrictEqual(
        Option.map(done, ({ attempts }) => attempts.map((a) => Option.getOrUndefined(a.outcome))),
        Option.some<ReadonlyArray<string | undefined>>(["completed"])
      )
    })), 60_000)
})
