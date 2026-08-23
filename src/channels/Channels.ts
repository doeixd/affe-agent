import { Effect, Option } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Prompt } from "effect/unstable/ai"
import * as AgentProtocol from "../client/AgentProtocol.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"

/**
 * Channels (issue #4 §10): put an agent in front of an external platform --
 * Slack, a webhook, a queue -- over the same `AgentSessionHost` seam the HTTP,
 * RPC, AG-UI and A2A adapters use. A channel is a thin adapter, not a second
 * Agent API; it owns at most four things, and everything else is the host's:
 *
 * 1. **Verify/authenticate** the incoming event -- done by the host's
 *    `resolve` from the delivery's headers, before a session is known.
 * 2. **Map the external conversation to a session** -- from the provider's
 *    stable opaque id, never a user-visible title (`session`, defaulting to the
 *    conversation id).
 * 3. **Map the message to a prompt** and run it (`deliver`).
 * 4. **Map the result back to a platform reply** (`reply`, which the
 *    application supplies -- it is what posts to Slack, answers the webhook).
 *
 * Two safety properties fall out and are worth stating:
 *
 * - **Duplicate deliveries dedupe for free.** Webhooks redeliver by design; a
 *   channel derives the host's `RequestId` from the platform's stable delivery
 *   id, and the host already joins a repeated mutation to its first result
 *   rather than running it twice. No extra store.
 * - **The prompt-injection boundary holds.** The message text is untrusted
 *   model input; identity, roles and authorization come from the host's
 *   principal (trusted, from headers), never from strings the sender supplied.
 *   Session ownership is the host's, from the opaque conversation id.
 *
 * Signature verification (Slack's HMAC, a webhook's shared secret) needs
 * platform crypto and stays the application's to supply -- in `serverLayer`'s
 * `decode`, or the host's `resolve` -- so this package stays portable.
 */

/** One inbound message, already decoded from the platform's payload. */
export interface Delivery {
  /** The provider's stable, opaque conversation id -- what a session is keyed on. */
  readonly conversation: string
  /** The user's message. Untrusted model input; never a source of identity. */
  readonly text: string
  /** A stable id for this delivery -- the platform's event/message id. Dedupes redelivery. */
  readonly deliveryId: string
  /** The request headers, for the host to authenticate the principal. */
  readonly headers: Headers.Headers
}

export interface Options<Principal, SE = never, RE = never, RR = never> {
  /** The shared session host every adapter routes through. */
  readonly host: AgentSessionHost.Tag<Principal>
  /**
   * Map a delivery to a session id. Defaults to the conversation id itself.
   * Derive it from the provider's opaque id, never a user-visible name.
   */
  readonly session?:
    | ((delivery: Delivery, principal: Principal) => Effect.Effect<AgentProtocol.SessionId, SE>)
    | undefined
  /**
   * Post the agent's result back to the platform. This is where a Slack channel
   * calls `chat.postMessage`, or a webhook answers its callback url.
   */
  readonly reply: (
    result: AgentProtocol.RemoteResult,
    context: { readonly delivery: Delivery; readonly principal: Principal }
  ) => Effect.Effect<void, RE, RR>
}

/** A channel: hand it a decoded delivery and it runs the agent and replies. */
export interface Channel<SE, RE, RR> {
  readonly deliver: (
    delivery: Delivery
  ) => Effect.Effect<AgentProtocol.RemoteResult, AgentProtocol.RemoteError | SE | RE, RR>
}

/**
 * Build a channel over a host. `deliver` authenticates, resolves and
 * get-or-creates the session, prompts it, and replies -- with the request ids
 * derived from the delivery id, so a redelivery is deduped by the host.
 */
