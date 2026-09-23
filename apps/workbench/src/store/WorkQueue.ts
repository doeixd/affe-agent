/**
 * The operational queue (plan-agent-product-control-plane.md §9): tasks
 * waiting for a worker to start them, with leases and bounded retries.
 *
 * Not the kernel's `JobStore`, on purpose: that one is at-most-once and
 * hands jobs out without ever hearing back, which its own note says rules
 * leases out. A work item here is claimed under a lease, completed when
 * the attempt is in flight, released with a delay when starting it failed,
 * and reclaimable by anyone once its lease has run out -- at-least-once
 * for *starting* an attempt, which is idempotent enough: an attempt that
 * started is a durable session, and a second start on the same task is
 * refused by the runner while it runs.
 *
 * One item per task at a time; queuing a task that is already queued is
 * the same item.
 */
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { TaskId, UserId, WorkItemId } from "../domain/WorkbenchIds.js"
import { failedAs } from "./WorkbenchStorageError.js"
import type { WorkbenchStorageError } from "./WorkbenchStorageError.js"

export const Item = Schema.Struct({
  id: WorkItemId,
  taskId: TaskId,
  ownerId: UserId,
  /** Higher is claimed first; equal priority is oldest first. */
  priority: Schema.Int,
  /** How many times it has been claimed. */
  claims: Schema.Int,
  /** After this many failed starts it is not retried. */
  maxClaims: Schema.Int,
  /** Epoch milliseconds: not claimable before. */
  availableAt: Schema.Number,
  leaseOwner: Schema.Option(Schema.String),
  /** Epoch milliseconds; the lease is over at or after this. */
  leaseUntil: Schema.Option(Schema.Number),
  createdAt: Schema.Number
})
export type Item = typeof Item.Type

export interface Enqueue {
  readonly taskId: TaskId
  readonly ownerId: UserId
  readonly priority: number
  readonly maxClaims: number
  readonly availableAt: number
  readonly now: number
}

export interface Claim {
  readonly worker: string
  readonly now: number
  readonly leaseMillis: number
  readonly limit: number
}

export interface Service {
  /** Idempotent per task: a task already queued keeps its item. Answers the item either way. */
  readonly enqueue: (input: Enqueue) => Effect.Effect<Item, WorkbenchStorageError>
  /**
   * Take up to `limit` items that are due and unleased (or whose lease has
   * run out), highest priority then oldest first, leasing each to `worker`
   * until `now + leaseMillis` and counting the claim.
   */
  readonly claim: (input: Claim) => Effect.Effect<ReadonlyArray<Item>, WorkbenchStorageError>
  /** Done: the attempt is in flight, or the item is given up on. Unknown ids change nothing. */
  readonly complete: (id: WorkItemId) => Effect.Effect<void, WorkbenchStorageError>
  /** Back in the queue, claimable at `availableAt`, lease cleared. */
  readonly release: (id: WorkItemId, availableAt: number) => Effect.Effect<void, WorkbenchStorageError>
  readonly forTask: (taskId: TaskId) => Effect.Effect<Option.Option<Item>, WorkbenchStorageError>
  /** Every item of this person's, in claim order. */
  readonly listFor: (owner: UserId) => Effect.Effect<ReadonlyArray<Item>, WorkbenchStorageError>
}

export class WorkQueue extends Context.Service<WorkQueue, Service>()("workbench/WorkQueue") {}

/** Highest priority first, then oldest. */
export const claimOrder = (a: Item, b: Item) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id)

export const isClaimable = (item: Item, now: number): boolean =>
  item.availableAt <= now && Option.match(item.leaseUntil, { onNone: () => true, onSome: (until) => until <= now })

const newItem = (input: Enqueue): Item => ({
  id: WorkItemId.make(globalThis.crypto.randomUUID()),
  taskId: input.taskId,
  ownerId: input.ownerId,
  priority: input.priority,
  claims: 0,
  maxClaims: input.maxClaims,
  availableAt: input.availableAt,
  leaseOwner: Option.none(),
  leaseUntil: Option.none(),
  createdAt: input.now
})

// -- Memory -----------------------------------------------------------------------------

export const memory: Layer.Layer<WorkQueue> = Layer.effect(
  WorkQueue,
  Effect.gen(function*() {
    const state = yield* Ref.make<ReadonlyMap<WorkItemId, Item>>(new Map())
    const update = (id: WorkItemId, change: (item: Item) => Option.Option<Item>) =>
      Ref.update(state, (items) => {
        const item = items.get(id)
        if (item === undefined) return items
        const next = new Map(items)
        Option.match(change(item), { onNone: () => next.delete(id), onSome: (changed) => next.set(id, changed) })
        return next
      })
    return WorkQueue.of({
      enqueue: (input) =>
        Ref.modify(state, (items): [Item, ReadonlyMap<WorkItemId, Item>] => {
          const existing = [...items.values()].find((item) => item.taskId === input.taskId)
          if (existing !== undefined) return [existing, items]
          const item = newItem(input)
          return [item, new Map(items).set(item.id, item)]
        }),
      claim: (input) =>
        Ref.modify(state, (items): [ReadonlyArray<Item>, ReadonlyMap<WorkItemId, Item>] => {
          const due = [...items.values()].filter((item) => isClaimable(item, input.now)).sort(claimOrder).slice(0, input.limit)
          const next = new Map(items)
          const claimed = due.map((item): Item => ({
            ...item,
            claims: item.claims + 1,
            leaseOwner: Option.some(input.worker),
            leaseUntil: Option.some(input.now + input.leaseMillis)
          }))
          for (const item of claimed) next.set(item.id, item)
          return [claimed, next]
        }),
      complete: (id) => update(id, () => Option.none()),
      release: (id, availableAt) =>
        update(id, (item) => Option.some({ ...item, availableAt, leaseOwner: Option.none(), leaseUntil: Option.none() })),
      forTask: (taskId) =>
        Effect.map(Ref.get(state), (items) => Option.fromNullishOr([...items.values()].find((item) => item.taskId === taskId))),
      listFor: (owner) =>
        Effect.map(Ref.get(state), (items) => [...items.values()].filter((item) => item.ownerId === owner).sort(claimOrder))
    })
  })
)

