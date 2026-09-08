import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, PubSub, Ref, Schema, Scope, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as EventBus from "../src/internal/eventBus.js"
import { Failpoint } from "../src/internal/failpoint.js"
import { AgentBusyError } from "../src/Errors.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * The invariant the whole design rests on:
 *
 *   Streaming output is observational. Canonical history remains atomic.
 *
 * A consumer may render deltas as they arrive, and the transcript is unchanged
 * by whether it did — including when a turn is interrupted part-way, where
 * history must contain no partial assistant message.
 */
const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const deltasOf = (events: ReadonlyArray<AgentEvent.AgentEventEnvelope>) =>
  events
    .filter(AgentEvent.is("MessageDelta"))
    .map((entry) => entry.event.delta)

describe("model streaming", () => {
  it.effect("emits deltas, and commits the same history as a batch run", () =>
    Effect.gen(function* () {
      const script = [
        { text: "Hello, world", chunks: ["Hello", ", ", "world"] }
      ]

      const transcriptFor = (stream: boolean) =>
        Effect.gen(function* () {
          const { layer } = yield* TestLanguageModel.script(script)
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* AgentSession.make(Agent.make({}))
              const probe = yield* AgentProbe.make(session)
              const result = yield* session.prompt("hi", { stream })
              return {
                text: result.text,
                history: yield* session.history,
                events: yield* probe.events
              }
            })
          ).pipe(Effect.provide(layer))
        })

      const streamed = yield* transcriptFor(true)
      const batched = yield* transcriptFor(false)

      // Streaming reported the output as it arrived...
      assert.deepStrictEqual(deltasOf(streamed.events), [
        "Hello",
        ", ",
        "world"
      ])
      assert.deepStrictEqual(deltasOf(batched.events), [])

      // ...and the message was framed, so a consumer can open and close it.
      const tags = streamed.events.map((entry) => entry.event._tag)
      assert.include(tags, "MessageStarted")
      assert.include(tags, "MessageStreamCompleted")

      // ...while the result and the transcript are identical either way.
      assert.strictEqual(streamed.text, "Hello, world")
      assert.strictEqual(streamed.text, batched.text)
      assert.deepStrictEqual(
        JSON.stringify(streamed.history),
        JSON.stringify(batched.history)
      )
    })
  )

  it.effect("streams a turn that calls tools, and still commits atomically", () =>
    Effect.gen(function* () {
      const toolkit = yield* Agent.toolkit([Search], {
        search: ({ query }) => Effect.succeed(`hits for ${query}`)
      })

      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("search", { query: "effect" }, { id: "s1" }),
        { text: "found it", chunks: ["found", " it"] }
      ])

      const { events, history, text } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ toolkit }))
          const probe = yield* AgentProbe.make(session)
          const result = yield* session.prompt("find effect", { stream: true })
          return {
            text: result.text,
            history: yield* session.history,
            events: yield* probe.events
          }
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(text, "found it")
      // Tool execution is unchanged by streaming.
      assert.include(
        events.map((entry) => entry.event._tag),
        "ToolCallSucceeded"
      )
      // Turn 1's assistant message, its tool result, and turn 2's message --
      // committed whole, in order.
      assert.deepStrictEqual(
        history.content.map((message) => message.role),
        ["user", "assistant", "tool", "assistant"]
      )
    })
  )

  it.effect("an interrupted stream commits no partial message", () =>
    Effect.gen(function* () {
      // The case the atomic-commit rule exists for. The model streams a chunk,
      // then hangs; the caller interrupts. A consumer saw the delta, but the
      // transcript must not contain a half-written assistant message, because
      // no later model call could make sense of one.
      const started = yield* Deferred.make<void>()
      const { layer } = yield* TestLanguageModel.script([
        {
          text: "half",
          chunks: ["half"],
          started,
          hang: true
        }
      ])

      const observed = yield* Ref.make<ReadonlyArray<string>>([])
      const history = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const probe = yield* AgentProbe.make(session)

          const running = yield* Effect.forkChild(
            session.prompt("go", { stream: true })
          )
          yield* Deferred.await(started)
          yield* Fiber.interrupt(running)

          yield* Ref.set(
            observed,
            (yield* probe.events).map((entry) => entry.event._tag)
          )
          return yield* session.history
        })
      ).pipe(Effect.provide(layer))

      const tags = yield* Ref.get(observed)
      // The message was opened and then closed by its terminal event: a
      // consumer is never left rendering something that never resolves.
      assert.include(tags, "MessageStarted")
      assert.include(tags, "MessageInterrupted")
      assert.notInclude(tags, "MessageStreamCompleted")

      // And nothing from that turn reached canonical history.
      assert.deepStrictEqual(
        history.content.map((message) => message.role),
        ["user"]
      )
    })
  )

  it.effect("a failure reported inside the stream is typed, not a defect", () =>
    Effect.gen(function* () {
      // A provider can fail *in* the stream rather than by failing it. The
      // batch path surfaces the same condition as an `AiError`, so the
      // streaming path must too: a caller should not have to handle a provider
      // failure differently depending on whether it asked to stream.
      const { layer } = yield* TestLanguageModel.script([
        { text: "partial", chunks: ["par"], streamError: "upstream exploded" }
      ])

      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          return yield* Effect.exit(session.prompt("go", { stream: true }))
        })
      ).pipe(Effect.provide(layer))

      assert.isTrue(Exit.isFailure(exit))
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined
      // `findErrorOption` returns none for a defect, so this fails outright if
      // the failure regresses to being died on.
      assert.isDefined(failure)
      assert.include(JSON.stringify(failure), "upstream exploded")

      // And nothing partial was committed.
      assert.isTrue(Exit.isFailure(exit))
    })
  )

  it.effect("a failed stream closes the message it opened", () =>
    Effect.gen(function* () {
      // Every `MessageStarted` owes a terminal event. Interruption was handled
      // and failure was not, so a provider error left a consumer rendering a
      // message that never resolved while the run reported `RunFailed`
      // somewhere else entirely.
      const { layer } = yield* TestLanguageModel.script([
        { text: "partial", chunks: ["par"], streamError: "upstream exploded" }
      ])

      const tags = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const probe = yield* AgentProbe.make(session)
          yield* Effect.ignore(session.prompt("go", { stream: true }))
          return (yield* probe.events).map((entry) => entry.event._tag)
        })
      ).pipe(Effect.provide(layer))

      assert.include(tags, "MessageStarted")
      assert.include(tags, "MessageFailed")
      // Failure and interruption stay distinct, the way they do for tools.
      assert.notInclude(tags, "MessageInterrupted")
      assert.notInclude(tags, "MessageStreamCompleted")
    })
  )
})

