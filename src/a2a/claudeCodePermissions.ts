import { Context, Effect, Layer, Option, Schema } from "effect"
import { McpSchema, McpServer, Tool } from "effect/unstable/ai"
import * as Elicitation from "../Elicitation.js"
import * as Permission from "../Permission.js"
import * as DelegatedPermission from "./internal/delegatedPermission.js"
import * as Namespace from "../internal/namespace.js"

/**
 * The bridged CLI's permission prompts, answered by *this* application's
 * policy.
 *
 * `docs/plan-a2a-layers-bridges.txt` step 2, and the boundary
 * `ClaudeCodeA2A` deliberately left open. Claude Code decides for itself what
 * it may do -- from its own flags and settings -- unless it is given
 * `--permission-prompt-tool`, which routes every prompt it would have shown a
 * human to an MCP tool instead. That tool is this module, and behind it sit
 * `Permission.Policy` and `Elicitation`: the same policy that governs this
 * agent's own tools, and the same question mechanism a person already answers.
 *
 * **One policy, two runtimes** is the point, and it is not a slogan: the
 * default projection maps the CLI's tools onto the same `action` vocabulary
 * `/coding` annotates its own with -- `shell` on the command, `read` and
 * `write` on the path -- so a rule written as "ask before `write` outside
 * `src/`" governs a delegated Claude Code run and a local `CodingToolkit` run
 * identically, without knowing that either exists.
 *
 * ```ts
 * // 1. Serve the decision. One tool, on your own HTTP router.
 * const Permissions = ClaudeCodePermissions.layer({ policy, elicitor })
 *
 * // 2. Point the CLI at it.
 * const claude = yield* ClaudeCodeA2A.remote(sandbox, {
 *   extraArgs: ClaudeCodePermissions.args({ url: "http://127.0.0.1:4599/permission" })
 * })
 * ```
 *
 * **Fail closed.** With no elicitor, an `Ask` is a denial -- the same default
 * `Elicitation.denied` gives the harness, for the same reason: a question
 * nobody can answer must not become a yes. A policy error cannot happen
 * (`evaluate` cannot fail) but a malformed request can, and it denies too.
 *
 * **The endpoint is an authority.** Anything that can reach it can be asked to
 * approve a tool call, and a decision it returns is one the CLI will act on.
 * Bind it to loopback, and do not put it on a router that is exposed.
 */

// ---------------------------------------------------------------------------
// The CLI's side of the contract

/**
 * What the CLI sends the permission tool.
 *
 * Every field is optional and both spellings are accepted, which is deliberate:
 * a name mismatch here would not fail one call, it would fail *every* call, and
 * the payload's exact casing is the one part of this contract that is not
 * nailed down in public documentation. A request that carries no tool name at
 * all is refused by the handler rather than by the decoder, so the CLI gets a
 * usable `deny` message instead of a schema error.
 */
const PromptInput = Schema.Struct({
  tool_name: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  tool_input: Schema.optional(Schema.Unknown),
  tool_use_id: Schema.optional(Schema.String),
  toolUseId: Schema.optional(Schema.String)
})

/**
 * What the CLI expects back, as one JSON object.
 *
 * `updatedInput` is echoed on every allow, never omitted: before v2.1.207 the
 * CLI rejected an allow that left it out, and an allow that is silently read as
 * a validation failure is the worst of both answers. The bridge does not modify
 * the input -- rewriting a delegated agent's tool arguments is a facility this
 * module deliberately does not offer, because a policy that quietly edits what
 * it approves is one nobody can audit.
 */
const PromptResult = Schema.Struct({
  behavior: Schema.Literals(["allow", "deny"]),
  updatedInput: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String)
})

export type PromptResult = typeof PromptResult.Type

// ---------------------------------------------------------------------------
// Projection: the CLI's tools in this application's vocabulary

/** What a tool call *is*, for policy purposes. */
export type Projected = DelegatedPermission.Projected

