/**
 * Tasks and their attempts (plan-agent-product-control-plane.md §8, §42).
 *
 * Two tables, one store, because an attempt without its task is meaningless
 * and starting an attempt changes the task's status in the same step. The
 * attempt's session id is indexed: the projection that settles tasks from
 * the host's events looks attempts up by it.
 */
import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Task from "../domain/Task.js"
import { TaskId } from "../domain/WorkbenchIds.js"
import type { UserId } from "../domain/WorkbenchIds.js"
import { failedAs } from "./WorkbenchStorageError.js"
import type { WorkbenchStorageError } from "./WorkbenchStorageError.js"

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFoundError",
  { taskId: TaskId },
  { httpApiStatus: 404 }
) {}

/** What starting an attempt records; the store numbers it and stamps the time. */
export interface NewAttempt {
  readonly taskId: TaskId
  readonly agentRevisionId: Task.Attempt["agentRevisionId"]
  readonly conversationId: Task.Attempt["conversationId"]
  readonly sessionId: string
}

export interface Service {
  readonly create: (input: Task.New) => Effect.Effect<Task.Record, WorkbenchStorageError>
  readonly get: (id: TaskId) => Effect.Effect<Option.Option<Task.Record>, WorkbenchStorageError>
  /** Newest first. */
  readonly list: (owner: UserId) => Effect.Effect<ReadonlyArray<Task.Record>, WorkbenchStorageError>
  readonly setStatus: (
    id: TaskId,
    status: Task.Status
  ) => Effect.Effect<Task.Record, TaskNotFoundError | WorkbenchStorageError>
  /** Oldest first. */
  readonly attempts: (id: TaskId) => Effect.Effect<ReadonlyArray<Task.Attempt>, WorkbenchStorageError>
  /** Record the next attempt and mark the task running, together. */
  readonly startAttempt: (
    input: NewAttempt
  ) => Effect.Effect<Task.Attempt, TaskNotFoundError | WorkbenchStorageError>
  /** Stamp the submission the live attempt on this session became. Idempotent; nothing to stamp changes nothing. */
  readonly recordSubmission: (sessionId: string, submissionId: string) => Effect.Effect<Option.Option<Task.Attempt>, WorkbenchStorageError>
  /** The unfinished attempt on this session, if any: how an event finds its task. */
  readonly liveAttemptOf: (sessionId: string) => Effect.Effect<Option.Option<Task.Attempt>, WorkbenchStorageError>
  /** Finish the attempt and give the task the matching status, together. Idempotent. */
  readonly finishAttempt: (
    sessionId: string,
    outcome: Task.Outcome,
    status: Task.Status
  ) => Effect.Effect<void, WorkbenchStorageError>
}

export class TaskStore extends Context.Service<TaskStore, Service>()("workbench/TaskStore") {}

const newestFirst = (a: Task.Record, b: Task.Record) =>
  DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt) || a.id.localeCompare(b.id)

const recordOf = (input: Task.New, now: DateTime.Utc): Task.Record => ({
  id: TaskId.make(globalThis.crypto.randomUUID()),
  ownerId: input.ownerId,
  agentId: input.agentId,
  title: input.title,
  description: input.description,
  status: "backlog",
  priority: input.priority ?? 0,
  createdAt: now,
  updatedAt: now
})

// -- Memory -----------------------------------------------------------------------------

interface State {
  readonly tasks: ReadonlyMap<TaskId, Task.Record>
  readonly attempts: ReadonlyArray<Task.Attempt>
}

