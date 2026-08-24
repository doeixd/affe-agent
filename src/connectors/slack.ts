import { Clock, Effect, Redacted } from "effect"

/**
 * Slack request-signature verification.
 *
 * **Portable.** This used to be a host module, kept out of the portable surface
 * because it reached for `node:crypto`. It now uses the Web Crypto API
 * (`globalThis.crypto.subtle`), which Node, Bun, Deno and edge runtimes all
 * implement, so the entry point carries no host dependency.
 *
 * The interesting part of that change is the *comparison*. Verifying a
 * signature by computing the expected one and comparing strings needs the
 * compare to be constant-time, or the time it takes leaks how much of a forged
 * signature was right. `node:crypto` gives that as `timingSafeEqual`; Web
 * Crypto has no such function, and hand-rolling one in JavaScript is a promise
 * the language cannot keep.
 *
 * So the comparison is not done here at all. `subtle.verify` takes the
 * signature and the data and answers the question directly, doing the compare
 * inside an implementation that is built for it. That is both more portable
 * and a better guarantee than the code it replaces.
 *
 * Note this is *not* `effect/Crypto`, which was the obvious candidate and does
 * not fit: it offers random bytes, UUIDs and SHA digests, and neither HMAC nor
 * a constant-time compare. See `docs/audit-effect-ecosystem.md` E10.
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

/**
 * The bytes of a `v0=<hex>` signature, or `undefined` if it is not one.
 *
 * Malformed input is a `false` verification, never a throw: the header is
 * attacker-controlled, so every shape it can take has to be an ordinary answer.
 */
const signatureBytes = (signature: string): Uint8Array | undefined => {
  if (!signature.startsWith("v0=")) return undefined
  const hex = signature.slice(3)
  // An odd length, or anything outside hex, is not a signature.
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return undefined
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i = i + 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

const utf8 = new TextEncoder()

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

    const provided = signatureBytes(request.signature)
    if (provided === undefined) return false

    const base = `v0:${request.timestamp}:${request.body}`
    // `verify` rather than sign-then-compare: the comparison happens inside the
    // implementation, in constant time, which is the property that matters and
    // the one JavaScript cannot provide for itself.
    return yield* Effect.promise(async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        utf8.encode(Redacted.value(options.signingSecret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      )
      return globalThis.crypto.subtle.verify(
        "HMAC",
        key,
        provided,
        utf8.encode(base)
      )
    })
  })
