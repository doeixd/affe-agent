# Examples

Every file under [`examples/`](../examples/) is typechecked by `npm run
typecheck`. The ones marked *runs in CI* also execute, against the scripted
`TestLanguageModel`, as part of `npm run check`.

## Start here

- [`getting-started.ts`](../examples/getting-started.ts) — the agent from
  [getting-started.md](./getting-started.md), verbatim: one typed agent
  against the scripted model, no key. `test/GettingStarted.test.ts` pins the
  two together. *Runs in CI.*
- [`typed-agent.ts`](../examples/typed-agent.ts) — a fully typed agent, with
  compile-time assertions that inference stays precise. *Runs in CI.*
- [`authoring.ts`](../examples/authoring.ts) — the pipeable and object
  authoring styles, bound tools, a bundle and `Agent.run`
- [`anthropic.ts`](../examples/anthropic.ts) — a real provider
- [`testing.ts`](../examples/testing.ts) — deterministic agent tests with the
  scripted model
- [`elicitation.ts`](../examples/elicitation.ts) — pausing a run for a human,
  through the published export map
- [`permissions.ts`](../examples/permissions.ts) — allow, ask, deny between
  the model's request and the tool
- [`dynamic-capabilities.ts`](../examples/dynamic-capabilities.ts) — a
  per-tenant toolkit resolved per turn from a service in the agent's context
- [`execution-plan.ts`](../examples/execution-plan.ts) — provider fallback:
  try one model, then another
- [`openrouter.ts`](../examples/openrouter.ts) — a model gateway as ordinary
  provider configuration: where routing lives, and what a gateway does to
  budgets
- [`marketing-copy.ts`](../examples/marketing-copy.ts) — the "generate,
  evaluate, maybe regenerate" chain, once at each level

## Reference implementations

Built only from the public surface, with compile-time assertions that
inference stayed precise. All *run in CI* as the `smoke:ref-*` scripts.

- [`pr-review.ts`](../examples/pr-review.ts) — a pull-request reviewer from
  parts that already exist: `Presets.coding`, an `AgentOutput` for a typed
  verdict, `Budget.within` for the ceiling, `Evals` for what it spent
- [`ref-coding-agent.ts`](../examples/ref-coding-agent.ts) — the coding
  agent, over `Presets.coding`
- [`ref-gateway.ts`](../examples/ref-gateway.ts) — an integration gateway:
  tool sources, credentials, per-tool policy and one host
- [`ref-declarative.ts`](../examples/ref-declarative.ts) — state, its
  rendering into the prompt, capability rules and event reactions, each as
  one declaration
- [`ref-delegation.ts`](../examples/ref-delegation.ts) — one policy governing
  a bridged Claude Code and a bridged OpenCode, both entering as ordinary
  tools

## Sandbox and coding

- [`sandbox.ts`](../examples/sandbox.ts) — user-defined coding tools over the
  sandbox seam; provider swap is one line of layer wiring
- [`coding-agent.ts`](../examples/coding-agent.ts) — the shipped `/coding`
  battery behind a permission policy
- [`web-agent.ts`](../examples/web-agent.ts) — the `/web` battery: search and
  guarded fetch as a separate capability from the filesystem
- [`code-mode.ts`](../examples/code-mode.ts) — many tools reaching the model
  as one `execute` tool over a confined interpreter
- [`subagent.ts`](../examples/subagent.ts) — a lead agent that delegates to a
  child running under its own model

## Transports

- [`http.ts`](../examples/http.ts) — serve an agent over HTTP
- [`rpc.ts`](../examples/rpc.ts) — serve an agent over Effect RPC
- [`agent-server-auth.ts`](../examples/agent-server-auth.ts) — several
  agents on one server, with separate authentication and authorization per
  mount
- [`ag-ui.ts`](../examples/ag-ui.ts) — serve an agent to an AG-UI front end
- [`a2a.ts`](../examples/a2a.ts) — serve an agent over A2A so other agents
  can call it
- [`openai-compat.ts`](../examples/openai-compat.ts) — an agent behind an
  OpenAI-compatible endpoint
- [`mcp.ts`](../examples/mcp.ts) — expose an agent as an MCP tool
- [`mcp-frontend.ts`](../examples/mcp-frontend.ts) — a portable MCP frontend
  over the application-owned session host; a complete cast-free stdio
  composition
- [`connectors.ts`](../examples/connectors.ts) — a Slack webhook that
  verifies, dedupes, prompts and replies
- [`host-events.ts`](../examples/host-events.ts) — one stream for a whole
  host, folded into a read model per session. *Runs in CI.*

## Durability

- [`durable.ts`](../examples/durable.ts) — durable execution and the cluster
  client; the snippets in [guide-durable.md](./guide-durable.md) are lifted
  from it, so they are type-checked rather than prose
- [`durable-client.ts`](../examples/durable-client.ts) — one program over
  `AgentClient`, run locally and durably by swapping a Layer; three clients
  addressing one durable session
- [`durable-resume.ts`](../examples/durable-resume.ts) — four processes over
  one SQLite file: a conversation outlives its process, a submission whose
  process dies mid-tool is finished by the next one, and the model call
  already made is replayed rather than re-issued (`npm run
  smoke:durable-resume`, about 20 s)
- [`deploy-cloudflare/`](../examples/deploy-cloudflare/) — the Alchemy stack
  that deploys `apps/worker` to Cloudflare: one Worker, one SQLite-backed
  Durable Object namespace, one DO per session

## Batteries

- [`state.ts`](../examples/state.ts) — a plan the agent fills in as typed
  state, shown to the model and persisted to SQLite
- [`skills.ts`](../examples/skills.ts) — a support agent that advertises
  skill metadata and loads a body on demand
- [`memory.ts`](../examples/memory.ts) — an assistant with long-term memory,
  against the built-in store and a bring-your-own backend
- [`compaction.ts`](../examples/compaction.ts) — compaction as a pure
  `ContextTransform`
- [`budget.ts`](../examples/budget.ts) — a token budget enforced through the
  loop seam
- [`session-tree.ts`](../examples/session-tree.ts) — a conversation as a
  tree: two lanes from one node, the divergence point, and the transcript an
  activation hands back. *Runs in CI.*
- [`evals.ts`](../examples/evals.ts) — one behavioural eval run against both
  a scripted model and a real provider
- [`observability.ts`](../examples/observability.ts) — tracing a run with the
  standard semantic attributes and a redaction policy
- [`tracing.ts`](../examples/tracing.ts) — OTLP export
- [`data.ts`](../examples/data.ts) — a tool emitting typed records to a UI
  channel while the run proceeds
- [`hooks.ts`](../examples/hooks.ts) — typed lifecycle hooks logging tool and
  run events over a session
- [`scheduling.ts`](../examples/scheduling.ts) — a tool that schedules a
  follow-up run, and a resilient cron digest
- [`agent-plugins.ts`](../examples/agent-plugins.ts) — load an Agent Plugins
  package (skills + MCP servers) into an agent
- [`full-stack-agent.ts`](../examples/full-stack-agent.ts) — coding, skills,
  memory, typed state and permissions composed in one agent, every
  capability arriving through the ordinary seams and one merged layer
