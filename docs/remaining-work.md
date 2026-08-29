# Remaining work, easiest first

Written 2026-08-26 from a pass over `/docs` against what actually ships.
Implementation proceeds in the numbered order below.

Most plans in `/docs` are already built. The easy leftover work is **small
remaining slices**, not the large new plans.

## Already done (do not restart)

| Plan | State |
| --- | --- |
| `plan-execution-plan.md` | All milestones checked off |
| `plan-opencode-tools-port.md` | M1–M5 landed; web tools exist |
| `plan-session-tree.md` | T1–T5 landed (delta storage deliberately deferred) |
| `plan-tui-port.md` | V0–V8 landed |
| `plan-tui-tool-views.md` | W1–W4 landed; W5 is “don’t do speculatively” |
| `plan-snapshot-export.md` | E1–E5 landed (JSONL commit log in E4) |
| `audit-effect-ecosystem.md` | All A-0 through A-13 actions and AS1–AS11 done |

## Order of work

### 1. `plan-snapshot-export.md` — E4, the JSONL commit log ✅

Landed 2026-08-26. `encodeJsonl` / `parseJsonl` / `headerOf` / `append` on
`/export`. Header line is picker metadata; remaining lines are messages.
EventLog was not adopted (H4b). Delta storage for the tree stays deferred.

### 2. `plan-agent-server.md` — S1 through S5 ✅

Landed 2026-08-26. `AgentHttp.api({ name })`, `AgentServer.mount` / `make` /
`serverLayer`. Duplicate mounts fail at construction. LayerMap deferred:
routes register at layer construction, so lazy mounts do not fit option A.
S3 mixed backing landed 2026-08-26: `AgentHttp.fromGenerated` /
`agentClientLayer` / `agentClientFromServer` adapt HTTP to `AgentClient`;
the shared `AgentClientContract` runs against that adapter; one server
serves a local mount and a remote-backed mount. S4 inventory landed too --
`/inventory`, the `Inventory` / `MountSnapshot` schemas, and a test that
reads it before and after creating a session. S5 landed 2026-08-27:
`examples/agent-server-auth.ts` shows bearer and cookie
`PrincipalResolver`s with separate per-mount authorization, backed by direct
resolver/policy tests. This plan is complete.

### 3. `plan-pi-toolkit.md` — second toolkit at `/pi` ✅

P0–P5 landed. `/pi` is a second toolkit: batch `edits[]` (I13–I15), rendered
`list_files`, injectable `Shell`, truncation that names the limit, shared
canonical-path lock with `/coding`. `test/PiToolkit.test.ts`.

### 4. TUI leftover — persist the tree across launches ✅

Live backend writes the tree to `NodeStore.keyValue` outside the workspace
(`apps/tui/src/backend.ts`); `restore.ts` paints a recovered `Prompt`. Smoke
V9 asserts a second launch resumes. Remaining TUI leftovers are live-region
scrolling and syntax highlighting (blocked on OpenTUI parsers).

### 5. Finish the in-progress A2A adapter (`STATUS.md`) ✅

`/a2a` already serves Agent Card, JSON-RPC, streaming and cancel. Two of the
four gaps this used to list have since closed: **input-required continuation**
is covered by two tests in `AgentA2A.test.ts` (pause and resume, and asking
again after a resume), and a **typed client** exists -- `AgentA2A.client`,
`RemoteAgent`, `TypedExchange`.

Closed 2026-08-27. The reverse peer suite was already present in
`AgentA2AClient.test.ts`; the earlier inventory was stale. The portable server
now advertises and serves HTTP+JSON alongside JSON-RPC: blocking and streaming
send, task get/list/subscribe/cancel, extended-card, and push-configuration
routes all delegate to the same official SDK request handler and owner-scoped
stores. The disabled extended-card and push capabilities return their protocol
errors. `AgentA2A.test.ts` drives the binding through the official REST client
and covers tenant-prefixed routing, schema/content/version errors, task lookup,
listing, streaming, cancellation, and SDK error encoding.

### 6. Two export-surface findings — small, and both real ✅

Found 2026-08-27 while writing [MODULES.md](./MODULES.md) §11. Neither is a
design question; both are gaps between what the library does and what it lets a
user reach.

Closed 2026-08-27. `Elicitation` is exported from the root and from the explicit
`/elicitation` subpath; the root vocabulary and the elicitation namespace are
pinned by `PublicApi.test.ts`. `examples/ref-coding-agent.ts` imports only
published package paths, uses `Elicitation.memory` for approval, and now runs as
`smoke:ref-coding` in `npm run check`. That example also closes the first
acceptance step in [plan-primitives.md](./plan-primitives.md).

### 7. `plan-filetypes.txt` Phase 1 — stable `PromptWire` codec ✅

Landed 2026-08-27 across every current prompt boundary at once: HTTP, shared
RPC schemas, cluster and workflow payloads, `DurableSessionStore`,
`DurableChannels`, snapshots/full exports, JSONL messages, and the key-value
tree store. The decoded types remain exactly Effect AI's `Prompt.Prompt` and
`Prompt.Message`; the JSON form tags string, bytes/base64, and URL data so the
runtime variant survives. New writes are explicit, legacy untagged strings are
still readable, and export format version 2 names the incompatible file shape.
Tests cover real HTTP/RPC clients, cluster/workflow, SQLite, both durable
session stores, both export forms, channel storage, and tree reconstruction.

