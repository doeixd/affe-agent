import { Clock, Effect, Layer, Metric, Option, Stream, Tracer } from "effect"
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
 * `redactingTracer` closes that, and an agent handling secrets should use it:
 * it wraps whichever tracer is configured and drops the attribute before it is
 * exported. Stated here rather than left to be discovered, because the default
 * reads as safe and is only safe for one of the two channels until you do.
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
  if (tag.startsWith("ModelCall")) return "ai.model"
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
    case "ModelCallCompleted": {
      attributes[attributeNames.modelFinishReason] = event.finishReason
      attributes[attributeNames.modelInputTokens] = event.usage.inputTokens
      attributes[attributeNames.modelOutputTokens] = event.usage.outputTokens
      attributes[attributeNames.modelTotalTokens] = event.usage.totalTokens
      break
    }
    case "UnknownEvent": {
      // A newer peer's event. The tag it arrived with is the only thing that
      // distinguishes one from another, so it is the one attribute worth keeping.
      attributes[attributeNames.eventOriginalTag] = event.originalTag
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

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * The instruments an agent runtime is asked about.
 *
 * This package standardised span names and attributes and shipped no metrics,
 * which left the four questions every operator actually asks -- how much work,
 * how deep, which tools fail, how much input is backed up -- answerable only by
 * aggregating logs. `/data`'s `agent_data_dropped_events` counter was the only
 * instrument in the repository, and it is the template these follow: a real
 * failure mode, attributed by the dimension you would group by.
 *
 * Names follow the attribute vocabulary above: `agent_*`, snake_case, with the
 * unit in the name where there is one. Every instrument reads the public stream
 * `trace` already consumes. `ModelCallCompleted` now supplies provider-neutral
 * usage, so tokens are observed here rather than reconstructed from results.
 */
export const metricNames = {
  modelAttempts: "agent_model_attempts",
  modelTokens: "agent_model_tokens",
  turns: "agent_turns",
  turnsPerRun: "agent_turns_per_run",
  toolCalls: "agent_tool_calls",
  toolDuration: "agent_tool_duration_ms",
  pendingInput: "agent_pending_input"
} as const

/** Input and output tokens reported by successful model calls. */
const modelTokens = Metric.counter(metricNames.modelTokens, {
  description: "Model tokens used, attributed by input or output direction",
  incremental: true
})

/** Turns executed, across every run. */
const turnsTotal = Metric.counter(metricNames.turns, {
  description: "Model turns completed",
  incremental: true
})

/**
 * How deep runs go.
 *
 * A histogram rather than a counter because the interesting question is the
 * shape: a loop that usually stops at two turns and occasionally runs to its
 * bound is a different system from one that always runs to eight.
 */
const turnsPerRun = Metric.histogram(metricNames.turnsPerRun, {
  description: "Turns taken by one run",
  boundaries: Metric.linearBoundaries({ start: 1, width: 1, count: 12 })
})

/** Tool calls, by tool and by how they ended. */
const toolCalls = Metric.counter(metricNames.toolCalls, {
  description: "Tool calls, attributed by tool name and outcome",
  incremental: true
})

/**
 * How long tools take, by tool.
 *
 * Measured between `ToolCallStarted` and the call's terminal event **as this
 * observer sees them**, because no event carries a timestamp. On a live stream
 * that is the tool's duration plus the stream's own latency; on a replayed or
 * recorded stream it is meaningless. Stated rather than left to be discovered:
 * an instrument whose validity depends on how it is fed should say so.
 */
const toolDuration = Metric.histogram(metricNames.toolDuration, {
  description: "Tool call duration in milliseconds, as observed",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 4, count: 10 })
})

/**
 * Input accepted and not yet applied.
 *
 * Steering and follow-ups are queued and then applied at a turn boundary, so
 * the difference is work the session has promised and not yet done. A gauge
 * that climbs is the backpressure signal; a gauge that never returns to zero
 * means something accepted input it then dropped, which is the invariant
 * `AgentSession` exists to keep.
 */
const pendingInput = Metric.gauge(metricNames.pendingInput, {
  description: "Steering and follow-up input accepted but not yet applied"
})

/**
 * The instruments themselves.
 *
 * Exported because a metric's *identity* is its name **and** its description,
 * so anything wanting to read one has to reconstruct both exactly. `/data`'s
 * test does reconstruct them, and that is a description string duplicated in
 * two places waiting to drift -- the same failure the coding toolkit's prompt
 * rendering was built to prevent.
 *
 * Handing out the instrument removes the duplication, and it is useful beyond
 * tests: an application exposing its own health endpoint can read these
 * directly rather than going through an exporter.
 *
 * Attributes are not applied here. `metrics` merges its `attributes` option at
 * update time, so a reader interested in one dimension applies the same
 * `Metric.withAttributes` it would anyway.
 */
