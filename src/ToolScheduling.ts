import { Context, Effect, Layer, Option, Ref, Semaphore } from "effect"
import * as Namespace from "./internal/namespace.js"

/**
 * Host scheduling: constraints the *deployment* puts on tool execution, beside
 * the ones the *agent* declares.
 *
 * The agent's `ToolExecution` strategy says how concurrently one response's
 * calls may run -- "up to eight at once". It cannot say what only the host
 * knows: that `book_room` must never overlap another `book_room` on this
 * machine, or that this deployment's database takes four writers at most.
 * And a strategy is scoped to one response, so it cannot serialize across
 * turns or sessions at all (`ToolExecution.perTool`'s own caveat).
 *
 * A `ToolScheduling` wraps each call's execution. **It can only make a call
 * wait, never start one**: the harness still decides which calls run and how
 * many at once, and a scheduling only holds some of them back. So host
 * scheduling tightens the agent's concurrency and cannot widen it -- by
 * construction, not by convention. Actual execution is the intersection of
 * the two.
 *
 * Provided by the host as a layer, and ambient: the default constrains
 * nothing, which is the safe direction for a default -- its absence can only
 * mean *more* waiting was not asked for, never that a guarantee was silently
 * dropped.
 *
 * The wait happens before `ToolCallStarted`: a call is announced when it
 * runs, not while it queues.
 */
export interface ToolScheduling {
  /** Hold `run` back as this host requires; run it unchanged otherwise. */
  readonly around: (call: Call) => <A, E, R>(run: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** What this scheduling does, as data, for `describe` and for an audit. */
  readonly description: Description
}

/** The part of a call a scheduling decides by. `params` are as the model sent them (encoded). */
export interface Call {
  readonly name: string
  readonly params: unknown
}

export type Description =
  | { readonly _tag: "Unconstrained" }
  | { readonly _tag: "Serialize"; readonly name: string }
  | { readonly _tag: "MaxConcurrent"; readonly max: number }
  | { readonly _tag: "All"; readonly schedulings: ReadonlyArray<Description> }

/** Nothing held back. The default. */
export const unconstrained: ToolScheduling = {
  around: () => (run) => run,
  description: { _tag: "Unconstrained" }
}

/**
 * The scheduling in effect for tool calls made on this fibre.
 *
 * A `Context.Reference` with a default that constrains nothing, so a
 * deployment that provides none behaves exactly as before.
 */
export const Current = Context.Reference<ToolScheduling>(Namespace.tag("ToolScheduling/Current"), {
  defaultValue: () => unconstrained
})

/** Provide a scheduling to everything built on this layer. */
export const layer = (scheduling: ToolScheduling): Layer.Layer<never> => Layer.succeed(Current, scheduling)

/**
 * Calls that share a key never overlap; calls with no key are untouched.
 *
 * ```ts
 * ToolScheduling.serialize("rooms", (call) =>
 *   call.name === "book_room" ? "rooms" : undefined
 * )
 * ```
 *
 * One lock per key, shared by every session and turn that uses this value:
 * build it once per process, at the edge, and provide it. `name` labels it in
 * `description`.
 */
export const serialize = (
  name: string,
  keyOf: (call: Call) => string | undefined
): ToolScheduling => {
  const locks = new Map<string, Semaphore.Semaphore>()
  const lockFor = (key: string): Semaphore.Semaphore => {
    const existing = locks.get(key)
    if (existing !== undefined) return existing
    // Created synchronously, so two calls asking for the same key at once
    // cannot each make a lock of their own.
    const created = Semaphore.makeUnsafe(1)
    locks.set(key, created)
    return created
  }
  return {
    around: (call) => (run) => {
      const key = keyOf(call)
      return key === undefined ? run : Semaphore.withPermit(lockFor(key), run)
    },
    description: { _tag: "Serialize", name }
  }
}

/**
 * At most `max` tool calls run at once, across every session and turn that
 * uses this value. Build it once per process and provide it.
 */
export const maxConcurrent = (max: number): ToolScheduling => {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new RangeError("ToolScheduling.maxConcurrent: max must be a positive integer")
  }
  const permits = Semaphore.makeUnsafe(max)
  return {
    around: () => (run) => Semaphore.withPermit(permits, run),
    description: { _tag: "MaxConcurrent", max }
  }
}

/**
 * Every constraint at once: a call waits for each, in the order given.
 *
 * Order matters for liveness, as it does for any set of locks: keep one
 * order everywhere, typically the narrowest constraint first.
 */
export const all = (...schedulings: ReadonlyArray<ToolScheduling>): ToolScheduling => ({
  around: (call) => (run) =>
    schedulings.reduceRight((inner, scheduling) => scheduling.around(call)(inner), run),
  description: { _tag: "All", schedulings: schedulings.map((scheduling) => scheduling.description) }
})

/**
 * A scheduling re-created from its description, or `None` when the
 * description does not carry enough: `Serialize` keys calls by a function it
 * has no data form for. What comes back holds calls back as the described
 * one did, with its own permits: a re-created `maxConcurrent` bounds the
 * calls made through it, not the host-wide ones the original also counted.
 * For durable recovery (item 105), combined with the running host's.
 */
export const fromDescription = (described: Description): Option.Option<ToolScheduling> => {
  switch (described._tag) {
    case "Unconstrained":
      return Option.some(unconstrained)
    case "MaxConcurrent":
      return Option.some(maxConcurrent(described.max))
    case "All":
      return Option.map(Option.all(described.schedulings.map(fromDescription)), (schedulings) => all(...schedulings))
    case "Serialize":
      return Option.none()
  }
}

/**
 * A scheduling whose every call goes to what `ref` holds, described as
 * `description` -- so a durable body can be run under it before recovery has
 * decided which scheduling that is.
 */
export const delegating = (ref: Ref.Ref<ToolScheduling>, description: Description): ToolScheduling => ({
  around: (call) => (run) => Effect.flatMap(Ref.get(ref), (scheduling) => scheduling.around(call)(run)),
  description
})
