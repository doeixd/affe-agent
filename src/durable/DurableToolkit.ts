import { Effect, Ref, Schema, Stream } from "effect"
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

        // The handler returns a stream so it can emit preliminary results; only
        // the final one is committed, and only that one is worth persisting.
        const results = yield* Activity.make({
          name: `tool-${index}-${String(name)}-${id}`,
          success: Schema.Unknown,
          execute: toolkit
            .handle(name, params, toolCallId)
            .pipe(
              Effect.flatMap(Stream.runCollect)
            ) as unknown as Effect.Effect<ReadonlyArray<unknown>, never>
        }).pipe(Effect.provide(workflowContext))

        return Stream.fromIterable(results as ReadonlyArray<any>)
      })) as Toolkit.WithHandler<Tools>["handle"]

    return { tools: toolkit.tools, handle }
  })
