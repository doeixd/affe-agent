import { Effect, Ref, Schema } from "effect"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"
import type * as InputChannel from "../InputChannel.js"

/**
 * Steering and follow-up input, persisted per drain.
 *
 * This is the seam PLAN §16.2 exists for. A durable replay returns persisted
 * model and tool results, so a turn re-derives the prompt it derived the first
 * time — unless it drains a queue, which on replay is empty. The turn would
 * then derive a *different* prompt from the one whose model result is being
 * replayed, and canonical history would silently diverge from the journal.
 *
 * Making each drain an `Activity` fixes the batch a turn consumed, so replay
 * hands back the same one.
 */

/**
 * The offered-input side, which lives outside the workflow.
 *
 * Input arrives out-of-band — from an HTTP handler, a cluster message — and
 * must survive until the workflow drains it. The backing store is supplied by
 * the caller so that this module does not dictate one; `memoryStore` is enough
 * for a single process, and a cluster deployment substitutes a shared store.
 */
export interface Store {
  readonly offer: (key: string, input: string) => Effect.Effect<void>
  readonly takeAll: (key: string) => Effect.Effect<ReadonlyArray<string>>
  readonly size: (key: string) => Effect.Effect<number>
}

/**
 * An in-process store. Suitable for tests and single-node development.
 *
 * Note what is and is not durable here. Each *drain* is journalled as an
 * activity, so replay is consistent — a resumed turn sees the batch it
 * originally consumed. But input that was offered and not yet drained lives
 * only in this map, so it does not survive a restart. A deployment that must
 * not lose queued steering needs a shared, persistent `Store`.
 */
export const memoryStore: Effect.Effect<Store> = Effect.map(
  Ref.make(new Map<string, Array<string>>()),
  (ref): Store => ({
    offer: (key, input) =>
      Ref.update(ref, (map) => {
        const next = new Map(map)
        next.set(key, [...(next.get(key) ?? []), input])
        return next
      }),
    takeAll: (key) =>
      Ref.modify(ref, (map) => {
        const pending = map.get(key) ?? []
        if (pending.length === 0) return [pending, map]
        const next = new Map(map)
        next.set(key, [])
        return [pending, next]
      }),
    size: (key) => Ref.get(ref).pipe(Effect.map((m) => (m.get(key) ?? []).length))
  })
)

const inputs = Schema.Array(Schema.String)

/**
 * Build channels whose drains are activities.
 *
 * `drainIndex` makes each drain's activity name unique and replay-stable. The
 * channel is not told the current run and turn — it is constructed once per
 * session — so the ordinal of the drain is used instead. That is sound because
 * drains happen in a fixed order within a submission: one per turn boundary.
 */
export const factory = (
  store: Store
): Effect.Effect<
  InputChannel.Factory,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()

    return {
      make: (sessionId, name) =>
        Effect.map(Ref.make(0), (drainIndex): InputChannel.InputChannel => {
          const key = `${sessionId}:${name}`
          return {
            offer: (input) => store.offer(key, input),
            size: store.size(key),
            drain: Effect.gen(function* () {
              const index = yield* Ref.getAndUpdate(drainIndex, (n) => n + 1)
              return yield* Activity.make({
                name: `${name}-drain-${index}`,
                success: inputs,
                execute: store.takeAll(key)
              }).pipe(Effect.provide(workflowContext))
            })
          }
        })
    }
  })
