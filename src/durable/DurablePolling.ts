import { Config, Duration, Schema } from "effect"

/**
 * Validated operational polling policy for the durable adapters.
 *
 * Concrete constructors continue to accept `Duration` values. Their
 * config-aware siblings load these recipes, which gives operators one stable
 * vocabulary without widening the error channel of existing constructors.
 */

const PositiveDuration = Schema.DurationFromString.check(
  Schema.makeFilter((value) =>
    Duration.isFinite(value) && Duration.toMillis(value) > 0
      ? true
      : "Expected a positive finite duration"
  )
)

const duration = (
  name: string,
  fallback: Duration.Duration
): Config.Config<Duration.Duration> =>
  Config.schema(PositiveDuration, name).pipe(Config.withDefault(fallback))

/** Concrete defaults shared by explicit and Config-backed constructors. */
export const defaults = Object.freeze({
  clientOutcome: Duration.millis(10),
  deliveryLog: Duration.millis(250),
  workflowInterrupt: Duration.millis(25),
  result: Duration.millis(10)
})

/** Initial delay while a durable client waits for a workflow outcome. */
export const clientOutcome = duration(
  "EFFECT_AGENT_DURABLE_CLIENT_POLL_INTERVAL",
  defaults.clientOutcome
)

/** Cross-node SQL delivery-log poll interval. */
export const deliveryLog = duration(
  "EFFECT_AGENT_DELIVERY_LOG_POLL_INTERVAL",
  defaults.deliveryLog
)

/** Poll interval for an interrupt intent inside a durable workflow. */
export const workflowInterrupt = duration(
  "EFFECT_AGENT_DURABLE_INTERRUPT_POLL_INTERVAL",
  defaults.workflowInterrupt
)

/** Poll interval for the lower-level `DurableAgent.result` helper. */
export const result = duration(
  "EFFECT_AGENT_DURABLE_RESULT_POLL_INTERVAL",
  defaults.result
)

/** Load every durable polling setting from one `ConfigProvider`. */
export const all = Config.all({
  clientOutcome,
  deliveryLog,
  workflowInterrupt,
  result
})
