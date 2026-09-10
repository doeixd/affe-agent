import { Cause, Clock, Effect, Exit, Option, Schema } from "effect"

/**
 * The conformance suite for a channel's inbound verification.
 *
 * The cases a webhook channel must hold --
 * a correct signature is accepted; a tampered body, the wrong secret, a
 * request outside the replay window, a missing or mangled header are all
 * refused *without throwing*; a large or unusual body is a body like any
 * other. They were written for Slack first (`test/SlackVerifier.test.ts`)
 * and are packaged here so a second channel is held to the same list.
 *
 * Framework-agnostic, like `SandboxConformance`: a case is a named Effect
 * that signs relative to whatever `Clock` says -- a real clock or a test
 * clock, the verifier and the case read the same one -- and `run` executes
 * them and reports. (`effect/testing` is deliberately not imported: its
 * barrel reaches `node:assert`, and `/testing` is a portable entry.) Threading and
 * attachments are *not* here: there is no decoder seam in `/connectors` to
 * hold them to yet (a `Delivery` is text in a conversation), and a suite
 * that asserted them would be asserting a shape that does not exist.
 */

export class Failure extends Schema.TaggedError<Failure>()(
  "ChannelConformanceFailure",
  { case: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `channel conformance: ${this.case}: ${this.detail}`
  }
}

/** A request as the verifier sees it: raw headers and the raw body. */
export interface Request {
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** How the suite drives one channel. */
export interface Channel {
  readonly name: string
  /**
   * A correctly signed request for `body` at `unixSeconds`, or one signed
   * with a secret the verifier does not hold when `secret` is `"wrong"`.
   */
  readonly sign: (body: string, unixSeconds: number, options?: { readonly secret?: "wrong" | undefined }) => Request
  /** The channel's verifier. Must never throw or fail: an unverifiable request is `false`. */
  readonly verify: (request: Request) => Effect.Effect<boolean>
  /** The replay window the verifier enforces, in seconds. */
  readonly toleranceSeconds: number
  /** The header the signature travels in, so the suite can remove and mangle it. */
  readonly signatureHeader: string
  /** The header the timestamp travels in. */
  readonly timestampHeader: string
}

export interface Case {
  readonly name: string
  readonly run: Effect.Effect<void, Failure>
}

export interface Report {
  readonly passed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<{ readonly name: string; readonly detail: string }>
}

const BODY = "token=abc&command=%2Fweather&text=94070"

/** The clock the verifier will read, in whole seconds. */
const now = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

const check = (name: string) => (condition: boolean, detail: string): Effect.Effect<void, Failure> =>
  condition ? Effect.void : Effect.fail(new Failure({ case: name, detail }))

const without = (request: Request, header: string): Request => {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== header.toLowerCase()) headers[key] = value
  }
  return { ...request, headers }
}

const withHeader = (request: Request, header: string, value: string): Request => ({
  ...request,
  headers: { ...without(request, header).headers, [header]: value }
})

const headerOf = (request: Request, header: string): string | undefined =>
  Object.entries(request.headers).find(([key]) => key.toLowerCase() === header.toLowerCase())?.[1]

