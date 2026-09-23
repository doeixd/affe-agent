/**
 * Tasks (control plane §8): the store's contract on both backends, and --
 * over a real server -- a task started as an attempt that is an ordinary
 * conversation, its status coming back from the session: completed when
 * the submission completes, waiting while a question is open, canceled
 * when interrupted, and a second attempt after that.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, DateTime, Effect, Layer, Option, Schedule } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AgentClient } from "affe-agent/client"
import type * as Conversation from "../src/domain/Conversation.js"
import * as Task from "../src/domain/Task.js"
import { AgentId, AgentRevisionId, ConversationId, TaskId, UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import * as TaskRunner from "../src/runtime/TaskRunner.js"
import { tokens } from "../src/server/Authentication.js"
import { approvedReply, buildReply, serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as HttpStores from "../src/store/http.js"
import * as TaskStore from "../src/store/TaskStore.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")

const tempFile = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-tasks-")), "tasks.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const backends: ReadonlyArray<readonly [string, Effect.Effect<Layer.Layer<TaskStore.TaskStore>, never, Scope.Scope>]> = [
  ["memory", Effect.succeed(TaskStore.memory)],
  ["sqlite", Effect.map(tempFile, (file) => TaskStore.layerSql.pipe(Layer.provide(SqliteClient.layer({ filename: file }))))]
]

const attemptOn = (taskId: TaskId, n: number): TaskStore.NewAttempt => ({
  taskId,
  agentRevisionId: AgentRevisionId.make("a@1"),
  conversationId: ConversationId.make(`c${n}`),
  sessionId: `conversation-c${n}`
})

for (const [name, backend] of backends) {
  describe(`task store (${name})`, () => {
    it.live("a task is created in the backlog, attempted in numbered order, and settled with its attempt", () =>
      Effect.scoped(Effect.gen(function*() {
        const store = Context.get(yield* Layer.build(yield* backend), TaskStore.TaskStore)
        const first = yield* store.create({ ownerId: ada, agentId: AgentId.make("a"), title: "First", description: "do it" })
        yield* Effect.sleep("2 millis")
        const second = yield* store.create({ ownerId: ada, agentId: AgentId.make("a"), title: "Second", description: "do more", priority: 5 })
        yield* store.create({ ownerId: grace, agentId: AgentId.make("a"), title: "Grace's", description: "hers" })
        assert.strictEqual(first.status, "backlog")
        assert.strictEqual(second.priority, 5)
        assert.deepStrictEqual((yield* store.list(ada)).map((task) => task.title), ["Second", "First"])
        assert.deepStrictEqual(yield* store.get(first.id), Option.some(first))

        const one = yield* store.startAttempt(attemptOn(first.id, 1))
        assert.strictEqual(one.attempt, 1)
        assert.isTrue(Option.isNone(one.finishedAt))
        assert.isTrue(Option.isNone(one.submissionId))
        const stamped = yield* store.recordSubmission("conversation-c1", "s1")
        assert.deepStrictEqual(Option.map(stamped, (a) => a.submissionId), Option.some(Option.some("s1")))
        assert.isTrue(Option.isNone(yield* store.recordSubmission("conversation-nope", "s9")))
        assert.strictEqual(Option.map(yield* store.get(first.id), (task) => task.status).pipe(Option.getOrUndefined), "running")
        assert.deepStrictEqual(Option.map(yield* store.liveAttemptOf("conversation-c1"), (a) => a.attempt), Option.some(1))
        assert.isTrue(Option.isNone(yield* store.liveAttemptOf("conversation-nope")))

        yield* store.finishAttempt("conversation-c1", "failed", "failed")
        yield* store.finishAttempt("conversation-c1", "completed", "completed") // already finished: nothing changes
        const after = yield* store.get(first.id)
        assert.strictEqual(Option.map(after, (task) => task.status).pipe(Option.getOrUndefined), "failed")
        assert.isTrue(Option.isNone(yield* store.liveAttemptOf("conversation-c1")))

        const two = yield* store.startAttempt(attemptOn(first.id, 2))
        assert.strictEqual(two.attempt, 2)
        const attempts = yield* store.attempts(first.id)
        assert.deepStrictEqual(attempts.map((a) => [a.attempt, Option.getOrUndefined(a.outcome)]), [[1, "failed"], [2, undefined]])

        const ready = yield* store.setStatus(second.id, "ready")
        assert.strictEqual(ready.status, "ready")
        assert.strictEqual((yield* Effect.flip(store.setStatus(TaskId.make("nope"), "ready")))._tag, "TaskNotFoundError")
        assert.strictEqual((yield* Effect.flip(store.startAttempt(attemptOn(TaskId.make("nope"), 9))))._tag, "TaskNotFoundError")
      })))
  })
}

// -- Over a real server ---------------------------------------------------------------

const port = 8783
const people = tokens({ "ada-token": "ada", "grace-token": "grace" })

const load = (token: string) => {
  const server = { baseUrl: `http://localhost:${port}`, token }
  return Effect.map(
    Layer.build(
      ConversationSessions.layer.pipe(
        Layer.provideMerge(AgentDirectory.http(server)),
        Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore(server), HttpStores.agentRegistry(server))),
        Layer.provideMerge(FetchHttpClient.layer)
      )
    ),
    (context) => ({
      sessions: Context.get(context, ConversationSessions.ConversationSessions),
      registry: Context.get(context, AgentRegistry.AgentRegistry),
      tasks: Effect.provide(HttpStores.tasks(server), FetchHttpClient.layer),
      task: (id: TaskId) => Effect.provide(HttpStores.task(server, id), FetchHttpClient.layer),
      create: (input: Task.New) => Effect.provide(HttpStores.createTask(server, input), FetchHttpClient.layer),
      start: (id: TaskId) => Effect.provide(HttpStores.startTask(server, id), FetchHttpClient.layer),
      cancel: (id: TaskId) => Effect.provide(HttpStores.cancelTask(server, id), FetchHttpClient.layer),
      inbox: Effect.provide(HttpStores.inbox(server), FetchHttpClient.layer)
    })
  )
}

const statusOf = (page: { readonly task: (id: TaskId) => Effect.Effect<Option.Option<{ readonly task: Task.Record }>, unknown> }, id: TaskId) =>
  Effect.map(page.task(id), (found) => Option.map(found, ({ task }) => task.status).pipe(Option.getOrUndefined))

/** Names the condition in the failure, so a timeout says what it was waiting for. */
const until = <A>(read: Effect.Effect<A, unknown>, ok: (value: A) => boolean) =>
  read.pipe(
    Effect.repeat({ until: ok, schedule: Schedule.spaced("50 millis") }),
    Effect.timeoutOrElse({ duration: "15 seconds", orElse: () => Effect.die(`timed out waiting for: ${ok.toString()}`) })
  )

