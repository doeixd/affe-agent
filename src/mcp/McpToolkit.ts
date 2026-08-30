import { Effect, Predicate, Schema } from "effect"
import type * as JsonSchema from "effect/JsonSchema"
import { AiError, Tool, Toolkit } from "effect/unstable/ai"

const isObject = Predicate.isObject

type DiscoveredTool = Tool.Dynamic<
  string,
  {
    readonly parameters: Schema.Constraint | JsonSchema.JsonSchema
    readonly success: typeof Schema.Unknown
    readonly failure: typeof Schema.Unknown
    readonly failureMode: "error"
  },
  never
>

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
  ) => Effect.Effect<
    unknown,
    McpTransportError | McpToolError | McpUnsupportedContentError
  >
}

/** A tool as the server describes it. */
export interface RemoteTool {
  readonly name: string
  readonly description?: string | undefined
  /** JSON Schema. Carried for inspection and codegen, not used for binding. */
  readonly inputSchema?: unknown
  /** The server's behavioural hints, when it sent any. See `requiresApproval`. */
  readonly annotations?: RemoteToolAnnotations | undefined
}

/**
 * MCP `ToolAnnotations`, as far as binding cares. The specification calls
 * these hints and says a client must not rely on them for safety; this
 * adapter uses them in the one direction that is safe -- to *tighten*.
 */
export interface RemoteToolAnnotations {
  readonly title?: string | undefined
  readonly readOnlyHint?: boolean | undefined
  readonly destructiveHint?: boolean | undefined
  readonly idempotentHint?: boolean | undefined
  readonly openWorldHint?: boolean | undefined
}

/**
 * Whether a remote tool's hints ask for a person in the loop.
 *
 * MCP's defaults are the conservative ones: `readOnlyHint` is false and
 * `destructiveHint` is true unless the server says otherwise. So a tool that
 * sent hints and did not call itself read-only or non-destructive is a
 * destructive one by the server's own account, and binding it turns that
 * into `needsApproval` so the harness's intrinsic floor applies without the
 * application hand-writing a policy. A tool that sent no hints gets no floor:
 * the server said nothing, and inventing an answer either way is a guess.
 * Hints only ever add a floor; a declared tool's own `needsApproval` is never
 * loosened by them.
 */
export const requiresApproval = (annotations: RemoteToolAnnotations | undefined): boolean =>
  annotations !== undefined &&
  annotations.readOnlyHint !== true &&
  annotations.destructiveHint !== false

/**
 * Raise a declared tool's approval floor when the server's hints ask for it.
 * A tool that already carries `needsApproval` keeps its own, whatever it is.
 */
const withRemoteFloor = <T extends Tool.Any>(tool: T, remote: RemoteTool | undefined): T =>
  tool.needsApproval === undefined && requiresApproval(remote?.annotations)
    ? (tool.setNeedsApproval(true) as T)
    : tool

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
 * The tool ran and reported a failure, as MCP's `isError` result does.
 *
 * Distinct from a transport failure, and the distinction is load-bearing: a
 * tool that refuses is an ordinary outcome the model can react to, while a
 * broken connection is not. Collapsing the two escalates every server-side
 * refusal into a failed run, and the model never gets the chance to try
 * something else.
 *
 * `error` is whatever the server reported. It is decoded against the tool's
 * declared `failure` schema, so a declared failure type reaches the agent as
 * itself.
 */
export class McpToolError extends Schema.TaggedError<McpToolError>()(
  "McpToolError",
  { error: Schema.Unknown }
) {
  override get message() {
    return "MCP tool reported a failure"
  }
}

/**
 * The peer returned content this SDK-neutral adapter does not model yet.
 *
 * Rich protocol values must never be silently discarded or leak as nominal
 * SDK values. Until Harness owns a stable cross-generation representation for
 * them, callers receive this precise failure and can choose a lower-level SDK
 * integration when they need those content blocks.
 */