const field = (input: unknown, name: string): Option.Option<string> => {
  if (typeof input !== "object" || input === null) return Option.none()
  const value = (input as Record<string, unknown>)[name]
  return typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none()
}

const first = (
  input: unknown,
  names: ReadonlyArray<string>
): Option.Option<string> => {
  for (const name of names) {
    const found = field(input, name)
    if (Option.isSome(found)) return found
  }
  return Option.none()
}

/**
 * Claude Code's built-in tools, in `/coding`'s vocabulary.
 *
 * This is the whole "one policy, two runtimes" claim, and it is one table. A
 * tool this does not know becomes `action: "tool"` on its own name, which is
 * what `Permission.defaultProjection` does for an unannotated tool of ours --
 * so a policy can always be written, and an unrecognised tool is *visible* to
 * it rather than silently uncategorised.
 *
 * MCP tools the CLI itself loaded arrive as `mcp__server__tool`; they keep that
 * name, because a rule about someone else's server should have to say so.
 */
export const defaultProjection = (toolName: string, input: unknown): Projected => {
  switch (toolName) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return {
        action: "shell",
        resource: Option.getOrElse(first(input, ["command", "shell_id"]), () => toolName)
      }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        action: "write",
        resource: Option.getOrElse(first(input, ["file_path", "notebook_path", "path"]), () => toolName)
      }
    case "Read":
    case "NotebookRead":
    case "Glob":
    case "Grep":
    case "LS":
      return {
        action: "read",
        resource: Option.getOrElse(
          first(input, ["file_path", "notebook_path", "path", "pattern"]),
          () => "."
        )
      }
    case "WebFetch":
    case "WebSearch":
      return {
        action: "fetch",
        resource: Option.getOrElse(first(input, ["url", "query"]), () => toolName)
      }
    default:
      return { action: "tool", resource: toolName }
  }
}

// ---------------------------------------------------------------------------
// The decision

export interface Options<R = never> {
  /**
   * The policy consulted for every prompt.
   *
   * The same value an `Agent` carries, if you want one rule set for both.
   */
  readonly policy: Permission.Policy<R>
  /**
   * Where an `Ask` becomes a question.
   *
   * Omitted, an `Ask` is a denial. That is `Elicitation.denied`'s behaviour and
   * the harness's own default: a caller opts *in* to being asked, because a
   * question nobody is listening for would otherwise hang a delegated run
   * forever or, worse, be assumed answered.
   */
  readonly elicitor?: Elicitation.Elicitor | undefined
  /**
   * The session id carried on the `Permission.Request`, for a policy that keeps
   * per-session grants. Defaults to the tool's own name, which is stable and
   * says plainly that these decisions did not come from one of our sessions.
   */
  readonly sessionId?: string | undefined
  /** Override how a CLI tool call maps onto `action` / `resource`. */
  readonly projection?: ((toolName: string, input: unknown) => Projected) | undefined
  /**
   * The MCP server's name, which the CLI uses to build the tool's full name.
   *
   * The *tool's* name is fixed at `approve`, deliberately: the flag and the
   * served tool have to agree, and two settings that must match are a way for
   * them not to. The CLI does not fail loudly when they disagree either -- it
   * waits for a tool that never answers and reports a timeout.
   */
  readonly serverName?: string | undefined
}

/**
 * Distinguishes two otherwise identical prompts that arrive together.
 *
 * The CLI's `tool_use_id` already does this when it sends one. When it does
 * not, the fallback id is derived from the tool and its resource -- and two
 * concurrent calls to `Bash("npm test")` would then share an elicitation id,
 * so one answer would resolve one question and leave the other waiting
 * forever. A counter costs nothing and removes the case.
 */
let nextPrompt = 0

const DEFAULT_SERVER = Namespace.table("permissions")
const DEFAULT_TOOL = "approve"

/**
 * The full MCP tool name the CLI is pointed at: `mcp__<server>__<tool>`.
 *
 * Derived rather than written twice: the flag and the served tool disagreeing
 * would mean the CLI waits for a tool that never answers, and blames a timeout.
 */
