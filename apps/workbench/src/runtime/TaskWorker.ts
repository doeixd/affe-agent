/**
 * The worker over the operational queue (plan-agent-product-control-plane.md
 * §9): claims queued tasks under a lease and starts them through
 * `TaskRunner`, with bounded retries.
 *
 * The queue's job is only to *start* an attempt reliably. Once one is in
 * flight the attempt is a durable session and its task settles from the
 * session's events, as every task does; the work item is completed then. A
 * start that fails -- the host refused the submit, the store was
 * unreachable -- releases the item with a backoff, until `maxClaims`, after
 * which the task is marked failed and the item is dropped. A worker that
 * dies mid-start leaves a lease that runs out, and another worker claims
 * the item: at-least-once for starting, which is safe because a task
 * already attempted refuses a second start while it runs.
 */
import { Duration, Effect, Option, Result, Schedule } from "effect"
import * as Task from "../domain/Task.js"
import { TaskStore } from "../store/TaskStore.js"
import { WorkQueue } from "../store/WorkQueue.js"
import type { Item } from "../store/WorkQueue.js"
import { TaskAttempts } from "./TaskRunner.js"
import * as TaskRunner from "./TaskRunner.js"

export interface Options {
  /** A name for the lease. Two workers with one name would take each other's items. */
  readonly worker: string
  /** How long a claim holds before another worker may take the item. Default 30 seconds. */
  readonly lease?: Duration.Input | undefined
  /** How often to look for due items. Default 500 milliseconds. */
  readonly poll?: Duration.Input | undefined
  /** How many items to start per poll. Default 4. */
  readonly batch?: number | undefined
  /** How long to wait before retrying a failed start, per claim so far. Default 1s, 5s, 30s, then 30s. */
  readonly backoff?: ((claims: number) => Duration.Input) | undefined
}

export const defaultMaxClaims = 5

const defaultBackoff = (claims: number): Duration.Input =>
  claims <= 1 ? Duration.seconds(1) : claims === 2 ? Duration.seconds(5) : Duration.seconds(30)

/** Put a task on the queue and mark it ready. Refused while it runs. */
export const enqueue = Effect.fn("TaskWorker.enqueue")(function*(task: Task.Record, options?: { readonly maxClaims?: number | undefined }) {
  const tasks = yield* TaskStore
  const queue = yield* WorkQueue
  if (!Task.canStart(task.status)) {
    return yield* new TaskRunner.TaskNotStartableError({ taskId: task.id, status: task.status })
  }
  const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  const item = yield* queue.enqueue({
    taskId: task.id,
    ownerId: task.ownerId,
    priority: task.priority,
    maxClaims: options?.maxClaims ?? defaultMaxClaims,
    availableAt: now,
    now
  })
  yield* tasks.setStatus(task.id, "ready")
  return item
})

/** Take a queued task back off the queue, as canceled. Nothing happens to a task that is not queued. */
export const dequeue = Effect.fn("TaskWorker.dequeue")(function*(task: Task.Record) {
  const tasks = yield* TaskStore
  const queue = yield* WorkQueue
  const item = yield* queue.forTask(task.id)
  if (Option.isNone(item)) return false
  yield* queue.complete(item.value.id)
  if (task.status === "ready") yield* tasks.setStatus(task.id, "canceled")
  return true
})

/** One claimed item: start its task, and settle the item by what happened. */
const attempt = (options: Options) =>
  Effect.fn("TaskWorker.attempt")(function*(item: Item) {
    const tasks = yield* TaskStore
    const queue = yield* WorkQueue
    const task = yield* tasks.get(item.taskId)
    if (Option.isNone(task)) {
      // The task went away while queued; nothing to start.
      yield* queue.complete(item.id)
      return
    }
    if (Task.isLive(task.value.status)) {
      // Already attempted -- a previous claim's start landed before its lease ran out. Done.
      yield* queue.complete(item.id)
      return
    }
    const started = yield* Effect.result(TaskRunner.start(task.value))
    if (Result.isSuccess(started)) {
      yield* queue.complete(item.id)
      return
    }
    yield* Effect.logWarning("workbench: a queued task could not be started", { taskId: item.taskId, claims: item.claims, error: started.failure })
    if (item.claims >= item.maxClaims) {
      yield* queue.complete(item.id)
      yield* tasks.setStatus(item.taskId, "failed").pipe(Effect.catchTag("TaskNotFoundError", () => Effect.void))
      return
    }
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const delay = (options.backoff ?? defaultBackoff)(item.claims)
    yield* queue.release(item.id, now + Duration.toMillis(delay))
    // Back on the queue, so back to ready: the failed attempt is recorded, the task is not given up on.
    yield* tasks.setStatus(item.taskId, "ready").pipe(Effect.catchTag("TaskNotFoundError", () => Effect.void))
  })

/** One poll: claim what is due and attempt each. Answers how many were claimed. */
export const tick = (options: Options) =>
  Effect.gen(function*() {
    const queue = yield* WorkQueue
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    const claimed = yield* queue.claim({
      worker: options.worker,
      now,
      leaseMillis: Duration.toMillis(options.lease ?? Duration.seconds(30)),
      limit: options.batch ?? 4
    })
    yield* Effect.forEach(claimed, attempt(options), { discard: true })
    return claimed.length
  })

/**
 * Poll forever. A tick that fails -- the queue unreachable -- is logged and
 * the next one runs; interruption on shutdown stops it without a log.
 */
export const run = (
  options: Options
): Effect.Effect<never, never, TaskStore | WorkQueue | TaskAttempts> =>
  tick(options).pipe(
    Effect.catchCause((cause) => Effect.logError("workbench: the task worker's poll failed", cause)),
    Effect.repeat(Schedule.spaced(options.poll ?? Duration.millis(500))),
    Effect.flatMap(() => Effect.never)
  )
