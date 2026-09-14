/**
 * Agent revision -> the existing `AgentClient` contract (plan-workbench.md §4).
 *
 * Every consumer talks to `AgentClient.Service`, whichever agent it named,
 * so a browser, a TUI and a test share one execution API.
 */
import { Context, Duration, Effect, Layer, RcMap } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { AgentClient as AgentClientService } from "affe-agent/client"
import type { AgentClient } from "affe-agent/client"
import { AgentHttp } from "affe-agent/http"
import type { AgentRevisionId } from "../domain/WorkbenchIds.js"
import type { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"
import { AgentResolver } from "./AgentResolver.js"
import type { RevisionResolutionError } from "./AgentResolver.js"

export interface Service {
  readonly client: (
    id: AgentRevisionId
  ) => Effect.Effect<AgentClient.Service, RevisionResolutionError | WorkbenchStorageError>
}

export class AgentDirectory extends Context.Service<AgentDirectory, Service>()("workbench/AgentDirectory") {}

/**
 * The browser's directory: every revision reaches one agent served over
 * `AgentHttp` -- the same `AgentClient.Service`, over a transport.
 *
 * W0 serves a single agent, so the revision chooses nothing yet: its
 * configuration is enforced where the agent runs, on the server. A server
 * that mounts one agent per revision is where this grows a lookup.
 */
export const http = (options: {
  readonly baseUrl: string
}): Layer.Layer<AgentDirectory, never, HttpClient.HttpClient> =>
  Layer.effect(
    AgentDirectory,
    Effect.gen(function*() {
      const built = yield* Layer.build(AgentHttp.agentClientLayer(options))
      const client = Context.get(built, AgentClientService.AgentClient)
      return AgentDirectory.of({ client: () => Effect.succeed(client) })
    })
  )

/**
 * One resolved client per revision, for as long as the directory lives.
 *
 * Held rather than resolved per call because a client owns its sessions: an
 * in-process client reopens only sessions it created, so resolving the
 * revision again would produce a client that cannot find the conversation it
 * was asked for. A failed resolution is not kept, so a binding registered
 * later is picked up on the next call.
 */
export const layer: Layer.Layer<AgentDirectory, never, AgentResolver> = Layer.effect(
  AgentDirectory,
  Effect.gen(function*() {
    const resolver = yield* AgentResolver
    const clients = yield* RcMap.make({
      lookup: (id: AgentRevisionId) => Effect.map(resolver.resolve(id), (resolved) => resolved.client),
      idleTimeToLive: Duration.infinity
    })
    return AgentDirectory.of({
      // The reference is released at once; the infinite idle time is what
      // keeps the client, until the directory's own scope closes.
      // RcMap keeps a failed lookup like a successful one, and with no idle
      // expiry it would keep it forever, so a failure is dropped explicitly.
      client: (id) =>
        Effect.scoped(RcMap.get(clients, id)).pipe(
          Effect.tapError(() => RcMap.invalidate(clients, id))
        )
    })
  })
)
