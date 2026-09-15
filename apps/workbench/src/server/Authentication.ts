/**
 * The server's half of authentication, resolved once and used twice (plan-workbench.md §16):
 * by the product routes, as `CurrentUser`, and by `AgentSessionHost`, as the
 * principal it authorizes session operations for.
 *
 * Credentials are bearer tokens mapped to users. A local deployment is the
 * default map `local=local` -- the same path with one person on it.
 */
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { AgentProtocol } from "affe-agent/client"
import type { AgentSessionHost } from "affe-agent/client"
import { UserId } from "../domain/WorkbenchIds.js"
import { Authenticated, CurrentUser, Unauthorized } from "../protocol/Authentication.js"
import { conversationIdOf } from "../runtime/ConversationSessions.js"
import type { ConversationStore } from "../store/ConversationStore.js"

export class Tokens extends Context.Service<Tokens, ReadonlyMap<string, UserId>>()("workbench/Tokens") {}

export class MalformedTokensError extends Schema.TaggedError<MalformedTokensError>()("MalformedTokensError", {
  entry: Schema.String
}) {
  override get message() {
    return `WORKBENCH_TOKENS: expected token=user, got ${JSON.stringify(this.entry)}`
  }
}

/** `token=user,token=user`; a malformed entry refuses to start rather than being ignored. */
export const parseTokens = (raw: string): Effect.Effect<ReadonlyMap<string, UserId>, MalformedTokensError> =>
  Effect.forEach(raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""), (entry) => {
    const [token, user, ...rest] = entry.split("=")
    return token === undefined || token === "" || user === undefined || user === "" || rest.length > 0
      ? Effect.fail(new MalformedTokensError({ entry }))
      : Effect.succeed([token, UserId.make(user)] as const)
  }).pipe(Effect.map((entries) => new Map(entries)))

export const tokensFromConfig: Layer.Layer<Tokens, Config.ConfigError | MalformedTokensError> = Layer.effect(
  Tokens,
  Effect.gen(function*() {
    const raw = yield* Config.string("WORKBENCH_TOKENS").pipe(Config.withDefault("local=local"))
    return yield* parseTokens(raw)
  })
)

export const tokens = (entries: Readonly<Record<string, string>>): Layer.Layer<Tokens> =>
  Layer.succeed(Tokens, new Map(Object.entries(entries).map(([token, user]) => [token, UserId.make(user)])))

/** The product routes' middleware: a known token becomes `CurrentUser`. */
export const authenticated: Layer.Layer<Authenticated, never, Tokens> = Layer.effect(
  Authenticated,
  Effect.gen(function*() {
    const known = yield* Tokens
    return Authenticated.of({
      bearer: (httpEffect, { credential }) => {
        const user = known.get(Redacted.value(credential))
        return user === undefined
          ? Effect.fail(new Unauthorized({ detail: "unknown bearer token" }))
          : Effect.provideService(httpEffect, CurrentUser, user)
      }
    })
  })
)

const bearerOf = (headers: Headers.Headers): Option.Option<string> =>
  Option.flatMap(Headers.get(headers, "authorization"), (value) =>
    value.startsWith("Bearer ") ? Option.some(value.slice("Bearer ".length)) : Option.none())

/**
 * The host's principal and authorization over the same tokens. Closed by
 * default: an operation is allowed only by one of the rules below.
 *
 * - An operation on a session -- making it included -- is allowed when the
 *   session is a conversation's and that conversation is the principal's. A
 *   session no conversation names is refused, so no one can claim the session
 *   id of a conversation they do not own.
 * - Any operation addressed to the host rather than a session --
 *   `listSessions` today, whatever the protocol adds tomorrow -- is refused:
 *   one person enumerating everyone's sessions is the leak this exists to stop.
 *
 * A store that cannot answer fails the request rather than letting it through.
 */
export const hostOptions = (
  known: ReadonlyMap<string, UserId>,
  store: ConversationStore["Service"]
): Pick<AgentSessionHost.Options<UserId>, "principal" | "authorization" | "subject"> => ({
  principal: {
    resolve: ({ headers, operation }) =>
      Option.match(Option.flatMap(bearerOf(headers), (token) => Option.fromNullishOr(known.get(token))), {
        onNone: () => Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation })),
        onSome: Effect.succeed
      })
  },
  authorization: {
    authorize: ({ operation, principal, sessionId }) => {
      const forbidden = new AgentProtocol.AgentForbiddenError({ operation, sessionId })
      if (Option.isNone(sessionId)) return Effect.fail(forbidden)
      return Option.match(conversationIdOf(sessionId.value), {
        onNone: () => Effect.fail(forbidden),
        onSome: (conversationId) =>
          store.get(conversationId).pipe(
            Effect.orDie,
            Effect.flatMap((found) =>
              Option.isSome(found) && found.value.ownerId === principal ? Effect.void : Effect.fail(forbidden)
            )
          )
      })
    }
  },
  subject: (principal) => principal
})
