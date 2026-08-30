import { Effect, Predicate, Schema } from "effect"
import type * as JsonSchema from "effect/JsonSchema"
import { AiError, Tool, Toolkit } from "effect/unstable/ai"
import * as McpToolkit from "../mcp/McpToolkit.js"
import * as Permission from "../Permission.js"

/**
 * One tool as a source describes it — the dual-schema shape from
 * `research-tool-sources.md` §4.
 *
 * Tier 1 (declared) callers provide their own `Tool.make` with a Schema;
 * the source verifies at `extract` that the name is offered. Tier 3
 * (discovered) callers take whatever the source offers as `Tool.dynamic`
 * with the source's raw JSON Schema and `unknown` result.
 *
 * `input` is either an Effect Schema (tier 1) or a JSON Schema (tier 3).
 * The extractor populates whichever it has; `bind` ignores it for tier 1
 * and `bindDiscovered` consumes it for tier 3.
 */
export interface Descriptor {
  readonly name: string
  readonly description?: string | undefined
  readonly input?: Schema.Schema<unknown> | JsonSchema.JsonSchema | undefined
  readonly output?: Schema.Schema<unknown> | JsonSchema.JsonSchema | undefined
  readonly annotations?: ToolAnnotations | undefined
  /** Source-specific data for `invoke` — e.g. HTTP method/path/param locations for OpenAPI. */
  readonly meta?: unknown | undefined
}

export interface ToolAnnotations {
  /**
   * The source says a person should be in the loop. Binding turns this into
   * the tool's `needsApproval`, so the harness's intrinsic approval floor
   * applies; it never loosens a declared tool that already carries one.
   */
  readonly requiresApproval?: boolean | undefined
}

/** Raise a declared tool's floor when the source asks for it; never lower it. */
const withSourceFloor = <T extends Tool.Any>(tool: T, descriptor: Descriptor | undefined): T =>
  tool.needsApproval === undefined && descriptor?.annotations?.requiresApproval === true
    ? (tool.setNeedsApproval(true) as T)
    : tool

export interface Skipped {
  readonly name: string
  readonly reason: string
}

export interface Extraction {
  readonly tools: ReadonlyArray<Descriptor>
  readonly skipped: ReadonlyArray<Skipped>
}

/** Extraction failed — the source could not be reached at connect/refresh time. */
export class ExtractionError extends Schema.TaggedError<ExtractionError>()(
  "ToolSourceExtractionError",
  { sourceId: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `Tool source ${this.sourceId} extraction failed: ${this.detail}`
  }
}

/** The source does not offer a tool that was declared. */
export class ToolSourceMissingError extends Schema.TaggedError<ToolSourceMissingError>()(
  "ToolSourceMissingError",
  { sourceId: Schema.String, missing: Schema.Array(Schema.String), offered: Schema.Array(Schema.String) }
) {
  override get message() {
    return `Tool source ${this.sourceId} does not offer: ${this.missing.join(", ")}. It offers: ${this.offered.length === 0 ? "(nothing)" : this.offered.join(", ")}`
  }
}

/** Transport failure invoking a tool — distinct from the tool's own failure. */
export class InvocationError extends Schema.TaggedError<InvocationError>()(
  "ToolSourceInvocationError",
  { sourceId: Schema.String, toolName: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `Tool ${this.toolName} on source ${this.sourceId} transport failed: ${this.detail}`
  }
}

/** Tool reported a failure (its own `isError` result). */
export class ToolError extends Schema.TaggedError<ToolError>()(
  "ToolSourceToolError",
  { sourceId: Schema.String, toolName: Schema.String, error: Schema.Unknown }
) {
  override get message() {
    return `Tool ${this.toolName} on source ${this.sourceId} reported a failure`
  }
}

export type SourceError = ExtractionError | InvocationError | ToolError

