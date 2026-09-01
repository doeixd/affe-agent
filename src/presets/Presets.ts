import { Layer } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as AgentLoop from "../AgentLoop.js"
import * as ContextTransform from "../ContextTransform.js"
import * as Permission from "../Permission.js"
import * as ToolExecution from "../ToolExecutionPublic.js"
import * as AgentClient from "../client/AgentClient.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"
import * as Sandbox from "../sandbox/Sandbox.js"
import * as WorkspaceManager from "../sandbox/WorkspaceManager.js"

/**
 * Opinionated assemblies over the primitives
 * (`docs/plan-primitives.md` §3B, §7 step 4).
 *
 * Thirty-plus modules with no recipe means every target re-derives the
 * same wiring, and the ones that get it subtly wrong do not find out.
 * These are that recipe -- and they are **derived, not designed**: each
 * one is what `examples/ref-coding-agent.ts` and `examples/ref-gateway.ts`
 * had to write by hand, which is why the plan says a preset built before
 * its first two callers is a guess.
 *
 * Three rules, from the plan's invariants:
 *
 * 1. **Compose, never extend.** A preset is layer composition plus
 *    defaults. Nothing here has an execution model, a new type parameter
 *    on `Agent.make`, or behaviour a package should own instead.
 * 2. **Every piece stays reachable.** Each preset returns the parts it
 *    assembled -- the agent, the layers, the policy -- so a caller takes
 *    what it wants and drops to the primitives for the rest. There is no
 *    opaque handle here and there should never be one.
 * 3. **A missing capability is a finding about the primitives**, not a
 *    licence to grow the preset.
 *
 * Deliberately absent: a chat preset. The plan names one, but nothing in
 * this repository calls it yet, and a preset with no caller is the guess
 * rule 1 exists to prevent. It arrives with its first two callers.
 */

// ---------------------------------------------------------------------------
// Coding agent
// ---------------------------------------------------------------------------

/**
 * The default a coding agent should have to *opt out of*, not into.
 *
 * Reads and searches run; anything that changes the workspace or runs a
 * command asks, and an unclassified action asks too. The failure this
 * prevents is the quiet one: a policy that allows writes because nobody
 * wrote a rule for them.
 */
export const codingPolicy: Permission.Policy = Permission.rules(
  [
    { action: "read", decision: Permission.allow },
    { action: "search", decision: Permission.allow },
    { action: "write", decision: Permission.ask("about to modify the workspace") },
    { action: "shell", decision: Permission.ask("about to run a shell command") }
  ],
  { otherwise: Permission.ask("unclassified action") }
)

const CODING_INSTRUCTIONS =
  "You edit code inside a workspace. Read before you write, prefer edit_file over write_file, and run tests with the shell."

/**
 * What a preset adds on top of an ordinary `Agent.make` config.
 *
 * Only the extras are declared here. The agent's own fields arrive as
 * `Agent.Config<...>` with every one of its type parameters left free,
 * and that shape is load-bearing twice over -- both failures were real,
 * and both were caught rather than reasoned about:
 *
 * - **Restating the fields** (an early version named `toolkit`, `loop`
 *   and `contextTransform` itself) fixes the error and requirement
 *   parameters to `never`, which rejects exactly the agents worth
 *   building: a toolkit whose handlers need a sandbox, a transform that
 *   can fail. Both references stopped compiling.
 * - **Widening to a bare `object`** compiles, and silently erases the
 *   tool names from the agent it hands back -- a preset that takes away
 *   more than it gives. `test/Presets.test.ts` pins this; breaking the
 *   type back to `object` fails that assertion.
 */
export interface CodingExtras {
  /** Where the workspace lives. Memory, local, or a derived remote one. */
  readonly sandbox: Layer.Layer<Sandbox.SandboxProvider>
  /** Names the workspace this agent acquires. Defaults to `workspace`. */
  readonly workspace?: string | undefined
  /**
   * Share the workspace through a manager instead of acquiring it privately.
   *
   * Without one, this preset calls `Sandbox.currentLayer`, which acquires per
   * layer -- and the local provider makes a fresh temporary directory per
   * acquisition. Two agents naming the same workspace therefore get two
   * directories, and each dies with the scope that built it. Pass a shared
   * `WorkspaceManager` and they get one, reference-counted, outliving either.
   *
   * Opt-in rather than the default because it changes a lifetime, and a
   * caller relying on a private throwaway directory per agent should not have
   * that quietly become a shared one. `docs/effect-plan-2.txt` §12-13.
   */
  readonly workspaces?: WorkspaceManager.Service | undefined
}

