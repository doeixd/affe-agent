import { Effect, Exit, Layer, Ref, Schema, Scope, Semaphore } from "effect"
import { McpServer, Tool, Toolkit } from "effect/unstable/ai"
import { AgentClient } from "../client/AgentClient.js"
import { positiveInteger } from "../internal/positive.js"
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
 * Named sessions outlive the call that opened them, so a `sessionId` reaching
 * the same conversation actually means something. Each gets its own child
 * scope, so it can be released individually rather than only when the server
 * stops.
 *
 * `maxSessions` bounds the registry. Without it, every distinct id a client
 * sends opens a session that lives for the server's lifetime — unbounded
 * memory driven by input from outside. The oldest is closed when the limit is
 * reached, which is the friendlier failure: a long-abandoned conversation is
 * dropped rather than a new one refused.
 */
export const handlers = (options?: {
  readonly maxSessions?: number | undefined
}) =>
  Effect.gen(function* () {
    const client = yield* Effect.service(AgentClient)
    const parent = yield* Effect.scope
    const limit = positiveInteger(
      "AgentMcp.handlers maxSessions",
      options?.maxSessions ?? 128
    )
    const sessions = yield* Ref.make(
      new Map<string, { session: Client.RemoteSession; scope: Scope.Closeable }>()
    )

    // Creation is effectful, so reserving a slot cannot be one atomic `modify`.
    // Serialising it is what stops two concurrent calls for the same id from
    // each opening a session -- which would leak one and, worse, silently give
    // the two calls different conversations.
    const creating = yield* Semaphore.make(1)

    const openNamed = (sessionId: string) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(sessions)).get(sessionId)
        if (existing !== undefined) return existing.session

        const scope = yield* Scope.make()
        const session = yield* Scope.provide(
          client.createSession({ sessionId }),
          scope
        )

        const evicted = yield* Ref.modify(sessions, (all) => {
          const next = new Map(all)
          next.set(sessionId, { session, scope })
          if (next.size <= limit) return [undefined, next]
          // Insertion order: the first key is the least recently opened.
          const oldest = next.keys().next().value
          const dropped = oldest === undefined ? undefined : next.get(oldest)
          if (oldest !== undefined) next.delete(oldest)
          return [dropped, next]
        })
        if (evicted !== undefined) {
          yield* Scope.close(evicted.scope, Exit.void)
        }
        return session
      })

    /**
     * Run one call against a session, with the right lifetime for each kind.
     *
     * An anonymous call gets a session scoped to the *call*, so it is released
     * when the call returns. It was previously created in the server's scope:
     * one-shot in reachability but not in lifetime, so every anonymous call
     * left a session alive until the server shut down — and in `AgentClient`'s
     * registry too, since that finalizer hangs off the same scope. Unbounded
     * growth driven entirely by input from outside.
     *
     * A named call gets the registered session, which outlives the call on
     * purpose: that is what makes `sessionId` mean anything.
     */
    const ask = (sessionId: string | undefined, prompt: string) =>
      sessionId === undefined
        ? Effect.scoped(
            Effect.flatMap(client.createSession(), (session) =>
              session.prompt(prompt)
            )
          )
        : creating
            .withPermits(1)(openNamed(sessionId))
            .pipe(Effect.flatMap((session) => session.prompt(prompt)))

    return AgentToolkit.toLayer({
      ask_agent: ({ prompt, sessionId }) =>
        ask(sessionId, prompt).pipe(
          Effect.map((result) => result.text),
          // A remote caller cannot act on the harness's error types, and MCP
          // has no place to put them. The tool's declared failure carries the
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
    Layer.provide(Layer.unwrap(handlers()))
  )
