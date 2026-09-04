import { Context, Duration, Effect, Layer, LayerMap } from "effect"
import type { Scope } from "effect"
import {
  Current,
  type ProviderError,
  type Sandbox,
  SandboxProvider,
  currentLayer,
  type Workspace
} from "./Sandbox.js"

/**
 * A workspace that outlives whoever asked for it first.
 *
 * `docs/effect-plan-2.txt` §12–13. Acquiring a sandbox is `Scope`-bound, and
 * the local provider makes a fresh temporary directory per acquisition unless
 * a `workspaceRoot` is configured. Two callers naming the same workspace
 * therefore get two different directories, and each one dies with the scope
 * that acquired it. That is fine while everything a sandbox does is a bounded
 * command inside a single tool call, and it stops being fine the moment
 * anything outlives that call:
 *
 * ```text
 * session opens a workspace
 *   → a tool starts something in it
 *     → the tool's scope ends
 *       → the directory is gone
 *         → a later tool cannot see what the first one wrote
 * ```
 *
 * So workspaces need an owner that is not any one holder. This is that owner:
 * a keyed, **reference-counted** map, where a workspace is built on first
 * request, shared by every subsequent one, and released only once the last
 * holder has gone *and* stayed gone for `idleTimeToLive`.
 *
 * The idle window is the part worth understanding. Without it, two tool calls
 * in the same conversation would tear the workspace down between them --
 * reference counting alone drops to zero the instant the first holder
 * releases. The window is what makes "the same workspace across calls" true
 * without making it "forever".
 *
 * ## Why `LayerMap`
 *
 * The resource genuinely *is* a layer: `Sandbox.currentLayer(workspace)`.
 * `LayerMap` is `RcMap` specialised to that, and `RcMap` is already how
 * `src/tree/SessionTree.ts` owns live branches, for the same reason stated the
 * same way -- a keyed scoped resource with a varying number of holders should
 * be released when the last of them goes, rather than when something guesses.
 *
 * `audit-effect-ecosystem.md` E4 rejected `LayerMap` for the agent server's
 * *static* routes, because `HttpRouter.use` binds paths when the layer is
 * built rather than on first request. It reserves `LayerMap` for a different,
 * still-unbuilt design -- the agent server with the agent name as a path
 * parameter -- so that finding neither blesses nor forbids this use; it simply
 * does not conflict with it.
 *
 * ## What this must not become
 *
 * **It must not own a process.** §13 is explicit and the reasoning is right: a
 * process is *managed* precisely because it outlives its handles, so reference
 * counting would kill it exactly when the last handle drops -- which is the
 * opposite of what a managed process is for. Workspaces are reference-counted
 * because every holder genuinely needs one alive; processes will need a
 * `FiberMap` and a store, owned by their manager rather than by their callers.
 * Nothing here should grow in that direction.
 */

/**
 * How long a workspace with no holders is kept before release.
 *
 * Long enough to span the gap between two tool calls in one conversation,
 * short enough that an abandoned workspace is not a leak. A caller that wants
 * a workspace to persist for a whole session should hold it for the session,
 * which is what reference counting is for -- not raise this.
 */
export const defaultIdleTimeToLive = Duration.seconds(30)

export interface Options {
  /** Defaults to {@link defaultIdleTimeToLive}. */
  readonly idleTimeToLive?: Duration.Input | undefined
}

export interface Service {
  /**
   * The workspace's sandbox, for as long as the calling scope holds it.
   *
   * Shared: two callers naming the same workspace get the same `Sandbox`, and
   * it survives either of them releasing.
   */
  readonly acquire: (
    workspace: Workspace
  ) => Effect.Effect<Sandbox, ProviderError, Scope.Scope>
  /**
   * The same thing as a `Layer`, for wiring rather than for calling.
   *
   * This is what replaces a bare `Sandbox.currentLayer(w)` in an application's
   * composition: same service, shared lifetime.
   */
  readonly layer: (workspace: Workspace) => Layer.Layer<Current, ProviderError>
  /**
   * Drop a workspace now, regardless of holders or idle time.
   *
   * For an operator forcing a rebuild, not for ordinary release. Existing
   * holders keep the sandbox they already have -- their scopes still own what
   * they were handed -- but the next `acquire` builds a fresh one.
   */
  readonly invalidate: (workspace: Workspace) => Effect.Effect<void>
}

export class WorkspaceManager extends Context.Service<
  WorkspaceManager,
  Service
>()("affe-agent/sandbox/WorkspaceManager") {}

export const make = (
  options?: Options
): Effect.Effect<Service, never, Scope.Scope | SandboxProvider> =>
  Effect.gen(function* () {
    const workspaces = yield* LayerMap.make(
      (workspace: Workspace) => currentLayer(workspace),
      {
        idleTimeToLive: options?.idleTimeToLive ?? defaultIdleTimeToLive
      }
    )
    return {
      acquire: (workspace) =>
        Effect.map(workspaces.contextEffect(workspace), (context) =>
          Context.get(context, Current)),
      layer: (workspace) => workspaces.get(workspace),
      invalidate: (workspace) => workspaces.invalidate(workspace)
    }
  })

export const layer = (
  options?: Options
): Layer.Layer<WorkspaceManager, never, SandboxProvider> =>
  Layer.effect(WorkspaceManager, make(options))
