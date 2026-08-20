import { Cause, Effect, Ref, Schema, Stream } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import { Toolkit } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"

/**
 * Makes every tool call a durable `Activity`.
 *
 * This is the stronger case for durability than the model call. A model call
 * repeated on replay costs money and returns something different; a *tool* call
 * repeated on replay reissues its side effect. The refund goes out twice.
 *
 * Wrapping the handler means a resumed execution returns the persisted result
 * for any call that already completed.
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

type Outcome =
  | { readonly _tag: "Succeeded"; readonly results: ReadonlyArray<Journalled> }
  | { readonly _tag: "Failed"; readonly failure: AgentEvent.Failure }

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

export const wrap = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>
): Effect.Effect<
  Toolkit.WithHandler<Tools>,
  never,
  WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()

    // A provider is only obliged to make tool call ids unique within a single
    // response, so the id alone cannot identify an activity: a model that
    // reuses one across turns would collide, and the later call would silently
    // replay the earlier result instead of executing.
    //
    // The ordinal is what makes identity sound. Tool calls are consumed in a
    // fixed order within a submission, so it is replay-stable, and the id is
    // kept alongside it purely to keep traces readable.
    const ordinal = yield* Ref.make(0)

    const handle: Toolkit.WithHandler<Tools>["handle"] = ((
      name: any,
      params: any,
      toolCallId?: string
    ) =>
      Effect.gen(function* () {
        const index = yield* Ref.getAndUpdate(ordinal, (n) => n + 1)
        const id = toolCallId ?? "anonymous"

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
          Schema.TaggedStruct("Failed", { failure: AgentEvent.Failure })
        ])

        const outcome = (yield* Activity.make({
          name: `tool-${index}-${String(name)}-${id}`,
          success: outcomeSchema,
          execute: (
            toolkit.handle(name, params, toolCallId).pipe(
              Effect.flatMap(Stream.runCollect)
            ) as unknown as Effect.Effect<ReadonlyArray<HandlerResult>, unknown>
          ).pipe(
            Effect.map(
              (results): Outcome => ({
                _tag: "Succeeded",
                results: results.map(toJournal)
              })
            ),
            Effect.catchCause((cause): Effect.Effect<Outcome> =>
              // Interruption is the run going away, not a tool outcome; it must
              // stay interruption rather than becoming a persisted failure.
              Cause.hasInterruptsOnly(cause)
                ? // Interruption carries no typed error, so re-raising it
                  // cannot widen the outcome's error channel.
                  (Effect.failCause(cause) as unknown as Effect.Effect<Outcome>)
                : Effect.succeed<Outcome>({
                    _tag: "Failed",
                    failure: AgentEvent.failureFromCause(cause)
                  })
            )
          )
        }).pipe(Effect.provide(workflowContext))) as Outcome

        if (outcome._tag === "Failed") {
          return yield* new DurableToolFailure({
            toolName: String(name),
            toolCallId: id,
            failure: outcome.failure
          })
        }

        return Stream.fromIterable(
          outcome.results.map(fromJournal) as ReadonlyArray<any>
        )
      })) as unknown as Toolkit.WithHandler<Tools>["handle"]

    return { tools: toolkit.tools, handle }
  })
