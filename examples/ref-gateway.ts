/**
 * Reference integration gateway — `plan-primitives.md` §4.
 *
 * The acceptance test for the integration axis (§7 step 3): if the
 * sources, the three credential layers, principals and per-tool policy
 * compose for a real caller, it looks like this. Built **only** from the
 * public surface (`affe-agent/*`), no casts, miniature not a
 * fork, and it runs — deterministically, on a fake fetch and a scripted
 * model, so CI can execute it rather than merely compile it.
 *
 * What it exercises, in the order the plan lists them:
 *
 * - **sources** — an OpenAPI document becomes tools, tier 1 (declared, so
 *   parameters and results are typed at the boundary);
 * - **auth** — method / binding / provider kept apart, the credential
 *   resolved per invocation and reaching the wire but never the model;
 * - **principals** — the host projects each caller to a subject, and the
 *   binding is chosen per subject per call;
 * - **per-tool policy** — the same `Permission` decision a direct call
 *   gets, keyed on what the tool does;
 * - **an MCP surface** — the same host, exposed to any MCP client.
 *
 * Run: `npx tsx examples/ref-gateway.ts`
 */

import { Console, Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpServer } from "effect/unstable/ai"

// Public surface only — the same import paths a user gets. If this file
// needs a private import, that is a missing primitive and belongs in
// STATUS.md (plan-primitives.md §4 rule 4).
import { Agent, AgentLoop, Permission, Principal, ToolExecution } from "affe-agent"
import { AgentProtocol, AgentSessionHost } from "affe-agent/client"
import { Presets } from "affe-agent/presets"
import { AgentMcp } from "affe-agent/mcp"
import { TestLanguageModel } from "affe-agent/testing"
import { Credentials, OpenApi, ToolSource } from "affe-agent/tool-source"
import { Prompt, Tool } from "effect/unstable/ai"

// ---------------------------------------------------------------------------
// The upstream: one small OpenAPI document, two operations of different risk
// ---------------------------------------------------------------------------

const spec = {
  openapi: "3.0.0",
  paths: {
    "/issues": {
      get: {
        operationId: "list_issues",
        summary: "List issues",
        parameters: [{ name: "state", in: "query", schema: { type: "string" } }],
        responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } }
      },
      post: {
        operationId: "create_issue",
        summary: "Open an issue",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"]
              }
            }
          }
        },
        responses: { "201": { content: { "application/json": { schema: { type: "object" } } } } }
      }
    }
  }
}

/**
 * Declared tools, so this is tier 1: `bind` checks at extraction that the
 * source offers every name, encodes parameters through these schemas and
 * decodes results through them. A source that drifts fails typed at the
 * boundary rather than on some later call.
 */
const ListIssues = Tool.make("list_issues", {
  description: "List issues",
  parameters: Schema.Struct({ state: Schema.optional(Schema.String) }),
  success: Schema.Unknown
})

const CreateIssue = Tool.make("create_issue", {
  description: "Open an issue",
  parameters: Schema.Struct({ title: Schema.String }),
  success: Schema.Unknown
})

// ---------------------------------------------------------------------------
// Auth: three layers, kept apart. Nothing here holds a secret.
// ---------------------------------------------------------------------------

/** The org's connection: everyone falls back to it. */
const orgBinding = Credentials.binding({
  integration: "tracker",
  method: Credentials.bearer(),
  values: { token: "tracker/org" }
})

/** Alice connected her own account; hers wins for her, and only for her. */
const aliceBinding = Credentials.binding({
  integration: "tracker",
  method: Credentials.bearer(),
  owner: "user",
  values: { token: "tracker/alice" }
})

const credentials = Layer.mergeAll(
  // Handles, never values, live in bindings; the provider is the only
  // thing that ever holds a secret, and only as `Redacted`.
  Credentials.fromValues({
    "tracker/org": "org-secret",
    "tracker/alice": "alice-secret"
  }),
  Credentials.bindings([
    { binding: orgBinding },
    { binding: aliceBinding, subject: "alice" }
  ])
)

// ---------------------------------------------------------------------------
// Per-tool policy: what the gateway will let a caller do at all
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