describe("tasks over the server", () => {
  it.live("a started task is a conversation whose session settles the task's status", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(people)))
      const adas = yield* load("ada-token")
      const graces = yield* load("grace-token")
      const [agent] = yield* adas.registry.list(ada)
      if (agent === undefined) return yield* Effect.die("no seeded agent")

      // A task that completes on its own: the scripted agent's first step builds and replies.
      const build = yield* adas.create({ ownerId: ada, agentId: agent.id, title: "Build", description: "build it" })
      assert.strictEqual(build.status, "backlog")
      assert.deepStrictEqual((yield* adas.tasks).map((task) => task.id), [build.id])
      assert.deepStrictEqual(yield* graces.tasks, [], "tasks are personal")
      assert.isTrue(Option.isNone(yield* graces.task(build.id)))
      assert.strictEqual((yield* Effect.flip(graces.start(build.id)))._tag, "TaskNotFoundError")

      const attempt = yield* adas.start(build.id)
      assert.strictEqual(attempt.attempt, 1)
      assert.strictEqual(attempt.agentRevisionId, agent.activeRevisionId)
      assert.isTrue(Option.isSome(attempt.submissionId), "the attempt names its submission")
      // Started twice is refused while it runs.
      const again = yield* Effect.flip(adas.start(build.id))
      assert.strictEqual(again._tag, "TaskNotStartableError")

      assert.strictEqual(yield* until(statusOf(adas, build.id), (status) => status === "completed"), "completed")
      // The attempt is an ordinary conversation, readable as one, with the agent's reply in it.
      const { conversation, session } = yield* adas.sessions.open(attempt.conversationId)
      assert.strictEqual(conversation.ownerId, ada)
      const history = yield* session.history
      assert.isTrue(
        history.content.some((message) =>
          message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === buildReply)
        )
      )
      const done = yield* adas.task(build.id)
      assert.deepStrictEqual(
        Option.map(done, ({ attempts }) => attempts.map((a) => [a.attempt, Option.getOrUndefined(a.outcome)])),
        Option.some<ReadonlyArray<ReadonlyArray<number | string | undefined>>>([[1, "completed"]])
      )

      // The server's scripted model alternates across every session it serves:
      // one prompt builds, the next asks before deleting. The second prompt of
      // this test, wherever it lands, is a question.
      const cleanup = yield* adas.create({ ownerId: ada, agentId: agent.id, title: "Clean up", description: "clean up" })
      const askingAttempt = yield* adas.start(cleanup.id)
      assert.strictEqual(askingAttempt.attempt, 1)
      assert.strictEqual(yield* until(statusOf(adas, cleanup.id), (status) => status === "waiting"), "waiting")
      const waiting = yield* until(adas.inbox, (items) => items.length > 0)
      assert.strictEqual(waiting[0]?.conversationId, askingAttempt.conversationId)

      // Cancelled: the session is interrupted, and the task and the inbox learn it from the session.
      yield* adas.cancel(cleanup.id)
      assert.strictEqual(yield* until(statusOf(adas, cleanup.id), (status) => status === "canceled"), "canceled")
      assert.deepStrictEqual(yield* until(adas.inbox, (items) => items.length === 0), [])
      assert.strictEqual((yield* Effect.flip(adas.cancel(cleanup.id)))._tag, "TaskNotStartableError")

      // Tried again, each on a fresh conversation. The interruption left the
      // script mid-cycle, so how many attempts complete before one asks again
      // is the script's business; within three, one does.
      let askedAgain: Task.Attempt | undefined
      for (let expected = 2; expected <= 4 && askedAgain === undefined; expected++) {
        const attempt = yield* adas.start(cleanup.id)
        assert.strictEqual(attempt.attempt, expected)
        assert.notStrictEqual(attempt.conversationId, askingAttempt.conversationId)
        const status = yield* until(statusOf(adas, cleanup.id), (status) => status === "completed" || status === "waiting")
        if (status === "waiting") askedAgain = attempt
      }
      if (askedAgain === undefined) return yield* Effect.die("no attempt asked a question again")
      const opened = yield* adas.sessions.open(askedAgain.conversationId)
      const [question] = yield* opened.session.pending
      assert.isTrue(yield* opened.session.respond({ id: question?.id ?? "", granted: true }))
      assert.strictEqual(yield* until(statusOf(adas, cleanup.id), (status) => status === "completed"), "completed")
      const finalHistory = yield* opened.session.history
      assert.isTrue(
        finalHistory.content.some((message) =>
          message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === approvedReply)
        )
      )
    })), 90_000)
})

