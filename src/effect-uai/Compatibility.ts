/**
 * Loss accounting for cross-ecosystem translation.
 *
 * Every conversion an adapter performs is one of three things, and the point of
 * naming them is that the middle one is the dangerous one: a `Degraded`
 * conversion produces valid output, so nothing downstream can tell it apart
 * from an exact one unless the adapter says so.
 *
 * The rule:
 *
 * > A `Degraded` conversion is never silent, and an `Unsupported` one never
 * > proceeds.
 *
 * A bridge that quietly drops a file, a refusal distinction, or reasoning
 * continuation state is worse than no bridge, because durable history then
 * looks authoritative while being false.
 */
import { Effect, Schema } from "effect"

/**
 * A conversion that succeeded but lost information.
 *
 * `feature` names what was lost, `source` and `target` name the two
 * representations, and `reason` says why the loss was unavoidable. All four are
 * required: a degradation notice that does not say which direction it happened
 * in cannot be acted on.
 */
export class Degradation extends Schema.Class<Degradation>(
  "@effect-harness/effect-uai/Degradation"
)({
  feature: Schema.String,
  source: Schema.String,
  target: Schema.String,
  reason: Schema.String
}) {
  /**
   * Derived, never a schema field, so it cannot drift from the fields it
   * describes.
   */
  get summary(): string {
    return `${this.feature}: ${this.source} -> ${this.target} (${this.reason})`
  }
}

/**
 * A conversion that would have to lie to proceed.
 *
 * This is a failure rather than a warning on purpose. The alternative -- a
 * best effort plus a log line -- puts a value into canonical history that
 * claims to be the thing it replaced.
 */
export class UnsupportedConversion extends Schema.TaggedError<UnsupportedConversion>()(
  "UnsupportedConversion",
  {
    feature: Schema.String,
    source: Schema.String,
    target: Schema.String,
    reason: Schema.String
  }
) {
  get message(): string {
    return `cannot represent ${this.feature} from ${this.source} in ${this.target}: ${this.reason}`
  }
}

/**
 * What to do when a conversion degrades.
 *
 * A function rather than a service because it has exactly one implementation
 * per adapter instance and no lifecycle of its own; a caller that wants to
 * collect degradations for assertions passes a collector, and everyone else
 * gets the default.
 */
export type OnDegraded = (degradation: Degradation) => Effect.Effect<void>

/**
 * The default: a debug log carrying the fields, not just the sentence, so a
 * structured backend can aggregate by feature.
 */
export const logDegradation: OnDegraded = (degradation) =>
  Effect.logDebug("effect-uai translation degraded", {
    feature: degradation.feature,
    source: degradation.source,
    target: degradation.target,
    reason: degradation.reason
  })