const program = Effect.gen(function*() {
  // Every request the upstream actually received, so the example can show
  // *which* credential reached the wire for *which* caller. Local
  // bookkeeping inside one `fetch` stub, so a plain array is the honest
  // shape -- a `Ref` here would mean running an Effect inside a callback
  // that has no fibre of its own.
  const wire: Array<{ readonly url: string; readonly authorization: string }> = []

  const fetchImpl: typeof fetch = (input, init) => {
    wire.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "(none)"
    })
    return Promise.resolve(
      new Response(JSON.stringify([{ id: 1, title: "a bug" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    )
  }

  const source = OpenApi.makeOpenApiSource("tracker", spec, {
    endpoint: "https://tracker.example.com",
    fetchImpl,
    // Resolved per invocation, on the fibre the call runs on — so the
    // binding is chosen per principal per call, and the value exists in
    // the clear only on its way into a header.
    credentials: Credentials.resolveFor("tracker").pipe(Effect.provide(credentials))
  })

  const toolkit = yield* ToolSource.bind(source, [ListIssues, CreateIssue])

  // What the operator configured, and a record of what it decided -- so
  // the policy path is asserted on its own rather than only through its
  // effect, which the approval floor below would mask.
  const decisions: Array<{ readonly tool: string; readonly decision: string }> = []
  const policy = Permission.make((request) =>
    Effect.sync(() => {
      const decision = request.tool.name === "create_issue"
        ? Permission.deny("this gateway is read-only")
        : Permission.allow
      decisions.push({ tool: request.tool.name, decision: decision._tag })
      return decision
    }))

  const { layer: model } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "t1", name: "list_issues", params: { state: "open" } }] },
    { text: "there is one open issue: a bug" },
    { toolCalls: [{ id: "t2", name: "list_issues", params: { state: "open" } }] },
    { text: "there is one open issue: a bug" },
    { toolCalls: [{ id: "t3", name: "create_issue", params: { title: "please fix" } }] },
    { text: "I am not allowed to open issues here." }
  ])

  // The preset is the recipe this file used to spell out: the agent, the
  // client behind it, and the host in front. Its two defaults are the
  // ones a gateway gets wrong by omission -- a refusal is returned to
  // the model rather than failing the run, and `subject` is required, so
  // there is no way to build a gateway where every caller quietly shares
  // the org's credential.
  const Host = AgentSessionHost.Tag<string>("example/ref-gateway/host")
  const preset = Presets.gateway({
    toolkit,
    permission: policy,
    principal: { resolve: ({ headers }) => Effect.succeed(headers["x-user"] ?? "anonymous") },
    subject: (user) => user,
    authorization: AgentSessionHost.allowAll(),
    loop: AgentLoop.bounded(3),
    maxSessions: 8,
    maxRequestsPerSession: 32
  })
  // Nothing is hidden: `preset.agent` is an ordinary definition, and the
  // host is an ordinary layer. Dropping to the primitives is taking a
  // field, not starting over.
  const host = preset.host(Host).pipe(Layer.provideMerge(model))

  const requestId = Schema.decodeSync(AgentProtocol.RequestId)
  const sessionId = Schema.decodeSync(AgentProtocol.SessionId)

  yield* Effect.gen(function*() {
    const gatewayHost = yield* Host

    const ask = (user: string, id: string, text: string) =>
      Effect.gen(function*() {
        yield* gatewayHost.createSession(user, {
          requestId: requestId(`${id}-create`),
          sessionId: sessionId(`${id}-session`)
        })
        return yield* gatewayHost.prompt(user, {
          requestId: requestId(id),
          sessionId: sessionId(`${id}-session`),
          input: Prompt.make(text)
        })
      })

    yield* Console.log("--- two callers, one gateway ---")
    const alice = yield* ask("alice", "r1", "what is open?")
    yield* Console.log(`alice: ${alice.result.text}`)
    const bob = yield* ask("bob", "r2", "what is open?")
    yield* Console.log(`bob:   ${bob.result.text}`)

    // Each caller's own connection was used, chosen per call. The secret
    // reached the wire and appears nowhere in what the model was told.
    yield* Console.log("\n--- what the upstream received ---")
    for (const call of wire) {
      yield* Console.log(`${call.authorization}  ${call.url}`)
    }

    yield* Console.log("\n--- policy ---")
    const refused = yield* ask("alice", "r3", "open an issue titled please fix")
    yield* Console.log(`alice: ${refused.result.text}`)

    return { alice, bob, refused }
  }).pipe(Effect.provide(host), Effect.scoped)

  // The claims, enforced rather than printed. An example that only prints
  // is a demo; `plan-primitives.md` §4 rule 5 wants these to run in CI, and
  // a check that cannot fail would not be worth running.
  //
  // Writing this file surfaced something worth stating: the write is
  // stopped **twice, independently**. The policy above denies it, and the
  // source's own OpenAPI annotation (non-GET => `requiresApproval`) is
  // floored by `ToolSource.bind` into the tool's `needsApproval`, which
  // asks -- and an agent with no elicitor configured fails closed. So a
  // gateway whose operator misconfigures the policy still does not
  // silently write. Both are asserted, because the second is the one
  // nobody would notice losing.
  // A violated claim is a *defect*, not a typed failure: it means this
  // reference's statement about the library is false, which is not a
  // condition any caller could handle.
  const expect = (claim: string, held: boolean) =>
    held ? Effect.void : Effect.die(new Error(`ref-gateway: ${claim}`))

  yield* expect(
    "each caller's own connection is used, chosen per call",
    wire[0]?.authorization === "Bearer alice-secret" &&
      wire[1]?.authorization === "Bearer org-secret"
  )
  // The outcome both guards exist for: a refused tool is refused *before*
  // the call, so nothing reaches the upstream -- not even to be rejected
  // there. Deliberately not attributed to either guard, because either
  // alone produces it; the two assertions below are what separate them.
  yield* expect(
    "a refused call never reaches the upstream",
    wire.length === 2
  )
  yield* expect(
    "the source's own annotation floors a write to needsApproval, whatever the policy says",
    toolkit.tools.create_issue.needsApproval === true &&
      toolkit.tools.list_issues.needsApproval !== true
  )
  yield* expect(
    "the operator's policy is consulted per call, and refuses the write on its own",
    decisions.some((one) => one.tool === "create_issue" && one.decision === "Deny") &&
      decisions.some((one) => one.tool === "list_issues" && one.decision === "Allow")
  )

  // The MCP surface is `mcpSurface` below: the same host, the same
  // policy, the same credentials, exposed to any MCP client. It is
  // typechecked rather than launched here, because launching one binds a
  // transport to this process's stdio -- the same split
  // `examples/mcp.ts` makes, and the reason that file says so plainly.

  yield* Console.log(`\nUpstream calls: ${wire.length} (the refused one never left the gateway)`)
  return wire
})

