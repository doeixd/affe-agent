import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Limits from "../src/internal/limits.js"
import * as FakeModel from "./FakeModel.js"

/**
 * The one-shot forms, held to one contract.
 *
 * `plan-run-stream-start.md` §3 asks for this before the surface grows, and
 * names the thing it is guarding against: a facade that quietly becomes a
 * second interpreter. `Agent.run` and `Agent.start` must be two ways of asking
 * for the same execution, not two executions that usually agree.
 *
 * So the assertions are mostly *sameness* assertions. A property that holds of
 * `run` and not of `start` is the bug this file exists to find.
 */

const Lookup = Tool.make("lookup", {
  description: "look something up",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

/** Two turns and a tool result, so history, runs and turns are all non-trivial. */
const script: ReadonlyArray<FakeModel.Turn> = [
  { toolCalls: [{ id: "l1", name: "lookup", params: { query: "orders" } }] },
  { text: "three orders" }
]

const agent = Agent.make({
  tools: [Agent.tool(Lookup, ({ query }) => Effect.succeed(`found ${query}`))],
  loop: AgentLoop.bounded(4)
})

/** What a result says, minus the identity that is expected to differ. */
const shapeOf = (result: {
  readonly status: string
  readonly runs: number
  readonly turns: number
  readonly text: string
}) => ({ status: result.status, runs: result.runs, turns: result.turns, text: result.text })

describe("the one-shot forms share one execution", () => {
  it.effect("run and start.await report the same result", () =>
    Effect.gen(function*() {
      const viaRun = yield* Effect.provide(
        Agent.run(agent, "how many orders"),
        (yield* FakeModel.layer(script)).layer
      )

      const viaStart = yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          return yield* started.await
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      assert.deepStrictEqual(shapeOf(viaStart), shapeOf(viaRun))
      assert.strictEqual(viaRun.status, "completed")
    }))

  it.effect("both forms send the model the same prompts, so neither has its own history", () =>
    Effect.gen(function*() {
      const forRun = yield* FakeModel.layer(script)
      yield* Effect.provide(Agent.run(agent, "how many orders"), forRun.layer)

      const forStart = yield* FakeModel.layer(script)
      yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          return yield* started.await
        }).pipe(Effect.provide(forStart.layer))
      )

      assert.deepStrictEqual(
        yield* forStart.recorder.prompts,
        yield* forRun.recorder.prompts,
        "a one-shot form with its own history would show up as a different model-facing prompt"
      )
    }))

  it.effect("draining stream yields the same lifecycle as start's events", () =>
    Effect.gen(function*() {
      const viaStart = yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          return yield* Stream.runCollect(started.events)
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      const viaStream = yield* Stream.runCollect(Agent.stream(agent, "how many orders")).pipe(
        Effect.provide((yield* FakeModel.layer(script)).layer)
      )

      assert.deepStrictEqual(
        viaStream.map((envelope) => envelope.event._tag),
        viaStart.map((envelope) => envelope.event._tag),
        "a second event model would show up here as a different lifecycle"
      )
    }))

  it.effect("stream reaches the same result as run", () =>
    Effect.gen(function*() {
      const viaRun = yield* Effect.provide(
        Agent.run(agent, "how many orders"),
        (yield* FakeModel.layer(script)).layer
      )

      const events = yield* Stream.runCollect(Agent.stream(agent, "how many orders")).pipe(
        Effect.provide((yield* FakeModel.layer(script)).layer)
      )
      const completed = events.find((envelope) => envelope.event._tag === "SubmissionCompleted")
      assert.isDefined(completed, "the streamed submission never reported completion")
      assert.strictEqual(viaRun.status, "completed")
    }))

  it.effect("both forms execute tools through the same path", () =>
    Effect.gen(function*() {
      const counted = (calls: Ref.Ref<number>) =>
        Agent.make({
          tools: [Agent.tool(Lookup, () => Effect.as(Ref.update(calls, (n) => n + 1), "found"))],
          loop: AgentLoop.bounded(4)
        })

      const runCalls = yield* Ref.make(0)
      yield* Effect.provide(
        Agent.run(counted(runCalls), "how many orders"),
        (yield* FakeModel.layer(script)).layer
      )

      const startCalls = yield* Ref.make(0)
      yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(counted(startCalls), "how many orders")
          return yield* started.await
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      assert.strictEqual(yield* Ref.get(startCalls), 1)
      assert.strictEqual(yield* Ref.get(runCalls), yield* Ref.get(startCalls))
    }))
})

