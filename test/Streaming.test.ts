import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
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
})