/** Every case, for one channel. Each signs relative to the current clock. */
export const cases = (channel: Channel): ReadonlyArray<Case> => {
  const named = (
    name: string,
    body: (expect: ReturnType<typeof check>) => Effect.Effect<void, Failure>
  ): Case => ({
    name,
    // Never a defect: a verifier that throws on hostile input has failed the
    // case, and the report should say which.
    run: body(check(name)).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(new Failure({ case: name, detail: `the verifier threw: ${String(defect)}` })))
    )
  })
  return [
    named("accepts a fresh, correctly signed request", (expect) =>
      Effect.gen(function* () {
        const t = yield* now
        yield* expect(yield* channel.verify(channel.sign(BODY, t)), "a valid request was refused")
      })
    ),
    named("refuses a tampered body", (expect) =>
      Effect.gen(function* () {
        const t = yield* now
        const signed = channel.sign(BODY, t)
        yield* expect(!(yield* channel.verify({ ...signed, body: `${BODY}&injected=1` })), "a body altered after signing was accepted")
        yield* expect(!(yield* channel.verify({ ...signed, body: "" })), "an emptied body was accepted")
      })
    ),
    named("refuses a signature made with a secret it does not hold", (expect) =>
      Effect.gen(function* () {
        const t = yield* now
        yield* expect(!(yield* channel.verify(channel.sign(BODY, t, { secret: "wrong" }))), "a signature from the wrong secret was accepted")
      })
    ),
    named("enforces the replay window in both directions", (expect) =>
      Effect.gen(function* () {
        const t = yield* now
        const inside = channel.sign(BODY, t - channel.toleranceSeconds + 2)
        yield* expect(yield* channel.verify(inside), "a request just inside the window was refused")
        const stale = channel.sign(BODY, t - channel.toleranceSeconds - 2)
        yield* expect(!(yield* channel.verify(stale)), "a stale request outside the window was accepted (replayable)")
        const future = channel.sign(BODY, t + channel.toleranceSeconds + 2)
        yield* expect(!(yield* channel.verify(future)), "a request from the future, outside the window, was accepted")
      })
    ),
    named("refuses a missing signature, a missing timestamp and a non-numeric timestamp, without throwing", (expect) =>
      Effect.gen(function* () {
        const t = yield* now
        const signed = channel.sign(BODY, t)
        yield* expect(!(yield* channel.verify(without(signed, channel.signatureHeader))), "no signature was accepted")
        yield* expect(!(yield* channel.verify(without(signed, channel.timestampHeader))), "no timestamp was accepted")
        yield* expect(!(yield* channel.verify(withHeader(signed, channel.timestampHeader, "nope"))), "a non-numeric timestamp was accepted")
        yield* expect(!(yield* channel.verify({ headers: {}, body: BODY })), "a request with no headers at all was accepted")
      })
    ),
    named("refuses a mangled signature, without throwing", (expect) =>
      Effect.gen(function* () {
        const t = yield* now
        const signed = channel.sign(BODY, t)
        const good = headerOf(signed, channel.signatureHeader) ?? ""
        const mangled = [
          "",
          good.slice(0, -2),
          `${good}00`,
          good.replace(/[0-9a-f]/gi, "z"),
          "not a signature at all",
          good.toUpperCase() === good ? good.toLowerCase().slice(0, -1) : good.slice(0, -1)
        ]
        for (const signature of mangled) {
          yield* expect(
            !(yield* channel.verify(withHeader(signed, channel.signatureHeader, signature))),
            `accepted the mangled signature ${JSON.stringify(signature)}`
          )
        }
      })
    ),
    named("a large or unusual body is a body: signed it verifies, unsigned it does not", (expect) =>
      Effect.gen(function* () {
        const t = yield* now
        const large = "x".repeat(1024 * 1024)
        yield* expect(yield* channel.verify(channel.sign(large, t)), "a correctly signed 1 MiB body was refused")
        yield* expect(!(yield* channel.verify({ ...channel.sign(BODY, t), body: large })), "a 1 MiB body was accepted under another body's signature")
        const unusual = "text=héllo — 日本 \n\r\t{\"json\":true}"
        yield* expect(yield* channel.verify(channel.sign(unusual, t)), "a body with unicode, NUL and control characters was refused when correctly signed")
      })
    )
  ]
}

/**
 * Run every case for a channel and report. Never fails: a failing case, and
 * a verifier that throws, are lines in the report.
 */
export const run = (channel: Channel): Effect.Effect<Report> =>
  Effect.gen(function* () {
    const passed: Array<string> = []
    const failed: Array<{ name: string; detail: string }> = []
    for (const entry of cases(channel)) {
      const exit = yield* Effect.exit(entry.run)
      if (Exit.isSuccess(exit)) passed.push(entry.name)
      else {
        const error = Cause.findErrorOption(exit.cause)
        failed.push({
          name: entry.name,
          detail: Option.isSome(error) ? error.value.detail : `defect: ${Cause.pretty(exit.cause)}`
        })
      }
    }
    return { passed, failed }
  })