/**
 * A source of tools — the seam `research-tool-sources.md` §6.1 describes.
 *
 * One implementation per origin (OpenAPI operation, GraphQL field, MCP server,
 * WebMCP page, CLI subcommand). Extraction is eager (at connect/refresh) and
 * returns a value the application can cache; `invoke` is per call, host-side.
 *
 * `extract` is an `Effect` the application runs when it wires the source, not
 * a hidden cost inside the first tool call — failures land where a human can
 * see them. `skipped` carries operations deliberately not represented, each
 * with a precise reason, rather than becoming broken tools.
 */
export interface ToolSource {
  readonly id: string
  readonly extract: Effect.Effect<Extraction, ExtractionError>
  readonly invoke: (
    name: string,
    args: unknown
  ) => Effect.Effect<unknown, InvocationError | ToolError>
}

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
 * How much of a foreign error's text reaches a `detail` field.
 *
 * A schema validation failure over a large payload renders to kilobytes, and
 * this string ends up in an error a model may be shown and a log will keep. The
 * cap is on the *description*, never on the value: `ToolError.error` carries
 * the source's failure whole for any caller that wants it.
 *
 * Marked in the output rather than trimmed quietly, so a reader can tell a
 * truncated message from a short one.
 */
const MAX_DESCRIBED_ERROR_CHARS = 500

const describe = (error: unknown): string => {
  const raw =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error)
  return raw.length > MAX_DESCRIBED_ERROR_CHARS
    ? `${raw.slice(0, MAX_DESCRIBED_ERROR_CHARS)}... (truncated)`
    : raw
}

const isValidName = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && !/[\r\n\0]/.test(value) && !/^\s|\s$/.test(value)

const assertValidName = (where: string, value: string): void => {
  if (!isValidName(value)) {
    throw new Error(`${where}: name must be a non-empty single-line string 1-128 chars, got ${JSON.stringify(value)}`)
  }
}

/**
 * Bind declared tools to a source — tier 1, fully typed.
 *
 * Verifies at `extract` that the source offers every declared name; missing
 * is `ToolSourceMissingError` with `missing` and `offered`, not a first-call
 * surprise. Parameters are encoded via the declared `parametersSchema` and
 * results decoded via `success`/`failure` schemas, so a source returning the
 * wrong shape fails typed at the boundary.
 */
export const bind = <const Tools extends ReadonlyArray<Tool.Any>>(
  source: ToolSource,
  tools: Tools
): Effect.Effect<
  Toolkit.WithHandler<Toolkit.ToolsByName<Tools>>,
  ExtractionError | ToolSourceMissingError
