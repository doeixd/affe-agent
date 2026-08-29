# Research: turning OpenAPI, GraphQL, MCP, WebMCP, CLIs and typed SDKs into tools

Written 2026-08-27. How other projects turn an external API surface into agent
tools — automatically, safely, lazily enough to attach a lot of them, and
authenticated per user — and what of it belongs in this repo.

The primary source is [`UsefulSoftwareCo/executor`](https://github.com/UsefulSoftwareCo/executor)
(MIT, 3.3k stars), the only project surveyed that does this for more than one
protocol in production. Its code-mode engine is covered separately in
[research-code-mode.md](./research-code-mode.md); this document is about the
layer *underneath* it — where the tools come from.

**Implementation status (2026-08-27): first slice landed.** `/tool-source`
ships the `ToolSource` seam, declared and discovered binders, an MCP connection
adapter, and bounded portable OpenAPI/GraphQL extraction and invocation. Tests
cover skipped operations, schema-checked declared results, live handler routing,
HTTP request construction, GraphQL selection validation, and exact error/service
inference. The credential method/binding/store layers in §7, WebMCP, CLI and the
reference gateway remain unimplemented.

§3 adds WebMCP, the W3C browser proposal, which no surveyed implementation
covers and which breaks one of executor's conclusions.

Companion to that document, not a replacement: everything about the sandbox,
the lazy `tools` proxy, discovery budgets and diagnostics lives there.

---

## 1. The distinction that makes this tractable

**Static TypeScript types and code mode want different artifacts.**

Static types matter in exactly one place: where a human writes
`toolkit.github.createIssue(...)` in this repo's own source, and `AGENTS.md`
says that call site must never need a cast.

An agent needs something else entirely — a rendered signature the model reads
as text, and a validator that runs at the boundary. The model never consumes a
TypeScript type. Neither does code mode.

So "automatic" and "type-safe" stop competing once they are recognised as two
different products of the same extraction. Automatic discovery yields
signatures and validators; static types are an opt-in second door.

This repo already has that pair, in one place, for one protocol:

- `McpToolkit.bind` (`src/mcp/McpToolkit.ts:227`) — the app declares tools with
  `Tool.make`, the source **verifies them at connect** and fails with
  `McpToolMissingError` naming both the missing tools and what the server
  offered. Fully typed, no casts.
- `McpToolkit.bindDiscovered` (`:165`) — whatever the server offers, bound as
  `Tool.dynamic` with the server's raw JSON Schema as parameters and results
  passed through as `unknown`.

Everything below is a generalisation of that pair to five more sources.

## 2. What executor actually does

### 2.1 The contract

Every plugin produces a `ToolDef` (`packages/core/sdk/src/tool.ts`):

```ts
interface ToolDef {
  readonly name: ToolName
  readonly description?: string
  readonly inputSchema?: unknown       // JSON Schema, deliberately untyped here
  readonly outputSchema?: unknown
  readonly annotations?: ToolAnnotations
}

interface ToolAnnotations {
  readonly requiresApproval?: boolean
  readonly approvalDescription?: string
  readonly mayElicit?: boolean
}
```

The SDK stamps an address onto each and persists it per connection.

`ToolAnnotations` is the piece most worth noticing. It is described as
"default-policy hints a plugin attaches — **enforced by the executor before the
handler runs**". The *source* decides its own approval defaults (a write
operation marks itself), and the gateway enforces them. Approval metadata is
derived, not hand-written.

Schemas are Standard Schema (`@standard-schema/spec`) at the executor contract
and JSON Schema inside the `ToolDef`. Nothing in the pipeline produces a
TypeScript type.

### 2.2 Extraction is eager; exposure is lazy

The comment at the top of `tool.ts` is the whole laziness design:

> Tools belong to a connection and are **PERSISTED** — not resolved live on
> every list. A plugin produces them at create/refresh (openapi from the
> integration's spec; mcp by dialing the connection's server), the SDK stamps
> each with its address and stores it per-connection, and `tools.list` is a
> read.

So the split is:

| stage | when | cost |
| --- | --- | --- |
| extraction | once, at connect / refresh | parse a spec, dial a server, run introspection |
| storage | per connection, in the database | — |
| listing / search | per call | a database read |
| prompt exposure | per session | integration slugs only |
| sandbox exposure | never | a lazy `Proxy`; no catalog exists in-sandbox |

This is a deliberate rejection of resolve-on-demand, and the reasoning holds up:
extraction is the expensive, failure-prone step. Doing it lazily moves a 5 MB
spec parse or an unreachable MCP server into the middle of a model's turn,
where nobody can see it, instead of to connect time, where a human is watching.
`compiled-spec-cache.test.ts` exists for the same reason.