describe("one submission as a stream", () => {
  /**
   * `plan-streaming.md` P1. `AgentSession.stream` is `submit` plus the bus,
   * with the subscription registered before admission. The rows hold the
   * invariants the plan names: the first and last envelopes are the
   * submission's own boundaries even when the run finishes at once; nothing
   * of another submission is included; the terminal is data, not a failure;
   * the stream is cold and submits once per evaluation; admission failures are
   * the error channel.
   */
  const tagsOf = (envelopes: ReadonlyArray<AgentEvent.AgentEventEnvelope>) => envelopes.map((e) => e.event._tag)

  it.effect("yields the submission's envelopes from its start through its terminal, and nothing after", () =>
    Effect.gen(function* () {
      // A run that finishes at once: every envelope may already be on the bus
      // by the time the receipt returns. The subscription came first, so the
      // stream still starts at SubmissionStarted.
      const { layer } = yield* TestLanguageModel.script([{ text: "done", chunks: ["do", "ne"] }])
      const envelopes = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          return yield* Stream.runCollect(AgentSession.stream(session, "go"))
        })
      ).pipe(Effect.provide(layer))
      const tags = tagsOf(envelopes)
      assert.strictEqual(tags[0], "SubmissionStarted")
      assert.strictEqual(tags[tags.length - 1], "SubmissionCompleted")
      assert.deepStrictEqual(deltasOf([...envelopes]), ["do", "ne"])
      assert.include(tags, "MessageStarted")
      assert.include(tags, "TurnCompleted")
      // Every envelope belongs to one submission, in strictly increasing sequence.
      const ids = new Set(envelopes.map((e) => Option.getOrThrow(e.submissionId)))
      assert.strictEqual(ids.size, 1)
      const sequences = envelopes.map((e) => e.sequence)
      assert.deepStrictEqual(sequences, [...sequences].sort((a, b) => a - b))
      assert.strictEqual(new Set(sequences).size, sequences.length)
    })
  )

  it.effect("includes nothing of an earlier or later submission on the same session", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([{ text: "first" }, { text: "second", chunks: ["sec", "ond"] }, { text: "third" }])
      const { streamed, all } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const probe = yield* AgentProbe.make(session)
          yield* session.prompt("one")
          const streamed = yield* Stream.runCollect(AgentSession.stream(session, "two"))
          yield* session.prompt("three")
          return { streamed, all: yield* probe.events }
        })
      ).pipe(Effect.provide(layer))
      const streamedIds = new Set(streamed.map((e) => Option.getOrThrow(e.submissionId)))
      assert.strictEqual(streamedIds.size, 1)
      const [id] = streamedIds
      // Exactly the bus's envelopes for that submission, no more and no fewer.
      const expected = all.filter((e) => Option.isSome(e.submissionId) && e.submissionId.value === id)
      assert.deepStrictEqual([...streamed], expected)
      assert.deepStrictEqual(deltasOf([...streamed]), ["sec", "ond"])
    })
  )

  it.effect("a failed submission is a SubmissionFailed envelope and a normal end, not a stream failure", () =>
    Effect.gen(function* () {
      const Boom = Tool.make("boom", { parameters: Schema.Struct({}), success: Schema.String })
      const agent = Agent.make({
        tools: [Agent.tool(Boom, () => Effect.die(new Error("the tool is broken")))],
        loop: AgentLoop.bounded(2)
      })
      const { layer } = yield* TestLanguageModel.script([{ toolCalls: [{ id: "b1", name: "boom", params: {} }] }])
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          return yield* Stream.runCollect(AgentSession.stream(session, "go"))
        })
      ).pipe(Effect.exit, Effect.provide(layer))
      assert.isTrue(Exit.isSuccess(exit), "the outcome was observed; observing did not fail")
      if (Exit.isSuccess(exit)) {
        const tags = tagsOf(exit.value)
        assert.strictEqual(tags[tags.length - 1], "SubmissionFailed")
        assert.strictEqual(tags.filter((t) => t.startsWith("Submission")).length, 2, "one start, one terminal")
      }
    })
  )

  it.effect("cold: each evaluation submits once; and admission failures are the error channel", () =>
    Effect.gen(function* () {
      const hanging = yield* Deferred.make<void>()
      const { layer } = yield* TestLanguageModel.script([{ text: "a" }, { text: "b" }, { hang: true, started: hanging }])
      const { first, second, busy } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const once = AgentSession.stream(session, "go")
          const first = yield* Stream.runCollect(once)
          const second = yield* Stream.runCollect(once)
          // A third submission hangs in its model call; a stream asked for
          // while it runs is refused at admission.
          const fiber = yield* Effect.forkChild(session.prompt("hangs"))
          yield* Deferred.await(hanging)
          const busy = yield* Effect.exit(Stream.runCollect(AgentSession.stream(session, "too")))
          yield* AgentSession.interrupt(session)
          yield* Fiber.await(fiber)
          return { first, second, busy }
        })
      ).pipe(Effect.provide(layer))
      const idOf = (envelopes: ReadonlyArray<AgentEvent.AgentEventEnvelope>) => Option.getOrThrow(envelopes[0]!.submissionId)
      assert.notStrictEqual(idOf([...first]), idOf([...second]), "two evaluations must be two submissions")
      assert.isTrue(Exit.isFailure(busy))
      if (Exit.isFailure(busy)) assert.instanceOf(Cause.squash(busy.cause), AgentBusyError)
    })
  )
})

