import { Cause, Effect, Schema } from "effect"
import { PersistedQueue } from "effect/unstable/persistence"
import * as AgentClient from "../client/AgentClient.js"
import * as PromptWire from "../PromptWire.js"

/**
 * Where background work reaches a conversation.
 *
 * `effect-plan-2.txt` §1–§5. A process exits, a monitor goes healthy, an
 * import finishes: each is a completion that happened *outside* any
 * submission and has to reach the session that cares about it. Without a
 * seam for that, the producer's only options are to hold a session handle
 * for the lifetime of the work -- which a process outliving its tool call
 * cannot do -- or to invent its own retry and de-duplication.
 *
 * ## The rule this module exists to enforce
 *
 * **A ping-back is future session input, never implicitly a follow-up.**
 * §5 argues it with an example worth keeping in mind:
 *
 * ```text
 * submission A: "research competitors"   → starts background task X
 * submission B: "actually, let's do payroll"
 * X finishes
 * ```
 *
 * If a completion attached itself to whatever happens to be running, the
 * competitor research lands in the payroll conversation. Timing would decide
 * meaning, which is never a property worth having. So a delivery either
 * starts a **new submission** on an idle session or it waits; it never joins
 * a submission in flight. Attaching to the originating submission is
 * expressible later by storing its id and asking for it explicitly, and that
 * is the point -- explicitly.
 *
 * ## What it is not
 *
 * `/scheduling`'s `AgentDispatcher` is the thing this resembles and is not.
 * That starts *independent* work -- an `Agent.run` of its own, with no
 * conversation behind it. This resumes an existing one. Both exist; §5 is
 * emphatic that they stay separate, because merging them would make "does
 * this belong to a conversation?" a runtime accident.
 *
 * ## Idempotency is the item's identity
 *
 * `Item.id` is an idempotency key, and the examples in §1 are the shape to
 * follow: `process:proc-123:exit`, `monitor:deploy-health:healthy`,
 * `job:invoice-import:completed`. It is enforced twice over, deliberately.
 * `PersistedQueue.offer` ignores an id already queued, so observing the same
 * completion twice enqueues once; and the delivery submits under that same id
 * as its `idempotencyKey`, so a redelivery after a crash is the same request
 * rather than a second one. A producer that can only promise "at least once"
 * is therefore safe to write, which is the only kind of producer there is.
 *
 * ## The boundary, stated
 *
 * An item carries a **prompt**. An agent that declares a typed input
 * (`AgentInput`) cannot be fed from here yet: the queue would have to carry
 * the encoded value and the delivery decode it with that session's schema,
 * which is the same widening `remaining-work.md` item 46 describes for every
 * other surface. Named here rather than discovered later.
 */

/** A completion waiting to reach a session. */
export const Item = Schema.Struct({
  /**
   * The idempotency key, and the item's whole identity.
   *
   * Two observations of one completion must produce the same string, which is
   * why the convention is `<kind>:<id>:<event>` rather than anything
   * generated. A uuid here would defeat the mechanism.
   */
  id: Schema.String,
  sessionId: Schema.String,
  /** What the session is prompted with when this is delivered. */
  input: PromptWire.Prompt,
  /** Who observed the completion. Carried for the reader, never interpreted. */
  source: Schema.Struct({
    kind: Schema.String,
    id: Schema.optional(Schema.String)
  }),
  createdAt: Schema.Number
})

export type Item = typeof Item.Type

/** The queue would not take it, or would not give it back. */
export class InboxError extends Schema.TaggedError<InboxError>()("InboxError", {
  operation: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `session inbox: ${this.operation} failed: ${this.detail}`
  }
}

/**
 * The session was still running when its turn came.
 *
 * Not a failure of the item: it is the ordinary case for a session that is
 * mid-conversation, and the queue's own retry is what handles it. It carries
 * the session so a log line says which one.
 */
export class SessionBusyError extends Schema.TaggedError<SessionBusyError>()("SessionBusyError", {
  sessionId: Schema.String,
  /**
   * The item that could not be delivered.
   *
   * Carried because of where this error ends up: `PersistedQueue.take`
   * surfaces it only once the attempts are spent, by which point the item is
   * out of the queue and this is the last thing holding it. Without it there
   * is nothing to hand `onUndeliverable` but an id.
   */
  item: Item
}) {
  get message(): string {
    return `session ${this.sessionId} is running; the completion stays queued for a later attempt`
  }
}

/**
 * What became of one delivery.
 *
 * The distinction is the queue's retry, and it is why this is a value rather
 * than an error. `PersistedQueue.take` retries whatever fails, so a failure
 * means "try again": right for a session that is merely busy, wrong for one
 * that is closed or absent, where ten identical attempts learn nothing the
 * first did not. An undeliverable item therefore *succeeds* -- it is consumed
 * and reported -- and only the transient cases fail.
 */
export type Outcome =
  | { readonly _tag: "Delivered"; readonly item: Item }
  | { readonly _tag: "Undeliverable"; readonly item: Item; readonly reason: string }

