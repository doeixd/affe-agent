import { Cron, Effect, Layer } from "effect"
import { ClusterCron } from "effect/unstable/cluster"
import type { WorkflowEngine } from "effect/unstable/workflow"
import * as DurableAgent from "../durable/DurableAgent.js"
import type * as DurableChannels from "../durable/DurableChannels.js"

/**
 * A recurring agent submission.
 *
 * Worth noting for what it does *not* add. There is no `AgentScheduler`, no
 * `CronAgent`, no timer manager: a scheduled agent is a cron entry that submits
 * a durable submission, and the cluster guarantees it fires once across the
 * whole deployment rather than once per node.
 *
 * The harness contributes nothing here, which is the point of PLAN §30.2.
 */
export const layer = <W extends ReturnType<typeof DurableAgent.workflow>>(
  options: {
    readonly name: string
    readonly cron: Cron.Cron
    readonly agent: W
    /** The same store the agent's channels use, for admission. */
    readonly store: DurableChannels.Store
    /** Distinct per firing, or the idempotency key would suppress reruns. */
    readonly sessionId: Effect.Effect<string>
    readonly input: string
  }
): Layer.Layer<never, never, WorkflowEngine.WorkflowEngine | any> =>
  ClusterCron.make({
    name: options.name,
    cron: options.cron,
    execute: Effect.gen(function* () {
      const sessionId = yield* options.sessionId
      yield* DurableAgent.submit(
        options.agent,
        options.store,
        sessionId,
        options.input
      )
    })
  }) as unknown as Layer.Layer<never, never, WorkflowEngine.WorkflowEngine | any>