describe("tool-call argument deltas", () => {
  /**
   * `plan-streaming.md` P2. A provider streams a tool call's arguments as
   * fragments before the assembled call; the accumulator used to drop them.
   * They are now reported as `ToolCallDelta`, observationally: the harness
   * still executes, approves and records only the assembled call, so the
   * committed history of a streamed run is the batched run's, fragment events
   * or not. The accumulator's own rows are in `StreamAccumulator.test.ts`.
   */
  const Add = Tool.make("add", {
    parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
    success: Schema.Number
  })
  const fragmentsOf = (events: ReadonlyArray<AgentEvent.AgentEventEnvelope>) =>
    events.filter(AgentEvent.is("ToolCallDelta")).map((e) => e.event)

  it.effect("reports the fragments, in order, before the assembled call, and executes only the call", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const agent = Agent.make({
        tools: [Agent.tool(Add, ({ a, b }) => Effect.as(Ref.update(calls, (n) => n + 1), a + b))],
        loop: AgentLoop.bounded(3)
      })
      const script = [
        { toolCalls: [{ id: "c1", name: "add", params: { a: 1, b: 2 }, paramChunks: ['{"a":1', ',"b":2}'] }] },
        { text: "3" }
      ]
      const run = (stream: boolean) =>
        Effect.gen(function* () {
          const { layer } = yield* TestLanguageModel.script(script)
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* AgentSession.make(agent)
              const probe = yield* AgentProbe.make(session)
              yield* session.prompt("add them", { stream })
              return { history: yield* session.history, events: yield* probe.events }
            })
          ).pipe(Effect.provide(layer))
        })
      const streamed = yield* run(true)
      const batched = yield* run(false)

      const fragments = fragmentsOf(streamed.events)
      assert.deepStrictEqual(fragments, [
        { _tag: "ToolCallDelta", id: "c1", name: "add", delta: '{"a":1' },
        { _tag: "ToolCallDelta", id: "c1", name: "add", delta: ',"b":2}' }
      ])
      // Concatenated, the fragments are the arguments the call was made with.
      const started = streamed.events.filter(AgentEvent.is("ToolCallStarted"))
      assert.strictEqual(started.length, 1)
      assert.deepStrictEqual(started[0]!.event.params, JSON.parse(fragments.map((f) => f.delta).join("")))
      // Every fragment precedes the call it belongs to, and lives inside the message.
      const tags = streamed.events.map((e) => e.event._tag)
      const lastFragment = tags.lastIndexOf("ToolCallDelta")
      assert.isBelow(lastFragment, tags.indexOf("ToolCallStarted"))
      assert.isAbove(lastFragment, tags.indexOf("MessageStarted"))
      assert.isBelow(lastFragment, tags.indexOf("MessageStreamCompleted"))
      // Nothing was executed on a fragment: two runs, two calls in total.
      assert.strictEqual(yield* Ref.get(calls), 2)
      // The fragments are not in the batched run, and neither history has them.
      assert.deepStrictEqual(fragmentsOf(batched.events), [])
      assert.deepStrictEqual(streamed.history, batched.history)
    })
  )

  it.effect("a message that fails after fragments leaves no call, no execution and no history", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const agent = Agent.make({
        tools: [Agent.tool(Add, ({ a, b }) => Effect.as(Ref.update(calls, (n) => n + 1), a + b))]
      })
      const { layer } = yield* TestLanguageModel.script([
        {
          toolCalls: [{ id: "c1", name: "add", params: { a: 1, b: 2 }, paramChunks: ['{"a":1'], abandon: true }],
          streamError: "provider died mid-arguments"
        }
      ])
      const { exit, events, history } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          const probe = yield* AgentProbe.make(session)
          const exit = yield* Effect.exit(session.prompt("add them", { stream: true }))
          return { exit, events: yield* probe.events, history: yield* session.history }
        })
      ).pipe(Effect.provide(layer))

      assert.isTrue(Exit.isFailure(exit))
      const tags = events.map((e) => e.event._tag)
      // The fragment was observed; the message's terminal is what closes it.
      assert.deepStrictEqual(fragmentsOf(events), [{ _tag: "ToolCallDelta", id: "c1", name: "add", delta: '{"a":1' }])
      assert.include(tags, "MessageFailed")
      assert.notInclude(tags, "ToolCallStarted")
      assert.isBelow(tags.lastIndexOf("ToolCallDelta"), tags.indexOf("MessageFailed"))
      assert.strictEqual(yield* Ref.get(calls), 0)
      // Canonical history has nothing of the abandoned call.
      assert.notInclude(JSON.stringify(history), '"add"')
    })
  )

  it.effect("crosses the wire with and without a name", () =>
    Effect.gen(function* () {
      const events: ReadonlyArray<AgentEvent.AgentEvent> = [
        { _tag: "ToolCallDelta", id: "c1", name: "add", delta: "{" },
        { _tag: "ToolCallDelta", id: "c1", delta: "{" }
      ]
      for (const event of events) {
        const encoded = yield* Schema.encodeEffect(AgentEvent.AgentEvent)(event)
        const decoded = yield* Schema.decodeUnknownEffect(AgentEvent.AgentEvent)(JSON.parse(JSON.stringify(encoded)))
        assert.deepStrictEqual(decoded, event)
      }
    })
  )
})

