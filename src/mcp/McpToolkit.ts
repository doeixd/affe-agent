import { Effect, Schema } from "effect"
import { AiError, Tool, Toolkit } from "effect/unstable/ai"

/**
 * Using a remote MCP server's tools, with the types inferred.
 *
 * The tension is that inference happens at compile time and an MCP server's
 * tool list is a runtime value: `tools/list` returns JSON Schema when the
 * program is already running. Nothing can infer a type from that.
 *
 * So the types come from a local declaration and the server is checked against
 * it. You write the `Tool`s you intend to use, exactly as you would for a local
 * toolkit, and `bind` verifies on connect that the server actually offers them.
 * From then on the agent has real tool types — parameters, results and failures
 * — and the declared schema doubles as the decoding contract: a server that
 * returns the wrong shape fails as a typed error at the boundary rather than
 * flowing onward as `unknown`.
 *
 * The alternative, for tools genuinely discovered at runtime, is Effect AI's
 * `Tool.dynamic`, whose parameters are `unknown` by construction. The two
 * compose: declare what you depend on, discover the rest.
 */

/**
 * What this needs from an MCP client.
 *
 * Deliberately small, and deliberately an interface. Effect ships `McpServer`,
 * `McpProtocol` and `McpSchema` but no client, so there is nothing to depend
 * on yet — and writing a protocol implementation against a specification with
 * no peer to check it against is how plausible-but-wrong code gets shipped.
 *
 * Keeping the transport abstract means the type story is settled before the
 * client arrives rather than retrofitted around it, and it makes all of this
 * testable against a fake.
 */
export interface Connection {
  /** The server's advertised tools, as `tools/list` reports them. */
  readonly listTools: Effect.Effect<ReadonlyArray<RemoteTool>, McpTransportError>
  /**
   * Invoke a tool. `params` is the encoded form of the declared parameters,
   * and the result is decoded against the declared success schema.
   */
  readonly callTool: (
    name: string,
    params: unknown
  ) => Effect.Effect<unknown, McpTransportError>
}

/** A tool as the server describes it. */
export interface RemoteTool {
  readonly name: string
  readonly description?: string | undefined
  /** JSON Schema. Carried for inspection and codegen, not used for binding. */
  readonly inputSchema?: unknown
}

/** The transport failed, as distinct from the tool or the server's answer. */
export class McpTransportError extends Schema.TaggedError<McpTransportError>()(
  "McpTransportError",
  { detail: Schema.String }
) {
  override get message() {
    return "MCP transport failure: " + this.detail
  }
}

/**
 * The server does not offer a tool that was declared.
 *
 * Raised at bind time rather than on first call. A missing tool is a
 * deployment mismatch — the wrong server, or one that has moved on — and
 * finding out when the model first reaches for it means discovering it in
 * production, mid-conversation.
 */
export class McpToolMissingError extends Schema.TaggedError<McpToolMissingError>()(
  "McpToolMissingError",
  {
    missing: Schema.Array(Schema.String),
    offered: Schema.Array(Schema.String)
  }
) {
  override get message() {
    return (
      "MCP server does not offer: " +
      this.missing.join(", ") +
      ". It offers: " +
      (this.offered.length === 0 ? "(nothing)" : this.offered.join(", "))
    )
  }
}

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)

/**
 * Bind declared tools to a remote MCP server.
 *
 * ```ts
 * const Search = Tool.make("search", {
 *   parameters: Schema.Struct({ query: Schema.String }),
 *   success: Schema.Struct({ hits: Schema.Array(Schema.String) })
 * })
 *
 * const toolkit = yield* McpToolkit.bind(connection, [Search])
 * const agent = Agent.make({ toolkit })
 * ```
 *
 * The returned toolkit is an ordinary `Toolkit.WithHandler`, indistinguishable
 * from a local one — which is the point. Nothing downstream of this line knows
 * the tools run somewhere else.
 */
export const bind = <const Tools extends ReadonlyArray<Tool.Any>>(
  connection: Connection,
  tools: Tools
): Effect.Effect<
  Toolkit.WithHandler<Toolkit.ToolsByName<Tools>>,
  McpTransportError | McpToolMissingError
> =>
  Effect.gen(function* () {
    // Verified once, on connect. See `McpToolMissingError` for why not lazily.
    const offered = yield* connection.listTools
    const available = new Set(offered.map((tool) => tool.name))
    const missing = tools
      .map((tool) => tool.name)
      .filter((name) => !available.has(name))

    if (missing.length > 0) {
      return yield* new McpToolMissingError({
        missing,
        offered: offered.map((tool) => tool.name)
      })
    }

    const built = Toolkit.make(...tools)

    const handlers = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        (params: unknown) =>
          Effect.gen(function* () {
            // Encoded on the way out and decoded on the way back, both through
            // the *declared* schemas. That is what makes the declaration a
            // contract rather than a hopeful annotation: a server whose
            // payload does not match fails here, with a typed error naming the
            // tool, instead of handing `unknown` to the agent.
            const encoded = yield* Schema.encodeEffect(tool.parametersSchema)(
              params
            ).pipe(
              Effect.mapError(
                (error) =>
                  new AiError.InvalidOutputError({
                    description:
                      "MCP tool " +
                      tool.name +
                      ": parameters did not match the declared schema: " +
                      describe(error)
                  })
              )
            )

            const result = yield* connection
              .callTool(tool.name, encoded)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new AiError.InternalProviderError({
                      description:
                        "MCP tool " + tool.name + ": " + error.detail
                    })
                )
              )

            return yield* Schema.decodeUnknownEffect(tool.successSchema)(
              result
            ).pipe(
              Effect.mapError(
                (error) =>
                  new AiError.InvalidOutputError({
                    description:
                      "MCP tool " +
                      tool.name +
                      ": result did not match the declared schema: " +
                      describe(error)
                  })
              )
            )
          })
      ])
    )

    return (yield* built.pipe(
      Effect.provide(
        built.toLayer(
          handlers as Toolkit.HandlersFrom<Toolkit.ToolsByName<Tools>>
        )
      )
    )) as Toolkit.WithHandler<Toolkit.ToolsByName<Tools>>
  })
