import { Cause, Context, Effect, Ref, Schema, Stream } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import { Tool, Toolkit } from "effect/unstable/ai"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"
import { activityName, nextOccurrence, startMarkerName } from "../internal/toolActivity.js"
import { InsideToolActivity } from "../internal/insideToolActivity.js"

/**
 * Makes every tool call a durable `Activity`.
 *
 * This is the stronger case for durability than the model call. A model call
 * repeated on replay costs money and returns something different; a *tool* call
 * repeated on replay reissues its side effect. The refund goes out twice.
 *
 * Wrapping the handler means a resumed execution returns the persisted result
 * for any call that already completed.
 *
 * One consequence is worth knowing: the activity journals the handler's
 * *whole* result stream, so a tool's preliminary results reach the harness —
 * and `ToolCallProgress` reaches `events` — only once the call has finished,
 * in a batch. Progress is observational and nothing in canonical history
 * changes, but a durable tool is not live in the way a local one is. Live
 * progress under durability would have to be written straight to a delivery
 * log from inside the activity, where the handler actually runs once.
 */

/**
 * Wrap a resolved toolkit so its handlers run as activities.
 *
 * Activity identity is `tool-{name}-{toolCallId}`. The id comes from the
 * provider and is stable within a response, which is exactly the property that
 * makes a replayed call recognisable as the same call.
 */
/**
 * What a tool activity persists: an outcome, never a failure.
 *
 * Effect AI's failure types are not generically encodable, and an activity that
 * fails without a declared error schema is unencodable outright, so the outcome
 * is modelled as data instead.
 */
type Journalled = {
  readonly _tag: "Ok" | "Err"
  readonly result: unknown
  readonly encodedResult: unknown
  readonly preliminary: boolean
}

/**
 * A tool call's outcome as the journal records it. Exported with `reraise`
 * so a recorded value can be driven through the rule that turns it back
 * into an effect without an engine.
 */
export type Outcome =
  | { readonly _tag: "Succeeded"; readonly results: ReadonlyArray<Journalled> }
  | { readonly _tag: "Failed"; readonly failure: AgentEvent.Failure }
  | { readonly _tag: "Unresolved" }

/**
 * Whether a tool's handler may be reissued after an interruption.
 *
 * Read from `Tool.Idempotent`, upstream's own annotation, rather than from a
 * field of our own. Its meaning is already exactly the question being asked --
 * "can this be called again with the same parameters without changing anything
 * beyond the first call" -- and it is what a tool author annotates anyway,
 * because it is emitted as the MCP `idempotentHint`. Inventing a second name
 * for one fact would have every tool declare it twice and eventually disagree.
 *
 * Upstream defaults it to `false`, which is the safe default and the one we
 * want: a tool nobody has thought about is assumed to have side effects.
 */
export const isRetrySafe = (tool: Tool.Any): boolean => Context.get(tool.annotations, Tool.Idempotent)

/**
 * Raised when a tool's outcome cannot be known.
 *
 * The handler was interrupted, or its process died, after it may already have
 * done its work (the start marker says it began; nothing says it finished),
 * and the tool is not annotated `Tool.Idempotent`, so running it again could
 * issue the side effect twice. Neither answer is available, and inventing one would be
 * worse than saying so.
 */
export class DurableToolUnresolvedError extends Schema.TaggedError<DurableToolUnresolvedError>()(
  "DurableToolUnresolvedError",
  {
    toolName: Schema.String,
    toolCallId: Schema.String
  }
) {
  override get message() {
    return `Tool ${this.toolName} was interrupted, or its process stopped, while it ran; it is not retry-safe, so its outcome is unknown`
  }
}

/**
 * The schema a tool's results are journalled under.
 *
 * `Schema.Unknown` was wrong here for the same reason it was wrong for model
 * response parts, but it failed later and louder. A handler result carries both
 * an `encodedResult` — JSON, destined for the model — and a decoded `result`,
 * which is what the harness commits to history and reports in
 * `ToolCallSucceeded`. That decoded value is whatever the tool's success schema
 * produces: a `Date`, a class instance, a branded type. `Schema.Unknown` cannot
 * encode those, so a SQL journal rejected the write outright with
 * `SchemaError: Expected JSON value` and the submission died. The in-memory
 * engine does not enforce JSON, which is why every existing test passed.
 *
 * Encoding `result` through the tool's own schema is what makes it round-trip,
 * and the success/failure split matters: on a failed call `result` holds the
 * tool's *failure* value, which a success schema would reject.
 */
const resultsSchema = (tool: Tool.Any) =>
  Schema.Array(
    Schema.Union([
      Schema.TaggedStruct("Ok", {
        result: tool.successSchema,
        encodedResult: Schema.Unknown,
        preliminary: Schema.Boolean
      }),
      Schema.TaggedStruct("Err", {
        result: tool.failureSchema,
        encodedResult: Schema.Unknown,
        preliminary: Schema.Boolean
      })
    ])
  )

/** Effect AI's shape, as the journal holds it. */
interface HandlerResult {
  readonly result: unknown
  readonly encodedResult: unknown
  readonly isFailure: boolean
  readonly preliminary: boolean
}