describe("bus retention under a stalled subscriber", () => {
  /**
   * `plan-streaming.md` P4: measure before bounding. The bus is unbounded and
   * every subscriber has its own queue, so a subscriber that stops reading
   * retains every envelope published after it subscribed -- deltas included --
   * for exactly as long as its scope lives, and not a moment longer. The row
   * measures that and holds the teardown: once the stalled subscriber's scope
   * ends, the bus retains nothing for it, and the session never noticed.
   */
  it.effect("retains every envelope for a stalled subscriber until its scope ends, then nothing", () =>
    Effect.gen(function* () {
      const chunk = "x".repeat(1024)
      const chunks = Array.from({ length: 32 }, () => chunk)
      const { layer } = yield* TestLanguageModel.script([
        { text: chunks.join(""), chunks },
        { text: chunks.join(""), chunks },
        { text: chunks.join(""), chunks },
        { text: "after" }
      ])
      const measured = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          // A live subscriber that keeps up, and a stalled one in a scope of
          // its own that never reads.
          const live = yield* AgentSession.subscribe(session)
          const stalledScope = yield* Scope.make()
          const stalled = yield* Scope.provide(AgentSession.subscribe(session), stalledScope)

          for (let i = 0; i < 3; i++) {
            yield* session.prompt(`turn ${i}`, { stream: true })
            yield* PubSub.takeAll(live)
          }
          // Everything since it subscribed, still held for it alone: the live
          // one has drained, so what the bus retains is what the stalled one owes.
          const retained = yield* PubSub.remaining(stalled)
          const retainedByBus = live.pubsub.size()
          // Read them without releasing, to weigh them.
          const held = yield* PubSub.takeAll(stalled)
          const bytes = held.reduce((n, envelope) => n + JSON.stringify(AgentEvent.toWire(envelope)).length, 0)
          const deltaBytes = deltasOf(held).reduce((n, delta) => n + delta.length, 0)

          // Teardown: end the stalled scope; the bus retains nothing for it,
          // and the session goes on.
          yield* Scope.close(stalledScope, Exit.void)
          const result = yield* session.prompt("go on")
          yield* PubSub.takeAll(live)
          const afterwards = live.pubsub.size()
          return { retained, retainedByBus, bytes, deltaBytes, held: held.length, afterwards, text: result.text }
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(measured.retained, measured.held)
      assert.strictEqual(measured.retainedByBus, measured.retained, "the bus retains exactly what the stalled subscriber owes")
      assert.strictEqual(measured.deltaBytes, 3 * 32 * 1024, "every delta of three streamed turns was retained")
      assert.isAbove(measured.bytes, measured.deltaBytes)
      assert.strictEqual(measured.afterwards, 0, "nothing is retained once the stalled scope has ended")
      assert.strictEqual(measured.text, "after")
    })
  )
})