export const memory: Layer.Layer<TaskStore> = Layer.effect(
  TaskStore,
  Effect.gen(function*() {
    const state = yield* Ref.make<State>({ tasks: new Map(), attempts: [] })

    const setStatusIn = (current: State, task: Task.Record, status: Task.Status, now: DateTime.Utc): State => ({
      ...current,
      tasks: new Map(current.tasks).set(task.id, { ...task, status, updatedAt: now })
    })

    /** One `Ref.modify` per write, so a task is read and changed together. */
    const modifyTask = <A>(
      id: TaskId,
      change: (task: Task.Record, current: State, now: DateTime.Utc) => [A, State]
    ): Effect.Effect<A, TaskNotFoundError> =>
      Effect.gen(function*() {
        const now = yield* DateTime.now
        const outcome = yield* Ref.modify(state, (current): [Option.Option<A>, State] => {
          const task = current.tasks.get(id)
          if (task === undefined) return [Option.none(), current]
          const [result, next] = change(task, current, now)
          return [Option.some(result), next]
        })
        return yield* Option.match(outcome, {
          onNone: () => Effect.fail(new TaskNotFoundError({ taskId: id })),
          onSome: Effect.succeed
        })
      })

    return TaskStore.of({
      create: (input) =>
        Effect.gen(function*() {
          const task = recordOf(input, yield* DateTime.now)
          yield* Ref.update(state, (current) => ({ ...current, tasks: new Map(current.tasks).set(task.id, task) }))
          return task
        }),
      get: (id) => Effect.map(Ref.get(state), (current) => Option.fromNullishOr(current.tasks.get(id))),
      list: (owner) =>
        Effect.map(Ref.get(state), (current) =>
          [...current.tasks.values()].filter((task) => task.ownerId === owner).sort(newestFirst)),
      setStatus: (id, status) =>
        modifyTask(id, (task, current, now) => {
          const next = setStatusIn(current, task, status, now)
          return [{ ...task, status, updatedAt: now }, next]
        }),
      attempts: (id) =>
        Effect.map(Ref.get(state), (current) =>
          current.attempts.filter((attempt) => attempt.taskId === id).sort((a, b) => a.attempt - b.attempt)),
      startAttempt: (input) =>
        modifyTask(input.taskId, (task, current, now) => {
          const attempt: Task.Attempt = {
            ...input,
            attempt: current.attempts.filter((existing) => existing.taskId === task.id).length + 1,
            submissionId: Option.none(),
            startedAt: now,
            finishedAt: Option.none(),
            outcome: Option.none()
          }
          return [attempt, { ...setStatusIn(current, task, "running", now), attempts: [...current.attempts, attempt] }]
        }),
      recordSubmission: (sessionId, submissionId) =>
        Ref.modify(state, (current): [Option.Option<Task.Attempt>, State] => {
          const live = current.attempts.find((attempt) => attempt.sessionId === sessionId && Option.isNone(attempt.finishedAt))
          if (live === undefined) return [Option.none(), current]
          const stamped: Task.Attempt = { ...live, submissionId: Option.some(submissionId) }
          return [Option.some(stamped), { ...current, attempts: current.attempts.map((attempt) => (attempt === live ? stamped : attempt)) }]
        }),
      liveAttemptOf: (sessionId) =>
        Effect.map(Ref.get(state), (current) =>
          Option.fromNullishOr(
            current.attempts.find((attempt) => attempt.sessionId === sessionId && Option.isNone(attempt.finishedAt))
          )),
      finishAttempt: (sessionId, outcome, status) =>
        Effect.gen(function*() {
          const now = yield* DateTime.now
          yield* Ref.update(state, (current) => {
            const live = current.attempts.find((attempt) => attempt.sessionId === sessionId && Option.isNone(attempt.finishedAt))
            if (live === undefined) return current
            const finished: Task.Attempt = { ...live, finishedAt: Option.some(now), outcome: Option.some(outcome) }
            const task = current.tasks.get(live.taskId)
            const withAttempt: State = {
              ...current,
              attempts: current.attempts.map((attempt) => (attempt === live ? finished : attempt))
            }
            return task === undefined ? withAttempt : setStatusIn(withAttempt, task, status, now)
          })
        })
    })
  })
)

// -- SQL --------------------------------------------------------------------------------

const RecordJson = Schema.toCodecJson(Task.Record)
const AttemptJson = Schema.toCodecJson(Task.Attempt)

const encodeRecord = (task: Task.Record) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(RecordJson)(task), (encoded) => JSON.stringify(encoded)))
const encodeAttempt = (attempt: Task.Attempt) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(AttemptJson)(attempt), (encoded) => JSON.stringify(encoded)))

const parse = (operation: string, text: string) =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs(operation) })

const decodeRecord = (text: string) =>
  Effect.flatMap(parse("TaskStore.decodeRecord", text), (json) =>
    Effect.mapError(Schema.decodeUnknownEffect(RecordJson)(json), failedAs("TaskStore.decodeRecord")))
const decodeAttempt = (text: string) =>
  Effect.flatMap(parse("TaskStore.decodeAttempt", text), (json) =>
    Effect.mapError(Schema.decodeUnknownEffect(AttemptJson)(json), failedAs("TaskStore.decodeAttempt")))

interface BodyRow {
  readonly body: string
}