**Note for §6:** an earlier sketch in this repo's discussion proposed lazy
`list`-per-namespace and `describe`-per-tool. Executor's split is the better
trade and this document adopts it. What survives from that sketch is the part
about *failure*: laziness must never turn an unreachable source into an empty
one.

### 2.3 OpenAPI

By far the largest plugin — `packages/plugins/openapi/src/sdk/` with
`extract.ts` (41 KB), `invoke.ts` (52 KB), `backing.ts` (43 KB), plus
`derive-auth.ts`, `migrate-config.ts`, and `providers/{google,microsoft}` for
vendor quirks. Google Discovery documents are handled as an OpenAPI variant
rather than as their own integration kind.

The rule worth copying is the one opencode's codemode states for the same job:
**skip what you cannot represent accurately.** Unsupported parameter
encodings, non-JSON request bodies, binary and streaming responses go into a
`skipped` list with a precise reason rather than becoming a broken tool.
Incorrect parameter encoding is worse than an absent operation.

Auth resolves host-side and is never model-visible.

### 2.4 GraphQL — the best idea in the survey

`packages/plugins/graphql/src/sdk/extract.ts` walks **only the root `Query` and
`Mutation` type fields**. Not the whole graph — the actual API surface, which is
bounded at tens to low hundreds even for large schemas.

- Field arguments become the tool's input schema.
- `INPUT_OBJECT` and `ENUM` types are hoisted into shared JSON Schema
  `definitions`, referenced by `$ref`, so a large schema does not repeat itself
  once per tool.
- `NON_NULL` wrappers become `required`; `LIST` becomes `array`.

The selection-set problem — a GraphQL call must say which fields to return, and
a fixed tool cannot know — is solved with a **`select` control input**
(`invoke.ts`, `effectiveOperationString`):

```text
<operationPrefix> { <select> } <operationSuffix>
```

Each tool stores a default operation string selecting the return type's scalar
leaves. When a caller passes `select`, it is spliced into the field's selection
set, so nested and list data can be requested per call. `select` is a control
input, never a GraphQL variable.

`validate-selection.ts` parse-checks the *assembled* string with `graphql-js`
before any network round trip, for two reasons stated in its own comment: to
reject a malformed selection early, and **to catch any attempt to break out of
the field's selection set** — the spliced text must parse as part of a single
operation. Field- and argument-level validity is deliberately left to the
upstream server, which returns verbatim errors, because the stored introspection
snapshot is reduced and `buildClientSchema` cannot consume it.

The result is bounded tool count, real input schemas, and full field selection.
Under code mode it is close to ideal: the model composes `select` inline and
gets exactly the fields it wants in one round trip.

### 2.5 MCP

Dials the server at connect, persists the listing. Structurally identical to
`bindDiscovered` here, minus the typed door.

### 2.6 What executor does not do

- **No CLIs.** No plugin, and no gRPC, SOAP or AsyncAPI either. There is no
  prior art here to borrow.
- **No static types, anywhere.** `inputSchema?: unknown` end to end; tools live
  in a database. The "generated typed SDK" in `vision.md` is a *forward*
  artifact — a typed client for calling Executor — not a way of turning an SDK
  into tools.

The second one is structural rather than an omission. A gateway serving
arbitrary agents has no call site to type. This repo does.

## 3. WebMCP — the source that will not sit still

WebMCP is a W3C proposal (incubated in the Web Machine Learning CG) letting a
web page register tools that an agent can discover and invoke, so an agent acts
through the page's own client-side code instead of scraping the DOM and
simulating clicks. It matters here for two reasons: it is a sixth tool source
with a shape none of the others have, and it breaks the eager-extraction
conclusion of §2.2.

**Status, read 2026-08-27** (`webmachinelearning/webmcp`, first published
2025-08-13, ~3.4k stars, active): Chrome Origin Trial live in 149, Edge Origin
Trial live in 150, supported in ChatGPT Desktop, experimental in Brave's Leo.
Firefox and WebKit have standards-positions issues open, neither committed.
Still explicitly experimental — the API has already moved once (it is
`document.modelContext`, not the `navigator.modelContext` most secondary
write-ups still name).

### 3.1 The API

Registration is per-tool, with an `AbortSignal` for the lifetime:

```js
const controller = new AbortController()

await document.modelContext.registerTool({
  name: "add-todo",
  description: "Add a new item to the user's active todo list",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "The text content" } },
    required: ["text"]
  },
  async execute({ text }) {
    await addTodoItemToCollection(text)
    return { content: [{ type: "text", text: `Added "${text}".` }] }
  }
}, { signal: controller.signal })
```

