import { Cause, Effect, Layer, Ref, Schema, Stream } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import { LanguageModel, Response, Toolkit } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"

/**
 * Makes every model call of a submission a durable `Activity`.
 *
 * A model call is the archetypal thing you must not repeat on replay: it is
 * billed, nondeterministic, and may have provider-side effects. Wrapping it in
 * an activity means a resumed execution returns the persisted response instead
 * of asking the model again.
 *
 * This is a Layer that replaces `LanguageModel`, so the harness above it is
 * untouched — it is the substitution point PLAN §30.1 identified.
 */

/**
 * Wrap an existing `LanguageModel` so its responses are persisted.
 *
 * The response is stored as its content parts, which `Response.Part` can encode
 * for a given toolkit. `GenerateTextResponse` is then reconstructed from those
 * parts on replay, so callers cannot tell the difference.
 */
/** What a model activity persists: an outcome, never a failure. */
type ModelOutcome =
  | { readonly _tag: "Succeeded"; readonly parts: ReadonlyArray<any> }
  | { readonly _tag: "Failed"; readonly failure: AgentEvent.Failure }

/** A provider failure, as it survives the durable boundary. */
export class DurableModelFailure extends Schema.TaggedError<DurableModelFailure>()(
  "DurableModelFailure",
  { failure: AgentEvent.Failure }
) {
  override get message() {
    return `Model call failed: ${this.failure.message}`
  }
}

export const wrap = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>
): Effect.Effect<
  Layer.Layer<LanguageModel.LanguageModel>,
  never,
  LanguageModel.LanguageModel | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const underlying = yield* LanguageModel.LanguageModel

    // `Activity.make` needs the workflow context, but the service methods below
    // are called by the harness, which knows nothing about workflows. Capturing
    // the context here — inside the running workflow — is what reconciles them,
    // and it is why this layer must be built inside the workflow body.
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()

    // Activity names must be stable across replays. A submission's model calls
    // are consumed in a fixed order, so their ordinal is exactly that.
    const callIndex = yield* Ref.make(0)

    const partsSchema = Schema.Array(Response.Part(toolkit))
    // A real schema, not `Schema.Unknown`: response parts are class instances
    // that `Unknown` cannot encode, which is how the original parts schema came
    // to exist. The outcome union has to preserve that.
    const outcomeSchema = Schema.Union([
      Schema.TaggedStruct("Succeeded", { parts: partsSchema }),
      Schema.TaggedStruct("Failed", { failure: AgentEvent.Failure })
    ])

    const service: LanguageModel.Service = {
      ...underlying,
      generateText: ((options: any) =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(callIndex, (n) => n + 1)
          // Like tool activities, this must not fail: an activity with no
          // declared error schema cannot encode a failure, and the engine
          // records an unencodable `SchemaError` instead of the provider error.
          // The outcome is carried as a value and re-raised here.
          const outcome = yield* Activity.make({
            name: `model-${index}`,
            success: outcomeSchema,
            execute: (
              underlying.generateText(options) as unknown as Effect.Effect<
                LanguageModel.GenerateTextResponse<Tools>,
                unknown
              >
            ).pipe(
              Effect.map(
                (response): ModelOutcome => ({
                  _tag: "Succeeded",
                  parts: response.content as ReadonlyArray<any>
                })
              ),
              Effect.catchCause(
                (cause): Effect.Effect<ModelOutcome> =>
                  Cause.hasInterruptsOnly(cause)
                    ? (Effect.failCause(cause) as unknown as Effect.Effect<
                        ModelOutcome
                      >)
                    : Effect.succeed<ModelOutcome>({
                        _tag: "Failed",
                        failure: AgentEvent.failureFromCause(cause)
                      })
              )
            )
          }).pipe(Effect.provide(workflowContext))

          const result = outcome as ModelOutcome
          if (result._tag === "Failed") {
            return yield* new DurableModelFailure({ failure: result.failure })
          }

          return new LanguageModel.GenerateTextResponse(
            result.parts as Array<Response.Part<any, any>>
          )
        })) as unknown as LanguageModel.Service["generateText"],
      // Streaming is out of scope for v0.1 (PLAN §24). A stub that silently
      // bypassed durability would be worse than an explicit refusal.
      streamText: (() =>
        Stream.fromEffect(
          Effect.die(
            new Error("DurableModel does not support streaming; see PLAN §24")
          )
        )) as LanguageModel.Service["streamText"]
    }

    return Layer.succeed(LanguageModel.LanguageModel, service)
  })
