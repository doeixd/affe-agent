import { createHmac, timingSafeEqual } from "node:crypto"
import { Clock, Effect, Redacted } from "effect"

/**
 * Slack request-signature verification.
 *
 * **A host module** — it uses `node:crypto`, so it lives in its own entry
 * (`@doeixd/effect-agent/connectors/slack`) and out of the portable surface,
 * exactly like `sandbox/local`. The rest of `/connectors` stays portable; an
 * application that deploys on Slack opts into this one host entry.
 *
 * Slack signs each request: `X-Slack-Signature` is `v0=` + the HMAC-SHA256 of
 * `v0:{timestamp}:{body}` under the app's signing secret, and
 * `X-Slack-Request-Timestamp` is the unix time it was signed. Verifying both —
 * the signature *and* the timestamp's freshness — is what stops forged and
 * replayed deliveries. Getting the constant-time compare or the replay window
 * wrong is exactly the kind of thing every adopter should not re-implement.
 */

/** The signed material from one Slack request. */
export interface SlackRequest {
  /** `X-Slack-Signature` header, e.g. `v0=a1b2...`. */
  readonly signature: string | undefined
  /** `X-Slack-Request-Timestamp` header — unix seconds, as a string. */
  readonly timestamp: string | undefined
  /** The raw request body, byte-for-byte as received (not re-serialised). */
  readonly body: string
}

export interface Options {
  /** The app's Slack signing secret. */
  readonly signingSecret: Redacted.Redacted<string>
  /**
   * Reject a request whose timestamp is more than this many seconds from now,
   * in either direction — the replay window. Slack's own guidance is 5 minutes.
   */
  readonly toleranceSeconds?: number | undefined
}

const DEFAULT_TOLERANCE_SECONDS = 300

// Length-safe, constant-time string comparison. `timingSafeEqual` throws on a
// length mismatch, so unequal lengths are treated as a (non-throwing) mismatch.
const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Build a verifier for one signing secret. The returned function checks a
 * request's signature and timestamp, returning `true` only when both hold, and
 * never throws on malformed input (a missing header, a non-numeric timestamp, a
 * length-mismatched signature are all just `false`).
 *
 * ```ts
 * const verify = Slack.verifier({ signingSecret: Config.redacted("SLACK_SIGNING_SECRET") })
 * // in a connector's decode:
 * if (!(yield* verify({ signature, timestamp, body }))) {
 *   return Connectors.respondWith(HttpServerResponse.empty({ status: 401 }))
 * }
 * ```
 */
export const verifier = (options: Options) =>
(request: SlackRequest): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (request.signature === undefined || request.timestamp === undefined) return false

    const signedAt = Number(request.timestamp)
    if (!Number.isInteger(signedAt)) return false

    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
    if (Math.abs(nowSeconds - signedAt) > tolerance) return false

    const base = `v0:${request.timestamp}:${request.body}`
    const expected = `v0=${createHmac("sha256", Redacted.value(options.signingSecret)).update(base).digest("hex")}`
    return safeEqual(expected, request.signature)
  })