export class McpUnsupportedContentError extends Schema.TaggedError<McpUnsupportedContentError>()(
  "McpUnsupportedContentError",
  {
    toolName: Schema.String,
    contentTypes: Schema.Array(Schema.String)
  }
) {
  override get message() {
    return (
      `MCP tool ${this.toolName} returned unsupported content: ` +
      (this.contentTypes.length === 0
        ? "(empty)"
        : this.contentTypes.join(", "))
    )
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

/**
 * A tool name this adapter is willing to put in a toolkit.
 *
 * `tools/list` is the server's word for what it offers, and the names go
 * straight into the toolkit the model provider is shown. An empty name, or one
 * carrying a newline, does not fail *that* tool — it fails the whole tool
 * declaration block, so one hostile or buggy server takes down every turn for
 * every other tool in the run. The length bound is the same argument at a
 * different scale.
 *
 * Deliberately permissive about what is *inside* a name: MCP places no
 * restriction there and servers in the wild use dots, slashes and colons.
 * `ToolSource.bindDiscovered` applies this same rule for the same reason;
 * this is the direct MCP door and had been missing it.
 */
const isBindableName = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && !/[\r\n\0]/.test(value) && !/^\s|\s$/.test(value)

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)

/**
 * Bind a server's *discovered* tools, without declaring them.
 *
 * The counterpart to `bind`: where `bind` verifies a server against local
 * `Tool.make` declarations and yields typed tools, this lists whatever the
 * server(s) offer and binds each as a `Tool.dynamic` — parameters `unknown`,
 * validated by the server on call, results passed through as `unknown`. It is
 * how a plugin loader, which has server configs but no compile-time tool types,
 * turns a set of connections into one toolkit.
 *
 * Multiple connections are combined into a single toolkit; on a tool-name
 * collision across servers the first connection to offer the name wins (the
 * loser is dropped). A server-reported failure reaches the agent as the tool's
 * failure; a transport or content problem becomes an `AiError`.
 */
export const bindDiscovered = (
  connections: ReadonlyArray<Connection>
): Effect.Effect<
  Toolkit.WithHandler<Record<string, DiscoveredTool>>,
  McpTransportError
> =>
  Effect.gen(function* () {
    const listings = yield* Effect.forEach(connections, (connection) =>
      Effect.map(connection.listTools, (tools) => tools.map((tool) => ({ tool, connection }))))

    const seen = new Set<string>()
    const dropped: Array<string> = []
    const unique = listings.flat().filter(({ tool }) => {
      // Dropped, not raised: a server offering one unusable name alongside
      // twenty good ones should cost the caller that one tool, which is the
      // same rule a name collision already follows. See `isBindableName`.
      if (!isBindableName(tool.name)) {
        dropped.push(JSON.stringify(tool.name))
        return false
      }
      if (seen.has(tool.name)) return false
      seen.add(tool.name)
      return true
    })
    // Dropped, but never silently: the operator reads the log, the model
    // never sees the name.
    if (dropped.length > 0) {
      yield* Effect.logWarning(`McpToolkit.bindDiscovered dropped ${dropped.length} tool(s) with unusable names: ${dropped.join(", ")}`)
    }

    const tools: Array<DiscoveredTool> = unique.map(({ tool }) => {
      const parameters: Schema.Constraint | JsonSchema.JsonSchema =
        isObject(tool.inputSchema)
          ? tool.inputSchema as JsonSchema.JsonSchema
          : Schema.Unknown
      return Tool.dynamic(tool.name, {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        // `inputSchema` is the server's JSON Schema; `unknown` structurally, but
        // that is exactly what `Tool.dynamic`'s JSON-Schema mode consumes.
        parameters,
        // Unknown, so a server-reported failure can surface as the tool's failure.
        failure: Schema.Unknown,
        // The server's own hints, as a floor. See `requiresApproval`.
        ...(requiresApproval(tool.annotations) ? { needsApproval: true } : {})
      })
    })

    const built = Toolkit.make(...tools)

    const handlers = Object.fromEntries(
      unique.map(({ connection, tool }) => [
        tool.name,
        (params: unknown) =>
          connection.callTool(tool.name, params).pipe(
            Effect.catch((error) =>
              error._tag === "McpToolError"
                ? Effect.fail(error.error)
                : Effect.fail(new AiError.InternalProviderError({ description: error.message }))
            )
          )
      ])
    )

    return (yield* built.pipe(
      Effect.provide(built.toLayer(handlers as Toolkit.HandlersFrom<Record<string, DiscoveredTool>>))
    )) as Toolkit.WithHandler<Record<string, DiscoveredTool>>
  })

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

    // The server's hints raise a declared tool's floor and never lower it.
    const byName = new Map(offered.map((tool) => [tool.name, tool] as const))
    // `map` widens the tuple; each element keeps its own type, so the tuple does too.
    const floored = tools.map((tool) => withRemoteFloor(tool, byName.get(tool.name))) as unknown as Tools
    const built = Toolkit.make(...floored)

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

            const result = yield* connection.callTool(tool.name, encoded).pipe(
              Effect.catch((error) =>
                error._tag === "McpTransportError"
                  ? Effect.fail(
                      new AiError.InternalProviderError({
                        description:
                          "MCP tool " + tool.name + ": " + error.detail
                      })
                    )
                  : error._tag === "McpUnsupportedContentError"
                    ? Effect.fail(
                        new AiError.InvalidOutputError({
                          description: error.message
                        })
                      )
                  : // A reported tool failure, decoded as the declared type so
                    // it reaches the agent as itself -- and so the run's
                    // `FailurePolicy` applies to it. Under the default,
                    // `ReturnToModel`, that means the model sees the refusal
                    // and can try something else, which is the whole point of
                    // a tool being allowed to fail.
                    Schema.decodeUnknownEffect(tool.failureSchema)(
                      error.error
                    ).pipe(
                      Effect.matchEffect({
                        // A server reporting an error for a tool declared
                        // infallible is a genuine mismatch, and saying so is
                        // more useful than inventing a failure value.
                        onFailure: () =>
                          Effect.fail(
                            new AiError.InvalidOutputError({
                              description:
                                "MCP tool " +
                                tool.name +
                                ": reported a failure that did not match the " +
                                "declared failure schema: " +
                                describe(error.error)
                            })
                          ),
                        onSuccess: (failure) => Effect.fail(failure)
                      })
                    )
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
