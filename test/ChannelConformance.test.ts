import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Redacted } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import * as Slack from "../src/connectors/slack.js"
import { ChannelConformance } from "../src/testing/index.js"

/**
 * `docs/plan-integrations.md` §10: `ChannelConformance` exists with the
 * hostile-payload and replay-window cases, Slack passes it, and a second
 * channel proves the suite generalises past Slack.
 */
const secret = "8f742231b10e8888abcd99yyyzzz85a5"

// ---------------------------------------------------------------------------
// Slack: `v0=` HMAC over `v0:{timestamp}:{body}`, two headers.

const slackSign = (ts: string, body: string, withSecret: string = secret): string =>
  `v0=${createHmac("sha256", withSecret).update(`v0:${ts}:${body}`).digest("hex")}`

const slack: ChannelConformance.Channel = {
  name: "slack",
  toleranceSeconds: 300,
  signatureHeader: "x-slack-signature",
  timestampHeader: "x-slack-request-timestamp",
  sign: (body, unixSeconds, options) => {
    const timestamp = String(unixSeconds)
    return {
      body,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSign(timestamp, body, options?.secret === "wrong" ? "not-the-secret" : secret)
      }
    }
  },
  verify: (request) =>
    Slack.verifier({ signingSecret: Redacted.make(secret) })({
      signature: request.headers["x-slack-signature"],
      timestamp: request.headers["x-slack-request-timestamp"],
      body: request.body
    })
}

// ---------------------------------------------------------------------------
// A second channel, written here in a dozen lines: `sha256=` HMAC over
// `{timestamp}.{body}`, GitHub-style header names. Not shipped -- it exists
// so the suite is held to more than the channel it was written for.

const hubSign = (ts: string, body: string, withSecret: string = secret): string =>
  `sha256=${createHmac("sha256", withSecret).update(`${ts}.${body}`).digest("hex")}`

const hubVerify = (request: ChannelConformance.Request): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const signature = request.headers["x-hub-signature-256"]
    const timestamp = request.headers["x-hub-timestamp"]
    if (signature === undefined || timestamp === undefined || !/^\d+$/.test(timestamp)) return false
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    if (Math.abs(now - Number(timestamp)) > 120) return false
    const expected = hubSign(timestamp, request.body)
    const a = Buffer.from(signature, "utf8")
    const b = Buffer.from(expected, "utf8")
    return a.length === b.length && timingSafeEqual(a, b)
  })

const hub: ChannelConformance.Channel = {
  name: "hub",
  toleranceSeconds: 120,
  signatureHeader: "x-hub-signature-256",
  timestampHeader: "x-hub-timestamp",
  sign: (body, unixSeconds, options) => ({
    body,
    headers: {
      "x-hub-timestamp": String(unixSeconds),
      "x-hub-signature-256": hubSign(String(unixSeconds), body, options?.secret === "wrong" ? "another" : secret)
    }
  }),
  verify: hubVerify
}

describe("ChannelConformance", () => {
  it.live("Slack passes every case", () =>
    Effect.gen(function* () {
      const report = yield* ChannelConformance.run(slack)
      assert.deepStrictEqual(report.failed, [])
      assert.strictEqual(report.passed.length, ChannelConformance.cases(slack).length)
    })
  )

  it.live("a second channel passes the same cases", () =>
    Effect.gen(function* () {
      const report = yield* ChannelConformance.run(hub)
      assert.deepStrictEqual(report.failed, [])
    })
  )

  it.live("a channel that forgets the clock fails exactly the replay case, and one that throws is reported, not crashed", () =>
    Effect.gen(function* () {
      const replayable: ChannelConformance.Channel = {
        ...hub,
        name: "hub-without-a-clock",
        verify: (request) =>
          Effect.gen(function* () {
            const signature = request.headers["x-hub-signature-256"]
            const timestamp = request.headers["x-hub-timestamp"]
            if (signature === undefined || timestamp === undefined) return false
            const expected = hubSign(timestamp, request.body)
            const a = Buffer.from(signature, "utf8")
            const b = Buffer.from(expected, "utf8")
            return a.length === b.length && timingSafeEqual(a, b)
          })
      }
      const report = yield* ChannelConformance.run(replayable)
      assert.deepStrictEqual(report.failed.map((entry) => entry.name), ["enforces the replay window in both directions"])
      assert.include(report.failed[0]?.detail, "replayable")

      const throwing: ChannelConformance.Channel = {
        ...hub,
        name: "hub-that-throws",
        verify: (request) =>
          Effect.sync(() => {
            const signature = request.headers["x-hub-signature-256"]
            if (signature === undefined) throw new Error("no signature header")
            return true
          })
      }
      const thrown = yield* ChannelConformance.run(throwing)
      const missing = thrown.failed.find((entry) => entry.name.startsWith("refuses a missing signature"))
      assert.include(missing?.detail, "the verifier threw")
    })
  )
})