export const instruments = {
  /**
   * Model calls attempted under an `ExecutionPlan`, by ladder step and outcome.
   *
   * Defined in the kernel rather than here, because the kernel is what produces
   * it -- a plan runs inside `AgentTurn` -- and a battery cannot be imported by
   * the thing it is built over. Re-exported so it is read the same way as the
   * rest.
   */
  modelAttempts: Telemetry.modelAttempts,
  modelTokens,
  turns: turnsTotal,
  turnsPerRun,
  toolCalls,
  toolDuration,
  pendingInput
} as const

/** How a tool call ended, as a metric dimension. */
const toolOutcome = (tag: string): string | undefined => {
  if (tag === "ToolCallSucceeded") return "succeeded"
  if (tag === "ToolCallFailed") return "failed"
  if (tag === "ToolCallInterrupted") return "interrupted"
  return undefined
}

/**
 * Observe an agent's event stream and record metrics from it.
 *
 * The sibling of `trace`, and forked the same way
 * (`Effect.forkScoped(Observability.metrics(AgentSession.events(session)))`).
 * Kept separate rather than folded into `trace` because the two have different
 * costs and different reasons to be switched off: tracing is per-event and
 * carries content policy, metrics are aggregate and carry none.
 *
 * There is no redaction policy here on purpose. A metric dimension must be
 * low-cardinality to be useful, so nothing user-supplied is ever an attribute:
 * tool *names* are, tool parameters and results are not, and no metric can
 * become the leak that `RedactionPolicy` exists to prevent.
 */
export const metrics = (
  events: Stream.Stream<AgentEventEnvelope>,
  options?: {
    /** Attributes added to every instrument -- e.g. a deployment or agent name. */
    readonly attributes?: Readonly<Record<string, string>> | undefined
  }
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const base = options?.attributes ?? {}
    // Start times by tool-call id. Local to one observer, and cleared as each
    // call ends, so a long session does not accumulate entries for calls that
    // have finished.
    const started = new Map<string, { readonly at: number; readonly name: string }>()
    // Accepted-not-applied, tracked as a running count rather than read from
    // the session: the gauge must describe what the *stream* has reported, or
    // it disagrees with the events beside it.
    let outstanding = 0

    // `withAttributes` preserves `Metric<Input, State>`, so this needs no cast:
    // the instrument that goes in is the instrument that comes out, and a
    // wrong `Metric.update` against it still fails to compile.
    const withBase = <Input, State>(
      metric: Metric.Metric<Input, State>,
      extra?: Readonly<Record<string, string>>
    ): Metric.Metric<Input, State> =>
      Metric.withAttributes(metric, { ...base, ...extra })

    return yield* Stream.runForEach(events, (envelope) => {
      const event = envelope.event
      switch (event._tag) {
        case "ModelCallCompleted":
          return Effect.all([
            Metric.update(
              withBase(modelTokens, { direction: "input" }),
              event.usage.inputTokens
            ),
            Metric.update(
              withBase(modelTokens, { direction: "output" }),
              event.usage.outputTokens
            )
          ], { discard: true })
        case "TurnCompleted":
          return Metric.update(withBase(turnsTotal), 1)
        case "RunCompleted":
          return Metric.update(withBase(turnsPerRun), event.turns)
        case "ToolCallStarted":
          return Clock.currentTimeMillis.pipe(
            Effect.map((at) => {
              started.set(event.id, { at, name: event.name })
            })
          )
        case "ToolCallSucceeded":
        case "ToolCallFailed":
        case "ToolCallInterrupted": {
          const outcome = toolOutcome(event._tag)!
          const begun = started.get(event.id)
          started.delete(event.id)
          const count = Metric.update(
            withBase(toolCalls, { tool: event.name, outcome }),
            1
          )
          return begun === undefined
            ? count
            : Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  Effect.andThen(
                    count,
                    Metric.update(
                      withBase(toolDuration, { tool: event.name }),
                      now - begun.at
                    )
                  )
                )
              )
        }
        case "SteeringQueued":
        case "FollowUpQueued":
          outstanding = outstanding + 1
          return Metric.update(withBase(pendingInput), outstanding)
        // Steering is drained in a batch: one `SteeringApplied` reports the
        // whole batch through `count`, so decrementing by one leaks a steer per
        // extra input in the batch and the gauge never returns to zero -- which
        // is precisely the signal this instrument uses to mean "input was
        // accepted and then dropped". A follow-up is applied singly and carries
        // no count.
        case "SteeringApplied":
          outstanding = Math.max(0, outstanding - event.count)
          return Metric.update(withBase(pendingInput), outstanding)
        case "FollowUpApplied":
          outstanding = Math.max(0, outstanding - 1)
          return Metric.update(withBase(pendingInput), outstanding)
        default:
          return Effect.void
      }
    })
  })

// ---------------------------------------------------------------------------
// Redaction for the span tree
// ---------------------------------------------------------------------------