export const toolReference = (options?: {
  readonly serverName?: string | undefined
}): string => `mcp__${options?.serverName ?? DEFAULT_SERVER}__${DEFAULT_TOOL}`

/**
 * The flags that point a `claude -p` run at this decision endpoint.
 *
 * `--strict-mcp-config` is included by default and matters more than it looks:
 * without it the CLI also loads whatever MCP servers the host or the workspace
 * happen to configure, so a delegated run's tool surface would depend on the
 * machine. A bridge whose authority varies by host is not one you can reason
 * about.
 */
export const args = (options: {
  /** Where the MCP server is reachable. Loopback, please. */
  readonly url: string
  readonly serverName?: string | undefined
  /**
   * Headers the CLI sends with every call, for authenticating the endpoint.
   *
   * A per-run bearer token belongs here. **Sending it is all this can do** --
   * the router is the caller's, so checking it is the caller's too, and a
   * token that nothing verifies is decoration. It is offered because the
   * alternative is a caller hand-writing the `--mcp-config` JSON to add one,
   * which is how the flag and the served tool come to disagree.
   *
   * The value reaches the CLI as a process argument, so it is visible to
   * anything that can list this machine's processes. Mint it per run, keep it
   * short-lived, and do not reuse a credential that means anything elsewhere.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** Set `false` to let the host's own MCP configuration load as well. */
  readonly strict?: boolean | undefined
}): ReadonlyArray<string> => [
  "--mcp-config",
  JSON.stringify({
    mcpServers: {
      [options.serverName ?? DEFAULT_SERVER]: {
        type: "http",
        url: options.url,
        ...(options.headers === undefined ? {} : { headers: options.headers })
      }
    }
  }),
  ...(options.strict === false ? [] : ["--strict-mcp-config"]),
  "--permission-prompt-tool",
  toolReference(options)
]

/**
 * One prompt, decided.
 *
 * Exported because it is the whole of the behaviour and needs no server to
 * test: hand it a tool name and an input, get back exactly what the CLI will
 * be told. The MCP tool below is this function with a schema on each side.
 */
/**
 * One prompt, decided.
 *
 * Exported because it is the whole of the behaviour and needs no server to
 * test: hand it a tool name and an input, get back exactly what the CLI will
 * be told. The MCP tool below is this function with a schema on each side.
 *
 * The decision itself is shared with the other bridges
 * (`internal/delegatedPermission.ts`); what is here is the CLI's spelling of
 * the answer. `remember` has no spelling in this protocol -- the prompt tool
 * can echo `updatedPermissions` back, which would write rules into the
 * *workspace's* settings, and a bridge silently editing the delegated repo is
 * not something to do on a policy's behalf. So "allow always" reaches our
 * policy and not the CLI, and the CLI asks again.
 */
export const decide = <R = never>(
  options: Options<R>
) =>
(request: {
  readonly toolName: Option.Option<string>
  readonly input: unknown
  readonly toolUseId: Option.Option<string>
}): Effect.Effect<PromptResult, never, R> =>
  Effect.gen(function* () {
    if (Option.isNone(request.toolName)) {
      return {
        behavior: "deny" as const,
        message: "the permission request named no tool, so nothing could be decided"
      }
    }
    const toolName = request.toolName.value
    const project = options.projection ?? defaultProjection
    const projected = project(toolName, request.input)
    const verdict = yield* DelegatedPermission.decide(options)({
      callId: Option.getOrElse(
        request.toolUseId,
        () => `${toolName}:${projected.resource}:${nextPrompt++}`
      ),
      toolName,
      params: request.input,
      projected,
      origin: toolReference(options)
    })
    return verdict.allow
      ? { behavior: "allow" as const, updatedInput: request.input ?? {} }
      : { behavior: "deny" as const, message: verdict.reason ?? "denied" }
  })

// ---------------------------------------------------------------------------
// Served as an MCP tool

