import { Effect, Layer, Ref, Schema, Stream } from "effect"
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

    const service: LanguageModel.Service = {
      ...underlying,
      generateText: ((options: any) =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(callIndex, (n) => n + 1)
          const parts = yield* Activity.make({
            name: `model-${index}`,
            success: partsSchema,
            execute: Effect.map(
              underlying.generateText(options) as unknown as Effect.Effect<
                LanguageModel.GenerateTextResponse<Tools>,
                never
              >,
              (response) => response.content as ReadonlyArray<
                Response.Part<Tools, false>
              >
            )
          }).pipe(Effect.provide(workflowContext))

          return new LanguageModel.GenerateTextResponse(
            parts as Array<Response.Part<any, any>>
          )
        })) as LanguageModel.Service["generateText"],
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
