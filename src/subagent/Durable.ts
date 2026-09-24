import { Effect, Option, Schema } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import type * as AgentOutput from "../AgentOutput.js"
import type * as DeliveryLog from "../durable/DeliveryLog.js"
import type * as DurableChannels from "../durable/DurableChannels.js"
import * as DurableSubmission from "../durable/DurableSubmission.js"
import * as DurableToolkit from "../durable/DurableToolkit.js"
import type * as DurableSessionStore from "../durable/DurableSessionStore.js"
import * as InputBoundary from "../internal/inputBoundary.js"
import { CurrentPrincipal } from "../Principal.js"

/**
 * Durable delegation: a subagent that runs as a **child session**, its own
 * durable submission.
 *
 * `Subagent.tool` runs the child inside the parent's tool call; this runs it in
 * the parent's workflow body as a delegation (`DurableToolkit.delegate`), so
 * the parent suspends behind the child, a restart reconnects to the same
 * child, and the child's approval parks the child rather than the parent's
 * process.
 *
 * **It is built on `DurableSubmission.workflow`, not `DurableAgent.workflow`,
 * and that is the whole design.** `DurableAgent.workflow`'s success is the
 * child's *text* and it keeps no session; `DurableSubmission`'s success is an
 * `Outcome` that already carries the child's encoded `AgentOutput` `value`,
 * its payload already carries a typed `input`, and it is backed by a session
 * store. So a typed child crosses — as input and as result — with no journal
 * change, and the child is a real session a host can enumerate and answer.
 *
 * ```ts
 * const research = Subagent.durable("research", Researcher, { store, sessionStore })
 * const Lead = Agent.make({ instructions: "Delegate research.", tools: [research.tool] })
 * // provide `research.workflow.layer` to the engine beside the parent's
 * ```
 */
export interface DurableOptions {
  /** What the tool is for, written for the parent model. */
  readonly description: string
  /** Where steering and admission markers live; shared with the parent's stores. */
  readonly store: DurableChannels.Store
  /** The session store the child is recorded in, so a host can see and answer it. */
  readonly sessionStore: DurableSessionStore.DurableSessionStore
  /** Where the child's client-facing events are recorded, when there is a host to feed. */
  readonly delivery?: DeliveryLog.DeliveryLog | undefined
  /** The child workflow's name. Default `subagent:<name>`. */
  readonly workflowName?: string | undefined
}

const PromptParams = Schema.Struct({ prompt: Schema.String })

/** The child's declared input as the tool's parameters, or `{ prompt }`. */
const parametersOf = (declared: InputBoundary.Declared): Schema.Codec<unknown, unknown> =>
  Option.match(declared, {
    onNone: (): Schema.Codec<unknown, unknown> => PromptParams,
    onSome: (input): Schema.Codec<unknown, unknown> => input.schema
  })

/** The child's declared output as the tool's success, or a string. */
const successOf = <Value>(agent: {
  readonly output: Option.Option<AgentOutput.AgentOutput<any, any>>
}): Schema.Codec<Value, unknown> =>
  Option.match(agent.output, {
    onNone: (): Schema.Codec<any, unknown> => Schema.String,
    onSome: (output): Schema.Codec<any, unknown> => output.schema
  })

/**
 * A child's outcome as the delegation's answer.
 *
 * `Succeeded` carries the encoded `value` when the child declared an output and
 * the text otherwise; `Failed` is the tool failure the parent model reads;
 * `Infrastructure` is the store, not the agent, so it stays a defect.
 */
const answerOf = (
  child: { readonly output: Option.Option<AgentOutput.AgentOutput<any, any>> },
  outcome: DurableSubmission.Outcome
): Effect.Effect<unknown, string> =>
  Effect.gen(function* () {
    if (outcome._tag === "Infrastructure") {
      return yield* Effect.die(
        new Error(`durable child: the store failed, not the agent: ${outcome.detail}`)
      )
    }
    if (outcome._tag === "Failed") {
      return yield* Effect.fail(outcome.failure.message)
    }
    // A child the harness cut short is not a short success: what it said is
    // what it *had* said, not an answer. The durable twin of
    // `SubagentInterruptedError` — without this, a partial reads as a result.
    if (outcome.status === "interrupted") {
      return yield* Effect.fail(
        `the child was interrupted after ${outcome.turns} turn${outcome.turns === 1 ? "" : "s"} and did not finish; ` +
          `it had said: ${outcome.text}`
      )
    }
    if (Option.isSome(child.output)) {
      if (outcome.value === undefined) {
        return yield* Effect.fail("the child finished without reporting its declared output")
      }
      // Decoded here; the seam re-encodes it through the tool's success schema.
      return yield* Schema.decodeUnknownEffect(child.output.value.schema)(outcome.value).pipe(
        Effect.mapError((error) => `the child's output did not decode: ${error.message}`)
      )
    }
    return outcome.text
  })

export const durable = <Tools extends Record<string, Tool.Any>, E, R, Value, Input>(
  name: string,
  child: AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>,
  options: DurableOptions
) => {
  const declared = InputBoundary.declared(child)
  const workflow = DurableSubmission.workflow(options.workflowName ?? `subagent:${name}`, child, {
    store: options.store,
    sessionStore: options.sessionStore,
    ...(options.delivery === undefined ? {} : { delivery: options.delivery })
  })

  const tool = DurableToolkit.delegate(
    Tool.make(name, {
      description: options.description,
      parameters: parametersOf(declared),
      success: successOf<Value>(child),
      failure: Schema.String
    }),
    (params, toolCallId, parentExecutionId) =>
      Effect.gen(function* () {
        // A fresh child session per call, named so a replay addresses the same
        // one and a reused tool-call id cannot reach another parent's child.
        const sessionId = `subagent:${parentExecutionId}:${toolCallId}`
        const principal = yield* CurrentPrincipal
        const payload = yield* (Option.isSome(declared)
          ? Schema.encodeUnknownEffect(child.input.schema)(params).pipe(
            Effect.orDie,
            Effect.map((encoded) => ({
              sessionId,
              submissionId: sessionId,
              prompt: Prompt.empty,
              input: encoded,
              initialHistory: Prompt.empty,
              stream: false,
              ...(Option.isSome(principal) ? { principal: principal.value } : {})
            }))
          )
          : Effect.map(Effect.sync(() => Schema.decodeUnknownSync(PromptParams)(params)), ({ prompt }) => ({
            sessionId,
            submissionId: sessionId,
            prompt: Prompt.make(prompt),
            initialHistory: Prompt.empty,
            stream: false,
            ...(Option.isSome(principal) ? { principal: principal.value } : {})
          })))
        const outcome = yield* workflow.definition.execute(payload)
        return yield* answerOf(child, outcome)
      })
  )

  return {
    tool: Agent.tool(tool, () => Effect.die("a durable delegation handler must never run")),
    workflow
  }
}
