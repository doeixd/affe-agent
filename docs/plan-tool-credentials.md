# Tool credentials: the contract

Drafted 2026-08-30 from [research-tool-sources.md](./research-tool-sources.md)
§7, which surveyed how executor, opencode and others answer the question every
tool source raises and none of the earlier sections did: *where does the
credential live, who resolves it, and does any of this work when the agent
serves more than one person?* This document is the answer for this library.
It is deliberately small. The shipped slice is the single-user degenerate case
of a seam built multi-user; the multi-user half is specified here and blocked
on one kernel decision, named in §6.

## 1. Three layers, kept apart because their lifetimes differ

| layer | what it is | lifetime | secret present? |
| --- | --- | --- | --- |
| **method** | how a credential is *applied* to a request: `header` or `query` carrier, name, prefix, which credential variable | derived once with the extraction | no |
| **binding** | which method a connection uses, and an **opaque handle per variable** | configuration | no |
| **provider** | resolves a handle to a value | per call | yes -- and only here |

A method is declarative and total: `render(placements, values)` produces
`{ headers, query }`, skipping any placement whose variable resolved to
nothing, and `requiredVariables(placements)` tells the caller which inputs a
binding must supply so it can enforce its own missing-value policy. Two
placements naming different variables are two inputs (Datadog's two keys);
two naming the same one share an input; `literal` renders a constant header
beside a credential without a second mechanism.

A binding holds no secret. It records the method and, per variable, a handle
whose shape only the provider understands. Deleting a binding drops routing;
a read-only provider's item is untouched.

A provider is a service: `get(handle) → Option<Redacted<string>>`, plus
`writable`, and optionally `set`/`delete`. The value is `Redacted` from the
moment it leaves the provider until `render` writes it into a header, so an
accidental log or event payload cannot carry it.

## 2. Where it meets the tool sources

The OpenAPI and GraphQL sources already take `headers: Effect<Headers>`,
resolved per invocation and never part of a tool's parameter schema. That is
the right seam and it does not change. `Credentials.headers(binding)` is an
`Effect<Headers, CredentialError, Provider>`; an application provides the
provider layer and hands the result to the source:

```ts
const github = Credentials.binding({
  integration: "github",
  method: Credentials.bearer(),           // Authorization: Bearer <token>
  values: { token: "env:GITHUB_TOKEN" }   // a handle, not a value
})

const source = OpenApi.makeOpenApiSource("github", spec, {
  endpoint: "https://api.github.com",
  headers: Credentials.headers(github).pipe(Effect.provide(Credentials.fromConfig))
})
```

Query-string placements are rendered by `render` too; the sources apply
headers today and query placements are the next slice (§7).

## 3. Invariants

1. **A credential never becomes model-visible.** Not in a tool argument, a
   description, a prompt, an `AgentEvent`, an `/export` envelope, or a
   code-mode program. There is no escape hatch. `Redacted` is defence in
   depth; the mechanism is that values exist only inside `render`.
2. **Resolution happens per call, at invoke time**, never baked into an
   extracted tool definition -- a value that gets cached and exported.
3. **A credential failure is typed and actionable**: `CredentialError`
   carries the handle, the reason, and `reauthRequired`, and is distinct
   from a defect. The sources surface it as their `InvocationError`.
4. **`writable: false` is honoured.** A read-only provider is never written.
5. **One derivation for every entry path.** UI, CLI and an agent adding an
   integration produce the same methods, because the methods are derived
   from the source, not typed by hand. (The derivation from OpenAPI
   `securitySchemes` is §7's next slice.)
6. **The owner segment of an address is a role, never an identity.** A
   binding's `owner` is `"org" | "user"`; identity lives in the binding's
   partition, never in a model-facing name.
7. **Auth is not authorization.** May this principal call this tool at all
   is `Permission` + `Authorization<Principal>`; can this credential reach
   that API is the three layers above. A tool the principal may not call
   fails before any credential is resolved -- which is guaranteed today by
   construction, since permission is evaluated before the handler runs.

## 4. What ships now

`@doeixd/effect-agent/tool-source` exports `Credentials`:

- `Placement`, `Method` (`apikey` with placements, or `none`), `bearer()`,
  `header(name, options?)`, `query(name)`: the method vocabulary.
- `render(method, values)` and `requiredVariables(method)`: the pure half.
- `Binding` and `binding(...)`: integration, owner (`"org"` by default),
  method, handles per variable.
- `Provider` (a `Context.Service`), `CredentialError`.
- Providers: `fromValues(record)` (in memory, writable), `fromConfig`
  (handles are `Config` keys, read-only), and `readOnly(provider)`.
- `resolve(binding)` → `{ headers, query }` with `Redacted` values applied,
  and `headers(binding)` → `Headers` for the sources' hook.

Single-user: one tenant, `subject` absent, every binding `owner: "org"`, the
provider reading configuration. That is the degenerate case of the seam, and
it costs nothing to have parameterised it.

## 5. Reauth through elicitation (built 2026-08-31)

An expired token raises an elicitation carrying the authorization URL, the
user completes it, and the run resumes -- and under `/durable` the elicitor
is a `DurableDeferred`, so that wait survives the process, which is the one
thing executor cannot do.

`Credentials.withReauth(resolve, { elicitor })` wraps any resolution and is
what a source's per-invocation `headers`/`credentials` hook takes. The
elicitor is the *host's* to supply -- the same answer §6 reached, and the
same shape code mode's in-program approvals use -- so an application passes
the elicitor its session was built with and the question lands in
`session.pending` beside every other, as `kind: "credential-reauth"`
carrying `{ handle, reason, authorizationUrl? }`.

Two rules the tests pin, both about not training people to click through
questions:

- **Only `reauthRequired` failures ask.** A missing handle is a
  misconfiguration a human cannot fix by following a link.
- **Exactly one retry.** A loop would re-ask forever against a connection
  that is not coming back; the second failure is the honest answer, and a
  refusal fails with the original error without retrying at all.

## 6. The blocked half: the principal at invoke time

Multi-user needs the binding chosen *per principal per call*. The host knows
the principal for every request, but the session does not carry it, and a
tool handler -- where `invoke` runs -- sees `TurnContext`, not the request.
The principal now reaches the tool fibre: `plan-principal-on-tool-fibre.md`
was decided 2026-08-31 as recommended and shipped the same day --
`Principal.CurrentPrincipal`, set by the host per request
(`AgentSessionHost.Options.subject`) and carried on the durable
claim/payload. The seam is ready for it: `Provider.get`
takes only a handle, and a per-principal `Bindings` store keyed by
`(tenant, owner, subject)` is a Layer over `resolve`. Until then, a binding
is chosen where the source is constructed, which is single-user by
definition, and this document says so rather than pretending otherwise.

## 7. Next slices, in order

1. ~~Query placements applied by the OpenAPI/GraphQL sources~~ -- landed
   2026-08-31: both sources take `credentials` (the `Rendered` shape)
   beside `headers`; query pairs land on the URL after the parameter loop,
   so a model-chosen argument cannot shadow a credential's query name, and
   the GraphQL document itself is untouched.
2. ~~Methods derived from OpenAPI `securitySchemes`~~ -- landed 2026-08-31:
   `methodFromOpenApi(spec)` uses the first root `security` requirement
   (its schemes required *together*, one placement each, variables named by
   scheme); apiKey header/query and http bearer are expressible; basic,
   oauth2/openIdConnect and cookie are `skipped` with reasons, never
   silently.
3. ~~The principal-on-the-tool-fibre decision (§6), then per-principal
   bindings~~ -- landed 2026-08-31: `Bindings` store keyed by
   `(integration, subject)` with user-over-org selection, and
   `resolveFor(integration)` reading `CurrentPrincipal`; a subject served
   by nothing gets `reauthRequired: true`, a bare configuration gap does
   not.
4. Reauth via elicitation (§5).
5. ~~OAuth as a per-source escape hatch, never a placement~~ -- built
   2026-08-31 as `Credentials.fromRefreshing`. The shape is the argument:
   static credentials are declarative, OAuth is stateful and
   protocol-specific, and pretending otherwise produces an abstraction
   that fits neither. So there is no `oauth` placement and there will not
   be one -- a refreshing connection resolves the conventional token input
   like any other credential, and everything specific to it (discovery,
   registration, scopes, callbacks, refresh, garbage collection) stays in
   the application behind one function. `token` returning `None` means
   *reconnection is required*, which is what a dead refresh token is, and
   becomes the `CredentialError` §5 turns into a question. Read-only by
   construction: the application owns the connection.

**The plan is complete.**