Consumption is the half that matters to this repo:

```js
const tools = await document.modelContext.getTools()          // { name, description, inputSchema, origin, window }
const result = await document.modelContext.executeTool(tool, args, { signal })
document.modelContext.addEventListener("toolchange", …)
```

Note what that is: **JSON Schema in, MCP content blocks out, discovery and
invocation as two calls, with cancellation.** It is `ToolSource` already, in the
browser, with no adapter of substance in between.

A declarative counterpart synthesizes tools from annotated `<form>` elements.
The explainer defends the imperative half on the grounds that "websites cannot
be built exclusively out of declarative forms" — the same argument applies to
tool extraction generally, and is worth remembering whenever a spec-driven
extractor is proposed as sufficient on its own.

### 3.2 What is different, and what it costs

**Tools are state-dependent and change during a session.** A page registers and
unregisters tools as its own state changes — that is the point of the imperative
API — and fires `toolchange` when it happens. Executor's persist-at-connect
model has no answer for this; a stored snapshot of a page's tools is wrong as
soon as the user navigates a step. **WebMCP is the one source where live
re-listing is mandatory rather than a nicety**, which is the case §2.2's
conclusion does not cover. Nuance for §6.2 rather than a contradiction: the
right rule is *extraction is eager where extraction is expensive, and live where
the source says it changed* — and a `toolchange`-style signal is what
distinguishes the two.

**Tool descriptions are attacker-controlled.** Chrome's security guidance names
indirect prompt injection as the primary threat and puts the burden on the page
author: `untrustedContentHint` and `readOnlyHint` annotations, and a 500-character
budget per description. For a consumer, the honest reading is stronger than the
guidance: a tool description from a web page is untrusted text authored by a
third party, and must be treated the way this repo already treats any
model-facing content that did not come from the application. No other source in
this survey has this property — an OpenAPI spec is usually vendor-published and
an MCP server is usually chosen deliberately, whereas a WebMCP tool arrives from
whatever page happens to be open.

**Access is origin-gated by the browser, not by us.** Tools are exposed to the
registering document, same-origin documents in the tree, and built-in agents;
cross-origin exposure requires both an `exposedTo` origin list on registration
and a `fromOrigins` list on `getTools()`, plus the `tools` Permissions Policy
(`allow="tools"`). Registration rejects with `NotAllowedError` when disallowed.
So the confinement is real and it is the browser's, not the harness's.

