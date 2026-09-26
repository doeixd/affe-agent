# Architecture review — 2026-09-26

Status: **proposal**, except item 125 (§1's code-mode bypass), **built
2026-09-26** as `ToolScheduling.Container`. Items 125–132 in
[remaining-work.md](./remaining-work.md) track each part, and each item
names its gate. This document holds the argument. The description of the
architecture it reviews is [architecture.md](./architecture.md).

This review was written after reading `src/` at `56a3865` and writing that
description. It asks where the design could be more composable, and it
checks each answer against the decisions already on record. Where a
proposal contradicts [`PLAN.md`](../PLAN.md), the contradiction is quoted
rather than worked around, as `AGENTS.md` requires.

## What to keep

The kernel's central decisions hold up, and nothing below changes them:

- An agent is a value that carries no model.
- There is one canonical history, and a transform only derives from it.
- One event contract feeds every observer.
- The local handle (`AgentSession`) is separate from the wire surface
  (`AgentClient`).
- A cross-cutting concern arrives as a combinator, not a new type parameter.
- Persisted identifiers are frozen.
- Claims in the docs are checked by the build.

## The finding behind most of this

Two of the kernel's mechanisms are reused far more than the others:

- **the tool-call pipeline**, and
- **the session's nondeterministic steps**: the model call, tool calls,
  input drains, permission decisions and elicitation.

**Neither is a reusable unit.** Each place that needs one of them builds its
own copy, or its own subset. Most of the proposals below follow from that.

---

## 1. The tool-call pipeline is not reusable

### Evidence

`ToolExecution.execute` runs a call through these stages:

1. exposure;
2. the `Alone` exclusivity check;
3. the agent's strategy;
4. host scheduling (`ToolScheduling.Current.around`);
5. permission and approval (`decide`, then elicitation);
6. the handler, with progress;
7. settlement under the failure and denial policies.

Nothing outside `ToolExecution.execute` can run those stages as one unit,
and the entry points that re-enter tools rebuild only a subset:

- **Code mode skips host scheduling.** `CodeMode.invoke`
  (`src/code/CodeMode.ts`) calls `ToolExecution.decide` and then
  `group.handle` directly. `ToolScheduling.Current` is read in exactly one
  place, `executeSettled` in `ToolExecution.ts` (the two durable modules only
  capture it). Suppose a host serialises `book_room` with
  `ToolScheduling.serialize`, which `ToolScheduling.ts` describes as a tool
  that "must never overlap". A model that calls `book_room` from inside
  `execute` is not serialised.
- **Code mode's nested calls are not tool-call events.** `CodeTool` reports
  each nested call as a preliminary result (`context.preliminary`), which the
  kernel emits as `ToolCallProgress` of the `execute` call. There is no
  `ToolCallStarted` or `ToolCallSucceeded` for them, so an observer that
  counts or audits tool calls through events does not see them.
- **Code mode under `/durable` is untested.** No test pairs `/code` with a
  durable host, and `guide-code-mode.md` does not mention durability. Reading
  the code, two outcomes are likely:
  - an `Ask` inside a program reaches `DurableElicitation` from inside the
    `execute` tool's activity, which is refused with
    `DurableElicitationInToolCallError`;
  - a crash in the middle of a program either replays the whole program,
    reissuing its nested side effects, or leaves the `execute` call
    `Unresolved` if the tool is not idempotent.

  Neither outcome has been demonstrated.
- **Most of the erasing casts come from wrapping.** The enforced inventory in
  `test/Casts.test.ts` allows 24. Nineteen of them exist because Effect AI's
  `Toolkit.WithHandler` and `LanguageModel` are closed, invariant types:

  | why | file | casts |
  | --- | --- | --- |
  | wrapping a closed service | `DurableModel.ts` | 4 |
  | wrapping a closed service | `DurableToolkit.ts` | 3 |
  | wrapping a closed service | `TestLanguageModel.ts` | 6 |
  | merging handled toolkits | `internal/toolkit.ts` | 2 |
  | merging handled toolkits | `AgentTurn.ts` | 2 |
  | restating erased requirements | `CodeMode.ts` | 2 |

  Of the other five, two map a declared tool tuple (`McpToolkit`,
  `ToolSource`) and three are in `Agent.ts`.
- **Tool policy is spread over many slots.** It is set in five `Agent`
  slots: `toolExecution`, `toolExposure`, `toolFailurePolicy`,
  `toolDenialPolicy` and `permission`. The host adds `ToolScheduling`, and
  `/durable` then re-captures three of them separately.

### Where this meets PLAN.md

[`PLAN.md`](../PLAN.md) §17 says:

> Use Effect AI's `Tool` and `Toolkit`.
>
> Do not create parallel harness-specific tool abstractions.
>
> The harness owns orchestration, not tool definition.
>
> Do not create a large tool middleware system.

That decision is why the proposal is split into two parts. **1a** stays
inside §17. **1b** does not, and it needs the owner to amend §17.

### 1a. One internal path for every tool call (within §17)

Pull stages 3 to 7 out of `execute` into a single internal function, for
example `ToolExecution.runOne(call, context)`.

- `execute` calls it once per call in the batch.
- `CodeMode.invoke` calls the same function instead of
  `decide` + `group.handle`.
- The subagent and A2A bridge paths call it wherever they re-enter a tool.

Tools are still defined with Effect AI's `Tool` and `Toolkit`, and no public
surface changes. This is orchestration, which §17 assigns to the harness.
It is enough to close the code-mode gaps, and it gives each future entry
point the whole pipeline for free.

The open design question is events: whether a nested call emits real
`ToolCallStarted` and terminal events correlated to its parent call, or
keeps the progress channel. The first is more observable. The second keeps
the rule that every tool call answers to one model response.

### 1b. A public tool middleware chain (needs §17 amended)

Convert the toolkit **once, at the edge**, into a harness-owned
representation typed by `Tools`: a record from tool name to
`(params) => Stream<Result>`. Express each stage as a middleware,
`(call, next) => Effect`.

Then the following all become entries in one ordered chain:

- permission and exposure;
- host scheduling;
- budget;
- durable journaling;
- credential re-authorisation;
- test counting.

This would give three benefits:

- **Fewer casts.** A durable or counting wrapper becomes a middleware
  instead of a cast over a closed method type. That should retire most of
  the 13 wrapping casts, and the 4 merge casts too if the merge happens on
  the owned representation. This needs a spike before it can be promised.
- **Third-party extension.** Applications could add rate limiting, auditing
  or argument redaction without the kernel knowing about them. The one hook
  offered today, `/hooks`, can only observe.
- **Fewer slots.** The five tool-policy slots on `Agent` become one chain,
  with the current slots kept as combinators that add entries to it.

**The cost.** This is exactly the "parallel harness-specific tool
abstraction" and "large tool middleware system" that §17 rules out. The
argument for it now is the evidence above, which §17 did not have: a
correctness gap, and 17 of 24 casts traced to wrapping or merging Effect
AI's closed toolkit and model types. A chain ordered by the user can also
put permission after a middleware that changes the arguments, so the
ordering needs its own rules.

---

## 2. Durability is a set of wrappers, not a seam

### Evidence

- `/durable` substitutes about eight things in the workflow body:
  - the model;
  - the toolkit;
  - the permission policy;
  - the input channels;
  - the elicitor;
  - Effect-valued input rendering;
  - the captured tool strategy;
  - the captured host scheduling.
- That assembly is written twice, once in `DurableAgent.ts` and once in
  `DurableSubmission.ts`. Both capture `ToolScheduling.Current`.
- A new nondeterministic seam is silently non-durable until someone writes
  its durable twin. `ExecutionPlan` is already refused outright by a durable
  agent for this reason.
- The Cloudflare host cannot use `/durable`, because Workflow stalls on
  workerd. It has its own separate durability: history in DO SQLite, events
  in a `DeliveryLog`. A crash there loses the turn in flight, where
  `/durable` would resume it from the journal.

### Proposal

Add a small `Journal` service with one operation, `step(name, schema,
effect)`. Its default implementation runs the effect unchanged. The kernel
calls `step` at each nondeterministic point, and the implementations differ:

| implementation | backing |
| --- | --- |
| local | none (the effect runs directly) |
| `/durable` | Workflow `Activity` |
| Cloudflare | DO SQLite |

This would give three benefits:

- Cloudflare gains real resume from the journal.
- `ExecutionPlan` can journal each step it tries instead of being refused.
- The two durable workflow shapes stop duplicating their assembly.

### Where this meets PLAN.md

§30.1 says:

> Do not add `AgentExecution` until a durable implementation demonstrates
> interception that the Layer boundary cannot express.

The case that the condition is now met rests on three facts:

- **Cloudflare** is a durable implementation that cannot use the Layer
  substitution at all.
- **`ExecutionPlan`** is a seam the substitution set cannot make durable.
- **`InputChannel`** already had to become a seam for exactly this reason,
  as `MODULES.md` records.

The case against: the kernel would then know where its nondeterminism is.
It would still not know about durability, since the default `step` is the
identity. **This is the owner's decision.** Item 129 is gated on it.

---

## 3. The session state machine exists three times

### Evidence

The admission transition, which yields `Claimed`, `Busy` or `Missing`, is
written three times:

- `AgentSession`'s `claim`, one atomic `SubscriptionRef.modify`;
- `DurableSessionStore`'s memory store;
- `DurableSessionStore`'s SQL store.

The dispatch outbox has two implementations:

- the channels store's `${sid}:dispatch` rows, used by the cluster entity;
- Cloudflare's `affe_dispatch` table.

Each copy needs its own tests to keep agreeing with the others. Today it is
the durable session store's conformance suite that holds them together,
after the fact.

### Proposal

Write a pure reducer, `(SessionState, Command) → (SessionState, Effects)`,
with one test suite over its transitions. The stores then only persist its
result. `/sessions`' `SessionProjection` already follows this pattern. A new
placement would then need a store, not another copy of the state machine.

The design question is atomicity. The local session gets it from
`SubscriptionRef.modify`, and the SQL store gets it from a transaction.
The reducer has to be something both can run inside their own atomic
section, so it must stay synchronous and pure.

---

## 4. Three ways to retain events

### Evidence

- `AgentSessionHost` keeps a bounded tail (`maxRetainedEvents`, default 256).
- `Agent.start` keeps a bounded trace of its own.
- Resumable delivery is a separate `DeliveryLog`.
- The in-process client's `events({ after })` fails with
  `AgentTransportError`, "this session has no delivery log".

### Proposal

Give the session an `EventLog` seam whose default is a bounded in-memory
ring. The host tail and `Agent.start`'s trace become that ring. Then
`events({ after })` works for every client, with the same "refuse rather
than serve a gap" rule the host already applies. A `DeliveryLog` remains the
durable implementation of the same seam.

---

## 5. Explicit client capabilities (declined, and not reopened)

`RemoteSession` has two optional methods, `framework?` and `eventLog?`, so a
caller has to check whether each exists. Making client capabilities explicit
was proposed and **declined on 2026-09-11** (item 86). The reasoning was:

- the refusal at first use is already typed;
- the conformance suite asserts both answers;
- a capability record would be a permanent obligation on every custom client,
  for a reader nobody has.

This review found no caller that has to choose between clients at wiring
time, which is item 86's stated reopen trigger. So it stays declined, it is
not a new item, and it is recorded here only so that the next reviewer does
not propose it again.

---

## 6. Core versioning is tied to experimental churn

`affe-agent` is one package with one version and 53 import subpaths. The
README's maturity map labels most of them experimental. As a result, a
release of the core vocabulary (root, `/client`, `/elicitation`,
`/testing`) is versioned together with changes to `/code` or `/web`, and the
"core" label cannot carry a semver promise of its own.

Separating the core into its own package would fix that. It matters less
than items 1–4, and it is worth deciding before a 1.0. It is gated on the
owner's release plans (item 131).

---

## Also found

- **The cast count is stated three ways.** `AGENTS.md` says "Twenty-four
  erasing casts exist, in seven files". `STATUS.md`'s casts gate says "six
  files". The enforced inventory in `test/Casts.test.ts` lists nine files
  (item 132).
- **Stale text found while writing `architecture.md`:**
  - `docs/transport.md` says the MCP server exposes only `ask_agent`; it also
    exposes the `agent_*` tools.
  - The README's runtimes section omits `/cloudflare` from the host modules.
  - `docs/plan-workbench.md` still says "specified, not implemented", but
    `apps/workbench` exists.

  These are doc fixes and are folded into item 132.

## 7. What `effect-agent` adds to this review

Status: **reviewed 2026-09-26** from the source of `danieljvdm/effect-agent`
at `343eba5`, not from its documentation site.
[plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) is the
earlier read of that site.

`effect-agent` is built durability-first:
- The canonical record is an append-only thread log of versioned Schema
  records (34 kinds).
- Every append is fenced twice: by a producer epoch, and by a compare-and-swap
  on the tail of a hash chain. Leases only signal liveness; correctness never
  depends on them.
- Replay never executes a tool.
- Its engine writes to that log through `RunDurabilityHook`, which has fixed
  commit points, and it does not use Effect Workflow.

That design has three consequences here.

### 7.1 Evidence for the `Journal` seam (item 129)

`effect-agent` runs one journal seam, at turn granularity, on SQLite, Postgres
and Durable Object SQLite. Its engine "behaves exactly as the ephemeral
runtime" when the hook is absent, and its Cloudflare host resumes from the
journal. This is the case §2 makes, demonstrated in another codebase.

It also shows the failure mode. The hook has grown into a protocol with its
coordinator:
- `RunDurabilityHook` alone has about eight members (`commitResponse`,
  `prepareToolCalls`, `step`, `commitCompaction`, `noteTurnUsage`, ...);
- separate subagent, step, resume and resume-usage seams sit beside it;
- a 10,534-line interpreter holds about 49 fields of mutable run context.

If item 129 goes ahead, the seam should stay at `step` and a few commit
points.

### 7.2 Adopted: schedule the calls that do work (item 125, closed)

Its code mode routes every programmatic call through one broker preflight:
the allowlist, visibility, the subagent grant, authorization and budget. That
is the shape item 125 needed. Building it here found an older deadlock, a
subagent under `maxConcurrent(1)` waiting on its own permit, which
`effect-agent` cannot have because it has no host-wide scheduling.
`ToolScheduling.Container` fixes both.

### 7.3 Its strengths, weighed against decisions already on record

- **An unknown outcome is parked, not fatal.** A crashed, non-idempotent call
  there becomes an obligation, with an explicit `resolveUnknown`, and later
  input still runs. Here it ends the run with a `DurableToolUnresolvedError`
  defect.

  The defect is deliberate, and `DurableToolkit.ts` argues it: a *typed*
  failure would reach the model, which would call the tool again. Parking
  keeps that property, because the model never sees the call, and adds an
  operator path. That is item 133.
- **Subagent budgets are reserved.** A child's allocation is admitted
  atomically, and all-or-nothing, against the parent's remaining budget.
  Item 99 kept "counted, not capped" here on 2026-09-10, because a `Budget`
  is a counter and its ceiling lives in the parent's loop. Reserving needs
  `Budget` to carry ceilings, which item 99 calls "a redesign no user has
  asked for".

  `effect-agent` shows the redesign working. Whether that is the ask item 99
  was waiting for is the owner's call, so it is not a new item.
- **Adapter certification is exportable.** It has three tiers: conformance,
  a failpoint sweep over its coordinator scenarios, and real process-loss
  evidence. `/testing` here already exports the conformance suites,
  `Failpoints` and `DurableEquivalence`. What it lacks is a sweep a
  third-party store can run over every boundary. That is item 134.
- **Recovery is a pure function, and operators can inspect it.**
  `classifyRecovery(snapshot, evidence)` feeds an admin `explain`/`verify`
  command. Recovery here is spread across `DurableAgentClient`'s
  reconciliation and the workflow engine. That is item 135, after 133,
  because a parked outcome is the first thing an operator would need to see.

### 7.4 Not taken

Four things are not taken, each for a stated reason:
- **The monolithic interpreter and mutable run context.** This repository's
  split into submission, run and turn, with atomic `Ref` transitions, is the
  better shape.
- **Spec ids in the source with no committed rationale.** It has about 516
  such references.
- **Possession-as-authorization defaults.** This repository requires
  authorization at every network-facing host (item 110).
- **Forbidding approval-gated tools in code mode.** Here they are routed
  through the elicitor.

`effect-agent` also has no client/server protocol, so nothing there bears on
§5 or on the adapters.

## Suggested order

1. **Item 125, the code-mode scheduling bypass.** It is a correctness fix,
   and whichever way 1a and 1b go, it is needed now.
2. **Items 126 (1a) and 128 (reducer).** Both are internal, with no public
   change and no conflict with the plan.
3. **Items 127 (1b) and 129 (journal).** Both wait on the owner's decision
   against PLAN §17 and §30.1.
4. **Items 130 (event retention), 131 (packaging) and 132 (doc drift).**
