# Decision: the principal on the tool fibre

**Decided 2026-08-31: Option A, as recommended.** The three open questions
resolve as recommended -- an opaque subject string (a tenant becomes a
second Reference the day multi-tenancy is real), `respond` sets it too,
and the home is `src/Principal.ts` exported from the root. Implemented the
same day: `Principal.CurrentPrincipal`; `AgentSessionHost.Options.subject`
providing it around the five mutations (owner-of-the-reservation
semantics, so a joining retry never re-principals a run); the durable path
carries it `claim.principal` → `Payload.principal` → provided around the
in-workflow prompt, optional and additive so existing journals decode.
`DurableAgent.submit` (the low-level, claimless path) deliberately does
not carry it -- the claim is where the caller's fibre meets persistence.

Drafted 2026-08-30 for review — this is the design review that
[design-assessment](./design-assessment-2026-08-28.md) rec 1 requires before
anything principal-shaped enters the kernel, written so the review is a
short read rather than an open discussion. Nothing here is implemented;
`docs/plan-tool-credentials.md` §6 is the consumer waiting on it.

## The problem, in one paragraph

Per-principal credentials need the *binding* chosen per principal per call
(research-tool-sources §7.5: identity lives in the binding). The host knows
the principal for every request — `AgentSessionHost` resolves it before any
operation runs — but a tool handler executes inside the session and sees
`TurnContext`, not the request. Today a credential binding is therefore
chosen where a tool source is constructed, which is single-user by
definition. The question: how does "who asked" reach "the tool that acts"?

## Facts the options rest on (verified in-code, 2026-08-30)

1. **A submission forks from the caller's fibre.** `startSubmission` runs on
   whatever fibre called `session.prompt`/`submit` and forks the run with
   `Effect.forkIn(self.scope)` (`AgentSession.ts` ~600–630). A fork inherits
   the parent's fibre context, so anything the *caller* provided is visible
   to the whole run — model calls, tool handlers, permission evaluation.
2. **The session env cannot clobber it.** The run pipes
   `Effect.provide(self.env)` with the environment captured at
   `AgentSession.make`; `provide` overrides only the keys that env
   *contains*. A key the env never held still reads from the fibre context.
3. **`Context.Reference` is the vocabulary for exactly this**: a service key
   with a default, readable anywhere without being a requirement —
   `Context.Reference<Service>(key, { defaultValue })`. `MinimumLogLevel`
   and friends already work this way.
4. **The durable path does not inherit the caller's fibre.** A durable run
   executes inside a Workflow on the engine's fibres; nothing provided
   around the client call reaches it. Whatever carries the principal there
   must ride the submission's persisted `Payload`
   (`DurableSubmission.Payload`: sessionId, submissionId, prompt,
   initialHistory, …) so a replay sees the same principal the original saw.

## Options

### A. A `Reference`, set by the host per request — **recommended**

```ts
// src/Principal.ts (new file, not a new kernel noun -- see below)
export class CurrentPrincipal extends Context.Reference<Option.Option<string>>(
  "affe-agent/CurrentPrincipal",
  { defaultValue: () => Option.none() }
) {}
```

- **The host sets it** around every session-bound mutation it forwards
  (`prompt`, `submit`, `steer`, `followUp`, `respond`):
  `Effect.provideService(CurrentPrincipal, Option.some(subject))`. Fact 1
  carries it into the run; fact 2 keeps it there.
- **What the value is:** an opaque *subject string*, produced by an
  application-supplied projection on the host
  (`options.principal.subject?: (principal: Principal) => string`, the same
  shape `AgentA2A.serverLayer` already takes). The host's `Principal` type
  stays generic; tools and credential bindings key on the stable string —
  §7.5's rule that model-facing/binding-facing identity is a role or
  subject, never a rich object.
- **Consumers read it** with `yield* CurrentPrincipal` (no requirement
  added): `Credentials.resolve` picks the per-subject binding; a permission
  policy may consult it; nothing else changes.
- **Semantics:** the *submitter's* principal governs the whole submission.
  A `steer`/`followUp` from another principal changes what the run is told,
  not who it acts as — the run's authority is whoever started it. (The host
  can refuse cross-principal steering via `Authorization` already; this
  decision does not change that.)
- **Durable extension:** `Payload` gains `principal: Schema.Option(Schema.String)`;
  the durable client captures `CurrentPrincipal` at claim time and writes it;
  `DurableSubmission`'s workflow body provides the Reference around the
  in-workflow session. Replay-stable by construction (it rides the same
  payload as the prompt). This is the one wire/storage change, and it is
  additive.
- **Why this is not a kernel-vocabulary change:** the kernel neither reads
  nor requires the Reference; no `AgentSession`/`ToolExecution` signature
  changes; a session run outside any host reads the default `None` and
  behaves exactly as today. It is a context key, like a log level — the
  same reasoning that keeps `MinimumLogLevel` out of every effect's type.

### B. Plumb the principal through the kernel (`MakeOptions` → `TurnContext`)

A `principal` field on session creation, threaded into `TurnContext` so
handlers receive it positionally. Rejected: it *is* a vocabulary change
(every layer of session/run/turn learns a new field), it fixes the principal
at session creation when the host resolves it per request, and it forces
single-principal sessions structurally — the wrong shape for a shared
session addressed by id.

### C. Application-level: bindings keyed by session id

No kernel or host change; the application maps `sessionId → subject` where
it constructs tool sources. Rejected as the *general* answer: it assumes a
session belongs to one principal forever and pushes the mapping into every
application; but it remains a valid pattern today and nothing in A breaks
it.

## What A unblocks, in order

1. Per-principal `Credentials` bindings (`plan-tool-credentials.md` §6): a
   `Bindings` store keyed by `(integration, owner, subject)` and a
   `Credentials.resolveFor` reading `CurrentPrincipal` — a Layer over the
   shipped single-user slice.
2. Reauth via elicitation (§5 there): the credential failure can name the
   subject whose reconnect is needed.
3. Auditing: tool events annotated with the subject via telemetry, without
   touching event schemas.

## Acceptance criteria (when implemented)

- A host-served prompt's tool handler observes the caller's subject; a
  bare `AgentSession.make` + `prompt` observes `None`. Broken once by
  removing the host's `provideService`.
- Two principals prompting one hosted session interleave: each submission's
  tools see the submitter's subject, not the other's.
- A durable submission replayed in another process observes the same
  subject as the original run (asserted against the store, not observed).
- No public signature changes outside the new module and the host option;
  the cast inventory and public-API pins unchanged except the new exports.

## Open questions for the reviewer

1. Subject string vs. `Option<{ subject; tenant? }>` — the research's tenant
   axis. Recommendation: start with the subject string; a tenant is a second
   Reference the day multi-tenancy is real, not a struct to design now.
2. Should `respond` (answering an elicitation) also set it? Recommendation:
   yes — an approval's authority is the approver's — but tools never run on
   the respond fibre today, so it is observability-only until reauth lands.
3. Name and home: `CurrentPrincipal` in a new `src/Principal.ts`, or on
   `/client` beside the host? Recommendation: `src/Principal.ts`, exported
   from the root — it is meaningful without the host (an application can set
   it around direct session calls).
