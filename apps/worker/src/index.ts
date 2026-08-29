/**
 * Workerd portability probe — `docs/plan-deployment.md` §10 Sequence 1.
 *
 * **What this establishes, exactly:** every module named below *resolves,
 * typechecks and bundles* under `lib: ["DOM","WebWorker"]` with `types: []` --
 * no `node:*`, no `@effect/platform-node`, no `Buffer`, `process` or
 * `__dirname` reachable through any of them. That is the compile-time half of
 * the portability fence, and it is the half `scripts/verify-portability.mjs`
 * cannot see, because a stray import only shows up once the types are resolved.
 *
 * **What it does not establish:** that any of this *runs*. The bindings below
 * are referenced, not exercised, and the `fetch` handler returns a constant.
 * `Agent.make` for `Coder` is the one construction that does real work, and it
 * is the model for widening this later: assemble a `Layer` from the portable
 * pieces and route `request` through `AgentHttp` with a `MemorySandbox` and a
 * stub model. Until then, read the claim as "imports are portable", not "the
 * core is known to work on workerd".
 *
 * Keep imports portable-only. `sandbox/local`, `connectors/slack` (now portable),
 * `apps/cli`, and any `node:*` import must stay out — they belong in their own
 * entry and in `HOST_MODULES`.
 */

import { Agent, AgentLoop, AgentSession, Elicitation, Permission } from "@doeixd/effect-agent"
import { CodingToolkit } from "@doeixd/effect-agent/coding"
import { Compaction } from "@doeixd/effect-agent/compaction"
import { Sandbox, MemorySandbox } from "@doeixd/effect-agent/sandbox"
import { Memory } from "@doeixd/effect-agent/memory"
import { AgentClient, AgentSessionHost } from "@doeixd/effect-agent/client"
import { AgentHttp } from "@doeixd/effect-agent/http"
import { Effect, Layer } from "effect"

// One small agent that exercises the portable seams only — the same shape
// `examples/ref-coding-agent.ts` proves on Node, but here on workerd types.
const Coder = Agent.make({
  instructions: "You edit code inside a workspace.",
  toolkit: CodingToolkit.toolkit(),
  permission: Permission.rules([{ action: "read", decision: Permission.allow }], {
    otherwise: Permission.ask()
  }),
  loop: AgentLoop.bounded(4)
})

void Coder
void Compaction
void Memory
void AgentSession
void Elicitation
void Sandbox
void MemorySandbox
void AgentClient
void AgentSessionHost
void AgentHttp

// Ensure a Layer can be assembled without a host provider — the portable shape
// a Worker would actually serve. No `SandboxProvider` concrete import here.
const portableLayer = Layer.empty
void portableLayer

// Workerd `fetch` entry shape, deliberately not importing `node:http`.
export default {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(request: Request, _env: unknown, _ctx: unknown): Promise<Response> {
    // The body is intentionally trivial — this file's job is to prove the core
    // typechecks and bundles for workerd, not to serve traffic. A real Worker
    // would route `request` to `AgentHttp`/`AgentSessionHost` inside a DO.
    void request
    return new Response("effect-agent workerd probe — portable core loads", {
      headers: { "content-type": "text/plain" }
    })
  }
}

// Compile-time portability fence: if any of the above imports pulled in a
// `node:*` type, `lib: ["DOM","WebWorker"]` with `types: []` would surface it
// as the stray import `verify-portability.mjs` checks for at the source level.
