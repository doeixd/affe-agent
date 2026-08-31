import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Redacted, Ref } from "effect"
import type * as Elicitation from "../src/Elicitation.js"
import { Credentials } from "../src/toolSource/index.js"

/**
 * `plan-tool-credentials.md` §5 and §7.5: a stateful token that expires
 * asks a human to reconnect, and OAuth stays a per-source escape hatch
 * rather than entering the placement vocabulary.
 */

const binding = Credentials.binding({
  integration: "github",
  method: Credentials.bearer(),
  values: { token: "oauth:github" }
})

/** An elicitor that answers immediately, recording what it was asked. */
const answering = (
  granted: boolean,
  seen: Array<Elicitation.Request>
): Elicitation.Elicitor => ({
  elicit: (request, announce) =>
    Effect.as(
      Effect.andThen(announce, Effect.sync(() => void seen.push(request))),
      { id: request.id, granted }
    ),
  respond: () => Effect.succeed(false),
  pending: Effect.succeed([])
})

/**
 * A connection that is dead until it is reconnected, and counts how many
 * times it was asked for a token.
 */
const connection = (options: { readonly reconnects: boolean }) =>
  Effect.gen(function*() {
    const live = yield* Ref.make(false)
    const reads = yield* Ref.make(0)
    const provider = Credentials.fromRefreshing({
      key: "oauth",
      authorizationUrl: (handle) => `https://example.com/connect?handle=${handle}`,
      token: (handle) =>
        Effect.gen(function*() {
          yield* Ref.update(reads, (n) => n + 1)
          return (yield* Ref.get(live))
            ? Option.some(Redacted.make(`fresh-token-for-${handle}`))
            : Option.none()
        })
    })
    // "Reconnecting" is whatever the application does when the human
    // finishes; here, flipping the connection live.
    const reconnect = options.reconnects ? Ref.set(live, true) : Effect.void
    return { provider, reads, reconnect }
  })

describe("Credentials reauth", () => {
  it.effect("an expired token asks to be reconnected, and the retry succeeds", () =>
    Effect.gen(function*() {
      const asked: Array<Elicitation.Request> = []
      const announced: Array<string> = []
      const { provider, reads, reconnect } = yield* connection({ reconnects: true })

      const rendered = yield* Credentials.withReauth(
        Credentials.resolve(binding),
        {
          elicitor: {
            elicit: (request, announce) =>
              // Reconnect as the human would, then answer.
              Effect.andThen(
                Effect.andThen(announce, reconnect),
                Effect.sync(() => {
                  asked.push(request)
                  return { id: request.id, granted: true }
                })
              ),
            respond: () => Effect.succeed(false),
            pending: Effect.succeed([])
          },
          onAsk: (detail) =>
            Effect.sync(() => void announced.push(detail.authorizationUrl ?? "(no url)"))
        }
      ).pipe(Effect.provide(provider))

      // The retry saw the reconnected token.
      assert.strictEqual(rendered.headers["Authorization"], "Bearer fresh-token-for-oauth:github")
      // Asked exactly once, as a credential-reauth carrying where to go.
      assert.strictEqual(asked.length, 1)
      assert.strictEqual(asked[0]!.kind, "credential-reauth")
      assert.deepStrictEqual(announced, ["https://example.com/connect?handle=oauth:github"])
      const detail = asked[0]!.detail as {
        readonly handle: string
        readonly authorizationUrl?: string
      }
      assert.strictEqual(detail.handle, "oauth:github")
      assert.strictEqual(
        detail.authorizationUrl,
        "https://example.com/connect?handle=oauth:github"
      )
      // Two reads: the failure, then the retry. Exactly one retry.
      assert.strictEqual(yield* Ref.get(reads), 2)
    })
  )

  it.effect("a refused question fails with the original error, and does not ask again", () =>
    Effect.gen(function*() {
      const asked: Array<Elicitation.Request> = []
      const { provider, reads } = yield* connection({ reconnects: false })

      const error = yield* Effect.flip(
        Credentials.withReauth(Credentials.resolve(binding), {
          elicitor: answering(false, asked)
        }).pipe(Effect.provide(provider))
      )

      assert.strictEqual(error.reason, "expired")
      assert.isTrue(error.reauthRequired)
      assert.strictEqual(asked.length, 1)
      // Refused means no retry at all: one read.
      assert.strictEqual(yield* Ref.get(reads), 1)
    })
  )

  it.effect("a reconnect that did not help fails once, rather than asking forever", () =>
    Effect.gen(function*() {
      const asked: Array<Elicitation.Request> = []
      const { provider, reads } = yield* connection({ reconnects: false })

      const error = yield* Effect.flip(
        Credentials.withReauth(Credentials.resolve(binding), {
          // Granted, but the connection is still dead.
          elicitor: answering(true, asked)
        }).pipe(Effect.provide(provider))
      )

      assert.isTrue(error.reauthRequired)
      // Asked once and retried once: a loop here would re-ask forever
      // against a connection that is not coming back.
      assert.strictEqual(asked.length, 1)
      assert.strictEqual(yield* Ref.get(reads), 2)
    })
  )

  it.effect("a misconfiguration is never turned into a question", () =>
    Effect.gen(function*() {
      const asked: Array<Elicitation.Request> = []
      // The binding names no handle for the method's variable: a human
      // cannot fix that by clicking a link, so it must not ask.
      const broken = Credentials.binding({
        integration: "github",
        method: Credentials.bearer()
      })
      const error = yield* Effect.flip(
        Credentials.withReauth(Credentials.resolve(broken), {
          elicitor: answering(true, asked)
        }).pipe(Effect.provide(Credentials.fromValues({})))
      )
      assert.strictEqual(error.reason, "missing")
      assert.isFalse(error.reauthRequired)
      assert.deepStrictEqual(asked, [])
    })
  )

  it.effect("a refreshing provider is read-only: the application owns the connection", () =>
    Effect.gen(function*() {
      const { provider } = yield* connection({ reconnects: true })
      const service = yield* Effect.service(Credentials.Provider).pipe(
        Effect.provide(provider)
      )
      assert.isFalse(service.writable)
      assert.isUndefined(service.set)
    })
  )

  it("OAuth never enters the method vocabulary", () => {
    // The escape hatch is a *provider*; the binding still describes a
    // conventional bearer token, and `render` knows nothing about
    // refresh, scopes or callbacks. This is the §7.4 lesson as a test:
    // static credentials are declarative, OAuth is stateful, and the
    // method vocabulary only ever describes the first.
    assert.deepStrictEqual(Credentials.requiredVariables(binding.method), ["token"])
    assert.strictEqual(binding.method.kind, "apikey")
    if (binding.method.kind === "apikey") {
      assert.deepStrictEqual(binding.method.placements, [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" }
      ])
    }
  })
})
