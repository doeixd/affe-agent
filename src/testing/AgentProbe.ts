import { Effect, Queue, Stream } from "effect"
import type { Scope } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentSession from "../AgentSession.js"

/**
 * Observes a session's lifecycle for assertions.
 *
 * The event stream is live: a subscriber that attaches after a run has started
 * has already missed events, and one that never drains competes with the run
 * it is watching. A probe attaches once, at a known point, and buffers
 * everything — so a test asserts on a complete record rather than on whatever
 * it happened to catch.
 *
 * Scoped, so the subscription ends with the surrounding scope.
 *
 * One event is out of reach by construction: `SessionStarted` is emitted
 * inside `AgentSession.make`, before any handle exists to attach to. A probe
 * therefore records from `SubmissionStarted` onward. That is a property of
 * when the session announces itself, not something the probe can work around,
 * and pretending otherwise by replaying a synthetic event would make the
 * record a fiction.
 */
export interface AgentProbe {
  /** Everything seen so far, in emission order. */
  readonly events: Effect.Effect<ReadonlyArray<AgentEventEnvelope>>
  /** Tags only, which is what most assertions actually compare. */
  readonly tags: Effect.Effect<ReadonlyArray<string>>
  /** Everything seen so far, clearing the buffer. */
  readonly drain: Effect.Effect<ReadonlyArray<AgentEventEnvelope>>
  /**
   * Wait for the next event with this tag.
   *
   * Deliberately "next", not "next or already seen": a test that needs to act
   * at a precise moment must attach before the moment arrives, and quietly
   * matching a past event would hide the fact that it did not.
   */
  readonly awaitEvent: <Tag extends AgentEvent.AgentEvent["_tag"]>(
    tag: Tag
  ) => Effect.Effect<AgentEventEnvelope>
}

/**
 * Attach a probe to a session.
 *
 * ```ts
 * const probe = yield* AgentProbe.make(session)
 * yield* session.prompt("go")
 * assert.deepStrictEqual(yield* probe.tags, [...])
 * ```
 */
export const make = (
  // All three slots, so a session whose agent declares an `AgentOutput` --
  // and therefore a `Value` -- can be probed like any other.
  session: AgentSession.AgentSession<any, any, any, any>
): Effect.Effect<AgentProbe, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Deliberately unbounded: a probe is test instrumentation whose contract is
    // a complete event record. Dropping would make exact-sequence assertions
    // lie, and backpressuring the observed run would make the probe change the
    // scheduling it is meant to observe. Its surrounding test scope bounds the
    // lifetime; tests remain responsible for not probing an infinite stream.
    const buffered = yield* Queue.unbounded<AgentEventEnvelope>()

    yield* Effect.forkScoped(
      Stream.runForEach(session.events, (event) =>
        Queue.offer(buffered, event)
      )
    )
    // Let the subscriber attach before anything can produce events. Without
    // this a prompt issued on the next line can outrun the subscription.
    yield* Effect.yieldNow

    // Buffered events move into `seen` as they are observed, so `events` can
    // be read repeatedly without consuming, while `drain` still offers a fresh
    // window for tests that assert per phase.
    const seen: Array<AgentEventEnvelope> = []
    const snapshot = Effect.map(Queue.clear(buffered), (taken) => {
      seen.push(...taken)
      return [...seen] as ReadonlyArray<AgentEventEnvelope>
    })

    return {
      events: snapshot,
      tags: Effect.map(snapshot, (all) => all.map((e) => e.event._tag)),
      drain: Effect.map(snapshot, (all) => {
        seen.length = 0
        return all
      }),
      awaitEvent: (tag) =>
        Stream.runHead(
          Stream.filter(session.events, AgentEvent.is(tag))
        ).pipe(
          Effect.flatMap((head) =>
            head._tag === "Some"
              ? Effect.succeed<AgentEventEnvelope>(head.value)
              : Effect.die(
                  new Error(
                    `AgentProbe.awaitEvent: the stream ended before ${tag}`
                  )
                )
          )
        )
    }
  })
