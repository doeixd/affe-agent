# Changelog

All notable changes to `affe-agent` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- behavior-changes:start -->
### Behaviour changes

- a persisted compaction checkpoint may now be a rollover (`kind: "rollover"`) as well as a summary; summaries decode as before. (`c30de48`; measured by `test/fixtures/compaction-checkpoint.json`)
- none for a caller -- every tag, table default and key prefix keeps its exact value; the fixture records them so a later change cannot pass unmeasured. (`fb22c34`; measured by `test/fixtures/namespace-manifest.json`)
- a delegation whose child was interrupted now fails the parent's tool call with `SubagentInterruptedError` carrying the partial text, instead of succeeding with the partial text as the answer. (`dc2d6d6`; measured by `test/fixtures/namespace-manifest.json`)
- none for a caller -- every error `_tag` keeps its value; the fixture records the bare set so a rename cannot pass unmeasured. (`3e3d1d0`; measured by `test/fixtures/error-tags-manifest.json`)
- the Cloudflare host gains a dispatch-intent table `affe_dispatch` beside `affe_history`; existing tables keep their names and shapes. (`aa506e5`; measured by `test/fixtures/namespace-manifest.json`)
- one identifier, `affe-agent/internal/ParentEvents`, joins the namespace manifest; it is a harness-provided reference and never crosses a wire. `DelegatedEvent` is a new event tag, additive under the tolerant decoder, emitted only for a child made with `Inherit.events: "parent"`; nothing changes on the wire for a caller who does not opt in. (`9a9c255`; measured by `test/fixtures/namespace-manifest.json`)
- `AgentObservationLagError` is a new error tag in the remote error union and the error-tags manifest, delivered as an SSE failure frame or RPC stream error with status 503 where a status is needed; existing tags and statuses are unchanged. An observer of `events` or `stream` that falls more than 2048 envelopes or 8 MiB behind is now ended with it instead of retaining without bound; a consumer that keeps up sees no change. (`df360f9`; measured by `test/fixtures/error-tags-manifest.json`)
- `UnsupportedConversion` is a new error tag in the error-tags manifest, raised only by the optional `affe-agent/effect-uai` adapter when a conversion cannot be represented faithfully; no existing tag, status or wire shape changes, and a caller who does not import that subpath cannot encounter it. (`133d14f`; measured by `test/fixtures/error-tags-manifest.json`)
- `AgentTraceLimitError` is a new error tag in the error-tags manifest, raised only by an `Agent.start` handle's `events` when its retained trace outgrows its bound; the submission, canonical history and durable delivery are unaffected, and no existing tag or wire shape changes. (`33afe17`; measured by `test/fixtures/error-tags-manifest.json`)
- `AgentToolProgressLimitError` is a new error tag in the error-tags manifest, and one submission may now publish at most 8 MiB of tool progress (lowerable through `toolProgress.maxBytes`), failing the offending call and its run rather than truncating the snapshot; a tool that stays under the ceiling sees no change, and no existing tag or wire shape changes. (`893fd9a`; measured by `test/fixtures/error-tags-manifest.json`)
- `RunCompleted` gains an optional `exhaustion` field and `AgentSubmission.Result` an `exhaustion: Option<Exhaustion>` naming which built-in ceiling ended a run ("turns", "tool-calls", "duration", "tokens", "cost"); it is absent for an ordinary stop, a custom policy's own reason and an interruption, the field is optional so a journal written before it still decodes, and `stopReason` is unchanged in both content and meaning. (`959bd9a`; measured by `test/fixtures/run-completed.json`)
- `AgentExhaustedError` is a new error tag in the error-tags manifest, raised only by `onExhaustion: "fail"`; `AgentLoop.Limits.finalTurn` and `Presets.PolicyOptions.finalTurn` are replaced by `onExhaustion: "stop" | "final-answer" | "fail"`, where `"final-answer"` is the old `finalTurn: true` except that it now declines for `maxDuration`, and the default remains stop. (`c57b3dd`; measured by `test/fixtures/error-tags-manifest.json`)
- `ToolExecution.Alone` now rejects the whole batch -- a sibling of an `Alone` call no longer runs and gets the new `ToolBatchRejectedError` -- and the `AgentOutput` tool is `Alone`, so an answer beside another call is refused and the model asked again; `AgentLoop.State` has a new required `outputReported` field, and an agent with an output stops on a committed answer rather than on the call's presence. (`ddd72c8`; measured by `test/fixtures/error-tags-manifest.json`)
- a new `ToolScheduling` kernel module and `affe-agent/ToolScheduling/Current` reference (default: no constraint), and a durable submission now journals an `execution-strategy` activity so a recovered attempt runs its tools with the strategy it was admitted with rather than the replacement process's. (`5b79340`; measured by `test/fixtures/namespace-manifest.json`)
- a durable submission journals a `contract-digests` activity at its first execution and refuses a replay whose tools changed or were removed with `ToolContractChangedError` (a new error tag); a recorded `new_context` result that does not decode now fails the turn instead of being ignored. (`bc40db7`; measured by `test/fixtures/error-tags-manifest.json`)
- a new `ToolExposure` kernel module and `Agent` field (default `eager()`, unchanged requests); under a visibility rule or progressive exposure the model is sent a `toolChoice.oneOf` subset and a call outside it is refused with the new `ToolNotExposedError`. (`2772b6f`; measured by `test/fixtures/error-tags-manifest.json`)
- a corrupt persisted compaction checkpoint no longer fails the turn; it is discarded, reported as CompactionCheckpointDiscarded, and rebuilt. Old checkpoints are rebuilt once under the new fingerprint. (`0b289f9`; unmeasured)
- subagent delegation is now refused past 8 levels by default (SubagentDepthExceededError); pass maxDepth to change it. (`a165708`; measured by `test/fixtures/namespace-manifest.json`)
- CloudflareHost.make now requires principal and authorization, and RelayServer.layer requires authorization; the allow-everything defaults and the header-as-principal default are gone. (`9342c8e`; unmeasured)
- AgentSession.Snapshot has a required version field (1), written by snapshot and by exports; snapshots without one still decode as version 1, and an unknown version is refused. (`4acc464`; unmeasured)
- the default Memory.recall rendering adds a line when more memories matched than were shown; DeliveryLogConformance gains a paging case, so a log that ignores read limit now fails it. (`3783b93`; unmeasured)
<!-- behavior-changes:end -->

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

