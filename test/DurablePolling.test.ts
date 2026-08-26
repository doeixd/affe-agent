import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Exit } from "effect"
import { DurablePolling } from "../src/durable/index.js"

describe("DurablePolling", () => {
  it.effect("loads documented defaults from an empty ConfigProvider", () =>
    Effect.gen(function* () {
      const loaded = yield* DurablePolling.all.parse(
        ConfigProvider.fromUnknown({})
      )

      assert.strictEqual(Duration.toMillis(loaded.clientOutcome), 10)
      assert.strictEqual(Duration.toMillis(loaded.deliveryLog), 250)
      assert.strictEqual(Duration.toMillis(loaded.workflowInterrupt), 25)
      assert.strictEqual(Duration.toMillis(loaded.result), 10)
    })
  )

  it.effect("loads operator overrides through stable config names", () =>
    Effect.gen(function* () {
      const loaded = yield* DurablePolling.all.parse(
        ConfigProvider.fromUnknown({
          EFFECT_AGENT_DURABLE_CLIENT_POLL_INTERVAL: "40 millis",
          EFFECT_AGENT_DELIVERY_LOG_POLL_INTERVAL: "2 seconds",
          EFFECT_AGENT_DURABLE_INTERRUPT_POLL_INTERVAL: "75 millis",
          EFFECT_AGENT_DURABLE_RESULT_POLL_INTERVAL: "90 millis"
        })
      )

      assert.strictEqual(Duration.toMillis(loaded.clientOutcome), 40)
      assert.strictEqual(Duration.toMillis(loaded.deliveryLog), 2_000)
      assert.strictEqual(Duration.toMillis(loaded.workflowInterrupt), 75)
      assert.strictEqual(Duration.toMillis(loaded.result), 90)
    })
  )

  it.effect("rejects non-positive policy instead of silently defaulting it", () =>
    Effect.gen(function* () {
      const loaded = yield* Effect.exit(
        DurablePolling.clientOutcome.parse(
          ConfigProvider.fromUnknown({
            EFFECT_AGENT_DURABLE_CLIENT_POLL_INTERVAL: "0 millis"
          })
        )
      )

      assert.isTrue(Exit.isFailure(loaded))
    })
  )
})
