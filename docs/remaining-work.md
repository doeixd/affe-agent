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
| `audit-effect-ecosystem.md` | Most items done |

## Order of work

### 1. `plan-snapshot-export.md` — E4, the JSONL commit log ✅

Landed 2026-08-26. `encodeJsonl` / `parseJsonl` / `headerOf` / `append` on
`/export`. Header line is picker metadata; remaining lines are messages.
EventLog was not adopted (H4b). Delta storage for the tree stays deferred.

### 2. `plan-agent-server.md` — S1 then S2 ✅

Landed 2026-08-26. `AgentHttp.api({ name })`, `AgentServer.mount` / `make` /
`serverLayer`. Duplicate mounts fail at construction. LayerMap deferred:
routes register at layer construction, so lazy mounts do not fit option A.
S3 mixed backing landed 2026-08-26: `AgentHttp.fromGenerated` /
`agentClientLayer` / `agentClientFromServer` adapt HTTP to `AgentClient`;
the shared `AgentClientContract` runs against that adapter; one server
serves a local mount and a remote-backed mount. S4 inventory landed too --
`/inventory`, the `Inventory` / `MountSnapshot` schemas, and a test that
reads it before and after creating a session. **S5, the auth example,
remains** and is the only part of this plan that does.

### 3. `plan-pi-toolkit.md` — second toolkit at `/pi` ✅

P0–P5 landed. `/pi` is a second toolkit: batch `edits[]` (I13–I15), rendered
`list_files`, injectable `Shell`, truncation that names the limit, shared
canonical-path lock with `/coding`. `test/PiToolkit.test.ts`.

### 4. TUI leftover — persist the tree across launches ✅

Live backend writes the tree to `NodeStore.keyValue` outside the workspace
(`apps/tui/src/backend.ts`); `restore.ts` paints a recovered `Prompt`. Smoke
V9 asserts a second launch resumes. Remaining TUI leftovers are live-region
scrolling and syntax highlighting (blocked on OpenTUI parsers).

### 5. Finish the in-progress A2A adapter (`STATUS.md`)

`/a2a` already serves Agent Card, JSON-RPC, streaming and cancel. Two of the
four gaps this used to list have since closed: **input-required continuation**
is covered by two tests in `AgentA2A.test.ts` (pause and resume, and asking
again after a resume), and a **typed client** exists -- `AgentA2A.client`,
`RemoteAgent`, `TypedExchange`.

What is actually left: the **REST binding** (only `GET` the card and one `POST`
for JSON-RPC are routed) and a **reverse peer test** against an official A2A
server.

## Durability: the two success conditions still open

The plan's milestones are done (H1-H9). Two acceptance criteria are not marked:

- **SD2 -- the falsification table is stale evidence.** H2 broke each invariant
  once and recorded which tests bit, over "nine durability test files (121
  tests)". The suite is now 1212 tests across 123 files, and everything the
  matrix rests on has been rewritten since -- conditional writes, resumable
  SSE, multi-node takeover. A guarantee that quietly stopped being enforced
  would not show up anywhere except in re-running those breaks.
- **SD6 -- limits at their boundaries.** A documentation sweep: every known
  limit either fixed or written where a user meets it, not only in
  `STATUS.md`.

## Medium, not first

- **`plan-filetypes.txt` Phase 1** — `Prompt` wire codec. Small idea; it must
  land in HTTP, RPC, durable store, and export at once.
- **`plan-branching-and-compaction.md` phases 1–4** — freeze current
  compaction, extract `prepare`, token budget, Schema checkpoint. Full plan is
  15 phases.
- **Audit leftovers** — A-12 (document unbounded queues) is docs-only. A-8
  (`Config` for poll intervals) is small. A-6 (`PartitionedSemaphore` / `Cache`)
  is more design than coding.

## Hard / not this pass

| Plan | Why not |
| --- | --- |
| ~~`plan-durability-hardening.md` remaining~~ | **Not hard any more: H3, H6 and H9 all landed 2026-08-26.** The multi-node fixture runs. What is left is SD2 and SD6 -- see below. |
| `plan-a2a-layers-bridges.txt` | New packages: spawn Claude Code / OpenCode as A2A agents. |
| `plan-relay.txt` | 16 phases: NAT, WSS, enrollment, RPC-over-relay. After other work. |
| [opencode-completion-plan.md](./opencode-completion-plan.md) / [effect-plan-2.txt](./effect-plan-2.txt) | New architecture (`SessionInbox`, `ProcessManager`). Design brief; `effect-plan-2.txt` has the related-docs map and §38 implementation order (ChildProcess and EventLog spikes already closed). |
| Filetypes phases 2–5 | Blob store, every protocol’s media projection. |
| Compaction phases 8–15 | Manual compact API, branch summaries, durable summarizer activities. |