// -- The runner on its own ------------------------------------------------------------

describe("task runner", () => {
  it.effect("a submit the host refuses fails the attempt, so nothing is left running", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = Context.get(yield* Layer.build(TaskStore.memory), TaskStore.TaskStore)
      const task = yield* store.create({ ownerId: ada, agentId: AgentId.make("a"), title: "Doomed", description: "try" })
      const conversation: Conversation.Record = {
        id: ConversationId.make("c1"),
        ownerId: ada,
        agentId: AgentId.make("a"),
        agentRevisionId: AgentRevisionId.make("a@1"),
        sessionId: "conversation-c1",
        workspaceId: Option.none(),
        modelProfile: Option.none(),
        title: "Doomed (attempt 1)",
        archived: false,
        createdAt: DateTime.makeUnsafe(0),
        updatedAt: DateTime.makeUnsafe(0)
      }
      const refusing = TaskRunner.TaskAttempts.of({
        begin: () => Effect.succeed(conversation),
        submit: () => Effect.fail(new AgentClient.AgentTransportError({ sessionId: "conversation-c1", detail: "gone" })),
        interrupt: () => Effect.void
      })
      const failed = yield* Effect.flip(
        TaskRunner.start(task).pipe(
          Effect.provideService(TaskStore.TaskStore, store),
          Effect.provideService(TaskRunner.TaskAttempts, refusing)
        )
      )
      assert.strictEqual(failed._tag, "AgentTransportError")
      assert.strictEqual(Option.map(yield* store.get(task.id), (found) => found.status).pipe(Option.getOrUndefined), "failed")
      assert.deepStrictEqual((yield* store.attempts(task.id)).map((a) => Option.getOrUndefined(a.outcome)), ["failed"])
      assert.isTrue(Option.isNone(yield* store.liveAttemptOf("conversation-c1")))
      // And it can be tried again.
      assert.isTrue(Task.canStart("failed"))
    })))
})