> =>
  Effect.gen(function* () {
    assertValidName("ToolSource.bind source.id", source.id)
    for (const tool of tools) assertValidName("ToolSource.bind tool.name", tool.name)
    const extraction = yield* source.extract
    // Remote tool names are untrusted: an MCP server may offer a name with a
    // newline or 200 characters. `assertValidName` throws a plain `Error` which
    // becomes a defect inside `Effect.gen`; a malformed remote name must never
    // crash the fiber. Treat invalid remote names as not offered (as if
    // `skipped`) so the `missing` check is still typed and the fiber stays
    // typed.
    const validExtractionTools = extraction.tools.filter((tool) => isValidName(tool.name))
    const offered = new Set(validExtractionTools.map((tool) => tool.name))
    const missing = tools.map((tool) => tool.name).filter((name) => !offered.has(name))
    if (missing.length > 0) {
      return yield* new ToolSourceMissingError({
        sourceId: source.id,
        missing,
        offered: [...offered]
      })
    }

    const byName = new Map(validExtractionTools.map((tool) => [tool.name, tool] as const))
    // `map` widens the tuple; each element keeps its own type, so the tuple does too.
    const floored = tools.map((tool) => withSourceFloor(tool, byName.get(tool.name))) as unknown as Tools
    const built = Toolkit.make(...floored)

    const handlers = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        (params: unknown) =>
          Effect.gen(function* () {
            const encoded = yield* Schema.encodeEffect(tool.parametersSchema)(params).pipe(
              Effect.mapError(
                (error) =>
                  new AiError.InvalidRequestError({
                    description: `Tool ${tool.name} on source ${source.id}: parameters did not match declared schema: ${describe(error)}`
                  })
              )
            )

            const result = yield* source.invoke(tool.name, encoded).pipe(
              Effect.catch((error) => {
                if (error._tag === "ToolSourceInvocationError") {
                  return Effect.fail(
                    new AiError.InternalProviderError({ description: error.message })
                  )
                }
                if (error._tag === "ToolSourceToolError") {
                  return Schema.decodeUnknownEffect(tool.failureSchema)(error.error).pipe(
                    Effect.matchEffect({
                      onFailure: () =>
                        Effect.fail(
                          new AiError.InvalidOutputError({
                            description: `Tool ${tool.name} on source ${source.id}: reported failure did not match declared failure schema: ${describe(error.error)}`
                          })
                        ),
                      onSuccess: (failure) => Effect.fail(failure)
                    })
                  )
                }
                return Effect.fail(
                  new AiError.InternalProviderError({ description: describe(error) })
                )
              })
            )

            return yield* Schema.decodeUnknownEffect(tool.successSchema)(result).pipe(
              Effect.mapError(
                (error) =>
                  new AiError.InvalidOutputError({
                    description: `Tool ${tool.name} on source ${source.id}: result did not match declared schema: ${describe(error)}`
                  })
              )
            )
          })
      ])
    )

    return (yield* built.pipe(
      Effect.provide(built.toLayer(handlers as Toolkit.HandlersFrom<Toolkit.ToolsByName<Tools>>))
    )) as Toolkit.WithHandler<Toolkit.ToolsByName<Tools>>
  })

/**
 * Bind whatever a source offers, without declaring — tier 3, `unknown`.
 *
 * Each descriptor becomes a `Tool.dynamic` with the source's raw JSON Schema
 * (or Schema) as `parameters` and `unknown` result. A source-reported failure
 * surfaces as the tool's failure (so `FailurePolicy.ReturnToModel` lets the
 * model try again); transport/content problems become `AiError`.
 *
 * Multiple descriptors with one name: first wins, later dropped — the same
 * rule `McpToolkit.bindDiscovered` uses for multiple connections.
 */
export const bindDiscovered = (
  source: ToolSource
): Effect.Effect<
  Toolkit.WithHandler<Record<string, DiscoveredTool>>,
  ExtractionError
