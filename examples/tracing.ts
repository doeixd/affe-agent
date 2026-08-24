import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"

/**
 * Exporting harness traces over OTLP.
 *
 * v4 ships an OTLP exporter in-tree at `effect/unstable/observability`, so
 * traces, logs and metrics reach a collector without the OpenTelemetry SDK or
 * `@effect/opentelemetry`. Reach for the SDK bridge only when you must interop
 * with existing OTel instrumentation in the same process.
 *
 * Nothing here is harness-specific: the engine emits ordinary Effect spans, so
 * wiring a tracer is the same job it would be in any Effect application.
 */
const TracingLayer = Otlp.layer({
  baseUrl: "http://localhost:4318",
  resource: { serviceName: "effect-harness" }
}).pipe(Layer.provide(FetchHttpClient.layer))

const Researcher = Agent.make({ instructions: "Research carefully." })

/**
 * A trace of one prompt nests as the execution actually nests:
 *
 * ```text
 * AgentSession.prompt        agent.session.id
 * └── AgentSubmission.execute        + agent.submission.id
 *     └── AgentRun.execute           + agent.run.id
 *         └── AgentTurn.execute      + agent.turn.index
 *             ├── LanguageModel.generateText   (GenAI conventions, from Effect AI)
 *             └── ToolExecution.tool  + ai.tool.name, ai.tool.call_id
 * ```
 *
 * The attribute keys are `Observability.attributeNames` -- the same ones the
 * `/observability` event records use, so a trace and the events describing the
 * same run join on `agent.run.id` with no translation table. Span *names* are
 * `Module.operation`, which is the Effect convention and what `Effect.fn`
 * produces; the join is by attribute, not by name.
 *
 * The model span and its GenAI attributes come from Effect AI itself; the
 * harness only supplies the structure above it. Effect AI also annotates
 * `ToolExecution.tool` with its own `tool` and `parameters` keys -- note
 * `parameters` is unredacted, so scrub at the exporter if tools see secrets.
 */
export const program = Effect.gen(function* () {
  const session = yield* AgentSession.make(Researcher)
  return yield* AgentSession.prompt(session, "Research Effect AI.")
}).pipe(Effect.scoped, Effect.provide(TracingLayer))

/**
 * In a real deployment prefer `layerFromConfig`, which reads the standard
 * `OTEL_*` configuration rather than hard-coding an endpoint. The harness never
 * reads the environment itself — this is ordinary application wiring.
 */
export const fromEnvironment = Otlp.layerFromConfig({
  resource: { serviceName: "effect-harness" }
}).pipe(Layer.provide(FetchHttpClient.layer))
