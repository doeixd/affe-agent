import { Effect, Option, Stream } from "effect"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as Telemetry from "../internal/telemetry.js"

/**
 * Observability (issue #4 §12): semantic tracing conventions, not a wrapper.
 *
 * Effect already has tracing and logging; this package standardises the *names
 * and attributes* an agent should emit, and adds the one policy telemetry needs
 * that generic tracing does not -- redaction. It operates through the public
 * event stream (`AgentSession.events`), so it observes without touching the run.
 *
 * The vocabulary follows the span tree the runtime already nests --
 * `AgentSession.prompt → AgentSubmission.execute → AgentRun.execute →
 * AgentTurn.execute → ToolExecution.tool` -- and shares its attribute keys with
 * it: every record carries the correlation ids under the same stable `agent.*`
 * / `ai.*` names the kernel annotates its spans with, so an exporter can group
 * and filter agent telemetry the same way across services, and can join a trace
 * to the events describing the same run.
 *
 * The join is by attribute, not by name. Span names are `Module.operation`
 * (the Effect convention, and what `Effect.fn` produces); `describe` names an
 * event's *record* in the `agent.*` / `ai.*` vocabulary. `agent.run.id` means
 * the same run in both.
 *
 * **Content is opt-in.** By default only metadata is recorded -- ids, event
 * names, tool names. Prompts, tool parameters, tool results and model output are
 * omitted unless a `RedactionPolicy` turns them on, and a `redact` hook can
 * scrub what does get through. Telemetry should not become a PII/secret leak.
 *
 * **That promise covers this event stream, and not the span tree.** Effect AI's
 * `Toolkit.handle` annotates the current span with `{ tool, parameters }`
 * (`effect/unstable/ai/Toolkit.ts`), and the current span there is the harness's
 * own `ToolExecution.tool`. So an application that wires a tracer exports raw
 * tool parameters regardless of the policy set here -- the policy governs what
 * *this package* records, and cannot reach an annotation made upstream.
 *
 * Anyone tracing an agent that handles secrets should therefore scrub at the
 * exporter as well. Stated here rather than left to be discovered, because the
 * default reads as safe and is only safe for one of the two channels.
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

/**
 * Stable attribute keys, so every emitter and dashboard agrees on the names.
 *
 * Re-exported from `internal/telemetry.ts` rather than defined here, because
 * the kernel annotates its spans through the same object. This package used to
 * hold its own copy, and the two drifted: spans said `runId` while this said
 * `agent.run.id`, so an exporter could not join a trace to the events emitted
 * about that same run. The definition now lives below both halves and neither
 * writes a key literal.
 */
export const attributeNames = Telemetry.attributeNames

/**
 * The span an event belongs to.
 *
 * Note this names the span an *event* is attributed to, which is not the same
 * string as the span the runtime opens for the work itself: those are
 * `Effect.fn` names in the `Module.operation` style (`AgentTurn.execute`,
 * `ToolExecution.tool`). Both are correct and they are joined by the attributes
 * above, not by their names — an event carrying `agent.run.id` and the
 * `AgentRun.execute` span carrying the same key are the same run.
 */
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