> =>
  Effect.gen(function* () {
    assertValidName("ToolSource.bindDiscovered source.id", source.id)
    const extraction = yield* source.extract
    // Remote names are untrusted input — see `bind` above. A malformed remote
    // tool name must become `skipped` with a reason or a typed `ExtractionError`,
    // never a defect. Filter invalid tools to `skipped`-like handling so the
    // fiber stays typed and the toolkit is built only from valid names.
    const validToolsRaw: Array<Descriptor> = []
    const dropped: Array<string> = []
    for (const tool of extraction.tools) {
      if (isValidName(tool.name)) {
        validToolsRaw.push(tool)
      } else {
        // The toolkit will not contain it, which is the `skipped` semantics;
        // the name reaches the log for the operator, never the model.
        dropped.push(JSON.stringify(tool.name))
      }
    }
    if (dropped.length > 0) {
      yield* Effect.logWarning(`ToolSource.bindDiscovered(${source.id}) dropped ${dropped.length} tool(s) with unusable names: ${dropped.join(", ")}`)
    }
    // What the source deliberately left out is worth a line too: a plugin
    // loader has no other place to learn that half an API was skipped.
    if (extraction.skipped.length > 0) {
      yield* Effect.logDebug(`ToolSource.bindDiscovered(${source.id}) skipped ${extraction.skipped.length} operation(s): ${extraction.skipped.map((entry) => `${JSON.stringify(entry.name)} (${entry.reason})`).join("; ")}`)
    }

    const seen = new Set<string>()
    const unique = validToolsRaw.filter((tool) => {
      if (seen.has(tool.name)) return false
      seen.add(tool.name)
      return true
    })

    const tools: Array<DiscoveredTool> = unique.map((descriptor) => {
      const parameters: Schema.Constraint | JsonSchema.JsonSchema =
        descriptor.input ?? Schema.Unknown
      // Discovered tools carry no output contract; failure is `unknown` so any
      // source-reported failure can surface.
      const asksApproval = descriptor.annotations?.requiresApproval === true
      const dynamic = Tool.dynamic(descriptor.name, {
        ...(descriptor.description === undefined
          ? {}
          : { description: descriptor.description }),
        parameters,
        failure: Schema.Unknown,
        // The source's hint as the tool's own requirement: this is what the
        // harness's intrinsic floor reads. The projection below only names
        // the call for policy; it never asked anything by itself.
        ...(asksApproval ? { needsApproval: true } : {})
      })
      if (asksApproval) {
        // `Permission.annotate` keeps the tool's exact type; the dynamic tool is
        // already `unknown` parameters, so the annotation is structural.
        return Permission.annotate(dynamic, {
          action: descriptor.name,
          resource: () => descriptor.name
        })
      }
      return dynamic
    })

    if (tools.length === 0) {
      const built = Toolkit.make()
      return (yield* built.pipe(Effect.provide(built.toLayer({})))) as Toolkit.WithHandler<Record<string, DiscoveredTool>>
    }

    const built = Toolkit.make(...tools)

    const handlers = Object.fromEntries(
      unique.map((descriptor) => [
        descriptor.name,
        (params: unknown) =>
          source.invoke(descriptor.name, params).pipe(
            Effect.catch((error) => {
              if (error._tag === "ToolSourceToolError") return Effect.fail(error.error)
              if (error._tag === "ToolSourceInvocationError")
                return Effect.fail(new AiError.InternalProviderError({ description: error.message }))
              return Effect.fail(new AiError.InternalProviderError({ description: describe(error) }))
            })
          )
      ])
    )

    return (yield* built.pipe(
      Effect.provide(built.toLayer(handlers as Toolkit.HandlersFrom<Record<string, DiscoveredTool>>))
    )) as Toolkit.WithHandler<Record<string, DiscoveredTool>>
  })

/**
 * Adapt an existing `McpToolkit.Connection` to the `ToolSource` seam.
 *
 * Keeps `McpToolkit.bind`/`bindDiscovered` as the typed doors for MCP;
 * this is the bridge for a mixed catalog (some MCP, some OpenAPI, some
 * local) that should be one uniform thing to the agent and to code mode.
 */
const isJsonSchema = (value: unknown): value is JsonSchema.JsonSchema => Predicate.isObject(value)

export const fromMcpConnection = (
  id: string,
  connection: McpToolkit.Connection
): ToolSource => ({
  id,
  extract: Effect.mapError(connection.listTools, (error) => new ExtractionError({ sourceId: id, detail: describe(error) })).pipe(
    Effect.map((tools) => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input: isJsonSchema(tool.inputSchema) ? tool.inputSchema : undefined,
        ...(McpToolkit.requiresApproval(tool.annotations) ? { annotations: { requiresApproval: true } } : {})
      })),
      skipped: []
    }))
  ),
  invoke: (name, args) =>
    connection.callTool(name, args).pipe(
      Effect.mapError((error) => {
        if (error instanceof McpToolkit.McpTransportError) {
          return new InvocationError({ sourceId: id, toolName: name, detail: String(error.detail ?? describe(error)) })
        }
        if (error instanceof McpToolkit.McpToolError) {
          return new ToolError({ sourceId: id, toolName: name, error: error.error })
        }
        if (error instanceof McpToolkit.McpUnsupportedContentError) {
          return new InvocationError({ sourceId: id, toolName: name, detail: error.message })
        }
        return new InvocationError({ sourceId: id, toolName: name, detail: describe(error) })
      })
    )
})