export interface Options {
  /**
   * The queue's name, and so its identity in the store. Default
   * `effect-agent/session-inbox`.
   */
  readonly name?: string | undefined
  /**
   * How many times a *transient* failure is retried before the item is given
   * up on. Default 10, which is `PersistedQueue`'s own default.
   *
   * This is the *wait*, and it is the queue's rather than ours on purpose. A
   * busy session fails its delivery immediately and the queue schedules the
   * next attempt; polling inside the delivery instead would duplicate that
   * machinery and hold a queue slot while doing nothing. Raise it for
   * conversations that stay busy for a long time.
   */
  readonly maxAttempts?: number | undefined
}

export interface Service {
  /**
   * Record a completion for a session.
   *
   * Idempotent on `item.id`: the same completion observed twice is enqueued
   * once. Returns once the item is durable, not once it is delivered.
   */
  readonly enqueue: (item: Item) => Effect.Effect<void, InboxError>
  /**
   * Deliver one item, waiting until one is available.
   *
   * There is deliberately no `run` loop here. One was written and removed:
   * a forked loop over this could not be torn down cleanly in a test, and
   * shipping a shutdown path nothing exercises is how the rest of this
   * module's bugs were found. The loop a caller wants is
   * `Effect.forever(Effect.flatMap(inbox.deliver, report))`, three lines they
   * own and can stop, and it keeps the reporting decision -- what to do with
   * an `Undeliverable` -- with the caller who has somewhere to put it.
   *
   * Answers `Delivered` when a submission has been started, and
   * `Undeliverable` when the target cannot ever receive it. A busy session is
   * neither: it fails the attempt so the queue schedules another, and only
   * surfaces as `SessionBusyError` once `maxAttempts` are spent.
   */
  readonly deliver: Effect.Effect<Outcome, InboxError | SessionBusyError>
}

/**
 * The inbox over a `PersistedQueue` and an `AgentClient`.
 *
 * The queue is the durability and the de-duplication; the client is how a
 * delivery reaches a session, which means the inbox works over any transport
 * the client does -- in-process, HTTP, durable -- without knowing which.
 */
export const make = Effect.fn("SessionInbox.make")(function*(options?: Options) {
  const client = yield* AgentClient.AgentClient
  const queue = yield* PersistedQueue.make({
    name: options?.name ?? "effect-agent/session-inbox",
    schema: Item
  })
  const maxAttempts = options?.maxAttempts ?? 10
  const fail = (operation: string) => (cause: unknown) =>
    new InboxError({ operation, detail: String(cause) })

  const undeliverable = (item: Item, reason: string): Outcome => ({ _tag: "Undeliverable", item, reason })

  const enqueue: Service["enqueue"] = (item) =>
    queue.offer(item, { id: item.id }).pipe(
      Effect.asVoid,
      Effect.mapError(fail("enqueue"))
    )

  /**
   * One delivery: wait for the session to be idle, then submit under the
   * item's own id.
   *
   * `submit` rather than `prompt` because the inbox's job ends when the work
   * is admitted; waiting for the answer would make one slow conversation
   * block every other session's completions.
   */
  const deliverItem = (item: Item) =>
    Effect.gen(function*() {
      // An absent session is permanent as far as this item is concerned:
      // the id was wrong, or the session is long gone. Consumed and
      // reported, not retried.
      const found = yield* Effect.exit(client.session(item.sessionId))
      if (found._tag === "Failure") {
        return undeliverable(
          item,
          `session ${item.sessionId} could not be reached: ${Cause.pretty(found.cause)}`
        )
      }
      const session = found.value
      // Busy means "not now", and saying so immediately is the whole
      // interaction with the queue: the attempt fails, the item stays
      // queued, and the queue decides when to try again. Waiting here
      // instead would hold a slot open doing nothing and reimplement the
      // backoff the queue already has.
      const settled = yield* session.status.pipe(
        Effect.mapError(fail(`status ${item.sessionId}`)),
        Effect.flatMap((status) =>
          status === "running"
            ? Effect.fail(new SessionBusyError({ sessionId: item.sessionId, item }))
            : Effect.succeed(status)
        )
      )
      // A closed session is not busy and never will be idle, so retrying is
      // pointless in the same way.
      if (settled === "closed") {
        return undeliverable(item, `session ${item.sessionId} is closed`)
      }
      // `submit`, not `prompt`: the inbox's job ends when the work is
      // admitted. Waiting for the answer would let one slow conversation
      // hold up every other session's completions.
      //
      // The idempotency key is the item's own id, so a redelivery after a
      // crash between the submit and the queue's acknowledgement is the same
      // request rather than a second one.
      // A submit that fails here is left transient on purpose: the session
      // was idle a moment ago, so the likeliest cause is another submission
      // winning the race, and that is worth another attempt. The idempotency
      // key makes the retry the same request rather than a second one.
      yield* session.submit(item.input, { idempotencyKey: item.id }).pipe(
        Effect.mapError(fail(`submit ${item.id}`))
      )
      return { _tag: "Delivered", item } as const
    })

  const deliver: Service["deliver"] = queue.take((item) => deliverItem(item), { maxAttempts }).pipe(
    Effect.mapError((error) =>
      error instanceof InboxError || error instanceof SessionBusyError
        ? error
        : new InboxError({ operation: "deliver", detail: String(error) })
    )
  )

  return { enqueue, deliver } satisfies Service
})

