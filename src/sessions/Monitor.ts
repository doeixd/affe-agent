import { Clock, Effect, Option, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { PersistedQueue } from "effect/unstable/persistence"
import type * as AgentEvent from "../AgentEvent.js"
import * as AgentClient from "../client/AgentClient.js"
import * as Messaging from "./Messaging.js"
import * as SessionInbox from "./SessionInbox.js"

/**
 * One session told when another goes down
 * ([plan-supervision.md](../../docs/plan-supervision.md) §3).
 *
 * `watch` reads the target's events through `AgentClient` and turns each
 * terminal failure into a framework item in the watcher's inbox:
 *
 * - `SubmissionFailed`: the submission ended with a failure;
 * - `SubmissionInterrupted`: it was interrupted;
 * - `SessionClosed`: the session itself is gone.
 *
 * A completed submission is not a `down`. OTP's monitors fire when a process
 * exits, and an agent that answered has not exited.
 *
 * **The item id is the event's, for this watcher.** It is
 * `down:<watcher>:<target>:<submission>`, or `down:<watcher>:<target>:closed`.
 * The same event seen twice for one watcher (two monitors, or a watch resumed
 * from a cursor) enqueues once. Two watchers of one target each get their
 * own: the queue drops a repeated id, so an id without the watcher would tell
 * only the first.
 *
 * **One pump.** By default the item goes onto `Messaging`'s queue, so the
 * loop that delivers messages also delivers these, and the watcher's model
 * reads each one only when it is idle, as it does a message.
 *
 * **Live, unless given a cursor.** A watch sees what happens after it attaches.
 * Over a client whose `events({ after })` resumes, which is the durable
 * client, `after` makes it gapless. The in-process client cannot resume and
 * says so.
 */

/** What went down, as the watcher's model reads it. */
export interface Down {
  readonly target: string
  readonly reason: "failed" | "interrupted" | "closed"
  /** The submission that ended, when the event names one. */
  readonly submissionId: Option.Option<string>
  /** Why it failed, for `"failed"`: the event's lossy projection of the cause. */
  readonly failure: Option.Option<AgentEvent.Failure>
  /** The event's sequence in the target session, unique within it. */
  readonly sequence: number
}

/** The default rendering: a system message the harness writes. */
export const defaultRender = (down: Down): string => {
  const submission = Option.match(down.submissionId, { onNone: () => "", onSome: (id) => ` (submission ${id})` })
  switch (down.reason) {
    case "failed": {
      const why = Option.match(down.failure, {
        onNone: () => "",
        onSome: (failure) => `: ${failure.tag}: ${failure.message}`
      })
      return `Session ${down.target} failed${submission}${why}.`
    }
    case "interrupted":
      return `Session ${down.target} was interrupted${submission}.`
    case "closed":
      return `Session ${down.target} closed; it will take no more input.`
  }
}

/** The `Down` an envelope reports, or `None` for every event that is not one. */
export const downOf = (target: string, envelope: AgentEvent.AgentEventEnvelope): Option.Option<Down> => {
  switch (envelope.event._tag) {
    case "SubmissionFailed":
      return Option.some({
        target,
        reason: "failed",
        submissionId: envelope.submissionId,
        failure: Option.some(envelope.event.failure),
        sequence: envelope.sequence
      })
    case "SubmissionInterrupted":
      return Option.some({
        target,
        reason: "interrupted",
        submissionId: envelope.submissionId,
        failure: Option.none(),
        sequence: envelope.sequence
      })
    case "SessionClosed":
      return Option.some({
        target,
        reason: "closed",
        submissionId: Option.none(),
        failure: Option.none(),
        sequence: envelope.sequence
      })
    default:
      return Option.none()
  }
}

/**
 * The inbox item id for a `Down`: the event's own coordinates, never generated.
 *
 * A failure is named by its submission. One without a submission id, which no
 * engine emits today, falls back to the event's sequence: a shared fallback
 * would make every such down a duplicate of the first, and the inbox would
 * drop them.
 */
export const itemId = (watcher: string, down: Down): string =>
  down.reason === "closed"
    ? `down:${watcher}:${down.target}:closed`
    : `down:${watcher}:${down.target}:${Option.getOrElse(down.submissionId, () => `event-${down.sequence}`)}`

export interface WatchOptions {
  /** The session told. */
  readonly watcher: string
  /** The session watched. */
  readonly target: string
  /** Resume after this event sequence, over a client that can. */
  readonly after?: number | undefined
  /** The queue the item goes onto. Default `Messaging`'s, so one pump delivers both. */
  readonly name?: string | undefined
  readonly render?: ((down: Down) => string) | undefined
}

/**
 * Watch `target` for `watcher`, until the target's event stream ends.
 *
 * The stream ends when the target closes, after its `SessionClosed` has been
 * turned into a `down`. Fork it into the scope the watch should live in.
 */
export const watch = Effect.fn("Monitor.watch")(function*(options: WatchOptions) {
  yield* Effect.annotateCurrentSpan({ "monitor.watcher": options.watcher, "monitor.target": options.target })
  const client = yield* AgentClient.AgentClient
  const queue = yield* PersistedQueue.make({ name: options.name ?? Messaging.defaultName, schema: SessionInbox.Item })
  const render = options.render ?? defaultRender
  const session = yield* client.session(options.target)
  const events = session.events(options.after === undefined ? undefined : { after: options.after })
  yield* Stream.runForEach(events, (envelope) =>
    Option.match(downOf(options.target, envelope), {
      onNone: () => Effect.void,
      onSome: (down) =>
        Effect.gen(function*() {
          const id = itemId(options.watcher, down)
          const item: SessionInbox.Item = {
            id,
            sessionId: options.watcher,
            kind: "framework",
            input: Prompt.fromMessages([Prompt.systemMessage({ content: render(down) })]),
            source: { kind: "monitor", id: options.target },
            createdAt: yield* Clock.currentTimeMillis
          }
          yield* queue.offer(item, { id }).pipe(
            Effect.mapError((cause) => new SessionInbox.InboxError({ operation: "enqueue", detail: String(cause) }))
          )
        })
    }))
})
