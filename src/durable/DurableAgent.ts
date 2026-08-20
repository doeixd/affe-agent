import { Duration, Effect, Exit, Option, Schedule, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"
import * as DurableChannels from "./DurableChannels.js"
import * as DurableModel from "./DurableModel.js"
import * as DurableToolkit from "./DurableToolkit.js"

/**
 * A submission, interpreted as a durable workflow.
 *
 * The agent definition is the same value the embedded runtime uses. Nothing
 * here reaches into the harness: the model becomes an activity by replacing a
 * Layer, tools by wrapping handlers, and out-of-band input by supplying an
 * `InputChannel.Factory`. Canonical history is not persisted — it is rebuilt
 * from replayed activity results, which is why this package needs no store.
 */

export interface Options {
  /** Where out-of-band steering and follow-up input is held. */
  readonly store: DurableChannels.Store
  /**
   * Resolved toolkit. Handlers are wrapped as activities, so a tool that
   * already ran is never executed twice.
   */
  readonly toolkit?: Toolkit.WithHandler<any> | undefined
}

/**
 * Define the workflow for an agent.
 *
 * The returned value is an ordinary `Workflow`, so its `execute`, `poll`,
 * `resume` and `interrupt` are available directly.
 */
export const workflow = <Tools extends Record<string, Tool.Any>>(
  name: string,
  agent: AgentDefinition<Tools, any, any>,
  options: Options
) => {
  const definition = Workflow.make(name, {
    payload: { sessionId: Schema.String, input: Schema.String },
    idempotencyKey: (payload) => `${name}:${payload.sessionId}`,
    success: Schema.String
  })

  const layer = definition.toLayer((payload) =>
    Effect.gen(function* () {
      // Built inside the workflow body: activities need the workflow context,
      // and `LanguageModel.make` pins its provider's requirements, so the
      // context cannot be threaded in from outside.
      const toolkit =
        options.toolkit ?? ((yield* Toolkit.empty) as Toolkit.WithHandler<any>)
      const durableTools = yield* DurableToolkit.wrap(toolkit)
      const modelLayer = yield* DurableModel.wrap(durableTools)
      const channels = yield* DurableChannels.factory(options.store)

      const durableAgent = {
        ...agent,
        toolkit: durableTools
      } as AgentDefinition<Tools, any, any>

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(durableAgent, {
            channels,
            sessionId: payload.sessionId
          })
          const result = yield* AgentSession.prompt(session, payload.input)
          return result.text
        })
      ).pipe(Effect.provide(modelLayer), Effect.orDie)
    })
  )

  return { definition, layer } as const
}

/**
 * Start a submission without waiting for it.
 *
 * `discard` is required rather than incidental: a submission that suspends —
 * awaiting approval, or simply outliving the process — never produces the
 * result a plain `execute` waits for.
 *
 * The idempotency key is the **session**, not the input. Retrying a submit is
 * therefore safe, but a second submit with *different* input for the same
 * session rejoins the live execution rather than starting a new one — the new
 * input is not processed. That upholds PLAN §11's one-submission-per-session
 * rule; queue further work with `followUp` instead.
 */
export const submit = <W extends ReturnType<typeof workflow>>(
  agent: W,
  sessionId: string,
  input: string
): Effect.Effect<string, never, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function* () {
    const executionId = yield* agent.definition.executionId({
      sessionId,
      input
    })
    yield* agent.definition.execute({ sessionId, input }, { discard: true })
    return executionId
  })

/** Queue steering for a running submission. It is applied at a turn boundary. */
export const steer = (
  store: DurableChannels.Store,
  sessionId: string,
  input: string
): Effect.Effect<void> => store.offer(`${sessionId}:steering`, input)

/** Queue a follow-up, extending the submission rather than the current run. */
export const followUp = (
  store: DurableChannels.Store,
  sessionId: string,
  input: string
): Effect.Effect<void> => store.offer(`${sessionId}:followUps`, input)

/**
 * Await a terminal result.
 *
 * A resumed execution continues in the background, so this polls rather than
 * blocking on a fiber that may not exist in this process.
 *
 * Note that a failed submission is still a *completed* workflow: the returned
 * `Complete` carries an `exit` that may be a `Failure`. Check the exit —
 * `_tag === "Complete"` alone does not mean the agent succeeded.
 */
export const result = <W extends ReturnType<typeof workflow>>(
  agent: W,
  executionId: string,
  options?: { readonly interval?: Duration.Duration | undefined }
): Effect.Effect<
  Exit.Exit<string, never>,
  "pending",
  WorkflowEngine.WorkflowEngine
> =>
  Effect.retry(
    Effect.flatMap(agent.definition.poll(executionId), (polled) =>
      Option.isSome(polled) && polled.value._tag === "Complete"
        ? Effect.succeed(
            (polled.value as Workflow.Complete<string, never>).exit
          )
        : Effect.fail("pending" as const)
    ),
    {
      times: 600,
      schedule: Schedule.spaced(options?.interval ?? Duration.millis(10))
    }
  )

export { DurableChannels, DurableModel, DurableToolkit }
