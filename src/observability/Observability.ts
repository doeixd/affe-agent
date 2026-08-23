import { Effect, Option, Stream } from "effect"
import type { AgentEventEnvelope } from "../AgentEvent.js"

/**
 * Observability (issue #4 §12): semantic tracing conventions, not a wrapper.
 *
 * Effect already has tracing and logging; this package standardises the *names
 * and attributes* an agent should emit, and adds the one policy telemetry needs
 * that generic tracing does not -- redaction. It operates through the public
 * event stream (`AgentSession.events`), so it observes without touching the run.
 *
 * The vocabulary follows the span tree the runtime already nests
 * (`agent.session → submission → run → turn → {ai.model, ai.tool}`): every
 * record carries the correlation ids under stable `agent.*` / `ai.*` keys, so an
 * exporter can group and filter agent telemetry the same way across services.
 *
 * **Content is opt-in.** By default only metadata is recorded -- ids, event
 * names, tool names. Prompts, tool parameters, tool results and model output are
 * omitted unless a `RedactionPolicy` turns them on, and a `redact` hook can
 * scrub what does get through. Telemetry should not become a PII/secret leak.
 *
 * ```ts
 * // Fork an observer over a session's events, metadata only (the default):
 * yield* Effect.forkScoped(Observability.trace(AgentSession.events(session)))
 *
 * // Opt into content, with redaction, and tag the run:
 * yield* Effect.forkScoped(Observability.trace(AgentSession.events(session), {
 *   policy: { ...Observability.withContent, redact: scrubSecrets },
 *   attributes: { [Observability.attributeNames.durable]: false }
 * }))
 * ```
 */

// ---------------------------------------------------------------------------
// The attribute vocabulary
// ---------------------------------------------------------------------------

/** Stable attribute keys, so every emitter and dashboard agrees on the names. */
export const attributeNames = {
  session: "agent.session.id",
  submission: "agent.submission.id",
  run: "agent.run.id",
  turn: "agent.turn.index",
  sequence: "agent.sequence",
  event: "agent.event",
  toolName: "ai.tool.name",
  toolCallId: "ai.tool.call_id",
  toolParams: "ai.tool.params",
  toolResult: "ai.tool.result",
  modelText: "ai.model.text",
  streaming: "agent.streaming",
  durable: "agent.durable"
} as const

/** The span an event belongs to, from the tree the runtime nests. */
const spanNameFor = (tag: string): string => {
  if (tag.startsWith("ToolCall")) return "ai.tool"
  if (tag.startsWith("Message")) return "ai.model"
  if (tag.startsWith("Session")) return "agent.session"
  if (tag.startsWith("Submission")) return "agent.submission"
  if (tag.startsWith("Run")) return "agent.run"
  if (tag.startsWith("Turn")) return "agent.turn"
  return "agent.event"
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * What content, if any, telemetry records. Everything defaults to off; `redact`
 * scrubs any content that is turned on before it is recorded.
 */
export interface RedactionPolicy {
  /** Record a tool call's parameters (`ai.tool.params`). */
  readonly toolParams: boolean
  /** Record a tool call's result (`ai.tool.result`). */
  readonly toolResults: boolean
  /** Record model output text (`ai.model.text`). */
  readonly modelText: boolean
  /** Scrub a value before it is recorded. Applied to every content field. */
  readonly redact?: ((value: unknown) => unknown) | undefined
}

/** Record ids and names, never content. The safe default. */
export const metadataOnly: RedactionPolicy = {
  toolParams: false,
  toolResults: false,
  modelText: false
}

/** Record content too. Combine with `redact` to scrub secrets. */
export const withContent: RedactionPolicy = {
  toolParams: true,
  toolResults: true,
  modelText: true
}

// ---------------------------------------------------------------------------
// Mapping an event to a telemetry record
// ---------------------------------------------------------------------------

/** A span/log name and its attributes, derived from one event. */
export interface TelemetryRecord {
  readonly name: string
  readonly attributes: Readonly<Record<string, unknown>>
}

/**
 * Map one event envelope to a telemetry record: its span name and the standard
 * attributes, with content included only where the policy allows. Pure, so an
 * exporter integration or a test can use it directly.
 */
export const describe = (
  envelope: AgentEventEnvelope,
  policy: RedactionPolicy = metadataOnly
): TelemetryRecord => {
  const event = envelope.event
  const redact = policy.redact ?? ((value: unknown) => value)
  const attributes: Record<string, unknown> = {
    [attributeNames.session]: envelope.sessionId,
    [attributeNames.sequence]: envelope.sequence,
    [attributeNames.event]: event._tag
  }
  if (Option.isSome(envelope.submissionId)) attributes[attributeNames.submission] = envelope.submissionId.value
  if (Option.isSome(envelope.runId)) attributes[attributeNames.run] = envelope.runId.value
  if (Option.isSome(envelope.turn)) attributes[attributeNames.turn] = envelope.turn.value

  switch (event._tag) {
    case "ToolCallStarted": {
      attributes[attributeNames.toolName] = event.name
      attributes[attributeNames.toolCallId] = event.id
      if (policy.toolParams) attributes[attributeNames.toolParams] = redact(event.params)
      break
    }
    case "ToolCallProgress":
    case "ToolCallSucceeded": {
      attributes[attributeNames.toolName] = event.name
      attributes[attributeNames.toolCallId] = event.id
      if (policy.toolResults) attributes[attributeNames.toolResult] = redact(event.result)
      break
    }
    case "ToolCallFailed":
    case "ToolCallInterrupted": {
      attributes[attributeNames.toolName] = event.name
      attributes[attributeNames.toolCallId] = event.id
      break
    }
    case "MessageCompleted": {
      if (policy.modelText) attributes[attributeNames.modelText] = redact(event.text)
      break
    }
    case "MessageDelta": {
      if (policy.modelText) attributes[attributeNames.modelText] = redact(event.delta)
      break
    }
    default:
      break
  }
  return { name: spanNameFor(event._tag), attributes }
}

// ---------------------------------------------------------------------------
// Observing a session
// ---------------------------------------------------------------------------

const logRecord = (record: TelemetryRecord): Effect.Effect<void> =>
  Effect.logInfo(record.name).pipe(Effect.annotateLogs(record.attributes))

export interface TraceOptions {
  /** What content to record. Defaults to metadata only. */
  readonly policy?: RedactionPolicy | undefined
  /** Attributes merged into every record -- e.g. `agent.streaming`, `agent.durable`. */
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
  /** Where records go. Defaults to a structured Effect log per event. */
  readonly sink?: ((record: TelemetryRecord) => Effect.Effect<void>) | undefined
}

/**
 * Observe an agent's event stream and emit a telemetry record per event.
 *
 * Runs until the stream ends, so fork it (`Effect.forkScoped`) alongside the
 * run. The default sink emits a structured Effect log per event with the
 * standard attributes as annotations, which any Effect logging/tracing exporter
 * already captures; pass `sink` to route records elsewhere.
 */
export const trace = (
  events: Stream.Stream<AgentEventEnvelope>,
  options?: TraceOptions
): Effect.Effect<void> => {
  const sink = options?.sink ?? logRecord
  const base = options?.attributes
  return Stream.runForEach(events, (envelope) => {
    const record = describe(envelope, options?.policy)
    return sink(base === undefined ? record : { name: record.name, attributes: { ...base, ...record.attributes } })
  })
}
