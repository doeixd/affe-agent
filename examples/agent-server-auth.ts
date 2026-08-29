import { NodeHttpServer } from "@effect/platform-node"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, Headers, HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentServer } from "../src/http/index.js"

/**
 * Two agents on one HTTP server, with authentication and authorization kept on
 * their hosts:
 *
 * - `/agents/support` authenticates `Authorization: Bearer ...`;
 * - `/agents/admin` authenticates the `agent_session` cookie;
 * - each mount has its own authorization policy and capacity.
 *
 * Typechecked, not executed. An upstream login service is expected to set the
 * admin cookie. The configured values stand in for a token/session lookup; a
 * real deployment captures its identity provider in these resolver closures.
 */

export interface Principal {
  readonly subject: string
  readonly role: "support" | "admin"
}

type Authenticate = (credential: string) => Option.Option<Principal>

const requirePrincipal = (
  operation: AgentProtocol.Operation,
  principal: Option.Option<Principal>
) =>
  Option.match(principal, {
    onNone: () => Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation })),
    onSome: Effect.succeed
  })

const bearerCredential = (headers: Headers.Headers): Option.Option<string> =>
  Option.flatMap(Headers.get(headers, "authorization"), (authorization) => {
    const [scheme, credential, extra] = authorization.trim().split(/\s+/)
    return scheme?.toLowerCase() === "bearer" && credential !== undefined && extra === undefined
      ? Option.some(credential)
      : Option.none()
  })

/** A bearer-token `PrincipalResolver`; credential validation stays application-owned. */
export const bearerPrincipal = (
  authenticate: Authenticate
): AgentSessionHost.PrincipalResolver<Principal> => ({
  resolve: ({ headers, operation }) =>
    requirePrincipal(
      operation,
      Option.flatMap(bearerCredential(headers), authenticate)
    )
})

const decodeCookieValue = (value: string): Option.Option<string> => {
  try {
    return Option.some(decodeURIComponent(value))
  } catch {
    return Option.none()
  }
}

const cookieValue = (
  headers: Headers.Headers,
  name: string
): Option.Option<string> => {
  const header = Headers.get(headers, "cookie")
  if (Option.isNone(header)) return Option.none()
  for (const field of header.value.split(";")) {
    const separator = field.indexOf("=")
    if (separator < 0 || field.slice(0, separator).trim() !== name) continue
    const encoded = field.slice(separator + 1).trim()
    const unquoted = encoded.startsWith('"') && encoded.endsWith('"')
      ? encoded.slice(1, -1)
      : encoded
    return decodeCookieValue(unquoted)
  }
  return Option.none()
}

/** A cookie `PrincipalResolver`; the cookie value is decoded before lookup. */
export const cookiePrincipal = (
  name: string,
  authenticate: Authenticate
): AgentSessionHost.PrincipalResolver<Principal> => ({
  resolve: ({ headers, operation }) =>
    requirePrincipal(
      operation,
      Option.flatMap(cookieValue(headers, name), authenticate)
    )
})

/** Per-mount authorization: authentication alone does not grant another role. */
export const allowRole = (
  role: Principal["role"]
): AgentProtocol.Authorization<Principal> => ({
  authorize: ({ principal, operation, sessionId }) =>
    principal.role === role
      ? Effect.void
      : Effect.fail(new AgentProtocol.AgentForbiddenError({ operation, sessionId }))
})

/**
 * Compare two secrets without leaking where they differ.
 *
 * `===` on strings returns at the first differing byte, and immediately when
 * the lengths differ. Both are measurable over a network, and recovering a
 * bearer token or session id a byte at a time is the standard use for that
 * signal. A credential check has to take the same time whatever the input.
 *
 * `node:crypto`'s `timingSafeEqual` is not available here: this example is the
 * portable server shape, and `scripts/verify-portability.mjs` keeps `node:*`
 * out of everything but the host modules. WebCrypto has no timing-safe
 * comparison either. So the comparison is written out: every byte of the
 * longer input is visited, and the length difference is folded into the same
 * accumulator rather than short-circuiting on it.
 *
 * A real deployment usually compares *digests* instead -- see the note on
 * `configuredCredential` -- which removes the length signal by construction.
 */
export const constantTimeEquals = (a: string, b: string): boolean => {
  const length = Math.max(a.length, b.length)
  let difference = a.length ^ b.length
  for (let index = 0; index < length; index++) {
    // `charCodeAt` past the end is NaN, and `NaN | 0` is 0, which would make
    // two different lengths agree on the tail. The explicit -1 keeps them
    // distinct without branching on which string ran out.
    const left = index < a.length ? a.charCodeAt(index) : -1
    const right = index < b.length ? b.charCodeAt(index) : -1
    difference |= left ^ right
  }
  return difference === 0
}

/**
 * Match a configured credential.
 *
 * The value stays in `Redacted` until the moment of comparison so it does not
 * end up in a log line or a stack frame on the way here.
 *
 * A production resolver would look the credential up rather than hold it, and
 * would usually compare a hash: `crypto.subtle.digest` both sides and compare
 * the fixed-length results. That is portable, keeps this same constant-time
 * property, and additionally hides the length. The shape of the closure does
 * not change, which is the point of the seam.
 */
const configuredCredential = (
  expected: Redacted.Redacted<string>,
  principal: Principal
): Authenticate =>
  (candidate) =>
    constantTimeEquals(candidate, Redacted.value(expected))
      ? Option.some(principal)
      : Option.none()

const Support = Agent.make({
  instructions: "Help customers with ordinary support requests."
})
const Admin = Agent.make({
  instructions: "Help administrators inspect internal operations."
})

const SupportHost = AgentSessionHost.Tag<Principal>("example/server/support-host")
const AdminHost = AgentSessionHost.Tag<Principal>("example/server/admin-host")

const credentials = Config.all({
  supportToken: Config.redacted("SUPPORT_AGENT_TOKEN"),
  adminSession: Config.redacted("ADMIN_AGENT_SESSION")
})

const model = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

const hosts = Layer.unwrap(
  Effect.map(credentials, ({ adminSession, supportToken }) => {
    const support = AgentSessionHost.layer(SupportHost, {
      principal: bearerPrincipal(configuredCredential(supportToken, {
        subject: "configured-support-client",
        role: "support"
      })),
      authorization: allowRole("support"),
      maxSessions: 100,
      maxRequestsPerSession: 64
    }).pipe(Layer.provide(AgentClient.layer(Support)))

    const admin = AgentSessionHost.layer(AdminHost, {
      principal: cookiePrincipal("agent_session", configuredCredential(adminSession, {
        subject: "configured-admin-session",
        role: "admin"
      })),
      authorization: allowRole("admin"),
      maxSessions: 10,
      maxRequestsPerSession: 32
    }).pipe(Layer.provide(AgentClient.layer(Admin)))

    return Layer.mergeAll(support, admin)
  })
).pipe(Layer.provide(model))

export const mounts = {
  agents: [
    AgentServer.mount("support", { host: SupportHost }),
    AgentServer.mount("admin", { host: AdminHost })
  ]
}

// An HttpApi value the application may combine with its own API and middleware.
export const api = AgentServer.make(mounts)

const routes = AgentServer.serverLayer(mounts).pipe(Layer.provide(hosts))
const server = HttpRouter.serve(routes).pipe(
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 3000 }))
)

export const main = Layer.launch(server)