/**
 * The same gateway as an MCP server: one host, so capacity, principals,
 * policy and credentials are decided once and every surface inherits
 * them. Typechecked, not launched (see the note in `program`).
 */
export const mcpSurface = <Principal>(
  host: AgentSessionHost.Tag<Principal>,
  hostLayer: Layer.Layer<AgentSessionHost.Service<Principal>>
) =>
  AgentMcp.serverLayer({ host }).pipe(
    Layer.provide(McpServer.layerStdio({
      name: "ref-gateway",
      version: "1.0.0",
      protocols: [McpProtocol.v2025_11_25]
    })),
    Layer.provide(hostLayer)
  )

void Effect.runPromise(Effect.scoped(program)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

// ---------------------------------------------------------------------------
// Compile-time assertions — break once to confirm enforcement, then restore.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

/** A source-bound tool keeps its literal name through `bind`. */
type BoundTools = Effect.Success<ReturnType<typeof ToolSource.bind<[typeof ListIssues, typeof CreateIssue]>>>["tools"]
export type _NamesAreLiteral = Assert<"list_issues" extends keyof BoundTools ? true : false>

/** Its parameters are the declared ones, not `any`. */
type ListParams = Tool.Parameters<typeof ListIssues>
export type _ParamsNotAny = Assert<IsAny<ListParams> extends false ? true : false>
export type _ParamsHaveState = Assert<
  ListParams extends { state?: string | undefined } ? true : false
>

/** Resolution is typed as a credential failure, never `unknown`. */
type ResolveErr = ReturnType<typeof Credentials.resolveFor> extends
  Effect.Effect<any, infer E, any> ? E : never
export type _CredentialErrorIsTyped = Assert<
  unknown extends ResolveErr ? false : true
>
export type _CredentialErrorIsNotAny = Assert<IsAny<ResolveErr> extends false ? true : false>

/** The principal is an `Option<string>`, so "nobody asked" is representable. */
type Subject = Effect.Success<typeof Principal.CurrentPrincipal>
export type _SubjectIsOptional = Assert<
  Subject extends Option.Option<string> ? true : false
>
