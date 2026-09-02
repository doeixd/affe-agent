import { Clock, Cron, Effect } from "effect"
import { ClusterCron } from "effect/unstable/cluster"
import type { RemoteInput } from "../client/AgentClient.js"
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

/**
 * A fresh session per firing.
 *
 * This default exists because getting it wrong is silent. A submission's
 * idempotency key is its session, so a scheduled agent that reuses one session
 * runs on its first firing and then does nothing at all, forever, while looking
 * perfectly healthy: each later firing rejoins the original execution rather
 * than starting a new one. Deriving the id from the firing time makes the
 * common case correct without the caller having to know that.
 */
const perFiring = (name: string): Effect.Effect<string> =>
  Effect.map(Clock.currentTimeMillis, (millis) => `${name}-${millis}`)

/**
 * The return type is deliberately inferred rather than annotated.
 *
 * It was previously written out as `Layer<never, never, WorkflowEngine | any>`,
 * which is just `Layer<never, never, any>` — the union swallows everything, so
 * the layer claimed to need nothing in particular and callers lost every
 * requirement the cron actually has. Letting `ClusterCron.make` infer gives the
 * honest `Sharding | WorkflowEngine | R`, and removes the cast that was papering
 * over the difference.
 */
export const layer = <
  W extends ReturnType<typeof DurableAgent.workflow>,
  E = never,
  R = never
>(options: {
  readonly name: string
  readonly cron: Cron.Cron
  readonly agent: W
  /** The same store the agent's channels use, for admission. */
  readonly store: DurableChannels.Store
  /**
   * Session id per firing. Defaults to one derived from the firing time.
   *
   * Override only with something that still varies per firing — see the note
   * on `perFiring` for what a constant id does.
   */
  readonly sessionId?: Effect.Effect<string, E, R> | undefined
  /**
   * `RawInput`, so a scheduled submission can be multimodal like any other;
   * or `AgentInput.typed(value)` for an agent that declares an input, decoded
   * by the entity with the agent's schema on every firing.
   */
  readonly input: RemoteInput
}) =>
  ClusterCron.make({
    name: options.name,
    cron: options.cron,
    execute: Effect.gen(function* () {
      const sessionId = yield* (options.sessionId ?? perFiring(options.name))
      yield* DurableAgent.submit(
        options.agent,
        options.store,
        sessionId,
        options.input
      )
    })
  })
