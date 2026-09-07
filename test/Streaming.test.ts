import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
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
