# Changelog

All notable changes to `@doeixd/effect-agent` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1]

First prerelease. Built on **Effect v4** (`effect@>=4.0.0-rc.111`); the
AI modules are used in-tree from `effect/unstable/ai`.

The design bet, stated once: the kernel vocabulary stays small, and everything
higher-level is built *from* it rather than into it. Nothing below the core is a
new engine concept — each is an ordinary composition of a tool, a service, a
context transform, or a layer, and end-user code needs no type casts.

### Core

- **Agent kernel** — `Agent` (a reusable definition that carries no model),
  `AgentSession` (a method-bearing session handle), and the internal vocabulary
  beneath it: submissions, runs, atomic turn commit, the continuation `AgentLoop`,
  Schema-defined `AgentEvent`s with correlation envelopes, and `ContextTransform`
  (canonical history → the ephemeral model prompt).
- **Steering and follow-ups** — out-of-band input through substitutable input
  channels, with FIFO ordering and a closed quiescence race.
- **Interruption** — ordinary fiber interruption; no bespoke cancellation
  protocol crosses a boundary.
- **Model streaming** — a stream/batch join via a stream accumulator, defined
  consistently for both generation modes and under durable execution.
- **Elicitation** — a run that pauses for an answer from outside, across the
  transport seam and durable execution (a paused run can outlive its process).
- **Permissions** — `allow` / `ask` / `deny` between the model's request and the
  tool, with a policy seam, typed projections, an intrinsic-approval floor, and
  `except` carve-outs.
- **Snapshots** — a conversation is a value: capture an idle session and restore
  it, identity intact.
- **Compaction** — summarise the head, keep the tail; a `ContextTransform` and
  nothing more.

### Packages (subpath exports; core depends on none of them)

- `@doeixd/effect-agent/testing` — a deterministic scripted model and a
  lifecycle probe.
- `@doeixd/effect-agent/durable` — the same agent definition inside an Effect
  `Workflow`: model and tool calls become activities, so a resumed submission
  replays them instead of repeating them.
- `@doeixd/effect-agent/cluster` — a session as a cluster entity.
- `@doeixd/effect-agent/client` — a protocol-neutral session transport, and one
  shared `AgentSessionHost` across adapters.
- `@doeixd/effect-agent/rpc`, `/http`, `/ag-ui`, `/a2a` — Effect RPC, plain JSON
  + live SSE, the AG-UI protocol, and an A2A v1 adapter with input-required
  continuation.
- `@doeixd/effect-agent/mcp` (+ `/mcp/v1`, `/mcp/v2`) — expose an agent over MCP
  and bind tools from an MCP server by declare-and-verify.
- `@doeixd/effect-agent/openai` — OpenAI-compatible chat completions over any
  `AgentClient`.
- `@doeixd/effect-agent/durable-streams` — official Durable Streams as typed
  streams, and the durable client's delivery log.
- `@doeixd/effect-agent/sandbox` (+ `/sandbox/local`) — a scoped
  filesystem-and-process capability that tools demand through the requirement
  channel; deterministic in memory, or a real directory on disk.
- `@doeixd/effect-agent/coding` — a coding-agent tool battery (read/write/edit
  files, list, in-process search, bash) over the sandbox seam, each tool
  permission-projected.
- `@doeixd/effect-agent/subagent` — a tool that opens a child session under its
  own model; isolation and interruption fall out of structured concurrency.
- `@doeixd/effect-agent/state` — persistent typed agent state a tool reads and
  writes, surfaced into the prompt and persisted through a store (memory or SQL).
- `@doeixd/effect-agent/skills` — on-demand skills: advertise metadata, load a
  body lazily through a tool, gated by a `skill` permission projection.
- `@doeixd/effect-agent/memory` — long-term, cross-session memory as a service
  plus a recall transform; non-fatal by default, bring your own backend.
- `@doeixd/effect-agent/evals` — behavioural evals over the public session
  interface: assert on tools called, turns, reply shape, an LLM judge; run the
  same eval against a scripted model or a real provider.

### Guarantees

- **No casts in user code.** `examples/typed-agent.ts` is a fully typed agent
  with zero casts and zero annotated parameters, carrying compile-time
  assertions that inference stays precise.
- **Portability is checked.** Only `@doeixd/effect-agent/sandbox/local` reaches
  the host; every other entry point is verified to import no `node:*` module.
- **Every published entry point is import-verified** from the packed tarball by
  `npm run verify:package` (28 entries).

[0.0.1]: https://github.com/doeixd/effect-agent/releases/tag/v0.0.1