/**
 * The tool as it is published to the CLI.
 *
 * Exported so a caller can serve it on a server of their own -- and so the wire
 * contract is testable directly: what the CLI sends decodes through
 * `parametersSchema`, and what it must read back encodes through
 * `successSchema` as a JSON *object*, which is what puts
 * `{"behavior":"allow",...}` in the tool result's text rather than a quoted
 * string the CLI would fail to parse.
 */
export const tool = Tool.make(DEFAULT_TOOL, {
  description:
    "Decide whether the requesting agent may make this tool call. Returns " +
    "{\"behavior\":\"allow\",\"updatedInput\":...} or {\"behavior\":\"deny\",\"message\":...}.",
  parameters: PromptInput,
  success: PromptResult,
  failure: Schema.Never
})

const handlerFor = <R>(options: Options<R>, services: Context.Context<R>) =>
(input: typeof PromptInput.Type) =>
  decide(options)({
    toolName: Option.orElse(
      Option.fromUndefinedOr(input.tool_name),
      () => Option.fromUndefinedOr(input.toolName)
    ),
    input: input.input ?? input.tool_input ?? {},
    toolUseId: Option.orElse(
      Option.fromUndefinedOr(input.tool_use_id),
      () => Option.fromUndefinedOr(input.toolUseId)
    )
  }).pipe(Effect.provideContext(services))

/**
 * Registered by hand, not through `McpServer.registerToolkit`.
 *
 * The toolkit registration sets `structuredContent` on the result whenever the
 * success value is an object, and declares an `outputSchema` to match. Claude
 * Code refuses such a result outright:
 *
 * > Permission prompt tool returned an invalid result. Expected a single text
 * > block param with type="text" and a string text value.
 *
 * It wants exactly one text block and nothing else -- the extra fields are not
 * ignored, they are the failure. Observed against the real CLI (2.1.252) on
 * 2026-09-01, and the run was *blocked* by that error rather than by the
 * policy's decision, which is the worst way for this to be wrong: it looks like
 * the gate working.
 *
 * So the result is built here, where its shape is the point. This mirrors
 * `AgentMcp.registerInteractive`, which exists for a neighbouring reason.
 */
const register = <R>(options: Options<R>, services: Context.Context<R>) =>
  Effect.gen(function*() {
    const server = yield* McpServer.McpServer
    const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJsonSchema)(
      Tool.getJsonSchema(tool)
    ).pipe(Effect.orDie)
    const decode = Schema.decodeUnknownEffect(PromptInput)
    const answer = handlerFor(options, services)

    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema
        // No `outputSchema`, deliberately: declaring one is what makes the
        // runtime attach `structuredContent`, which is what the CLI refuses.
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        decode(payload ?? {}).pipe(
          // A request this cannot even decode is still a decision to make, and
          // the only safe one. Failing the tool call would leave the CLI
          // reporting a broken permission layer -- true, but it would look
          // exactly like a refusal, and nobody could tell them apart.
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed(
                deniedResult(`the permission request could not be read: ${error.message}`)
              ),
            onSuccess: (input) =>
              Effect.map(answer(input), (result) =>
                new McpSchema.CallToolResult({
                  isError: false,
                  content: [{ type: "text", text: JSON.stringify(result) }]
                }))
          })
        )
    })
  })

const deniedResult = (message: string) =>
  new McpSchema.CallToolResult({
    isError: false,
    content: [{
      type: "text",
      text: JSON.stringify({ behavior: "deny", message } satisfies PromptResult)
    }]
  })

/**
 * Register the permission tool on the ambient `McpServer`.
 *
 * Pair with `McpServer.layerHttp` and a loopback router; `args` produces the
 * flags that point the CLI at it. One tool is served, named `approve`, and
 * nothing else -- this endpoint is an authority, and it should be able to do
 * exactly one thing.
 */
export const layer = <R = never>(
  options: Options<R>
): Layer.Layer<never, never, McpServer.McpServer | R> =>
  Layer.effectDiscard(
    Effect.flatMap(Effect.context<R>(), (services) => register(options, services))
  )
