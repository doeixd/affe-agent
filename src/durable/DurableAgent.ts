import { Cause, Duration, Effect, Exit, Option, Schedule, Schema } from "effect"
import { Toolkit } from "effect/unstable/ai"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { Workflow, WorkflowEngine } from "effect/unstable/workflow"
import * as AgentEvent from "../AgentEvent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"
import { AgentIdleError } from "../Errors.js"
import * as Ids from "../internal/ids.js"
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
  /**
   * Where out-of-band steering and follow-up input is held, and where the
   * submission's admission marker lives.
   */
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
    // `Prompt` carries its own Schema, so a multimodal submission survives the
    // journal exactly as a text one does.
    payload: { sessionId: Schema.String, prompt: Prompt.Prompt },
    idempotencyKey: (payload) => `${name}:${payload.sessionId}`,
    success: Schema.String
    // NOTE: no `error` schema yet. Declaring one and mapping agent failures
    // into it — the obvious way to stop `orDie` flattening typed failures into
    // defects — currently ends in a `SchemaError` defect when a tool fails,
    // and the encoding that rejects it has not been isolated. Shipping a
    // half-working error channel would be worse than an honest defect, so the
    // failure still crosses as a defect and the gap is recorded in
    // WORKFLOW_CLUSTER_PLAN.
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
      const store = options.store

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
          const result = yield* AgentSession.prompt(session, payload.prompt)
          return result.text
        })
      ).pipe(
        Effect.provide(modelLayer),
        Effect.orDie,
        Effect.ensuring(store.takeAll(openKey(payload.sessionId)))
      )
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
  store: DurableChannels.Store,
  sessionId: string,
  input: Prompt.RawInput
): Effect.Effect<string, never, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function* () {
    const prompt = Prompt.make(input)
    const executionId = yield* agent.definition.executionId({
      sessionId,
      prompt
    })
    // Opened here rather than inside the workflow body: `submit` has accepted
    // the submission by the time it returns, so steering must be admissible
    // from that moment. Marking it in the body instead leaves a window where a
    // caller holding an execution id is told the session is idle.
    yield* store.offer(openKey(sessionId), "open")
    yield* agent.definition.execute({ sessionId, prompt }, { discard: true })
    return executionId
  })

/** Queue steering for a running submission. It is applied at a turn boundary. */
/**
 * Queue steering for a running submission.
 *
 * Admission is enforced the same way core enforces it: input for a submission
 * that has already finished is rejected rather than written to a store nobody
 * will drain. Without this the durable API would be a weaker sibling of the
 * core one — accepting work that silently never runs.
 */
export const steer = (
  store: DurableChannels.Store,
  sessionId: string,
  input: Prompt.RawInput
): Effect.Effect<void, AgentIdleError> =>
  admit(store, sessionId, "steer").pipe(
    Effect.andThen(DurableChannels.offer(store, sessionId, "steering", input))
  )

/** Queue a follow-up, extending the submission rather than the current run. */
/** Queue a follow-up, extending the submission rather than the current run. */
export const followUp = (
  store: DurableChannels.Store,
  sessionId: string,
  input: Prompt.RawInput
): Effect.Effect<void, AgentIdleError> =>
  admit(store, sessionId, "followUp").pipe(
    Effect.andThen(DurableChannels.offer(store, sessionId, "followUps", input))
  )

/**
 * The durable analogue of core's "is this session still running".
 *
 * `Workflow.poll` cannot answer it: a suspended execution and a finished one
 * are not reliably distinguishable from outside, and polling races a submission
 * that has been dispatched but not yet begun.
 *
 * Instead the submission owns a marker in the same store the channels use — the
 * durable counterpart of core's `acceptingFollowUps`. It is written when the
 * submission starts and cleared however it ends, so an out-of-band sender sees
 * the same admission contract a local caller would.
 */
const openKey = (sessionId: string) => `${sessionId}:open`

const admit = (
  store: DurableChannels.Store,
  sessionId: string,
  operation: "steer" | "followUp"
): Effect.Effect<void, AgentIdleError> =>
  Effect.flatMap(store.size(openKey(sessionId)), (open) =>
    open > 0
      ? Effect.void
      : Effect.fail(
          new AgentIdleError({
            sessionId: Ids.sessionId(sessionId),
            operation
          })
        )
  )

/**
 * Await a terminal result.
 *
 * A resumed execution continues in the background, so this polls rather than
 * blocking on a fiber that may not exist in this process.
 *
 * The returned `Exit` is where success and failure live: a failed submission is
 * still a *completed* workflow. Its failure currently crosses as a defect
 * rather than a typed error — see the note on the workflow definition.
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