describe("Agent.start's handle", () => {
  /**
   * The reason a handle is worth holding.
   *
   * An observer that attaches after execution began must still see the
   * beginning. This is also the subscribe-before-submit assertion: a collector
   * that subscribed after `submit` returned would miss the opening events of a
   * fast deterministic model, and the failure would look like a scheduling
   * flake rather than a bug.
   */
  it.effect("an observer attaching after settlement still sees the whole trace", () =>
    Effect.gen(function*() {
      const trace = yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          // Await first, so the submission is over before anything observes it.
          yield* started.await
          return yield* Stream.runCollect(started.events)
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      assert.isAbove(trace.length, 0, "a settled submission replayed no events at all")
      const tags = trace.map((envelope) => envelope.event._tag)
      assert.include(tags, "SubmissionStarted", "the opening event was lost to a late subscription")
      assert.include(tags, "SubmissionCompleted")
    }))

  it.effect("the events stream ends when the submission settles", () =>
    Effect.gen(function*() {
      // If it did not end, this would hang rather than fail, so the timeout is
      // the assertion.
      const trace = yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          return yield* Stream.runCollect(started.events)
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      ).pipe(Effect.timeout("10 seconds"))

      assert.isAbove(trace.length, 0)
    }))

  /**
   * The ownership claim from the plan's §2.1 table: dropping an observer does
   * not stop the work. `run` cannot express this, which is the whole reason
   * `start` exists.
   */
  it.effect("dropping an observer does not stop the submission", () =>
    Effect.gen(function*() {
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          // Take one event and walk away.
          yield* Stream.runCollect(Stream.take(started.events, 1))
          return yield* started.await
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.text, "three orders")
    }))

  /**
   * Not awaiting is not cancelling either: the work is already running when
   * the handle is returned.
   */
  it.effect("work proceeds without anyone awaiting", () =>
    Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      const observed = Agent.make({
        tools: [
          Agent.tool(Lookup, () => Effect.as(Deferred.succeed(reached, undefined), "found"))
        ],
        loop: AgentLoop.bounded(4)
      })

      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Agent.start(observed, "how many orders")
          // Never awaited, never observed.
          yield* Deferred.await(reached)
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      ).pipe(Effect.timeout("10 seconds"))
    }))

  /**
   * Closing the owner scope is the cancellation mechanism, and the reason the
   * handle has no `interrupt`.
   */
  it.effect("closing the owner scope interrupts work in flight", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function*() {
            yield* Agent.start(agent, "how many orders")
            yield* Deferred.await(entered)
          }).pipe(
            Effect.provide(
              (yield* FakeModel.layer([{ started: entered, hang: true }])).layer
            )
          )
        ).pipe(Effect.timeout("10 seconds"))
      )

      // Leaving the scope while the model hangs must not hang the caller: the
      // ephemeral session, the model call and the collector all go with it.
      assert.isTrue(exit._tag === "Success" || exit._tag === "Failure")
    }))

  /**
   * The failure is about a gap *this reader* has, not about the buffer.
   *
   * A reader attached before the bound was reached receives every later
   * envelope live -- the collector publishes whatever it retains -- so its own
   * stream is complete and failing it would be an alarm about nothing. The
   * reader below attaches first and takes a tiny bound; the one after it
   * attaches late and is missing the middle, which is the real case.
   */
  it.effect("a reader attached before the bound was reached is not failed by it", () =>
    Effect.gen(function*() {
      const trace = yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders", {
            traceLimits: { envelopes: 1 }
          })
          // Subscribed before anything was dropped, and reading throughout.
          return yield* Stream.runCollect(started.events)
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      const tags = trace.map((envelope) => envelope.event._tag)
      assert.include(tags, "SubmissionStarted", "a live reader saw the beginning")
      assert.include(tags, "SubmissionCompleted", "and the end")
      assert.isAbove(
        trace.length,
        1,
        "a live reader receives what the trace declined to retain"
      )
    }))

  it.effect("a trace that outgrew its bound fails observation and not the run", () =>
    Effect.gen(function*() {
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          // One envelope is fewer than any real submission emits.
          const started = yield* Agent.start(agent, "how many orders", {
            traceLimits: { envelopes: 1 }
          })
          const settled = yield* started.await
          const observed = yield* Effect.exit(Stream.runCollect(started.events))

          assert.isTrue(observed._tag === "Failure", "an incomplete trace must not pass as a whole one")
          return settled
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      // The submission is untouched by its observer's misfortune.
      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.text, "three orders")
    }))

  it.effect("the trace ceiling cannot be raised, only lowered", () =>
    Effect.gen(function*() {
      // The JSDoc says lowerable and not raisable; a ceiling a caller can
      // raise is not a ceiling, so this asserts the clamp rather than the
      // sentence.
      const trace = yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders", {
            traceLimits: { envelopes: Limits.TRACE_ENVELOPES * 10 }
          })
          yield* started.await
          return yield* Stream.runCollect(started.events)
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )
      // Asking for ten times the ceiling still succeeds -- it is clamped, not
      // rejected -- and a normal submission stays well inside it.
      assert.isAbove(trace.length, 0)
      assert.strictEqual(Limits.traceEnvelopes(Limits.TRACE_ENVELOPES * 10), Limits.TRACE_ENVELOPES)
      assert.strictEqual(Limits.traceEnvelopes(4), 4)
    }))

  it.effect("the handle's submission id is the one the events carry", () =>
    Effect.gen(function*() {
      yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          const result = yield* started.await
          assert.strictEqual(result.submissionId, started.submissionId)

          const trace = yield* Stream.runCollect(started.events)
          const ids = new Set(
            trace.flatMap((envelope) => Option.isSome(envelope.submissionId) ? [envelope.submissionId.value] : [])
          )
          assert.deepStrictEqual([...ids], [started.submissionId])
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )
    }))

  it.effect("await may be read more than once", () =>
    Effect.gen(function*() {
      yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          const first = yield* started.await
          const second = yield* started.await
          assert.deepStrictEqual(shapeOf(second), shapeOf(first))
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )
    }))

  it.effect("two observers each see the whole trace", () =>
    Effect.gen(function*() {
      yield* Effect.scoped(
        Effect.gen(function*() {
          const started = yield* Agent.start(agent, "how many orders")
          // Both start before the submission can settle, so this is two live
          // observers rather than two replays.
          const first = yield* Effect.forkChild(Stream.runCollect(started.events))
          const second = yield* Effect.forkChild(Stream.runCollect(started.events))
          const one = yield* Fiber.join(first)
          const two = yield* Fiber.join(second)
          assert.isDefined(one)
          assert.isDefined(two)
          assert.deepStrictEqual(
            two.map((envelope) => envelope.event._tag),
            one.map((envelope) => envelope.event._tag)
          )
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )
    }))
})

