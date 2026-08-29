import { Effect, HashMap, Option, Semaphore, TxRef } from "effect"
import type * as Sandbox from "../../sandbox/Sandbox.js"

/**
 * One write lock per file, shared by every toolkit in the process.
 *
 * Ported in design from Pi's `file-mutation-queue.ts`
 * (earendil-works/pi @ dcd461925db2edf69a43c8135db1180d418afd54), which keys
 * on the canonical path and drops a queue once it drains. Two divergences:
 *
 * - Pi's "if the queue is still ours, delete it" is two steps that the
 *   single-threaded event loop makes one. Fibres give no such guarantee, so
 *   the registry is a `TxRef`: "last holder leaves" and "entry removed" are
 *   one commit, and there is no instant at which a waiter can see an entry
 *   that is about to vanish. The holder count rises *before* the permit is
 *   taken and falls *after* it is released, so an entry outlives everyone
 *   queued behind it.
 * - Pi's state is per environment. This one is module-global on purpose: two
 *   toolkit instances over one workspace -- or the `/coding` and `/pi`
 *   toolkits side by side -- must serialise, and a per-layer registry would
 *   quietly trade that guarantee for a runtime-wide one.
 *
 * The key is `Sandbox.canonical`, so two names for one file (a symlink, a
 * differently-cased spelling) take the same lock. Built with `makeUnsafe`:
 * module-level construction with no yield point, so no fibre can observe a
 * half-initialised registry.
 */
interface LockEntry {
  readonly semaphore: Semaphore.Semaphore
  /** Fibres holding the permit or queued behind it. Zero means evictable. */
  readonly holders: number
}

const editLocks: TxRef.TxRef<HashMap.HashMap<string, LockEntry>> =
  TxRef.makeUnsafe(HashMap.empty<string, LockEntry>())

/**
 * Join the queue for a key's lock, creating it if this is the first holder.
 *
 * One transaction, so two fibres racing for an absent key cannot both publish
 * a semaphore -- the loser sees the winner's.
 */
const acquireLock = (key: string): Effect.Effect<Semaphore.Semaphore> =>
  TxRef.modify(editLocks, (map) => {
    const existing = HashMap.get(map, key)
    if (Option.isSome(existing)) {
      const entry = existing.value
      return [
        entry.semaphore,
        HashMap.set(map, key, { ...entry, holders: entry.holders + 1 })
      ]
    }
    const semaphore = Semaphore.makeUnsafe(1)
    return [semaphore, HashMap.set(map, key, { semaphore, holders: 1 })]
  })

/** Leave the queue, dropping the entry when nobody is left. */
const releaseLock = (key: string): Effect.Effect<void> =>
  TxRef.update(editLocks, (map) => {
    const existing = HashMap.get(map, key)
    if (Option.isNone(existing)) return map
    const holders = existing.value.holders - 1
    return holders <= 0
      ? HashMap.remove(map, key)
      : HashMap.set(map, key, { ...existing.value, holders })
  })

/**
 * Run an effect under a file's write lock.
 *
 * The key is the sandbox's canonical name for the path, so two spellings of
 * one file take the same lock.
 *
 * **A `canonical` failure fails the operation; it does not fall back.** The
 * earlier version substituted the spelled path, reasoning that the operation
 * was about to fail with the same error anyway. That holds for a *permanent*
 * failure like a path escaping the workspace, and not for a transient one --
 * `local.ts` implements `canonical` as a filesystem `stat`, which can fail
 * because an ancestor directory is briefly absent, on an EINTR, or on a
 * momentary permissions error. When that happened to one fibre and not
 * another, the two took different keys for the same file and the mutual
 * exclusion this module exists to provide silently disappeared: two writers
 * proceeding at once, with no error and nothing observable from outside.
 *
 * Trading a visible error for a silent correctness hole is the wrong side of
 * that trade. Where the operation really was about to fail, surfacing the
 * error here costs nothing and loses no behaviour.
 *
 * `acquireUseRelease` rather than a bare `withPermit`, so the holder count is
 * decremented even when the caller is interrupted while waiting or mid-edit.
 * A leaked count would pin the entry forever.
 */
export const withFileLock = <A, E, R>(
  sandbox: Sandbox.Sandbox,
  path: Sandbox.SandboxPath,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | Sandbox.FileError, R> =>
  Effect.flatMap(
    sandbox.canonical(path),
    (key) =>
      Effect.acquireUseRelease(
        acquireLock(key),
        (semaphore) => semaphore.withPermit(effect),
        () => releaseLock(key)
      )
  )

/**
 * How many files currently hold a lock entry.
 *
 * Exported for the test that asserts the registry drains. The leak this
 * replaced was invisible from outside, and an invariant nobody can observe is
 * one nobody can defend.
 */
export const lockRegistrySize: Effect.Effect<number> = Effect.map(
  TxRef.get(editLocks),
  HashMap.size
)