describe("subscribe before submit, proved through a subscription gate", () => {
  /**
   * `plan-streaming-followups.md` §1, item 76. Breaking the order did not
   * bite: in-process scheduling publishes nothing before the receipt
   * returns, so a subscription taken after `submit` still saw
   * `SubmissionStarted`. This row holds the gate `EventBus.failpoints`
   * exposes -- registration of the subscription yields to other fibres many
   * times -- without changing what admission publishes. In the right order
   * the gate delays a subscription nothing is being published to yet; in
   * the swapped order the run publishes through the gate and the first
   * envelope is gone. Broken once by swapping the two lines in
   * `AgentSession.stream`: this row fails.
   */
  const gated = ({
    hit: (location: string) =>
      location === EventBus.failpoints.qualified("before-subscribe")
        ? Effect.forEach(Array.from({ length: 32 }), () => Effect.yieldNow, { discard: true })
        : Effect.void
  })

  it.effect("the stream's first envelope is SubmissionStarted even when registering the subscription yields many times", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([{ text: "done", chunks: ["do", "ne"] }])
      const tags = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const envelopes = yield* Stream.runCollect(AgentSession.stream(session, "go"))
          return envelopes.map((e) => e.event._tag)
        })
      ).pipe(Effect.provideService(Failpoint, gated), Effect.provide(layer))
      assert.strictEqual(tags[0], "SubmissionStarted")
      assert.strictEqual(tags[tags.length - 1], "SubmissionCompleted")
      assert.include(tags, "MessageDelta")
    })
  )
})

