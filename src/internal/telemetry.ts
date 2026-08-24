import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type * as ExecutionPlan from "effect/ExecutionPlan"
import type { RunId, SubmissionId } from "./ids.js"

/**
 * The attribute vocabulary, defined once.
 *
 * Two halves of this library emit telemetry about the same run: the kernel
 * opens spans (`Effect.fn("AgentTurn.execute")` and friends) and annotates them
 * with the correlation ids, while `/observability` maps the public event stream
 * to records an exporter can ship. Both are describing the same submission,
 * run and turn.
 *
 * They previously did so in different words. The spans annotated `runId`; the
 * package documented `agent.run.id`. Nothing was wrong in either place on its
 * own, and the result was still broken: an exporter could not join a trace to
 * the events emitted about that same run, because the keys did not match. The
 * correlation existed in the system and not in the telemetry — which is the one
 * thing `/observability` exists to provide.
 *
 * So the names live here, below both halves, and neither writes a key literal.
 * `/observability` re-exports this as `Observability.attributeNames`, which
 * stays the public name; the kernel annotates through `annotate*` below.
 *
 * The keys follow OpenTelemetry convention — lowercase, dot-separated, prefixed
 * by the thing they describe (`agent.*` for our own vocabulary, `ai.*` for the
 * model and tool concepts shared with Effect AI).
 */
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

export type AttributeNames = typeof attributeNames

/**
 * Why `sessionId` is `string` here and branded everywhere else.
 *
 * `ToolExecution.SessionContext` deliberately carries an unbranded `id`: a tool
 * call needs the session's identity for correlation and has no business
 * decoding one. Widening this parameter is the cheaper side of that mismatch —
 * the alternative is widening a public interface to suit telemetry, which is
 * the tail wagging the dog. `SubmissionId` and `RunId` stay branded, so the
 * mistakes worth catching (passing a run id where a submission id belongs)
 * still fail to compile.
 */
type SessionIdentity = string

/**
 * Annotate the current span with a session's identity.
 *
 * Every kernel span carries this. Filtering a trace view by session is the
 * first thing anyone does, and before this the id appeared only on the spans
 * `client/internal/sessionHost.ts` opened — so the filter selected the host's
 * spans and none of the work beneath them.
 */
export const annotateSession = (
  sessionId: SessionIdentity
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({ [attributeNames.session]: sessionId })

/** Annotate the current span with the submission it belongs to. */
export const annotateSubmission = (
  sessionId: SessionIdentity,
  submissionId: SubmissionId
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    [attributeNames.session]: sessionId,
    [attributeNames.submission]: submissionId
  })

/** Annotate the current span with the run it belongs to. */
export const annotateRun = (
  sessionId: SessionIdentity,
  submissionId: SubmissionId,
  runId: RunId
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    [attributeNames.session]: sessionId,
    [attributeNames.submission]: submissionId,
    [attributeNames.run]: runId
  })

/**
 * Annotate the current span with the turn it belongs to.
 *
 * The turn index is a number rather than a string: `agent.turn.index` is a
 * quantity a backend should be able to filter as one.
 */
export const annotateTurn = (
  sessionId: SessionIdentity,
  runId: RunId,
  turn: number
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    [attributeNames.session]: sessionId,
    [attributeNames.run]: runId,
    [attributeNames.turn]: turn
  })

/** Annotate the current span with the tool call it is executing. */
export const annotateTool = (
  sessionId: SessionIdentity,
  name: string,
  toolCallId: string
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    [attributeNames.session]: sessionId,
    [attributeNames.toolName]: name,
    [attributeNames.toolCallId]: toolCallId
  })

// ---------------------------------------------------------------------------
// Model attempts, under an ExecutionPlan
// ---------------------------------------------------------------------------

/**
 * How often the model ladder was climbed, and how far.
 *
 * Lives here for the same reason `attributeNames` does: the kernel produces
 * these (an `ExecutionPlan` runs inside `AgentTurn`) and `/observability`
 * publishes them, so the definition belongs below both. A battery cannot be
 * imported by the kernel it is built over.
 *
 * Attributed by **step** and **outcome**, because "how often are we falling
 * back, and to what" is the question a fallback ladder exists to make
 * answerable. A ladder whose second step is carrying production is working
 * exactly as designed and is also something an operator should know.
 *
 * Deliberately not an `AgentEvent`. The kernel's event vocabulary describes
 * what the *conversation* did; which provider answered is an infrastructure
 * fact, and adding a tag for it would be the first event that is not about the
 * agent at all.
 */
export const modelAttempts = Metric.counter("agent_model_attempts", {
  description:
    "Model calls attempted under an ExecutionPlan, by ladder step and outcome",
  incremental: true
})

/**
 * Record one plan event, if it is one that settles.
 *
 * `AttemptStart` is deliberately ignored: every start is followed by a success
 * or a failure, so counting starts as well would double every attempt and make
 * the ratio between them meaningless.
 */
export const recordAttempt = <E>(
  // Generic in the failure type rather than taking `Event<unknown>`: the
  // handler's parameter is what `withExecutionPlan` infers the plan's error
  // channel from, so pinning it to `unknown` widens the whole call's `E`.
  event: ExecutionPlan.Event<E>
): Effect.Effect<void> => {
  if (event._tag === "AttemptStart") return Effect.void
  return Metric.update(
    Metric.withAttributes(modelAttempts, {
      step: String(event.stepIndex),
      outcome: event._tag === "AttemptSuccess" ? "succeeded" : "failed"
    }),
    1
  )
}
