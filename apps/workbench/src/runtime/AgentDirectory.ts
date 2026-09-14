/**
 * Agent profile id -> the existing `AgentClient` contract (plan-workbench.md §4).
 *
 * Every consumer talks to `AgentClient.Service`, whichever profile it named,
 * so a browser, a TUI and a test share one execution API.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Scope } from "effect"
import { AgentClient } from "affe-agent/client"
import { AgentProfileId } from "../domain/WorkbenchIds.js"
import { AgentCatalog } from "../store/AgentCatalog.js"

export class AgentResolutionError extends Schema.TaggedError<AgentResolutionError>()(
  "AgentResolutionError",
  { agentProfileId: AgentProfileId, reason: Schema.Literal("unknown-profile") }
) {}

export interface Service {
  /**
   * Scoped because a real directory builds per-profile wiring (model, tools,
   * policies) and releases it; W0's single-agent directory holds nothing.
   */
  readonly client: (
    id: AgentProfileId
  ) => Effect.Effect<AgentClient.Service, AgentResolutionError, Scope.Scope>
}

export class AgentDirectory extends Context.Service<AgentDirectory, Service>()("workbench/AgentDirectory") {}

/**
 * W0's directory: every profile the catalog knows resolves to one existing
 * agent. What it proves is the seam -- resolution is by profile, failure is
 * typed, the result is the ordinary client -- not per-profile construction,
 * which is W4.
 */
export const single: Layer.Layer<AgentDirectory, never, AgentCatalog | AgentClient.AgentClient> = Layer.effect(
  AgentDirectory,
  Effect.gen(function*() {
    const catalog = yield* AgentCatalog
    const client = yield* AgentClient.AgentClient
    return AgentDirectory.of({
      client: Effect.fn("AgentDirectory.client")(function*(id: AgentProfileId) {
        const profile = yield* catalog.get(id)
        if (Option.isNone(profile)) {
          return yield* new AgentResolutionError({ agentProfileId: id, reason: "unknown-profile" })
        }
        return client
      })
    })
  })
)
