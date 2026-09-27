import { Effect, Option, Ref, Schema } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

/**
 * What a supervisor must remember across its own death (item 138, slice 1;
 * [plan-supervision.md](../../docs/plan-supervision.md) §5).
 *
 * An in-process supervisor keeps its restart history and its children's
 * progress in memory, which is OTP's model: a supervisor that dies takes its
 * children with it, and its parent starts both again from scratch. That is
 * wrong for children whose work outlives the process -- a durable session
 * reached through an `AgentClient` keeps running after the supervisor that
 * asked for it is gone. Starting such a child again repeats work, and bills
 * it, that is already under way or done.
 *
 * So the ledger records, per child, what a restarted supervisor needs to
 * pick up where the dead one left off:
 * - `attempts`: how many starts there have been, which names each attempt's
 *   idempotency key;
 * - `current`: the attempt under way, opened before it submits anything,
 *   and the submission it waits on, recorded before the wait begins;
 * - `finished`: whether the child exited normally, so a restarted
 *   supervisor does not run it again unless it is `permanent`.
 *
 * And, per supervisor, the restart history its intensity limit counts, so a
 * supervisor restarted in a crash loop does not start every life with a
 * fresh allowance.
 *
 * `Supervisor.run` reads it through `Spec.ledger`, and `Supervisor.remoteTask`
 * is the child that uses the open attempt.
 */

export const ChildRecord = Schema.Struct({
  attempts: Schema.Number,
  /**
   * The attempt under way, opened before anything is submitted, with its
   * submission once there is one. An open attempt with no submission is one
   * whose supervisor died between opening it and recording what it
   * submitted, if it submitted at all: the next life reuses its key.
   */
  current: Schema.Option(Schema.Struct({ attempt: Schema.Number, submissionId: Schema.Option(Schema.String) })),
  finished: Schema.Boolean
})
export type ChildRecord = typeof ChildRecord.Type

export const empty: ChildRecord = { attempts: 0, current: Option.none(), finished: false }

/** The ledger could not be read or written. */
export class SupervisorLedgerError extends Schema.TaggedError<SupervisorLedgerError>()("SupervisorLedgerError", {
  operation: Schema.String,
  key: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `supervisor ledger: ${this.operation} ${this.key} failed: ${this.detail}`
  }
}

export interface SupervisorLedger {
  readonly child: (supervisor: string, id: string) => Effect.Effect<ChildRecord, SupervisorLedgerError>
  /** Replace one child's record with `f` of it. Each child's record is written only by its own starts and exits. */
  readonly update: (
    supervisor: string,
    id: string,
    f: (record: ChildRecord) => ChildRecord
  ) => Effect.Effect<ChildRecord, SupervisorLedgerError>
  /** The restart times the supervisor's intensity counts, in milliseconds. */
  readonly restarts: (supervisor: string) => Effect.Effect<ReadonlyArray<number>, SupervisorLedgerError>
  readonly setRestarts: (supervisor: string, at: ReadonlyArray<number>) => Effect.Effect<void, SupervisorLedgerError>
}

/** A ledger in memory: for tests, and for a supervisor restarted within one process. */
interface MemoryState {
  readonly children: ReadonlyMap<string, ChildRecord>
  readonly restarts: ReadonlyMap<string, ReadonlyArray<number>>
}

export const memory: Effect.Effect<SupervisorLedger> = Effect.map(
  Ref.make<MemoryState>({ children: new Map(), restarts: new Map() }),
  (state): SupervisorLedger => {
    const key = (supervisor: string, id: string) => `${supervisor}\u0000${id}`
    return {
      child: (supervisor, id) => Effect.map(Ref.get(state), (s) => s.children.get(key(supervisor, id)) ?? empty),
      update: (supervisor, id, f) =>
        Ref.modify(state, (s): [ChildRecord, MemoryState] => {
          const next = f(s.children.get(key(supervisor, id)) ?? empty)
          return [next, { ...s, children: new Map(s.children).set(key(supervisor, id), next) }]
        }),
      restarts: (supervisor) => Effect.map(Ref.get(state), (s) => s.restarts.get(supervisor) ?? []),
      setRestarts: (supervisor, at) =>
        Ref.update(state, (s) => ({ ...s, restarts: new Map(s.restarts).set(supervisor, at) }))
    }
  }
)

const Restarts = Schema.Array(Schema.Number)

/**
 * A ledger over any `KeyValueStore`: memory, the filesystem, SQL or web
 * storage. One key per child and one per supervisor's restart history, so a
 * child's update never rewrites another's record.
 */
export const keyValue = (
  kv: KeyValueStore.KeyValueStore,
  options?: {
    /** Namespace, so several ledgers can share one backing. Default `supervisor`. */
    readonly prefix?: string | undefined
  }
): SupervisorLedger => {
  const scoped = KeyValueStore.prefix(kv, `${options?.prefix ?? "supervisor"}:`)
  const children = KeyValueStore.toSchemaStore(scoped, ChildRecord)
  const restarts = KeyValueStore.toSchemaStore(scoped, Restarts)
  const childKey = (supervisor: string, id: string) => `${encodeURIComponent(supervisor)}/child/${encodeURIComponent(id)}`
  const restartsKey = (supervisor: string) => `${encodeURIComponent(supervisor)}/restarts`
  const fail = (operation: string, key: string) => (cause: unknown) =>
    new SupervisorLedgerError({ operation, key, detail: cause instanceof Error ? cause.message : String(cause) })

  const child = (supervisor: string, id: string) =>
    children.get(childKey(supervisor, id)).pipe(
      Effect.map(Option.getOrElse(() => empty)),
      Effect.mapError(fail("read", childKey(supervisor, id)))
    )
  return {
    child,
    update: (supervisor, id, f) =>
      Effect.flatMap(child(supervisor, id), (current) => {
        const next = f(current)
        return children.set(childKey(supervisor, id), next).pipe(
          Effect.as(next),
          Effect.mapError(fail("write", childKey(supervisor, id)))
        )
      }),
    restarts: (supervisor) =>
      restarts.get(restartsKey(supervisor)).pipe(
        Effect.map(Option.getOrElse((): ReadonlyArray<number> => [])),
        Effect.mapError(fail("read", restartsKey(supervisor)))
      ),
    setRestarts: (supervisor, at) =>
      restarts.set(restartsKey(supervisor), at).pipe(Effect.mapError(fail("write", restartsKey(supervisor))))
  }
}