**Structured output is still missing.** `outputSchema` is an open issue (#9);
today a tool returns MCP content blocks and nothing declares their shape. So
WebMCP is a tier-3-only source by construction — there is no output contract to
generate a type from even if one wanted to.

Other open questions that bear on any integration: multimodal and streaming
inputs/outputs, cross-document responses when a tool navigates the page, native
input/output schema validation, user prompting and elicitation (issue #165 — the
`requestUserInteraction()` draft), progress reporting for long tools, and a
Service Workers extension for reaching sites the user does not currently have
open.

### 3.3 The two directions, and which one is real

**Outbound — this repo's agent consuming a page's tools.** Direct and nearly
free *if the agent is running in the page*: `getTools()` → `bindDiscovered`,
`executeTool` → the handler, `toolchange` → re-list. WebMCP explicitly supports
"author-provided agents, such as agents embedded directly on a page or running
in an iframe", which is exactly that deployment. Note the non-goals, though:
WebMCP is not designed for headless or fully autonomous use, and a server-side
agent reaching a page's tools needs a browser somewhere regardless — an
extension, CDP, or the harness shipped into the page.

**Inbound — a page exposing this repo's agent as a WebMCP tool.** The mirror of
`AgentMcp` and `docs/plan-mcp-frontend.md`, and structurally the same work:
`registerTool` instead of `McpServer.toolkit`, `AbortSignal` instead of a
cancelled-notification. Cheap once the frontend plan's session model exists.

Both are browser-only, which puts them on the wrong side of
`verify-portability.mjs` — see §6.3.

## 4. Three tiers, named honestly

You cannot obtain static TypeScript types from a runtime-discovered source
without a build step. Any design that claims otherwise is either lying or
generating code. So name the tiers rather than blurring them:

| tier | mechanism | TS types | runtime validation | precedent here |
| --- | --- | --- | --- | --- |
| **declared** | app writes `Tool.make`; the source verifies at connect | full, no casts | yes | `McpToolkit.bind` |
| **generated** | build step reads the spec, emits `Tool.make` declarations → tier 1 | full, no casts | yes | none yet |
| **discovered** | `Tool.dynamic` + JSON Schema | `unknown` | yes | `McpToolkit.bindDiscovered` |

Tier 2 is the only automatic *and* typed answer, and it is honest because the
types are real — there is a real `.ts` file a human can read.

**Tier 3 does not violate the cast rule.** The type genuinely is unknown; a cast
there would be a lie about a value nobody has checked. The library's obligation
is to make the unknown-ness precise — `unknown`, never `any` — and to offer
tiers 1 and 2 to callers who want more. `Tool.dynamic` already behaves this way.

Executor lives entirely in tier 3. Opencode's codemode supports tier 1 and 3
simultaneously through its dual `input` field (a validating Effect Schema *or* a
render-only JSON Schema), which is the same trick `Tool.dynamic` already plays.

## 5. What this repo already has

Rather more than expected. Nothing below needs to be built.

- **`Tool.dynamic` accepts a JSON Schema directly** for `parameters`, and
  `Tool.getJsonSchema` extracts one from any tool. The render-only door is
  native to Effect, not something to add.
- **`JsonSchema.fromSchemaOpenApi3_1` and `fromSchemaOpenApi3_0`** ship in
  `effect` and convert OpenAPI's dialects to draft-2020-12 — precisely the
  conversion an OpenAPI extractor needs, so tier 3 for OpenAPI requires no
  codegen and no third-party converter.
- **`Permission.annotate`** (`src/Permission.ts:159`) projects a tool's
  parameters into a permission resource, preserving the tool's exact type. It is
  the natural target for executor's derived `ToolAnnotations`: an extractor can
  annotate a write operation at extraction time instead of leaving policy to the
  application.
- **`Sandbox.command` / `Sandbox.exec`** give a portable argv boundary, and
  `/shell` owns dialect translation for eight shells. A CLI source has an
  execution substrate already.
- **`McpToolkit`'s two doors** are the design; the work is generalising them.
- **`Elicitation`** is the approval seam, and executor demonstrates raising
  approvals from inside a nested call (see research-code-mode.md §6.5).

One hard constraint shapes everything: `scripts/verify-portability.mjs` rejects
`node:*`, bare Node built-ins, concrete platform packages and host globals in
every module except an explicit list (currently just `sandbox/local.ts`). A
source that needs a filesystem or a subprocess — reading a spec from disk,
probing a CLI — must take those through Effect's platform services or live
behind its own entry point.

## 6. How to integrate it here

### 6.1 The seam

One interface, implemented once per source:

```ts
interface ToolSource {
  readonly id: string
  /** Extract everything this source offers. Called at connect/refresh, not per turn. */
  readonly extract: Effect<Extraction, ExtractionError>
  readonly invoke: (name: string, args: unknown) => Effect<unknown, ToolFailure>
}

interface Extraction {
  readonly tools: ReadonlyArray<Descriptor>
  /** Operations deliberately not represented, each with a precise reason. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>
}
```

`Descriptor` carries `{ name, description, input: Schema | JsonSchema, output?,
annotations? }` — the dual-schema shape, so tier 1 and tier 3 differ only in
which side of the union is populated.

Two derived functions give the doors, mirroring `McpToolkit` exactly:

```ts
ToolSource.bind(source, [DeclaredTool, ...])   // tier 1: verify, fail naming misses
ToolSource.bindDiscovered(source)              // tier 3: Tool.dynamic over the extraction
```

`skipped` is not optional decoration. It is the difference between a source that
covers 80% of an API honestly and one that appears to cover 100% and lies about
20%. It should be surfaced as a `Warning` the way `/plugins` already surfaces
loader warnings.

### 6.2 Laziness, resolved

Take executor's split, not the resolve-on-demand sketch:

- **Extraction is eager and explicit** — an `Effect` the application runs when it
  wires a source, not a hidden cost inside the first tool call. Failures land
  where a human can see them.
- **The result is a value** the application can cache, persist, or snapshot.
  This repo has no database, so `extract` returning a plain `Extraction` is the
  right shape: the app decides whether that lives in memory, in `/state`, or on
  disk between runs.
- **Exposure is lazy**, and that work already has a home: code mode's budgeted
  catalog and search (research-code-mode.md §2), which is where a large
  extraction stops costing prompt tokens.

With one exception, which §3.2 names: a source that tells you it changed must
be re-listed live. WebMCP's `toolchange` is the signal, and any source with an
equivalent gets the same treatment. The general rule is **eager where extraction
is expensive, live where the source says it changed** — never lazy merely to
defer work nobody asked to defer.

Three rules survive from the earlier sketch and should be invariants:

1. A source that cannot be reached fails **at extraction**, by name, and does
   not contribute an empty tool set that reads as "this API has no operations".
2. One source failing must not fail the others. `bindDiscovered` already isolates
   per-connection failures; make it a property of the seam.
3. A tool name that does not resolve fails with a named error carrying
   **suggestions**, capped — executor's `tool_not_found` shape.

### 6.3 Per source

**OpenAPI.** One tool per operation; dotted `operationId` segments become the
namespace. Convert schemas with Effect's own `JsonSchema.fromSchemaOpenApi3_*`.
Skip, with reasons: unsupported parameter encodings, non-JSON bodies, binary and
streaming responses. Resolve auth host-side. Flatten path/query/header/body
fields into one model-facing object while retaining their HTTP locations
internally, and prefix on cross-location name collisions (`path_id`,
`query_id`) — opencode's OpenAPI adapter documents both and they are the right
defaults. Annotate non-`GET` operations with `requiresApproval` via
`Permission.annotate`.

**GraphQL.** Root `Query`/`Mutation` fields only. Args → input schema;
`INPUT_OBJECT`/`ENUM` → shared `$ref` definitions. Add the **`select` control
input** with a default scalar-leaf selection, splice it into
`prefix { select } suffix`, and **parse-check the assembled operation locally
before sending it** — both for early rejection and to prevent breaking out of
the selection set. This needs `graphql-js` as a dependency of that source only.

**MCP.** Already done, both doors. The work is conforming `McpToolkit` to the
seam so that a mixed catalog — some MCP, some OpenAPI, some local — is one
uniform thing to the agent and to code mode.

**WebMCP.** Tier 3 only — there is no `outputSchema` in the spec yet, so there
is nothing to generate a type from. `getTools()` maps onto the seam's
`extract` and `executeTool` onto `invoke` almost verbatim, so the adapter is
small; the work is everywhere else:

- It is **browser-only**, so it cannot live in portable `src/`. It belongs
  behind its own entry point the way `sandbox/local.ts` does — `/webmcp`, listed
  in `verify-portability.mjs`'s `HOST_MODULES`. Same rule, second instance.
- **Re-list on `toolchange`** rather than persisting an extraction. This is the
  §6.2 exception, and it is the one source that forces the seam to carry a
  change signal at all.
- **Treat every description as untrusted content.** It was authored by whatever
  page is open. Carry `untrustedContentHint` and `readOnlyHint` through to
  `Permission.annotate` — `readOnlyHint: false` is exactly executor's
  `requiresApproval`, arrived at independently by a third project.
- **Pass the `AbortSignal` through.** `executeTool` takes one, so interruption
  propagates end to end if the handler wires `Effect.onInterrupt` to it; this is
  one of the few sources where cancellation is natively expressible.
- Do not promise headless operation. The spec lists headless and fully
  autonomous use as **non-goals**, and building on it as though they were
  supported is how a source becomes quietly unreliable.

**CLIs.** No prior art anywhere in the survey; proceed most carefully. Ordered
preference:

1. a machine-readable spec if the CLI emits one (`--json-schema`, clap/Cobra
   generators);
2. **shell completion scripts** — bash/zsh/fish completions enumerate the
   subcommand tree and flag names far more reliably than `--help` prose. They
   give the *shape* and nothing about types or semantics, which is worth being
   explicit about in the generated description;
3. `--help` parsing last, marked low-confidence.

A heuristic that silently produces a *wrong* tool is worse than no tool, so
levels 2 and 3 should mark their tools as observed rather than declared —
opencode's `/* observed; may be incomplete */` marker is the right honesty
device. Shape: one tool per subcommand, argv-shaped input, executed through
`Sandbox.exec` (never a shell string), with `/shell` owning dialect. Tier 1 is
the recommended door: the app declares the schema, and the source verifies the
subcommand exists — the CLI analogue of `McpToolMissingError`.

**Typed SDKs.** The one case where static types are already present and only
runtime schemas are missing. Recommended shape is a `fromMethods` helper taking
`{ method, input: Schema }` pairs: the input schema is written once (it is
needed for the model anyway) and the result type is inferred from the SDK's own
return type. Fully typed, no codegen, no reflection. Hand-declaring the ten
methods actually used is not a failure mode — for most SDKs it is the right
call, and it is the only option that survives the no-casts rule without a build
step.

### 6.4 What code mode changes

Under code mode all six sources collapse to the same four things: a namespace,
a set of paths, a rendered TypeScript signature, and a JSON-Schema validator.
The model never sees a TypeScript type.

So the cost of supporting GraphQL and CLIs *in code mode* is far below the cost
of supporting them as statically-typed toolkits, and the ordering follows: build
tier 3 for every source first, and add tiers 1 and 2 only where a human call
site actually exists.

## 7. Auth

The question every source raises and none of the sections above answer: where
does the credential live, who resolves it, and does any of this work when the
agent serves more than one person.

Executor is the only surveyed project with a complete answer, and it is a good
one. The short version: **auth is three separable layers plus one thing that
refuses to be modelled with them**, and the common mistake is fusing them.

### 7.1 Layer one — the method, declarative and derived

How a credential is applied to a request is a *pure, declarative* description
(`packages/core/sdk/src/http-auth/auth-method.ts`):

```ts
AuthPlacement = {
  carrier: "header" | "query"
  name: string                 // "Authorization", "token"
  prefix?: string              // "Bearer "
  variable?: string            // which credential input; absent ⇒ "token"
  literal?: string             // render this verbatim, reference no credential
}
```

An integration declares a *list* of methods (`{ slug, kind: "apikey", placements }`,
or `{ kind: "none" }`); a connection binds one by slug. Rendering is a total
function — `renderAuthPlacements(placements, values) → { headers, queryParams }`
— and a placement whose variable resolved to nothing is skipped, with
`requiredPlacementVariables` telling the caller which inputs a connection must
supply so it can enforce its own missing-value policy.

Two consequences worth noting. Multi-credential auth falls out for free: two
placements naming different `variable`s get two inputs (their example is
Datadog's two keys), while two naming the same one share a single input. And
`literal` covers the static-header-alongside-a-credential case without a second
mechanism.

**The methods are derived from the source, not hand-written.**
`plugins/openapi/src/sdk/derive-auth.ts` turns spec-detected security schemes
into stored templates, and its header comment states the invariant that matters:

> One implementation so the web UI and headless callers cannot drift: an
> integration added over MCP gets the same auth methods the add page would have
> produced.

It also gets OpenAPI's semantics right — multiple schemes in one security object
are *required together*, so a multi-header preset yields one input per header
rather than a choice between them.

Opencode's OpenAPI adapter lands in the same place from a different direction:
`auth.resolve({ name, scopes, operation })` returns bearer/basic/header/query,
credential storage and OAuth flows "never enter the compiler", cookie auth
alternatives are discarded, and an operation with no supported alternative is
*skipped* rather than generated broken.

### 7.2 Layer two — the binding, which holds no secret

A connection records: which integration, which owner, which method slug, and an
**opaque handle per credential variable**. That is all. The secret is not here.

### 7.3 Layer three — the store, resolved at invoke time

```ts
interface CredentialProvider {
  readonly key: ProviderKey                    // "default" | "1password" | "keychain" | …
  readonly writable: boolean
  readonly get: (id: ProviderItemId) => Effect<string | null, StorageFailure>
  readonly has?: …; readonly set?: …; readonly delete?: …
  readonly list?: () => Effect<readonly ProviderEntry[], StorageFailure>   // optional: some backends cannot enumerate
}
```

From its own header comment: the default store holds pasted values; external
backends resolve an opaque id on demand and "the value never lands in our core
storage"; **core never knows how the id is shaped, only the provider interprets
it**; and there is deliberately no `scope` argument — the connection row owns the
`(tenant, owner, subject)` partition and the provider sees only an opaque id.

`writable: false` is the detail that shows the model was thought through: a
read-only backend is never written to, and removing a connection that references
it drops only the routing, leaving the 1Password item intact.

Shipped backends are separate plugin packages: `keychain`, `onepassword`,
`workos-vault`, `encrypted-secrets`, `file-secrets`.

### 7.4 The thing that refuses to be modelled — OAuth

Executor deliberately keeps OAuth *out* of the placement vocabulary, and says
why:

> OAuth methods are NOT modeled here — their config genuinely differs per plugin
> (openapi stores endpoints+scopes, graphql an optional header override, mcp
> discovers everything at connect time). Each plugin's method union is
> `NoneAuthMethod | ApiKeyAuthMethod | <its own oauth variant>`.

OAuth-refreshed connections resolve only the conventional `token` input, so
OAuth values are never mixed into a placements method. The supporting machinery
is a subsystem of its own — roughly twenty files covering discovery, dynamic
client registration, scope union, callback state, refresh, garbage collection
and popup flows.

The lesson to carry: **static credentials are declarative; OAuth is stateful and
protocol-specific, and pretending otherwise produces an abstraction that fits
neither.** Model the first, and give the second a per-source escape hatch.

### 7.5 Multi-user, and the address trick

Executor's tool address embeds the owner:

```text
tools.<integration>.<owner>.<connection>.<tool>
```

where `<owner>` is the literal `"org"` or `"user"` — **not a user id**. The
executor binds to `{ tenant, subject }`, and the storage policy
(`owner-policy.ts`) enforces:

- read / update / delete → tenant matches **and** (`owner = 'org'` or subject
  matches);
- create → the written `(tenant, owner, subject)` triple must match the binding.

Two orthogonal axes sit on top: `reach` (`bound` — this subject plus org rows;
`tenant` — the whole tenant, read-only by construction) and `writes`
(`allowed` / `denied`). The comment explaining why those are separate axes is
worth reading before designing anything similar: a tenant-reach context is
always write-denied, but the converse does not hold, because the platform's
*ordinary* bound-reach surfaces must be read-only too without being widened.

**The literal `"org" | "user"` segment is the idea to steal.** A tool address is
model-facing text: it appears in prompts, transcripts, exports, and code-mode
programs. An address containing a real user id leaks identity into all of those
and does not replay for anyone else. `tools.github.user.main.create_issue` is
stable across users, portable between transcripts, and resolves to a different
credential per principal — because the identity lives in the *binding*, never in
the name.

### 7.6 How this should look here

**Hang tool auth off the principal that already exists.** `AgentSessionHost`
carries `PrincipalResolver<Principal>` and `Authorization<Principal>`
(`src/client/AgentSessionHost.ts:50`), and the whole point of that service is
that adapters share one identity rather than each inventing one. A second
identity system for credentials would be exactly the mistake `AgentSessionHost`
was created to fix. `Principal` maps onto executor's `subject`; a `tenant` is
whatever the application says it is.

**Build the seam multi-user; ship it single-user.** The single-user case is the
degenerate one — one tenant, `subject = null`, every connection `owner: "org"`,
provider reading environment variables — and it costs nothing if the seam is
already parameterised. Retrofitting identity afterwards is the expensive
direction, and the repo already has the pattern:
`AgentSessionHost.Tag<Principal>("app/AgentSessionHost")` makes the principal a
type parameter the application picks once. Do the same for credentials rather
than inventing a parallel one.

**Keep the three layers separate**, because each has a different lifetime: the
method is derived once with the extraction (§6.1), the binding is
configuration, and the value is resolved per call.

**Use `Redacted`.** Effect ships `Redacted` and `Config`; a resolved credential
should be `Redacted<string>` from the moment it leaves the provider until the
moment a placement renders it, so an accidental log or event payload cannot
carry it. That is defence in depth, not the mechanism — the mechanism is that
the value never crosses into a tool argument, a prompt, an `AgentEvent`, an
`/export` envelope, or a code-mode sandbox.

**Give reauth a path through `Elicitation`.** Executor maps
`CredentialResolutionError` into a tool failure carrying `reauthRequired` and
`oauthErrorCode`, so the model can say "reconnect GitHub" instead of "internal
error", and it mints an `ElicitationId` described as a "correlation id for a URL
elicitation callback". This repo has the seam already: an expired token during a
run raises an elicitation carrying an authorization URL, the user completes it,
and the run resumes. Under `/durable` that survives the process, which is the
one thing executor cannot do (research-code-mode.md §5.3).

**Auth is not authorization.** Two different questions, and they must not share
a mechanism:

| question | mechanism here |
| --- | --- |
| may this principal invoke this tool at all? | `Authorization<Principal>` + `Permission` |
| can this credential reach that API? | the three layers above |

A tool the principal may not call must fail *before* any credential is resolved.

### 7.7 Auth invariants

1. **A credential never becomes model-visible.** Not in a tool argument, a
   description, a prompt, an `AgentEvent`, an `/export` envelope, or a code-mode
   program. Executor: "credentials never enter agent or sandbox code. **No escape
   hatch.**" Opencode: "Auth is never model-visible."
2. **Resolution happens per call, host-side, at invoke time** — never baked into
   an extracted tool definition, which is a value that gets cached and exported.
3. **A credential failure is typed and actionable**, carrying whether reauth is
   required, and is distinct from a defect. An opaque "internal error" for an
   expired token wastes the turn and the user's time.
4. **`writable: false` is honoured.** A read-only backend is never written, and
   disconnecting drops routing only.
5. **One derivation for every entry path.** The UI, the CLI, and an agent adding
   an integration must produce the same auth methods, or the two paths drift and
   only one is tested.
6. **The owner segment of an address is a role, never an identity.** Addresses
   are model-facing text; identity lives in the binding.
7. **Redaction is defence in depth, not the boundary.** If redaction is what
   stops a leak, the design already failed.

### 7.8 What auth looks like per source

- **OpenAPI** — derive methods from `securitySchemes`; multiple schemes in one
  security object are required together. Skip an operation whose only auth
  alternative is unsupported rather than generating it broken.
- **GraphQL** — one endpoint, so usually one method; executor's GraphQL OAuth
  variant is just an optional header override.
- **MCP** — discovers auth at connect time, which is why it gets its own OAuth
  variant. Remote servers increasingly speak OAuth; stdio servers usually take
  environment variables, which is a `CredentialProvider`, not a placement.
- **WebMCP** — **no auth layer at all, by design.** The page is already the
  user's authenticated session; the tool runs in that origin with those cookies.
  This is a feature (nothing to store, nothing to leak) and a hazard (the agent
  inherits ambient authority it never presented a credential for, and the browser
  is the only thing gating it — §3.2).
- **CLIs** — the case that proves the layers must be separate. A CLI's
  "credential" is a login state, a config file, or an environment variable, not a
  header. Executor's core is explicitly carrier-agnostic for this reason: "a
  connection could be a CLI login or a DB URL". The store layer applies
  unchanged; the method layer does not, and a CLI source should supply
  environment or argv rather than placements.
- **Typed SDKs** — the client is usually constructed with the credential, so
  auth belongs in the layer that builds the client, and the tool wrapper never
  sees it.

## 8. Two things to lift regardless

1. **Plugin-derived approval annotations.** The extractor knows a `DELETE` is
   destructive; the application should not have to be told. `Permission.annotate`
   is already the right target, and it preserves the tool's exact type.
2. **The `select` splice with local parse validation.** It solves a problem that
   looks unsolvable — fixed tools over a field-selection protocol — with a
   control input and a parse check, and the security half (a splice that must
   parse as part of a single operation) is the kind of thing that is obvious only
   after someone else has written it down.

## 9. Open questions

- **Where does an `Extraction` live between runs?** Executor has a database;
  this repo does not, and should not grow one for this. `/state` and
  `/export` are candidates; the honest default is that the application owns it.
- **Do this repo's tools carry field-level descriptions?** Generated signatures
  are only as good as the schema annotations behind them. If `Tool.make` callers
  do not annotate fields, a catalog will be accurate and useless.
- **Does `skipped` belong in the type or in a warning channel?** `/plugins`
  already has a `Warning` shape; reusing it avoids a second vocabulary for the
  same idea.
- **How much of an OpenAPI extractor is worth owning?** It is the largest single
  piece in executor by a wide margin (~140 KB across three files), and most of
  that is encoding and auth edge cases. Starting from "JSON bodies, JSON
  responses, `form` query, `simple` path/header, everything else skipped" —
  which is where opencode's adapter starts — covers most real specs.

## Sources

- [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor),
  branch `main`, read 2026-08-27:
  `packages/core/sdk/src/tool.ts` (the `ToolDef` contract and the persistence
  comment), `packages/plugins/graphql/src/sdk/{extract,invoke,validate-selection}.ts`,
  `packages/plugins/openapi/src/sdk/` (`extract.ts`, `invoke.ts`, `backing.ts`,
  `derive-auth.ts`, `providers/{google,microsoft}`),
  `packages/core/integrations-registry/src/registry.ts`; and for §7:
  `packages/core/sdk/src/http-auth/auth-method.ts` (the placement vocabulary),
  `provider.ts` (`CredentialProvider`), `ids.ts` (branded ids, the `Owner`
  literal, `NO_AUTH_TEMPLATE`), `owner-policy.ts` (tenant/owner/subject, reach
  vs writes), `plugins/openapi/src/sdk/derive-auth.ts`, and the ~20 `oauth-*.ts`
  files alongside them.
- [sst/opencode](https://github.com/sst/opencode), `packages/codemode/README.md`
  (the OpenAPI adapter's skip-rather-than-guess rule, the dual schema type, and
  the observed-type marker) — see [research-code-mode.md](./research-code-mode.md).
- [webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp) —
  `README.md` (explainer: `document.modelContext`, `registerTool`, `getTools`,
  `executeTool`, `toolchange`, `exposedTo`/`fromOrigins`, goals and non-goals,
  open questions) and `implementation-status.md`, read 2026-08-27. Spec:
  [webmachinelearning.github.io/webmcp](https://webmachinelearning.github.io/webmcp/).
- [WebMCP tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
  and [AI on Chrome: WebMCP](https://developer.chrome.com/docs/ai/webmcp) —
  indirect prompt injection as the named threat, `untrustedContentHint` /
  `readOnlyHint`, the 500-character description budget, origin isolation and the
  `tools` Permissions Policy.
- This repo: `src/mcp/McpToolkit.ts`, `src/Permission.ts`, `src/sandbox/`,
  `src/shell/Shell.ts`, `scripts/verify-portability.mjs`, `AGENTS.md`.