const toJournal = (value: HandlerResult) => ({
  _tag: value.isFailure ? ("Err" as const) : ("Ok" as const),
  result: value.result,
  encodedResult: value.encodedResult,
  preliminary: value.preliminary
})

const fromJournal = (value: Journalled): HandlerResult => ({
  result: value.result,
  encodedResult: value.encodedResult,
  isFailure: value._tag === "Err",
  preliminary: value.preliminary
})

/** A tool failure, as it survives the durable boundary. */
export class DurableToolFailure extends Schema.TaggedError<DurableToolFailure>()(
  "DurableToolFailure",
  {
    toolName: Schema.String,
    toolCallId: Schema.String,
    failure: AgentEvent.Failure
  }
) {
  override get message() {
    return `Tool ${this.toolName} failed: ${this.failure.message}`
  }
}

/**
 * What running an `Activity` needs, named once.
 *
 * Callers -- including tests -- otherwise have to restate the pair, and a
 * caller restating a requirement is a signature the library should have
 * provided.
 */
export type WorkflowContext = WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance

export const wrap = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>
): Effect.Effect<Toolkit.WithHandler<Tools>, never, WorkflowContext> =>
  Effect.gen(function* () {
    const workflowContext = yield* Effect.context<WorkflowContext>()

    // See `nextOccurrence`: identity counts repeats of a given call, rather
    // than position in a global sequence.
    const seen = yield* Ref.make(new Map<string, number>())

    const handle: Toolkit.WithHandler<Tools>["handle"] = ((
      name: any,
      params: any,
      toolCallId?: string
    ) =>
      Effect.gen(function* () {
        const id = toolCallId ?? "anonymous"
        const index = yield* Ref.modify(seen, nextOccurrence(String(name), id))

        // The activity must not fail.
        //
        // `Activity.make` defaults its error schema to `Schema.Never`, so an
        // execute that fails cannot be encoded and the engine records a
        // `SchemaError` defect instead — destroying the failure it was meant to
        // persist. Every tool failure took that path.
        //
        // So the outcome is carried as a *value*: the activity always succeeds,
        // and the wrapper re-raises. That also makes a failed tool call
        // replayable — it fails the same way on resume instead of running
        // again.
        const tool = (toolkit.tools as Record<string, Tool.Any>)[String(name)]
        if (tool === undefined) {
          // The harness only dispatches calls it matched against the toolkit,
          // so this is a bug rather than a tool failure.
          return yield* Effect.die(
            new Error(`DurableToolkit: unknown tool ${String(name)}`)
          )
        }

        const outcomeSchema = Schema.Union([
          Schema.TaggedStruct("Succeeded", { results: resultsSchema(tool) }),
          Schema.TaggedStruct("Failed", { failure: AgentEvent.Failure }),
          Schema.TaggedStruct("Unresolved", {})
        ])
        const retrySafe = isRetrySafe(tool)

        /**
         * The crash window, closed for a call that must not run twice.
         *
         * Interruption is handled below by journalling `Unresolved`. A
         * process that *dies* mid-handler writes nothing -- the entry below is
         * never recorded -- so a replacement ran the handler again: measured,
         * a non-idempotent tool crashed inside its handler did its side
         * effect twice, under a history that read as one clean call.
         *
         * So a non-idempotent call first journals a start marker, and notes
         * whether *this* attempt wrote it: a marker's `execute` never runs on
         * replay, which makes "written now" a fact rather than a guess. A
         * replacement that finds the marker already written and no outcome
         * for the call knows the handler may have run in a process that did
         * not live to say so, and records `Unresolved` instead of running it
         * -- the same answer, and the same refusal to guess, as an
         * interruption. A call whose outcome was journalled replays it as
         * before. A crash between the marker and the handler's first step is
         * reported unresolved too: conservative, and indistinguishable from
         * outside. A journal from before the marker existed has none, so its
         * calls write it fresh and behave as they always did.
         *
         * Retry-safe tools skip it: running them again is the point.
         *
         * A handler cannot suspend the workflow, and this relies on it. The
         * engine suspends by interrupting the fiber itself, which the branch
         * below cannot catch, so the activity comes back `Suspended`; its
         * re-execution would then find the marker and record `Unresolved`. What
         * keeps it unreachable: a handler's requirements are `never`, so no
         * handler can name `WorkflowEngine` to sleep or await a deferred, and
         * the library's two elicitors refuse inside a call
         * (`InsideToolActivity`). Durable handlers, if they come, need a
         * marker that tells a suspended attempt from a dead one (item 113):
         * one marker per attempt, and a durable note that attempt k
         * suspended, written by an interrupt finalizer -- the self-interrupt
         * cannot be caught, but finalizers still run.
         */
        let startedHere = true
        if (!retrySafe) {
          startedHere = false
          yield* Activity.make({
            name: startMarkerName(index, String(name), id),
            success: Schema.Literal(true),
            execute: Effect.sync(() => {
              startedHere = true
              return true as const
            })
          }).pipe(Effect.provide(workflowContext))
        }

        const outcome = (yield* Activity.make({
          name: activityName(index, String(name), id),
          success: outcomeSchema,
          execute: !startedHere ? Effect.succeed<Outcome>({ _tag: "Unresolved" }) : (
            toolkit.handle(name, params, toolCallId).pipe(
              Effect.flatMap(Stream.runCollect),
              // So an elicitation from inside the handler knows it cannot
              // suspend the workflow from here (`DurableElicitation`).
              Effect.provideService(InsideToolActivity, true)
            ) as unknown as Effect.Effect<ReadonlyArray<HandlerResult>, unknown>
          ).pipe(
            Effect.map(
              (results): Outcome => ({
                _tag: "Succeeded",
                results: results.map(toJournal)
              })
            ),
            Effect.catchCause((cause): Effect.Effect<Outcome> => {
              if (!Cause.hasInterruptsOnly(cause)) {
                return Effect.succeed<Outcome>({
                  _tag: "Failed",
                  failure: AgentEvent.failureFromCause(cause)
                })
              }
              // An interrupted handler, and what upstream does with it.
              //
              // `Activity.make` wraps its `execute` in `retryOnInterrupt`,
              // whose default schedule retries *while the cause has
              // interrupts*, up to ten attempts. So re-raising interruption
              // here does not end the call: it reissues the handler, and a
              // tool that charges a card charges it again. Nothing in this
              // library asked for that, and it is invisible because the retry
              // looks like ordinary durability.
              //
              // For a retry-safe tool that behaviour is fine and is kept:
              // re-raising is what lets an interrupted-by-infrastructure call
              // resume. Interruption carries no typed error, so re-raising it
              // cannot widen the outcome's error channel.
              if (retrySafe) {
                return Effect.failCause(cause) as unknown as Effect.Effect<Outcome>
              }
              // Otherwise the call must not run twice. Recording `Unresolved`
              // as a *success* of the activity is what stops it: the cause the
              // retry schedule inspects no longer has interrupts, so nothing
              // is reissued, and the journal now holds an entry for this call,
              // so a later replay returns it instead of executing the handler
              // again. The wrapper turns it back into a typed failure below.
              //
              // What this does not do: if the process dies before the engine
              // persists this entry, the call is unjournalled and a replay
              // will run it. No code here can close that window -- only the
              // engine's write can -- so the claim is at-most-once for
              // interruption, not for power loss.
              return Effect.succeed<Outcome>({ _tag: "Unresolved" })
            })
          )
        }).pipe(Effect.provide(workflowContext))) as Outcome

        return Stream.fromIterable(yield* reraise(outcome, String(name), id))
      })) as unknown as Toolkit.WithHandler<Tools>["handle"]

    return { tools: toolkit.tools, handle }
  })