// -- SQL --------------------------------------------------------------------------------

const ItemJson = Schema.toCodecJson(Item)

const encode = (item: Item) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(ItemJson)(item), (encoded) => JSON.stringify(encoded)))

const decode = (text: string) =>
  Effect.flatMap(
    Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs("WorkQueue.decode") }),
    (json) => Effect.mapError(Schema.decodeUnknownEffect(ItemJson)(json), failedAs("WorkQueue.decode"))
  )

interface BodyRow {
  readonly body: string
}

/**
 * The body is the item; the columns beside it are what `claim` orders and
 * filters by. A claim is one transaction that reads the due rows and
 * writes their leases, so two workers polling the same table cannot both
 * take one item: SQLite serialises the writers.
 */
export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient

  const write = (item: Item) =>
    Effect.flatMap(encode(item), (body) =>
      client`INSERT INTO workbench_work_queue (id, task_id, owner_id, priority, available_at, lease_until, created_at, body)
        VALUES (${item.id}, ${item.taskId}, ${item.ownerId}, ${item.priority}, ${item.availableAt}, ${Option.getOrNull(item.leaseUntil)}, ${item.createdAt}, ${body})
        ON CONFLICT (id) DO UPDATE SET priority = excluded.priority, available_at = excluded.available_at, lease_until = excluded.lease_until, body = excluded.body`)

  const one = (rows: ReadonlyArray<BodyRow>) =>
    rows[0] === undefined ? Effect.succeed(Option.none<Item>()) : Effect.map(decode(rows[0].body), Option.some)

  const byId = (id: WorkItemId) =>
    Effect.flatMap(client<BodyRow>`SELECT body FROM workbench_work_queue WHERE id = ${id}`, one)

  const sqlFailed = (operation: string) =>
    <A, R>(effect: Effect.Effect<A, unknown, R>) => Effect.mapError(effect, failedAs(operation))

  return WorkQueue.of({
    enqueue: (input) =>
      client.withTransaction(Effect.gen(function*() {
        const existing = yield* Effect.flatMap(
          client<BodyRow>`SELECT body FROM workbench_work_queue WHERE task_id = ${input.taskId}`,
          one
        )
        if (Option.isSome(existing)) return existing.value
        const item = newItem(input)
        yield* write(item)
        return item
      })).pipe(sqlFailed("WorkQueue.enqueue")),
    claim: (input) =>
      client.withTransaction(Effect.gen(function*() {
        const rows = yield* client<BodyRow>`SELECT body FROM workbench_work_queue
          WHERE available_at <= ${input.now} AND (lease_until IS NULL OR lease_until <= ${input.now})
          ORDER BY priority DESC, created_at, id LIMIT ${input.limit}`
        const due = yield* Effect.forEach(rows, (row) => decode(row.body))
        const claimed = due.map((item): Item => ({
          ...item,
          claims: item.claims + 1,
          leaseOwner: Option.some(input.worker),
          leaseUntil: Option.some(input.now + input.leaseMillis)
        }))
        yield* Effect.forEach(claimed, write, { discard: true })
        return claimed
      })).pipe(sqlFailed("WorkQueue.claim")),
    complete: (id) =>
      client`DELETE FROM workbench_work_queue WHERE id = ${id}`.pipe(Effect.asVoid, sqlFailed("WorkQueue.complete")),
    release: (id, availableAt) =>
      client.withTransaction(Effect.gen(function*() {
        const found = yield* byId(id)
        if (Option.isNone(found)) return
        yield* write({ ...found.value, availableAt, leaseOwner: Option.none(), leaseUntil: Option.none() })
      })).pipe(sqlFailed("WorkQueue.release")),
    forTask: (taskId) =>
      Effect.flatMap(client<BodyRow>`SELECT body FROM workbench_work_queue WHERE task_id = ${taskId}`, one).pipe(
        sqlFailed("WorkQueue.forTask")
      ),
    listFor: (owner) =>
      client<BodyRow>`SELECT body FROM workbench_work_queue WHERE owner_id = ${owner} ORDER BY priority DESC, created_at, id`.pipe(
        sqlFailed("WorkQueue.listFor"),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.body)))
      )
  })
})

export const sqlWithTables: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_work_queue (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    priority INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    body TEXT NOT NULL
  )`.pipe(Effect.orDie)
  yield* client`CREATE INDEX IF NOT EXISTS workbench_work_queue_due ON workbench_work_queue (available_at, lease_until, priority)`.pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<WorkQueue, never, SqlClient.SqlClient> = Layer.effect(WorkQueue, sqlWithTables)
