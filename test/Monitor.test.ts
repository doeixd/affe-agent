import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Schedule, Scope } from "effect"
import { Prompt } from "effect/unstable/ai"
import { PersistedQueue } from "effect/unstable/persistence"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentClient } from "../src/client/index.js"
import { Messaging, Monitor } from "../src/sessions/index.js"
import { SessionId, SubmissionId } from "../src/internal/ids.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `plan-supervision.md` §3. A terminal failure of one session reaches its
 * watcher's inbox, once, and a completed submission does not.
 */

const harness = (turns: ReadonlyArray<Parameters<typeof TestLanguageModel.script>[0][number]>) =>
  Effect.map(TestLanguageModel.script(turns), ({ layer: model }) => {
    const queues = PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory))
    const messaging = Messaging.layer({ authorize: Messaging.allowAll }).pipe(Layer.provide(queues))
    return Layer.mergeAll(AgentClient.layer(Agent.make({})).pipe(Layer.provide(model)), messaging, queues)
  })

const until = <A, E>(observation: Effect.Effect<A, E>, done: (value: A) => boolean) =>
  Effect.repeat(observation, { until: done, schedule: Schedule.spaced("10 millis") })

const systemTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) =>
    message.role === "system" && typeof message.content === "string" ? [message.content] : []
  )

/**
 * Fork a watch of `t` for `w` into `scope`, and let it attach before anything
 * happens to `t`. The scope is the caller's to choose: a watch forked into the
 * target's own scope would be interrupted by the close it is meant to report.
 */
const watching = (scope: Scope.Scope) =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkIn(Monitor.watch({ watcher: "w", target: "t" }), scope)
    yield* Effect.yieldNow
    return fiber
  })

describe("Monitor", () => {
  it.live("a failed submission reaches the watcher as a down, with why", () =>
    Effect.gen(function*() {
      const layer = yield* harness([{ failWith: "provider down" }, TestLanguageModel.text("noted")])
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const w = yield* client.createSession({ sessionId: "w" })
        const t = yield* client.createSession({ sessionId: "t" })
        const { deliver } = yield* Messaging.deliverer()
        yield* watching(yield* Effect.scope)

        assert.isTrue(Exit.isFailure(yield* Effect.exit(t.prompt("go"))))
        const outcome = yield* deliver
        assert.strictEqual(outcome._tag, "Delivered")
        assert.strictEqual(outcome.item.id, "down:t:t:submission-1")
        assert.strictEqual(outcome.item.sessionId, "w")
        assert.deepStrictEqual(outcome.item.source, { kind: "monitor", id: "t" })
        yield* until(w.status, (status) => status === "idle")
        const told = systemTexts(yield* w.history)
        assert.strictEqual(told.length, 1)
        assert.include(told[0]!, "Session t failed (submission t:submission-1)")
        assert.include(told[0]!, "provider down")
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.live("a completed submission is not a down; a close is, and ends the watch", () =>
    Effect.gen(function*() {
      const layer = yield* harness([TestLanguageModel.text("answered"), TestLanguageModel.text("noted")])
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const w = yield* client.createSession({ sessionId: "w" })
        const { deliver } = yield* Messaging.deliverer()
        const outer = yield* Effect.scope
        const fiber = yield* Effect.scoped(Effect.gen(function*() {
          const t = yield* client.createSession({ sessionId: "t" })
          const fiber = yield* watching(outer)
          assert.strictEqual((yield* t.prompt("go")).text, "answered")
          return fiber
        }))
        // The target's scope closed it; its stream ended after `SessionClosed`.
        yield* Fiber.join(fiber)
        // FIFO: had the completed submission been a down, it would come first.
        const outcome = yield* deliver
        assert.strictEqual(outcome.item.id, "down:t:closed")
        yield* until(w.status, (status) => status === "idle")
        assert.include(systemTexts(yield* w.history)[0]!, "Session t closed")
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.live("an interrupted submission is a down", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const layer = yield* harness([{ hang: true, started }, TestLanguageModel.text("noted")])
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        yield* client.createSession({ sessionId: "w" })
        const t = yield* client.createSession({ sessionId: "t" })
        const { deliver } = yield* Messaging.deliverer()
        yield* watching(yield* Effect.scope)
        const receipt = yield* t.submit("go")
        yield* Deferred.await(started)
        yield* t.interrupt()
        const outcome = yield* deliver
        assert.strictEqual(outcome.item.id, "down:t:t:submission-1")
        const input = outcome.item.input.content[0]
        assert.isTrue(input?.role === "system" && typeof input.content === "string" &&
          input.content.includes("was interrupted"))
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.live("two monitors of one target for one watcher enqueue each down once", () =>
    Effect.gen(function*() {
      const layer = yield* harness([
        { failWith: "provider down" },
        TestLanguageModel.text("noted"),
        TestLanguageModel.text("noted")
      ])
      yield* Effect.gen(function*() {
        const client = yield* AgentClient.AgentClient
        const w = yield* client.createSession({ sessionId: "w" })
        const { deliver } = yield* Messaging.deliverer()
        const outer = yield* Effect.scope
        const [first, second] = yield* Effect.scoped(Effect.gen(function*() {
          const t = yield* client.createSession({ sessionId: "t" })
          const first = yield* watching(outer)
          const second = yield* watching(outer)
          yield* Effect.exit(t.prompt("go"))
          return [first, second] as const
        }))
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        assert.strictEqual((yield* deliver).item.id, "down:t:t:submission-1")
        yield* until(w.status, (status) => status === "idle")
        // Were the failure queued twice, its duplicate would come next.
        assert.strictEqual((yield* deliver).item.id, "down:t:closed")
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it("downOf ignores every event that is not a terminal failure", () => {
    const envelope = (event: AgentEvent.AgentEventEnvelope["event"]): AgentEvent.AgentEventEnvelope => ({
      sessionId: SessionId.make("t"),
      submissionId: Option.some(SubmissionId.make("t:submission-1")),
      runId: Option.none(),
      turn: Option.none(),
      sequence: 1,
      event
    })
    const failure = { tag: "AiError", message: "down", isDefect: false }
    // A run that fails or is interrupted reports it, and its submission then
    // does: the down is the submission's, once, not the run's as well.
    for (const event of [
      AgentEvent.SubmissionCompleted.make({ runs: 1 }),
      AgentEvent.RunFailed.make({ failure }),
      AgentEvent.RunInterrupted.make({}),
      AgentEvent.SessionStarted.make({})
    ]) {
      assert.isTrue(Option.isNone(Monitor.downOf("t", envelope(event))), event._tag)
    }
    assert.isTrue(Option.isSome(Monitor.downOf("t", envelope(AgentEvent.SubmissionFailed.make({ failure })))))
  })

  it("a down without a submission id is named by its event, never by a shared fallback", () => {
    const down = (sequence: number): Monitor.Down => ({
      target: "t",
      reason: "failed",
      submissionId: Option.none(),
      failure: Option.none(),
      sequence
    })
    assert.notStrictEqual(Monitor.itemId(down(3)), Monitor.itemId(down(4)))
    assert.strictEqual(Monitor.itemId(down(3)), Monitor.itemId(down(3)))
  })
})
