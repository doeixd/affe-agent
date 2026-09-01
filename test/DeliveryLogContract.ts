import { describe, it } from "@effect/vitest"
import type { Effect } from "effect"
import type { Duration, Scope } from "effect"
import type * as DeliveryLog from "../src/durable/DeliveryLog.js"
import { DeliveryLogConformance } from "../src/testing/index.js"

/**
 * The delivery log contract, as vitest wiring over the shipped suite.
 *
 * The cases live in `DeliveryLogConformance` (`/testing`) so a log over a
 * backing this repository does not have is held to the same rows; what
 * remains here is one `it.live` per case.
 */

export const envelope = DeliveryLogConformance.envelope

export const contract = (
  name: string,
  makeLog: Effect.Effect<DeliveryLog.DeliveryLog, never, Scope.Scope>,
  options: { readonly settle?: Duration.Input } = {}
) =>
  describe(`DeliveryLog (${name})`, () => {
    for (const entry of DeliveryLogConformance.cases({ log: makeLog, settle: options.settle })) {
      it.live(entry.name, () => entry.run)
    }
  })

export const crossProcessLive = (
  name: string,
  twoLogs: Effect.Effect<
    readonly [DeliveryLog.DeliveryLog, DeliveryLog.DeliveryLog],
    never,
    Scope.Scope
  >,
  options: { readonly settle: Duration.Input }
) =>
  describe(`DeliveryLog (${name}) cross-process live`, () => {
    for (const entry of DeliveryLogConformance.crossProcessCases({ twoLogs, settle: options.settle })) {
      it.live(entry.name, () => entry.run)
    }
  })