/**
 * A recorded outcome, back into the effect the handler would have been.
 *
 * The one rule for tool outcomes across the journal, on a first run and on
 * every replay: success is the results; an expected failure is the typed
 * `DurableToolFailure`, which `ToolExecution` treats as the handler's own
 * failure; a defect stays a defect; an unresolved call is a defect too.
 * Kept as a function of the recorded value so the rule can be exercised on
 * reconstruction alone, which is the path a replay takes.
 */
export const reraise = (
  outcome: Outcome,
  toolName: string,
  toolCallId: string
): Effect.Effect<ReadonlyArray<HandlerResult>, DurableToolFailure> =>
  Effect.gen(function* () {
        if (outcome._tag === "Unresolved") {
          // A defect, deliberately, and this is the half of the fix that
          // matters most.
          //
          // A *typed* failure here is handed to `ToolExecution`, which under
          // the default `ReturnToModel` policy commits it as a failed tool
          // result and lets the model see it. The model's entirely reasonable
          // next move is to call the tool again -- so stopping upstream's ten
          // automatic retries would have bought nothing, because the model
          // would issue the eleventh. An unknown outcome reported as "it
          // failed" is a lie that invites exactly the double side effect this
          // whole mechanism exists to prevent.
          //
          // `ToolExecution` never returns a defect to the model ("a defect
          // means the handler is broken, not that the model asked for
          // something the tool could refuse"), so the run ends. And
          // `DurableSubmission.isInfrastructure` matches only storage-shaped
          // defects, so this settles as a terminal `Failed` rather than the
          // retryable `Infrastructure`, which would invite the caller to
          // resubmit instead.
          return yield* Effect.die(
            new DurableToolUnresolvedError({
              toolName,
              toolCallId
            })
          )
        }

        if (outcome._tag === "Failed") {
          const failure = new DurableToolFailure({
            toolName,
            toolCallId,
            failure: outcome.failure
          })
          // A defect stays a defect. The journal holds it as a value so a
          // replay fails the same way, but re-raising it *typed* handed it to
          // `ToolExecution` as a tool failure, which under `ReturnToModel`
          // the model saw and could act on -- while the same handler
          // in-process fails the run ("a defect means the handler is broken,
          // not that the model asked for something the tool could refuse").
          // Item 73: one rule on every client.
          return outcome.failure.isDefect ? yield* Effect.die(failure) : yield* failure
        }

        return outcome.results.map(fromJournal)
  })
