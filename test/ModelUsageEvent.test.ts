import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  failure: Schema.String
})

describe("ModelCallCompleted", () => {
  it.effect("normalises usage once per batch or streamed provider call, before tools", () =>
    Effect.gen(function* () {
      for (const stream of [false, true]) {
        const toolkit = yield* Agent.toolkit([Lookup], {
          lookup: ({ query }) => Effect.succeed(`result for ${query}`)
        })
        const { layer } = yield* TestLanguageModel.script([
          {
            toolCalls: [{ id: "lookup-1", name: "lookup", params: { query: "Effect" } }],
            usage: { input: 7, output: 3 }
          },
          { text: "done", usage: { input: 11, output: 5 } }
        ])

        const events = yield* Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ toolkit }))
          const probe = yield* AgentProbe.make(session)
          yield* session.prompt("go", { stream })
          return yield* probe.events
        }).pipe(Effect.provide(layer), Effect.scoped)

        const completed = events.filter(AgentEvent.is("ModelCallCompleted"))
        assert.deepStrictEqual(
          completed.map(({ event }) => ({ usage: event.usage, finishReason: event.finishReason })),
          [
            {
              usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
              finishReason: "stop"
            },
            {
              usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
              finishReason: "stop"
            }
          ]
        )

        const tags = events.map(({ event }) => event._tag)
        assert.isBelow(tags.indexOf("ModelCallCompleted"), tags.indexOf("ToolCallStarted"))
        if (stream) {
          assert.isBelow(tags.indexOf("MessageStreamCompleted"), tags.indexOf("ModelCallCompleted"))
        }

        const encoded = yield* Schema.encodeEffect(AgentEvent.AgentEventEnvelope)(completed[0]!)
        const decoded = yield* Schema.decodeEffect(AgentEvent.AgentEventEnvelope)(encoded)
        assert.deepStrictEqual(decoded, completed[0])
      }
    })
  )

  it.effect("preserves model usage when the response's tool later fails the run", () =>
    Effect.gen(function* () {
      const toolkit = yield* Agent.toolkit([Lookup], {
        lookup: () => Effect.fail("lookup failed")
      })
      const { layer } = yield* TestLanguageModel.script([{
        toolCalls: [{ id: "lookup-1", name: "lookup", params: { query: "Effect" } }],
        usage: { input: 13, output: 2 }
      }])

      const { events, result } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(Agent.make({
          toolkit,
          toolFailurePolicy: ToolExecution.FailRun
        }))
        const probe = yield* AgentProbe.make(session)
        const result = yield* Effect.exit(session.prompt("go"))
        return { events: yield* probe.events, result }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.isTrue(Exit.isFailure(result))
      const completed = events.filter(AgentEvent.is("ModelCallCompleted"))
      assert.strictEqual(completed.length, 1)
      assert.deepStrictEqual(completed[0]!.event.usage, {
        inputTokens: 13,
        outputTokens: 2,
        totalTokens: 15
      })

      const tags = events.map(({ event }) => event._tag)
      assert.isBelow(tags.indexOf("ModelCallCompleted"), tags.indexOf("ToolCallFailed"))
      assert.notInclude(tags, "TurnCompleted")
    })
  )
})

/**
 * Adding an event must not break a peer that predates it.
 *
 * `AgentEvent` is carried over RPC, HTTP and SSE, and the two ends are not
 * always the same build -- `AgentServer` and the relay exist so they need not
 * be. Under a strict union, adding `ModelCallCompleted` meant an older client
 * failed to decode the stream the first time a model call completed, which is
 * every turn. Client and server are the same build in every other test here,
 * so nothing else can see this.
 */
describe("event stream evolution", () => {
  const decode = Schema.decodeUnknownEffect(AgentEvent.AgentEventTolerant)
  const encode = Schema.encodeUnknownEffect(AgentEvent.AgentEventTolerant)

  it.effect("an event from a newer peer decodes instead of failing", () =>
    Effect.gen(function*() {
      const event = yield* decode({
        _tag: "SomeFutureEvent",
        detail: "from a newer build"
      })

      assert.strictEqual(event._tag, "UnknownEvent")
      if (event._tag !== "UnknownEvent") return
      // The tag survives by name, so a consumer can recognise or log it.
      assert.strictEqual(event.originalTag, "SomeFutureEvent")
      // And the payload is intact, so a relay can forward it to a build that
      // does understand it.
      assert.deepStrictEqual(event.payload, {
        _tag: "SomeFutureEvent",
        detail: "from a newer build"
      })
    }))

  it.effect("a known event is completely unaffected", () =>
    Effect.gen(function*() {
      const event = yield* decode({ _tag: "TurnStarted" })
      assert.strictEqual(event._tag, "TurnStarted")

      const usage = yield* decode({
        _tag: "ModelCallCompleted",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        finishReason: "stop"
      })
      assert.strictEqual(usage._tag, "ModelCallCompleted")
      if (usage._tag !== "ModelCallCompleted") return
      assert.strictEqual(usage.usage.totalTokens, 3)
    }))

  it.effect("an unknown event re-encodes to exactly what arrived", () =>
    Effect.gen(function*() {
      // Relaying a stream through a build that does not understand every event
      // must not degrade it for one that does.
      const original = { _tag: "SomeFutureEvent", detail: "verbatim" }
      const reencoded = yield* encode(yield* decode(original))
      assert.deepStrictEqual(reencoded, original)
    }))

  it.effect("a known event round-trips unchanged", () =>
    Effect.gen(function*() {
      const original = { _tag: "SubmissionCompleted", runs: 2 }
      const reencoded = yield* encode(yield* decode(original))
      assert.deepStrictEqual(reencoded, original)
    }))

  it.effect("a value with no tag is still a decode failure", () =>
    Effect.gen(function*() {
      // Tolerance is for a newer peer, not for malformed input: accepting this
      // would remove the only check that this is an event stream at all.
      for (const bad of [{ notAnEvent: true }, "a string", 42, null]) {
        const exit = yield* Effect.exit(decode(bad))
        assert.isTrue(
          Exit.isFailure(exit),
          `${JSON.stringify(bad)} is not an event`
        )
      }
    }))

  it.effect("a malformed *known* event fails rather than degrading to UnknownEvent", () =>
    Effect.gen(function*() {
      // The tolerant path is for a tag this build has never heard of. A tag it
      // does have that will not decode is a corrupt event, and answering with
      // `UnknownEvent` would lose both the failure and the tool result -- every
      // consumer skips a tag it has no frame for.
      const exit = yield* Effect.exit(
        decode({ _tag: "ModelCallCompleted", usage: "garbage" })
      )
      assert.isTrue(Exit.isFailure(exit))

      const succeeded = yield* Effect.exit(
        decode({ _tag: "ToolCallSucceeded", id: "t1" })
      )
      assert.isTrue(Exit.isFailure(succeeded))
    }))
})
