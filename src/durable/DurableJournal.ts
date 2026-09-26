import { Cause, Effect, Ref, Schema } from "effect"
import { Activity } from "effect/unstable/workflow"
import * as AgentEvent from "../AgentEvent.js"
import type * as Journal from "../Journal.js"
import type { WorkflowContext } from "./DurableToolkit.js"

/**
 * `Journal` backed by workflow activities (item 129, slice 1).
 *
 * Each step is an `Activity` named `${prefix}journal-${name}-${n}`, where `n`
 * counts that name's occurrences in this execution. A replay that makes the
 * same calls in the same order meets the same names, and the engine returns
 * the recorded values without running the effects.
 *
 * Built inside the workflow body, as `DurableModel.wrap` is: an activity
 * needs the workflow context, which cannot be threaded in from outside.
 */

/** A defect a step recorded, raised again on replay. */
export class JournalStepDefect extends Schema.TaggedError<JournalStepDefect>()("JournalStepDefect", {
  step: Schema.String,
  failure: AgentEvent.Failure
}) {
  override get message() {
    return `Journal step ${this.step} died: ${this.failure.message}`
  }
}

export const make = (prefix: string): Effect.Effect<Journal.Service, never, WorkflowContext> =>
  Effect.gen(function*() {
    const workflowContext = yield* Effect.context<WorkflowContext>()
    const seen = yield* Ref.make(new Map<string, number>())
    const occurrence = (name: string) =>
      Ref.modify(seen, (all): [number, Map<string, number>] => {
        const n = (all.get(name) ?? 0) + 1
        return [n, new Map(all).set(name, n)]
      })

    const step: Journal.Service["step"] = (name, schema, effect) =>
      Effect.gen(function*() {
        const activity = `${prefix}journal-${name}-${yield* occurrence(name)}`
        // The outcome is a value, as the tool and model activities' are: an
        // activity with no error schema cannot record a failure. A `step`
        // cannot fail, so the only other outcome is a defect.
        const outcome = yield* Activity.make({
          name: activity,
          success: Schema.Union([
            Schema.TaggedStruct("Value", { value: schema }),
            Schema.TaggedStruct("Died", { failure: AgentEvent.Failure })
          ]),
          execute: effect.pipe(
            Effect.map((value) => ({ _tag: "Value" as const, value })),
            Effect.catchCause((cause) =>
              // An interrupt is not an outcome: re-raised, so the activity's
              // own retry runs the step again, as `Journal.step` documents.
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({ _tag: "Died" as const, failure: AgentEvent.failureFromCause(cause) })
            )
          )
        }).pipe(Effect.provide(workflowContext))
        return outcome._tag === "Value"
          ? outcome.value
          : yield* Effect.die(new JournalStepDefect({ step: activity, failure: outcome.failure }))
      })

    return { step }
  })