- `affe-agent/testing` — a deterministic scripted model and a
  lifecycle probe.
- `affe-agent/durable` — the same agent definition inside an Effect
  `Workflow`: model and tool calls become activities, so a resumed submission
  replays them instead of repeating them.
- `affe-agent/cluster` — a session as a cluster entity.
- `affe-agent/client` — a protocol-neutral session transport, and one
  shared `AgentSessionHost` across adapters.
- `affe-agent/rpc`, `/http`, `/ag-ui`, `/a2a` — Effect RPC, plain JSON
  + live SSE, the AG-UI protocol, and an A2A v1 adapter with input-required
  continuation.
- `affe-agent/mcp` (+ `/mcp/v1`, `/mcp/v2`) — expose an agent over MCP
  and bind tools from an MCP server by declare-and-verify.
- `affe-agent/openai` — OpenAI-compatible chat completions over any
  `AgentClient`.
- `affe-agent/a2a` also bridges an external runtime *in*:
  `ClaudeCodeA2A.remote` presents Anthropic's Claude Code CLI as a
  `RemoteAgent`, spawned through `Sandbox.execStream` inside a workspace, with
  the A2A context mapped to the CLI's own session. `AgentA2A.tool` then makes it
  an ordinary tool, so no new concept is needed to delegate to it.
  `ClaudeCodePermissions` puts this application's `Permission` policy and
  `Elicitation` in front of the CLI's own tool calls, in `/coding`'s action
  vocabulary — one rule set for both runtimes. `OpenCodeA2A` bridges an
  `opencode serve` over its HTTP API with the same surface, answering its
  native permission requests from the same policy.
- `affe-agent/durable-streams` — official Durable Streams as typed
  streams, and the durable client's delivery log.
- `affe-agent/sandbox` (+ `/sandbox/local`) — a scoped
  filesystem-and-process capability that tools demand through the requirement
  channel; deterministic in memory, or a real directory on disk. Commands can
  be run to a result (`exec`) or watched while they run (`execStream`), with
  `lines` decoding across chunk boundaries and `collect` folding events back to
  a result; a provider that cannot stream gets the derivation and is reported
  as derived.
- `affe-agent/coding` — a coding-agent tool battery (read/write/edit
  files, list, in-process search, bash) over the sandbox seam, each tool
  permission-projected.
- `affe-agent/subagent` — a tool that opens a child session under its
  own model; isolation and interruption fall out of structured concurrency.
- `affe-agent/state` — persistent typed agent state a tool reads and
  writes, surfaced into the prompt and persisted through a store (memory or SQL).
- `affe-agent/skills` — on-demand skills: advertise metadata, load a
  body lazily through a tool, gated by a `skill` permission projection.
- `affe-agent/memory` — long-term, cross-session memory as a service
  plus a recall transform; non-fatal by default, bring your own backend.
- `affe-agent/evals` — behavioural evals over the public session
  interface: assert on tools called, turns, reply shape, an LLM judge; run the
  same eval against a scripted model or a real provider.

### Guarantees

- **No casts in user code.** `examples/typed-agent.ts` is a fully typed agent
  with zero casts and zero annotated parameters, carrying compile-time
  assertions that inference stays precise.
- **Portability is checked.** Only `affe-agent/sandbox/local` reaches
  the host; every other entry point is verified to import no `node:*` module.
- **Every published entry point is import-verified** from the packed tarball by
  `npm run verify:package` (28 entries).

[0.0.1]: https://github.com/doeixd/affe-agent/releases/tag/v0.0.1