export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient

  const getTask = (id: TaskId) =>
    client<BodyRow>`SELECT body FROM workbench_tasks WHERE id = ${id}`.pipe(
      Effect.mapError(failedAs("TaskStore.get")),
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(Option.none<Task.Record>()) : Effect.map(decodeRecord(rows[0].body), Option.some)
      )
    )

  const writeTask = (task: Task.Record) =>
    Effect.flatMap(encodeRecord(task), (body) =>
      client`UPDATE workbench_tasks SET status = ${task.status}, body = ${body} WHERE id = ${task.id}`)

  const writeAttempt = (attempt: Task.Attempt) =>
    Effect.flatMap(encodeAttempt(attempt), (body) =>
      client`INSERT INTO workbench_task_attempts (task_id, attempt, session_id, finished, body) VALUES (${attempt.taskId}, ${attempt.attempt}, ${attempt.sessionId}, ${Option.isSome(attempt.finishedAt) ? 1 : 0}, ${body})
        ON CONFLICT (task_id, attempt) DO UPDATE SET finished = excluded.finished, body = excluded.body`)

  const requireTask = (id: TaskId) =>
    Effect.flatMap(getTask(id), (found) =>
      Option.match(found, {
        onNone: () => Effect.fail(new TaskNotFoundError({ taskId: id })),
        onSome: Effect.succeed
      }))

  const attemptsOf = (id: TaskId) =>
    client<BodyRow>`SELECT body FROM workbench_task_attempts WHERE task_id = ${id} ORDER BY attempt`.pipe(
      Effect.mapError(failedAs("TaskStore.attempts")),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeAttempt(row.body)))
    )

  const liveAttemptOf = (sessionId: string) =>
    client<BodyRow>`SELECT body FROM workbench_task_attempts WHERE session_id = ${sessionId} AND finished = 0 ORDER BY attempt DESC`
      .pipe(
        Effect.mapError(failedAs("TaskStore.liveAttemptOf")),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none<Task.Attempt>())
            : Effect.map(decodeAttempt(rows[0].body), Option.some))
      )


  return TaskStore.of({
    create: (input) =>
      Effect.gen(function*() {
        const task = recordOf(input, yield* DateTime.now)
        const body = yield* encodeRecord(task)
        yield* client`INSERT INTO workbench_tasks (id, owner_id, status, created_at, body) VALUES (${task.id}, ${task.ownerId}, ${task.status}, ${DateTime.toEpochMillis(task.createdAt)}, ${body})`
          .pipe(Effect.mapError(failedAs("TaskStore.create")))
        return task
      }),
    get: getTask,
    list: (owner) =>
      client<BodyRow>`SELECT body FROM workbench_tasks WHERE owner_id = ${owner} ORDER BY created_at DESC, id`.pipe(
        Effect.mapError(failedAs("TaskStore.list")),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRecord(row.body)))
      ),
    setStatus: (id, status) =>
      client.withTransaction(Effect.gen(function*() {
        const task = yield* requireTask(id)
        const next: Task.Record = { ...task, status, updatedAt: yield* DateTime.now }
        yield* writeTask(next)
        return next
      })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("TaskStore.setStatus")(cause)))),
    attempts: attemptsOf,
    startAttempt: (input) =>
      client.withTransaction(Effect.gen(function*() {
        const task = yield* requireTask(input.taskId)
        const now = yield* DateTime.now
        const [row] = yield* client<{ readonly latest: number | bigint }>`SELECT COALESCE(MAX(attempt), 0) AS latest FROM workbench_task_attempts WHERE task_id = ${input.taskId}`
        const attempt: Task.Attempt = {
          ...input,
          attempt: Number(row?.latest ?? 0) + 1,
          submissionId: Option.none(),
          startedAt: now,
          finishedAt: Option.none(),
          outcome: Option.none()
        }
        yield* writeAttempt(attempt)
        yield* writeTask({ ...task, status: "running", updatedAt: now })
        return attempt
      })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("TaskStore.startAttempt")(cause)))),
    recordSubmission: (sessionId, submissionId) =>
      client.withTransaction(Effect.gen(function*() {
        const live = yield* liveAttemptOf(sessionId)
        if (Option.isNone(live)) return Option.none<Task.Attempt>()
        const stamped: Task.Attempt = { ...live.value, submissionId: Option.some(submissionId) }
        yield* writeAttempt(stamped)
        return Option.some(stamped)
      })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("TaskStore.recordSubmission")(cause)))),
    liveAttemptOf,
    finishAttempt: (sessionId, outcome, status) =>
      client.withTransaction(Effect.gen(function*() {
        const live = yield* liveAttemptOf(sessionId)
        if (Option.isNone(live)) return
        const now = yield* DateTime.now
        yield* writeAttempt({ ...live.value, finishedAt: Option.some(now), outcome: Option.some(outcome) })
        const task = yield* getTask(live.value.taskId)
        if (Option.isSome(task)) yield* writeTask({ ...task.value, status, updatedAt: now })
      })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("TaskStore.finishAttempt")(cause))))
  })
})

export const sqlWithTables: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_tasks (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`.pipe(Effect.orDie)
  yield* client`CREATE INDEX IF NOT EXISTS workbench_tasks_by_owner ON workbench_tasks (owner_id, created_at)`.pipe(Effect.orDie)
  yield* client`CREATE TABLE IF NOT EXISTS workbench_task_attempts (
    task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    finished INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (task_id, attempt)
  )`.pipe(Effect.orDie)
  yield* client`CREATE INDEX IF NOT EXISTS workbench_task_attempts_by_session ON workbench_task_attempts (session_id, finished)`.pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<TaskStore, never, SqlClient.SqlClient> = Layer.effect(TaskStore, sqlWithTables)
