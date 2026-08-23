import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import type { AgentEventEnvelope } from "../src/AgentEvent.js"
import { Observability } from "../src/observability/index.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Observability standardises the names/attributes an agent emits and adds
 * redaction. Tested against the real events of a real run: the mapper is pinned
 * on genuine envelopes, and the observer is driven over them.
 */

const GetWeather = Tool.make("get_weather", {
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.String
})
const Weather = Agent.make({
  instructions: "weather",
  tools: [Agent.tool(GetWeather, ({ city }) => Effect.succeed(`Sunny in ${city}`))],
  loop: AgentLoop.bounded(4)
})

// Run one session and collect its real event envelopes.
const collectEnvelopes = Effect.gen(function* () {
  const { layer } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "w1", name: "get_weather", params: { city: "Paris" } }] },
    TestLanguageModel.text("It is Sunny in Paris.")
  ])
  return yield* Effect.gen(function* () {
    const session = yield* AgentSession.make(Weather)
    const probe = yield* AgentProbe.make(session)
    yield* session.prompt("weather in Paris?")
    return yield* probe.events
  }).pipe(Effect.provide(layer), Effect.scoped)
})

const find = (envelopes: ReadonlyArray<AgentEventEnvelope>, tag: string) =>
  envelopes.find((envelope) => envelope.event._tag === tag)

const N = Observability.attributeNames

describe("Observability.describe", () => {
  it.effect("maps events to the semantic span tree and standard correlation attributes", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const toolStarted = find(envelopes, "ToolCallStarted")!
      const record = Observability.describe(toolStarted)

      assert.strictEqual(record.name, "ai.tool")
      assert.strictEqual(record.attributes[N.toolName], "get_weather")
      assert.strictEqual(record.attributes[N.toolCallId], "w1")
      assert.isDefined(record.attributes[N.session])
      assert.isDefined(record.attributes[N.submission]) // present -> Some was unwrapped
      assert.isDefined(record.attributes[N.run])
      assert.strictEqual(record.attributes[N.event], "ToolCallStarted")

      // Span names follow the tree.
      assert.strictEqual(Observability.describe(find(envelopes, "SubmissionStarted")!).name, "agent.submission")
      assert.strictEqual(Observability.describe(find(envelopes, "RunStarted")!).name, "agent.run")
      assert.strictEqual(Observability.describe(find(envelopes, "TurnStarted")!).name, "agent.turn")
      assert.strictEqual(Observability.describe(find(envelopes, "MessageCompleted")!).name, "ai.model")
    })
  )

  it.effect("content is omitted by default, included under a policy, and scrubbed by redact", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const toolStarted = find(envelopes, "ToolCallStarted")!
      const toolSucceeded = find(envelopes, "ToolCallSucceeded")!
      const message = find(envelopes, "MessageCompleted")!

      // Metadata only (default): no params/result/text.
      assert.isUndefined(Observability.describe(toolStarted).attributes[N.toolParams])
      assert.isUndefined(Observability.describe(toolSucceeded).attributes[N.toolResult])
      assert.isUndefined(Observability.describe(message).attributes[N.modelText])

      // With content: present.
      assert.deepStrictEqual(
        Observability.describe(toolStarted, Observability.withContent).attributes[N.toolParams],
        { city: "Paris" }
      )
      assert.strictEqual(
        Observability.describe(toolSucceeded, Observability.withContent).attributes[N.toolResult],
        "Sunny in Paris"
      )
      assert.strictEqual(
        Observability.describe(message, Observability.withContent).attributes[N.modelText],
        "It is Sunny in Paris."
      )

      // redact scrubs whatever content is turned on.
      const scrubbed = Observability.describe(toolStarted, {
        ...Observability.withContent,
        redact: () => "[redacted]"
      })
      assert.strictEqual(scrubbed.attributes[N.toolParams], "[redacted]")
    })
  )
})

describe("Observability.trace", () => {
  it.effect("emits one record per event through the sink, with base attributes merged in", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const captured = yield* Ref.make<ReadonlyArray<Observability.TelemetryRecord>>([])
      yield* Observability.trace(Stream.fromIterable(envelopes), {
        attributes: { [N.durable]: false },
        sink: (record) => Ref.update(captured, (all) => [...all, record])
      })

      const records = yield* Ref.get(captured)
      assert.strictEqual(records.length, envelopes.length)
      // The tool call and the model message both surfaced under their span names.
      assert.isTrue(records.some((r) => r.name === "ai.tool" && r.attributes[N.toolName] === "get_weather"))
      assert.isTrue(records.some((r) => r.name === "ai.model"))
      // Base attributes are merged into every record.
      assert.isTrue(records.every((r) => r.attributes[N.durable] === false))
    })
  )
})