## Durability: complete (2026-08-28)

The plan's milestones are done (H1-H9), and the last two acceptance criteria
closed on 2026-08-28:

- **SD2 ✅ (2026-08-28).** Re-run against the current tree, and it is now
  `scripts/falsify.mjs` rather than a one-off: eight of nine breaks bite, and
  every verdict the 2026-08-24 table recorded still holds. D1 and D2 bite
  harder than they did, because the breaks now reach both store
  implementations. **The guarantees enforced in August are still enforced.**

  One survivor, D4b: removing the interrupt discrimination in `DurableAgent`'s
  `catchCause` changes nothing any of 1389 tests can see, and a probe found the
  interrupt and failure paths indistinguishable through `poll` in the one
  scenario that exercises it. Recorded in
  [plan-durability-hardening.md](./plan-durability-hardening.md) as either dead
  code or an untested path, with the evidence for both readings — not papered
  over with a test asserting a difference that may not exist.
- **SD6 ✅ (2026-08-28).** The three limits `STATUS.md` names were already at
  their boundaries. The sweep found the gaps in `/toolSource` instead — six
  bare numeric literals now named and explained, and two options interfaces
  that had **no JSDoc at all**, so a caller meeting `maxResponseBytes` or
  `timeout` could not learn the default without reading source. That is the
  shape SD6 is about: a limit that exists, is reachable, and is written down
  nowhere the person hitting it will look. Full inventory, including what was
  checked and found sound, in
  [plan-durability-hardening.md](./plan-durability-hardening.md).

## Design threads opened 2026-08-27 — not ranked here

Six documents written in one pass, now partly implemented, each stating its own
sequence. They are listed rather than ranked because
[plan-primitives.md](./plan-primitives.md) argues the ordering between them, and
that argument does not compress into a row.

| thread | first step |
| --- | --- |
| [plan-primitives.md](./plan-primitives.md) | first reference coding agent ✅; gateway/declarative references remain |
| [plan-mcp-frontend.md](./plan-mcp-frontend.md) | shared host + controls + status/respond + elicitation + history/pending resources ✅; events need a finite log read, progress/cancellation need MCP fixes, skill prompts need permission-aware loading |
| [research-tool-sources.md](./research-tool-sources.md) | `ToolSource` seam, OpenAPI, and per-invocation auth headers ✅; GraphQL ✅ — variables instead of interpolation, `$defs` hoisting for recursive input types (#26, #27 closed) |
| [plan-integrations.md](./plan-integrations.md) | `SandboxConformance`, broken once against a deliberately wrong provider |
| [plan-deployment.md](./plan-deployment.md) | portable `workerd` typecheck + bundle ✅; a real Worker/DO host remains |
| [research-code-mode.md](./research-code-mode.md) | signature generation and the budgeted catalog, which are useful with no interpreter at all |

The two cheapest probes both passed. The coding reference exposed the missing
Elicitation export; the `workerd` bundle found no new portability exception.
The first integration-axis slice also landed. Its execution test exposed and
fixed an `any` service requirement in both generic and MCP discovered toolkits.

## Medium, not first

- **`plan-branching-and-compaction.md` phases 1–7** ✅ — landed 2026-08-27.
  Ten existing behavior tests stayed green; pure cut preparation, token-budget
  policy, portable approximate estimation, exact error-channel inference, and
  the Schema checkpoint are covered. The checkpoint keeps token counts in
  `Option`: the message policy has no tokenizer. Effect `KeyValueStore`
  persistence survives transform recreation, structured summaries preserve
  provider-neutral usage, and the transcript serializer bounds tool results
  without copying file payloads. A separate checkpoint-store noun and generic
  typed details were rejected until they have real independent consumers.
  Phases 8–15 remain the larger controller/branch work below.

## Hard / not this pass

| Plan | Why not |
| --- | --- |
| ~~`plan-durability-hardening.md` remaining~~ | **Not hard any more: H3, H6 and H9 all landed 2026-08-26.** The multi-node fixture runs. SD2 and SD6 were both closed 2026-08-28. This plan is complete. |
| `plan-a2a-layers-bridges.txt` | New packages: spawn Claude Code / OpenCode as A2A agents. |
| `plan-relay.txt` | 16 phases: NAT, WSS, enrollment, RPC-over-relay. After other work. [plan-deployment.md](./plan-deployment.md) §6.3 narrows when it is actually the right tool — and §6.2 covers the fronting cases that do not need it. |
| [opencode-completion-plan.md](./opencode-completion-plan.md) / [effect-plan-2.txt](./effect-plan-2.txt) | New architecture (`SessionInbox`, `ProcessManager`). Design brief; `effect-plan-2.txt` has the related-docs map and §38 implementation order (ChildProcess and EventLog spikes already closed). |
| Filetypes phases 2–5 | Blob store, every protocol’s media projection. |
| Compaction phases 8–15 | Manual compact API, branch summaries, durable summarizer activities. |