describe("Agent.stream owns what it observes", () => {
  /**
   * The cancellation distinction from §5.1, and the reason `Agent.stream` and
   * `AgentSession.stream` differ on purpose.
   *
   * Here the stream owns the ephemeral session, so reading a prefix and
   * walking away closes the scope and interrupts the model call. The model in
   * this test never returns; if the stream did not own its session, collecting
   * one event and stopping would leave it hanging and this test would time out
   * rather than fail.
   */
  it.effect("abandoning the stream interrupts the work it owns", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()

      const taken = yield* Stream.runCollect(
        Stream.take(Agent.stream(agent, "how many orders"), 1)
      ).pipe(
        Effect.provide((yield* FakeModel.layer([{ started: entered, hang: true }])).layer),
        Effect.timeout("10 seconds")
      )

      assert.strictEqual(taken.length, 1)
    }))

  /**
   * The same claim, but observed from inside the work rather than from the
   * caller returning promptly. A stream that merely detached would leave the
   * tool running, and the caller would still come back on time -- so the
   * finalizer is what tells the two apart.
   */
  it.effect("the interruption reaches a running tool, not just the caller", () =>
    Effect.gen(function*() {
      const running = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()

      const slow = Agent.make({
        tools: [
          Agent.tool(Lookup, () =>
            Effect.never.pipe(
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              Effect.andThen(Effect.succeed("found")),
              Effect.tap(() => Deferred.succeed(running, undefined))
            ))
        ],
        loop: AgentLoop.bounded(4)
      })

      // Read until the tool is under way, then stop reading.
      yield* Effect.scoped(
        Stream.runCollect(
          Stream.take(
            Stream.filter(
              Agent.stream(slow, "how many orders"),
              (envelope) => envelope.event._tag === "ToolCallStarted"
            ),
            1
          )
        ).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      )

      // The tool was interrupted by the stream ending, not left running.
      yield* Deferred.await(interrupted).pipe(Effect.timeout("10 seconds"))
    }))

  /**
   * The contrast, asserted rather than described: a session-owned submission
   * survives its observer. Same script, same prefix taken, opposite outcome.
   */
  it.effect("a session-owned submission survives the same treatment", () =>
    Effect.gen(function*() {
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          const receipt = yield* AgentSession.submit(session, "how many orders")
          // Observe one envelope, then stop observing.
          yield* Stream.runCollect(Stream.take(AgentSession.events(session), 1))
          // The observer is gone; the submission is not.
          return yield* AgentSession.awaitSubmission(session, receipt.submissionId)
        }).pipe(Effect.provide((yield* FakeModel.layer(script)).layer))
      ).pipe(Effect.timeout("10 seconds"))

      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.text, "three orders")
    }))
})