export const make = <Principal, SE = never, RE = never, RR = never>(
  options: Options<Principal, SE, RE, RR>
): Effect.Effect<Channel<SE, RE, RR>, never, AgentSessionHost.Service<Principal>> =>
  Effect.map(options.host, (host): Channel<SE, RE, RR> => ({
    deliver: (delivery) =>
      Effect.gen(function* () {
        // Authenticated from the headers before the session is known.
        const principal = yield* host.resolve({
          operation: "prompt",
          sessionId: Option.none(),
          headers: delivery.headers
        })
        const sessionId = options.session === undefined
          ? AgentProtocol.SessionId.make(delivery.conversation)
          : yield* options.session(delivery, principal)
        // Get or create -- both keyed off the delivery id, so a redelivery
        // rejoins the first run rather than starting a second.
        yield* host.session(principal, { sessionId }).pipe(
          Effect.catchTag("AgentSessionNotFoundError", () =>
            host.createSession(principal, {
              requestId: AgentProtocol.RequestId.make(`${delivery.deliveryId}:create`),
              sessionId
            }))
        )
        const response = yield* host.prompt(principal, {
          requestId: AgentProtocol.RequestId.make(`${delivery.deliveryId}:prompt`),
          sessionId,
          input: Prompt.make(delivery.text)
        })
        yield* options.reply(response.result, { delivery, principal })
        return response.result
      })
  }))

// ---------------------------------------------------------------------------
// Webhook convenience: an HTTP route that acks fast and works in the background
// ---------------------------------------------------------------------------

/**
 * What the application's `decode` decided an inbound request is: a real
 * delivery, a direct response (a Slack `url_verification` challenge, say), or
 * nothing to do (a bot's own message, a duplicate the app already handled).
 */
export type Decoded =
  | { readonly _tag: "deliver"; readonly delivery: Delivery }
  | { readonly _tag: "respond"; readonly response: HttpServerResponse.HttpServerResponse }
  | { readonly _tag: "ignore" }

/** Decode result: run this delivery. */
export const delivered = (delivery: Delivery): Decoded => ({ _tag: "deliver", delivery })
/** Decode result: answer the request directly (e.g. a verification challenge). */
export const respondWith = (response: HttpServerResponse.HttpServerResponse): Decoded => ({
  _tag: "respond",
  response
})
/** Decode result: nothing to do. */
export const ignored: Decoded = { _tag: "ignore" }

export interface ServerOptions<Principal, SE, RE, RR, DE, DR> extends Options<Principal, SE, RE, RR> {
  /** The route to mount the webhook on. */
  readonly path: `/${string}`
  /**
   * Turn a raw request into a `Decoded`. This is where the application verifies
   * the platform signature, answers a challenge, drops a retry, and extracts
   * the message -- everything platform-specific, kept out of the core.
   */
  readonly decode: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Decoded, DE, DR>
}

/**
 * Mount a webhook that acks within the platform's timeout and does the work in
 * the background. A real delivery is forked -- so the reply goes out through
 * `reply` after the agent runs -- and the route returns 200 at once; a decode
 * that says `respond`/`ignore` answers directly. Mirrors the other adapters'
 * `serverLayer`, adding only the application's `decode`.
 */
export const serverLayer = <Principal, SE = never, RE = never, RR = never, DE = never, DR = never>(
  options: ServerOptions<Principal, SE, RE, RR, DE, DR>
) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const channel = yield* make(options)
      yield* router.add("POST", options.path, (request) =>
        options.decode(request).pipe(
          Effect.flatMap((decoded) => {
            switch (decoded._tag) {
              case "respond":
                return Effect.succeed(decoded.response)
              case "ignore":
                return Effect.succeed(HttpServerResponse.empty({ status: 200 }))
              case "deliver":
                // Ack fast; the reply is delivered by `reply` once the run ends.
                return channel.deliver(decoded.delivery).pipe(
                  Effect.catchCause((cause) => Effect.logError("channels: delivery failed", cause)),
                  Effect.forkScoped,
                  Effect.as(HttpServerResponse.empty({ status: 200 }))
                )
            }
          }),
          Effect.catchCause((cause) =>
            Effect.logError("channels: decode failed", cause).pipe(
              Effect.as(HttpServerResponse.empty({ status: 400 }))
            ))
        ))
    }))
