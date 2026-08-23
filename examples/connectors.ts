import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentSessionHost } from "../src/client/index.js"
import { Connectors } from "../src/connectors/index.js"
import * as Slack from "../src/connectors/slack.js"

/**
 * A Slack channel: the agent answers messages in a Slack workspace.
 *
 * Typechecked, not executed. It shows the shape the guidance prescribes -- a
 * thin adapter over the shared host that owns exactly four things -- and where
 * the platform specifics live: all inside `decode` and `reply`, so the core
 * package stays platform-agnostic and portable.
 *
 * The host authenticates the principal from the request headers; `decode`
 * verifies Slack's signature, answers the setup challenge, drops retries and a
 * bot's own messages, and extracts the message; the delivery id is Slack's
 * `event_id`, so a redelivery is deduped by the host for free; `reply` posts the
 * answer back with `chat.postMessage`.
 */

const Host = AgentSessionHost.Tag<string>("app/slack/host")

// The slice of Slack's event payload this agent cares about.
const SlackEnvelope = Schema.Struct({
  type: Schema.String,
  challenge: Schema.optional(Schema.String),
  event_id: Schema.optional(Schema.String),
  event: Schema.optional(Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    channel: Schema.optional(Schema.String),
    bot_id: Schema.optional(Schema.String)
  }))
})

// Signature verification uses platform crypto, so it is the one host-flagged
// entry (`@doeixd/effect-agent/connectors/slack`); the rest of this file stays
// portable.
const verify = (signingSecret: Redacted.Redacted<string>) => Slack.verifier({ signingSecret })

const decode = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const signingSecret = yield* Config.redacted("SLACK_SIGNING_SECRET")
    // Verify against the *raw* body Slack signed, before parsing anything.
    const raw = yield* request.text
    const ok = yield* verify(signingSecret)({
      signature: request.headers["x-slack-signature"],
      timestamp: request.headers["x-slack-request-timestamp"],
      body: raw
    })
    if (!ok) {
      return Connectors.respondWith(HttpServerResponse.empty({ status: 401 }))
    }
    // The signature checked out, so the body is genuinely Slack's JSON; a parse
    // failure here is a defect, not something to handle.
    const body = yield* Schema.decodeUnknownEffect(SlackEnvelope)(JSON.parse(raw))
    // Slack's one-time endpoint verification.
    if (body.type === "url_verification" && body.challenge !== undefined) {
      return Connectors.respondWith(HttpServerResponse.text(body.challenge))
    }
    const event = Option.fromNullishOr(body.event)
    // Ignore anything that isn't a user's message (a bot's own posts included).
    if (Option.isNone(event) || event.value.bot_id !== undefined || event.value.text === undefined) {
      return Connectors.ignored
    }
    return Connectors.delivered({
      conversation: event.value.channel ?? "unknown",
      text: event.value.text,
      deliveryId: body.event_id ?? "unknown",
      headers: request.headers
    })
  })

const slack = Connectors.serverLayer({
  host: Host,
  path: "/slack/events",
  decode,
  reply: (result, { delivery }) =>
    Effect.flatMap(HttpClient.HttpClient, (client) =>
      Effect.flatMap(
        HttpBody.json({ channel: delivery.conversation, text: result.text }),
        (json) =>
          client.execute(
            HttpClientRequest.post("https://slack.com/api/chat.postMessage", {
              headers: { authorization: "Bearer xoxb-...", "content-type": "application/json" },
              body: json
            })
          )
      )).pipe(Effect.asVoid)
})

// The Slack adapter with its host provided. It still requires an
// `HttpRouter`, an `HttpClient` (e.g. FetchHttpClient) and a `LanguageModel`
// layer -- what a real deployment serves it with.
export const main = slack.pipe(
  Layer.provide(
    AgentSessionHost.layer(Host, {
      authorization: { authorize: () => Effect.void },
      principal: { resolve: () => Effect.succeed("slack-workspace") },
      maxSessions: 1000,
      maxRequestsPerSession: 256
    }).pipe(Layer.provide(AgentClient.layer(Agent.make({ instructions: "You are a helpful Slack assistant." }))))
  )
)

