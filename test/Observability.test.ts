import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Metric, Option, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import type { AgentEvent, AgentEventEnvelope } from "../src/AgentEvent.js"
import * as Ids from "../src/internal/ids.js"
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
    {
      toolCalls: [{ id: "w1", name: "get_weather", params: { city: "Paris" } }],
      usage: { input: 5, output: 2 }
    },
    { text: "It is Sunny in Paris.", usage: { input: 8, output: 3 } }
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
      const model = Observability.describe(find(envelopes, "ModelCallCompleted")!)
      assert.strictEqual(model.name, "ai.model")
      assert.strictEqual(model.attributes[N.modelInputTokens], 5)
      assert.strictEqual(model.attributes[N.modelOutputTokens], 2)
      assert.strictEqual(model.attributes[N.modelTotalTokens], 7)
      assert.strictEqual(model.attributes[N.modelFinishReason], "stop")
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

      // redact scrubs every content field it is applied to -- params, results
      // and model text alike, not only the first branch.
      const redact = { ...Observability.withContent, redact: () => "[redacted]" }
      assert.strictEqual(Observability.describe(toolStarted, redact).attributes[N.toolParams], "[redacted]")
      assert.strictEqual(Observability.describe(toolSucceeded, redact).attributes[N.toolResult], "[redacted]")
      assert.strictEqual(Observability.describe(message, redact).attributes[N.modelText], "[redacted]")
    })
  )
})

describe("Observability.describe on a failed tool", () => {
  const Boom = Tool.make("boom", { parameters: Schema.Struct({}), success: Schema.String, failure: Schema.String })
  const BoomAgent = Agent.make({
    instructions: "boom",
    tools: [Agent.tool(Boom, () => Effect.fail("nope"))],
    loop: AgentLoop.bounded(3)
  })

  it.effect("a failed or interrupted tool records its name and id but never a result, even under withContent", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "b1", name: "boom", params: {} }] },
        TestLanguageModel.text("gave up")
      ])
      const envelopes = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(BoomAgent)
        const probe = yield* AgentProbe.make(session)
        yield* session.prompt("go")
        return yield* probe.events
      }).pipe(Effect.provide(layer), Effect.scoped)

      const failed = find(envelopes, "ToolCallFailed")!
      const record = Observability.describe(failed, Observability.withContent)
      assert.strictEqual(record.name, "ai.tool")
      assert.strictEqual(record.attributes[N.toolName], "boom")
      assert.strictEqual(record.attributes[N.toolCallId], "b1")
      // A failure carries no result, even with content turned on.
      assert.isUndefined(record.attributes[N.toolResult])
      assert.isUndefined(record.attributes[N.toolParams])
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

  it.effect("a record's own attributes win over a colliding base attribute", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      const captured = yield* Ref.make<ReadonlyArray<Observability.TelemetryRecord>>([])
      // Base sets a key the record also sets: the record's real value must win.
      yield* Observability.trace(Stream.fromIterable(envelopes), {
        attributes: { [N.event]: "OVERRIDDEN" },
        sink: (record) => Ref.update(captured, (all) => [...all, record])
      })
      const records = yield* Ref.get(captured)
      assert.isTrue(records.length > 0)
      assert.isTrue(records.every((r) => r.attributes[N.event] !== "OVERRIDDEN"))
    })
  )
})

