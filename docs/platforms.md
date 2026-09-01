# Platforms

Where an agent built on this library runs, and what survives what on each.
One row per host; the words are the ones the code uses.

The portable core (`@doeixd/effect-agent` and every subpath not named below
as a host entry) has no engine requirement: no `node:*`, no `@cloudflare/*`,
enforced by `npm run lint:portability`. What binds to a host is behind its
own entry point, so importing `/sandbox` never pulls in `/sandbox/local`.

| | Node.js | Cloudflare Workers |
| --- | --- | --- |
| **Requirement** | 22.5+, for the host entries only | workerd; `apps/worker` is proven on it through miniflare in CI |
| **Entry** | `/sandbox/local`, `/durable` with `@effect/sql-sqlite-node`, `/cluster` | [`apps/worker`](../apps/worker/src/index.ts) — a reference host to read and copy, not yet a published entry |
| **Execution model** | a process you operate; `/cluster` for more than one | one Durable Object per session, the Worker routing by session id |
| **History** | in memory; `/durable` rebuilds it from the journal, `/tree` persists it to a `NodeStore` | DO SQLite, written as each turn commits and restored when the object wakes |
| **Work that survives the process** | `/durable`: model and tool calls are Workflow activities, so a resumed submission replays them instead of repeating them; `/cluster` reassigns a shard when its owner dies mid-activity | every committed turn and the conversation survive hibernation and death; the turn in flight and its submission do not — the DO equivalent of Node without `/durable` (see the file's header for why the workflow engine is not used there) |
| **Events** | the `DeliveryLog` (SQL or `/durable-streams`); a client resumes with `read({ after })` | the same `DeliveryLog`, in DO SQLite; `events?after=N` is served from the journal then live, gaplessly |
| **Scheduling** | `/scheduling` over Effect's `Schedule`; `/cluster`'s `ScheduledAgent` across nodes | `/scheduling`'s `AgentDispatcher` over a job table in DO SQLite and the object's alarm; a wake re-arms from the table, so a job outlives the runtime that dispatched it |
| **Sandbox** | `/sandbox/local`, real processes | `MemorySandbox`, or `Sandbox.fromExec` over a remote provider |
| **Model** | any `@effect/ai-*` layer | the scripted test model until a deployment wires one; `examples/deploy-cloudflare/` is the Alchemy stack, written and not yet run against an account |
| **Proof** | `npm run verify:durability`, `examples/durable-resume.ts` (four processes, one SQLite file) | `test/WorkerDurableObject.test.ts` on miniflare |

**Bun** is untested. Nothing in the portable core is known to exclude it, and
nothing has been run on it; treat it as unsupported until a smoke says
otherwise.

**Choosing.** Node when you operate a process and a disk, and when a run must
survive that process — that is what `/durable` and `/cluster` are for.
Workers when your application already lives in Durable Objects and a
conversation that outlives its runtime is enough. Both speak the same
`AgentClient`, so a program written against the client seam moves between
them without change ([transport.md](./transport.md)).

A caller still supplies what no host can: the model layer and its
credentials, tool handlers, who the caller is (`AgentSessionHost.Options`)
and what they may do (`Permission`). The [reference
implementations](../STATUS.md#what-ships) show each wired.