/**
 * A coding agent: toolkit, a policy that asks before it changes anything,
 * and an acquired workspace.
 *
 * ```ts
 * const coder = Presets.coding({
 *   toolkit: CodingToolkit.toolkit(),
 *   sandbox: MemorySandbox.layer({ seed })
 * })
 * const session = yield* AgentSession.make(coder.agent, { elicitation: Elicitation.memory })
 * ```
 *
 * Everything is reachable: `coder.agent` is an ordinary definition the
 * authoring combinators accept, and `coder.workspace` an ordinary layer.
 */
export const coding = <
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never,
  KE = never,
  KR = never,
  Bound extends ReadonlyArray<Agent.BoundTool<Tool.Any>> = [],
  PR = never
>(
  options: Agent.Config<Tools, LE, LR, TE, TR, KE, KR, Bound, PR> & CodingExtras
) => {
  const { sandbox, workspace, workspaces, ...agentConfig } = options
  return {
    agent: Agent.make({
      instructions: CODING_INSTRUCTIONS,
      permission: codingPolicy,
      loop: AgentLoop.bounded(10),
      // A coding agent re-sends large instructions and a large toolkit every
      // turn, so the prefix cache is the biggest saving available to it and
      // the one a caller is least likely to think of. Anthropic-only by
      // default -- see `cacheBreakpoint`, where the asymmetry is argued.
      contextTransform: ContextTransform.cacheBreakpoint(),
      // The caller's config last: every default above is one a caller can
      // simply set, and none of them is behaviour this module owns. That
      // is "compose, never extend" in code.
      ...agentConfig
    }),
    workspace: workspaces === undefined
      ? Layer.provide(
        Sandbox.currentLayer(Sandbox.workspace(workspace ?? "workspace")),
        sandbox
      )
      : workspaces.layer(Sandbox.workspace(workspace ?? "workspace"))
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/** What a gateway adds on top of an ordinary `Agent.make` config. */
export interface GatewayExtras<Principal> {
  /** Who is calling. The host resolves it once, per request. */
  readonly principal: AgentSessionHost.Options<Principal>["principal"]
  /**
   * The caller as an opaque subject, put on the fibre the tools run on.
   *
   * Not optional, and that is the point of the preset: a gateway that
   * forgets this is one where every caller shares the org's credential,
   * and nothing about it looks wrong. `Credentials.resolveFor` reads
   * exactly this.
   */
  readonly subject: (principal: Principal) => string
  readonly authorization: AgentSessionHost.Options<Principal>["authorization"]
  readonly maxSessions?: number | undefined
  readonly maxRequestsPerSession?: number | undefined
}

/**
 * A gateway: source-bound tools behind one host that knows who is
 * calling.
 *
 * Two defaults are the recipe. A refusal is **returned to the model**
 * rather than failing the run -- a gateway's job is to keep serving the
 * caller it just refused -- and the caller's `subject` is required
 * rather than optional, because a gateway that omits it silently gives
 * every caller the org's credential.
 *
 * ```ts
 * const Host = AgentSessionHost.Tag<User>("app/host")
 * const gw = Presets.gateway({ toolkit, principal, subject, authorization })
 * const layer = gw.host(Host).pipe(Layer.provide(model))
 * ```
 */
export const gateway = <
  Principal,
  Tools extends Record<string, Tool.Any> = {},
  LE = never,
  LR = never,
  TE = never,
  TR = never,
  KE = never,
  KR = never,
  Bound extends ReadonlyArray<Agent.BoundTool<Tool.Any>> = [],
  PR = never
>(
  options:
    & Agent.Config<Tools, LE, LR, TE, TR, KE, KR, Bound, PR>
    & GatewayExtras<Principal>
) => {
  const {
    authorization,
    maxRequestsPerSession,
    maxSessions,
    principal,
    subject,
    ...agentConfig
  } = options
  const agent = Agent.make({
    permission: Permission.allowAll,
    // The gateway default: a refused call is told to the model, not a
    // failed run. The caller asked for something it may not have; the
    // connection is still good.
    toolDenialPolicy: ToolExecution.ReturnToModel,
    loop: AgentLoop.bounded(8),
    // The caller's config last: every default above is one a caller can
    // simply set, and none of them is behaviour this module owns.
    ...agentConfig
  })
  return {
    agent,
    host: (tag: AgentSessionHost.Tag<Principal>) =>
      AgentSessionHost.layer(tag, {
        principal,
        subject,
        authorization,
        maxSessions: maxSessions ?? 64,
        maxRequestsPerSession: maxRequestsPerSession ?? 256
      }).pipe(Layer.provide(AgentClient.layer(agent)))
  }
}