describe("stream lifecycle: the subscription's release, and what the tail promises", () => {
  /**
   * `plan-streaming-followups.md`, second opinion; item 77. "Scope ends" and
   * "stream finishes" are different observations, so each way a consumer
   * can stop gets a row that measures the subscription's release directly:
   * a probe subscription's `subscribers` map is the bus's own count of live
   * subscriptions. And the appended `awaitSubmission` is a barrier for
   * normal consumption, not a finalizer: a consumer that cuts at the
   * terminal itself has not waited, which the last row states rather than
   * hides. Broken once by taking the stream's subscription in the session's
   * scope instead of the stream's: the release rows fail.
   */
  const withProbe = <A, E>(
    turns: ReadonlyArray<TestLanguageModel.Turn>,
    use: (session: AgentSession.AgentSession<{}, never, string, string>, live: () => number) => Effect.Effect<A, E, Scope.Scope>
  ) =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script(turns)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const probe = yield* AgentSession.subscribe(session)
          return yield* use(session, () => probe.subscribers.size)
        })
      ).pipe(Effect.provide(layer))
    })
  const submissionOf = (envelope: AgentEvent.AgentEventEnvelope) => Option.getOrThrow(envelope.submissionId)

  it.effect("released after natural exhaustion, while the enclosing scope lives", () =>
    withProbe([{ text: "done", chunks: ["do", "ne"] }], (session, live) =>
      Effect.gen(function* () {
        const before = live()
        const envelopes = yield* Stream.runCollect(AgentSession.stream(session, "go"))
        assert.strictEqual(envelopes[envelopes.length - 1]!.event._tag, "SubmissionCompleted")
        assert.strictEqual(live(), before, "the stream's subscription outlived the stream")
      }))
  )

  it.effect("released after take(1), and the submission runs on", () =>
    withProbe([{ text: "done", chunks: ["do", "ne"] }], (session, live) =>
      Effect.gen(function* () {
        const before = live()
        const [first] = yield* Stream.runCollect(Stream.take(AgentSession.stream(session, "go"), 1))
        assert.strictEqual(first!.event._tag, "SubmissionStarted")
        assert.strictEqual(live(), before, "ending the consumer early left the subscription")
        // Nothing but the subscription was released: the run completes.
        const outcome = yield* AgentSession.awaitSubmission(session, submissionOf(first!))
        assert.strictEqual(outcome.status, "completed")
      }))
  )

  it.effect("released after the consumer fails, and the submission runs on", () =>
    withProbe([{ text: "done", chunks: ["do", "ne"] }], (session, live) =>
      Effect.gen(function* () {
        const before = live()
        const seen = yield* Ref.make<Option.Option<AgentEvent.AgentEventEnvelope>>(Option.none())
        const exit = yield* Effect.exit(
          Stream.runForEach(AgentSession.stream(session, "go"), (envelope) =>
            Effect.andThen(Ref.set(seen, Option.some(envelope)), Effect.fail("the consumer broke")))
        )
        assert.isTrue(Exit.isFailure(exit))
        assert.strictEqual(live(), before, "a failed consumer left the subscription")
        const first = Option.getOrThrow(yield* Ref.get(seen))
        const outcome = yield* AgentSession.awaitSubmission(session, submissionOf(first))
        assert.strictEqual(outcome.status, "completed")
      }))
  )

  it.effect("interrupted while acquiring the subscription: nothing was submitted", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>()
      const gate = { hit: (location: string) => location === EventBus.failpoints.qualified("before-subscribe") ? Deferred.await(held) : Effect.void }
      yield* withProbe([{ text: "done" }], (session, live) =>
        Effect.gen(function* () {
          const before = live()
          const consumer = yield* Effect.forkChild(Stream.runCollect(AgentSession.stream(session, "go")))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(consumer)
          assert.strictEqual(live(), before)
          assert.strictEqual(yield* session.status, "idle", "a submission was admitted for a consumer that had already gone")
        })).pipe(Effect.provideService(Failpoint, gate))
    })
  )

  it.effect("interrupted after admission: the subscription is released and the run settles on its own", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* withProbe([{ text: "done", started, during: Deferred.await(release) }], (session, live) =>
        Effect.gen(function* () {
          const probe = yield* AgentProbe.make(session)
          const before = live()
          const consumer = yield* Effect.forkChild(Stream.runCollect(AgentSession.stream(session, "go")))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(consumer)
          assert.strictEqual(live(), before, "interrupting the consumer left the subscription")
          assert.strictEqual(yield* session.status, "running", "interrupting the consumer stopped the run")
          yield* Deferred.succeed(release, void 0)
          const admitted = (yield* probe.events).find(AgentEvent.is("SubmissionStarted"))
          const outcome = yield* AgentSession.awaitSubmission(session, submissionOf(admitted!))
          assert.strictEqual(outcome.status, "completed")
        }))
    })
  )

  it.effect("a consumer that cuts at the terminal itself has not waited for release; the run still settles", () =>
    withProbe([{ text: "done" }, { text: "again" }], (session) =>
      Effect.gen(function* () {
        // `takeUntil` on the terminal stops pulling before the stream's own
        // tail runs, so this consumer may find the session still busy for a
        // moment. The promise is "normal exhaustion waits for release", and
        // this row says what the alternative gives: the outcome, once asked
        // for.
        const envelopes = yield* Stream.runCollect(
          Stream.takeUntil(AgentSession.stream(session, "go"), (e) => e.event._tag === "SubmissionCompleted")
        )
        const outcome = yield* AgentSession.awaitSubmission(session, submissionOf(envelopes[0]!))
        assert.strictEqual(outcome.status, "completed")
        const next = yield* session.prompt("more")
        assert.strictEqual(next.text, "again")
      }))
  )
})