describe("Observability.metrics", () => {
  it.effect("records model usage, turns, tool outcomes and queue depth from the event stream", () =>
    Effect.gen(function* () {
      const envelopes = yield* collectEnvelopes
      yield* Observability.metrics(Stream.fromIterable(envelopes))

      // Turns: one per TurnCompleted in the real run.
      const turns = envelopes.filter((e) => e.event._tag === "TurnCompleted").length
      const turnsMetric = yield* Metric.value(Observability.instruments.turns)
      assert.strictEqual(turnsMetric.count, turns)

      const inputTokens = yield* Metric.value(
        Metric.withAttributes(Observability.instruments.modelTokens, {
          direction: "input"
        })
      )
      const outputTokens = yield* Metric.value(
        Metric.withAttributes(Observability.instruments.modelTokens, {
          direction: "output"
        })
      )
      assert.strictEqual(inputTokens.count, 13)
      assert.strictEqual(outputTokens.count, 5)

      // Tool calls are attributed by tool name *and* by how the call ended, so
      // "which tool is failing" is a query rather than a log search.
      const succeeded = yield* Metric.value(
        Metric.withAttributes(Observability.instruments.toolCalls, {
          tool: "get_weather",
          outcome: "succeeded"
        })
      )
      assert.strictEqual(succeeded.count, 1)

      // A tool that never failed has no failure count, rather than a zero that
      // looks like a measurement.
      const failed = yield* Metric.value(
        Metric.withAttributes(Observability.instruments.toolCalls, {
          tool: "get_weather",
          outcome: "failed"
        })
      )
      assert.strictEqual(failed.count, 0)

      // Run depth landed in the histogram.
      const perRun = yield* Metric.value(
        Observability.instruments.turnsPerRun
      )
      assert.isAbove(perRun.count, 0)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
  )

  it.effect("pending input climbs while queued and returns to zero once applied", () =>
    Effect.gen(function* () {
      // The invariant behind the gauge: accepted input is always applied, so a
      // gauge that does not return to zero means something was dropped. Driven
      // from synthetic envelopes so the queue depth is exactly known.
      //
      // The climb is asserted as well as the return, because an unset gauge
      // reads as zero: a test that only checked the end state would pass just
      // as well if `metrics` ignored every one of these events.
      const envelope = (event: AgentEvent, sequence: number): AgentEventEnvelope => ({
        sessionId: Ids.sessionId("s1"),
        submissionId: Option.some(Ids.submissionId("s1:submission-1")),
        runId: Option.none(),
        turn: Option.none(),
        sequence,
        event
      })
      const queued = [
        envelope({ _tag: "SteeringQueued" }, 1),
        envelope({ _tag: "FollowUpQueued" }, 2)
      ]
      const gauge = Metric.value(Observability.instruments.pendingInput)

      yield* Observability.metrics(Stream.fromIterable(queued))
      assert.strictEqual((yield* gauge).value, 2)

      yield* Observability.metrics(
        Stream.fromIterable([
          ...queued,
          envelope({ _tag: "SteeringApplied", count: 1 }, 3),
          envelope({ _tag: "FollowUpApplied" }, 4)
        ])
      )
      assert.strictEqual((yield* gauge).value, 0)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
  )

  it.effect("a batched SteeringApplied clears every steer it applied", () =>
    Effect.gen(function* () {
      // Steering drains as a batch: two steers queued during one turn are
      // committed by a single `SteeringApplied` carrying `count: 2`. A gauge
      // that decremented once per event would sit at 1 forever and report the
      // dropped-input invariant as broken. Driven from a real run, because the
      // batching is the runtime's behaviour and not something a synthetic
      // sequence should be trusted to reproduce.
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<{}>>()
      const { layer } = yield* TestLanguageModel.script([
        {
          text: "first",
          during: Effect.gen(function* () {
            const session = yield* Deferred.await(sessionRef)
            yield* AgentSession.steer(session, "one")
            yield* AgentSession.steer(session, "two")
          }).pipe(Effect.orDie)
        },
        TestLanguageModel.text("second")
      ])

      const envelopes = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(Agent.make({ instructions: "steerable" }))
        const probe = yield* AgentProbe.make(session)
        yield* Deferred.succeed(sessionRef, session)
        yield* session.prompt("go")
        yield* session.prompt("again")
        return yield* probe.events
      }).pipe(Effect.provide(layer), Effect.scoped)

      const applied = envelopes.filter((envelope) => envelope.event._tag === "SteeringApplied")
      assert.strictEqual(applied.length, 1)
      assert.strictEqual(
        envelopes.filter((envelope) => envelope.event._tag === "SteeringQueued").length,
        2
      )

      yield* Observability.metrics(Stream.fromIterable(envelopes))
      const gauge = yield* Metric.value(Observability.instruments.pendingInput)
      assert.strictEqual(gauge.value, 0)
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
  )
})