/**
 * Scrub attributes off spans before they reach whatever tracer is configured.
 *
 * ## Why this exists
 *
 * The `RedactionPolicy` above governs what *this package* records from the
 * event stream, and it cannot reach the other channel. Effect AI's
 * `Toolkit.handle` annotates the **current span** with `{ tool, parameters }`
 * (`effect/unstable/ai/Toolkit.ts`), and because `handle` is `Effect.fnUntraced`
 * the current span there is the harness's own `ToolExecution.tool`. So an
 * application that wires any tracer exports every tool call's raw arguments,
 * whatever policy it set here -- including under `metadataOnly`, the default
 * chosen because it is safe.
 *
 * Nothing about that is upstream's bug: annotating a tool call is reasonable,
 * and `Toolkit` promises no redaction. The defect was ours, in making a promise
 * broad enough to be read as covering both channels while owning only one.
 *
 * ## Why a `Layer` here does not break the harness's rule
 *
 * AGENTS.md is explicit that *"tracing export is application wiring, never a
 * harness dependency"*, and that rule is worth keeping. This does not touch it:
 *
 * - it imports no exporter and names no backend;
 * - it decides nothing about where spans go -- it wraps whichever `Tracer` is
 *   already in context, including the default one;
 * - it is opted into, exactly as `RedactionPolicy` is.
 *
 * What it is, is a *policy value* about content, which is this package's
 * subject. An application still chooses its exporter and still chooses whether
 * to apply this at all.
 *
 * ## Using it
 *
 * ```ts
 * program.pipe(
 *   Effect.provide(Observability.redactingTracer()),
 *   Effect.provide(myOtlpLayer)          // still entirely the application's
 * )
 * ```
 *
 * Order matters: this must be provided *inside* the tracer it wraps, so that
 * the tracer it reads is the real one.
 */
export interface SpanRedaction {
  /**
   * Attribute keys to drop, by span name.
   *
   * Keyed by span rather than applied globally because an application's own
   * spans may legitimately carry an attribute called `parameters`, and a
   * redactor that silently ate it would be a different bug.
   */
  readonly drop: Readonly<Record<string, ReadonlyArray<string>>>
  /**
   * Rewrite an attribute that is not dropped. Applied to every attribute on a
   * span named in `drop`; return the value unchanged to keep it.
   */
  readonly redact?: ((key: string, value: unknown) => unknown) | undefined
}

/**
 * The default: the one leak we know about, on the one span it lands on.
 *
 * `parameters` is Effect AI's raw tool arguments. `tool` is just the name and
 * is kept -- it is the dimension you would group by, and it is not content.
 */
export const defaultSpanRedaction: SpanRedaction = {
  drop: { "ToolExecution.tool": ["parameters"] }
}

/**
 * A tracer that applies `redaction` and then delegates everything else.
 *
 * Written as a delegating object rather than a subclass because `Tracer.Span`
 * is an interface with live getters -- `status` and `attributes` change as the
 * span runs, so the wrapper reads through to the underlying span rather than
 * snapshotting it.
 */
const redactSpan = (
  span: Tracer.Span,
  redaction: SpanRedaction
): Tracer.Span => {
  const dropped = redaction.drop[span.name]
  if (dropped === undefined) return span
  const drop = new Set(dropped)
  const rewrite = redaction.redact
  return {
    _tag: "Span",
    get name() {
      return span.name
    },
    get spanId() {
      return span.spanId
    },
    get traceId() {
      return span.traceId
    },
    get parent() {
      return span.parent
    },
    get annotations() {
      return span.annotations
    },
    get status() {
      return span.status
    },
    get attributes() {
      return span.attributes
    },
    get links() {
      return span.links
    },
    get sampled() {
      return span.sampled
    },
    get kind() {
      return span.kind
    },
    end: (endTime, exit) => span.end(endTime, exit),
    addLinks: (links) => span.addLinks(links),
    attribute: (key, value) => {
      if (drop.has(key)) return
      span.attribute(key, rewrite === undefined ? value : rewrite(key, value))
    },
    event: (name, startTime, attributes) => {
      if (attributes === undefined) return span.event(name, startTime)
      const kept: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(attributes)) {
        if (drop.has(key)) continue
        kept[key] = rewrite === undefined ? value : rewrite(key, value)
      }
      span.event(name, startTime, kept)
    }
  }
}

/**
 * A `Layer` that scrubs span attributes on the way to the configured tracer.
 *
 * Defaults to `defaultSpanRedaction`, which drops the one attribute known to
 * carry content the event-stream policy would have withheld.
 */
export const redactingTracer = (
  redaction: SpanRedaction = defaultSpanRedaction
): Layer.Layer<never> =>
  Layer.effect(
    Tracer.Tracer,
    Effect.map(Tracer.Tracer, (underlying) =>
      Tracer.make({
        span: (options) => redactSpan(underlying.span(options), redaction)
      })
    )
  )
