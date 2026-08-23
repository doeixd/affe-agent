import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { createHmac } from "node:crypto"
import * as Slack from "../src/connectors/slack.js"

/**
 * The Slack signature verifier, against known vectors. Freshness is driven by
 * TestClock, so "now" relative to the request timestamp is exact -- no wall
 * clock, no flakiness. The HMAC is computed here the same way Slack computes it,
 * so a correct request is genuinely signed, not asserted by construction.
 */

const secret = "8f742231b10e8888abcd99yyyzzz85a5"
const body = "token=abc&command=%2Fweather&text=94070"
const timestamp = "1531420618"

const sign = (ts: string, payload: string, withSecret: string = secret): string =>
  `v0=${createHmac("sha256", withSecret).update(`v0:${ts}:${payload}`).digest("hex")}`

// Fix "now" to a given unix second, so freshness is deterministic.
const at = (unixSeconds: number) => TestClock.setTime(unixSeconds * 1000)

describe("Slack.verifier", () => {
  const verify = Slack.verifier({ signingSecret: Redacted.make(secret) })
  const run = <A>(effect: Effect.Effect<A>) => effect.pipe(Effect.provide(TestClock.layer()))

  it.effect("accepts a correctly-signed request within the freshness window", () =>
    run(Effect.gen(function* () {
      yield* at(Number(timestamp))
      const ok = yield* verify({ signature: sign(timestamp, body), timestamp, body })
      assert.isTrue(ok)
    }))
  )

  it.effect("rejects a tampered body", () =>
    run(Effect.gen(function* () {
      yield* at(Number(timestamp))
      // Signature is over the original body; the delivered body differs.
      const ok = yield* verify({ signature: sign(timestamp, body), timestamp, body: `${body}&injected=1` })
      assert.isFalse(ok)
    }))
  )

  it.effect("rejects a signature made with the wrong secret", () =>
    run(Effect.gen(function* () {
      yield* at(Number(timestamp))
      const ok = yield* verify({ signature: sign(timestamp, body, "not-the-secret"), timestamp, body })
      assert.isFalse(ok)
    }))
  )

  it.effect("rejects a stale timestamp outside the replay window", () =>
    run(Effect.gen(function* () {
      // Correctly signed, but 'now' is 400s past the signing time (> 300 default).
      yield* at(Number(timestamp) + 400)
      const ok = yield* verify({ signature: sign(timestamp, body), timestamp, body })
      assert.isFalse(ok)
    }))
  )

  it.effect("honours a custom tolerance", () =>
    run(Effect.gen(function* () {
      const lenient = Slack.verifier({ signingSecret: Redacted.make(secret), toleranceSeconds: 600 })
      yield* at(Number(timestamp) + 400) // within 600, outside the 300 default
      assert.isTrue(yield* lenient({ signature: sign(timestamp, body), timestamp, body }))
    }))
  )

  it.effect("rejects missing headers and a non-numeric timestamp without throwing", () =>
    run(Effect.gen(function* () {
      yield* at(Number(timestamp))
      assert.isFalse(yield* verify({ signature: undefined, timestamp, body }))
      assert.isFalse(yield* verify({ signature: sign(timestamp, body), timestamp: undefined, body }))
      assert.isFalse(yield* verify({ signature: sign("nope", body), timestamp: "nope", body }))
    }))
  )
})
