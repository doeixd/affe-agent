import { Effect, Layer, Ref, Schema, Scope } from "effect"
import { McpServer, Tool, Toolkit } from "effect/unstable/ai"
import { AgentClient } from "../client/AgentClient.js"
import type * as Client from "../client/AgentClient.js"

/**
 * An agent, exposed to MCP clients as a tool.
 *
 * The interesting thing is how little of it is MCP. The handler talks to
 * `AgentClient` — the transport seam — and knows nothing about sessions,
 * scopes, or the harness. MCP is a protocol adapter over that seam, which is
 * what the seam was for.
 *
 * Only this direction is implemented. Consuming a remote MCP server's tools —
 * turning them into an Effect AI `Toolkit` — would need an MCP *client*, and
 * Effect ships `McpServer`, `McpProtocol` and `McpSchema` but no client. That
 * is a protocol implementation, not an adapter, and writing one against a
 * specification with no peer to check it against is how plausible-but-wrong
 * code gets shipped.
 */

/**
 * Conversation continuity across calls.
 *
 * MCP tool calls are individually stateless, so a client that wants a
 * conversation has to say which one. Omitting `sessionId` gives a fresh
 * session, which is the right default for a one-shot question; supplying one
 * reaches the same session again, and it lives as long as the server does.
 */
export const AskAgent = Tool.make("ask_agent", {
  parameters: Schema.Struct({
    prompt: Schema.String,
    sessionId: Schema.optional(Schema.String)
  }),
  success: Schema.String,
  failure: Schema.String
})

export const AgentToolkit = Toolkit.make(AskAgent)

/**
 * Handlers for the toolkit above, backed by a client.
 *
 * Sessions are held in the surrounding scope rather than per call, so a
 * `sessionId` reaching the same conversation actually means something. They
 * are released when that scope closes, which for a server is its lifetime.
 */
export const handlers = Effect.gen(function* () {
  const client = yield* Effect.service(AgentClient)
  const scope = yield* Effect.scope
  const sessions = yield* Ref.make(new Map<string, Client.RemoteSession>())

  const sessionFor = (sessionId: string | undefined) =>
    Effect.gen(function* () {
      if (sessionId === undefined) {
        return yield* Scope.provide(client.createSession(), scope)
      }
      const existing = (yield* Ref.get(sessions)).get(sessionId)
      if (existing !== undefined) return existing
      const opened = yield* Scope.provide(
        client.createSession({ sessionId }),
        scope
      )
      yield* Ref.update(sessions, (all) => new Map(all).set(sessionId, opened))
      return opened
    })

  return AgentToolkit.toLayer({
    ask_agent: ({ prompt, sessionId }) =>
      sessionFor(sessionId).pipe(
        Effect.flatMap((session) => session.prompt(prompt)),
        Effect.map((result) => result.text),
        // A remote caller cannot act on the harness's error types, and MCP has
        // no place to put them. The tool's declared failure carries the
        // description instead, so the client sees a tool that failed for a
        // stated reason rather than a transport that broke.
        Effect.mapError((error: Client.RemoteError) => error.message)
      )
  })
})

/**
 * Register the agent as an MCP tool.
 *
 * Compose with one of Effect's `McpServer` transports:
 *
 * ```ts
 * AgentMcp.layer.pipe(
 *   Layer.provide(McpServer.layerStdio({ name: "my-agent", version: "1.0.0" })),
 *   Layer.provide(AgentClient.layer(agent))
 * )
 * ```
 */
export const layer: Layer.Layer<never, never, McpServer.McpServer | AgentClient> =
  McpServer.toolkit(AgentToolkit).pipe(
    Layer.provide(Layer.unwrap(handlers))
  )
