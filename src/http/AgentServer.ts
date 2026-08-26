import { Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi } from "effect/unstable/httpapi"
import * as AgentSessionHost from "../client/AgentSessionHost.js"
import * as AgentHttp from "./AgentHttp.js"

/**
 * Composition over hosts, not a second authority.
 *
 * HTTP, RPC, A2A, AG-UI and MCP already share one `AgentSessionHost` for
 * registry, capacity, authentication and authorization. What was missing is
 * a way to say "serve these agents, at these paths" without hand-wiring and
 * hitting the group-id trap: prefixing `AgentHttp.Api` twice silently drops
 * the first agent because both copies are still named `sessions`.
 *
 * `AgentServer` returns an `HttpApi` (a value) and a layer that registers
 * the prefixed routes. Auth stays on the host. Local vs remote is whichever
 * `AgentClient` the host was given.
 */

/**
 * Two mounts claimed the same name or the same path.
 *
 * Construction-time, not a 404: a duplicate that surfaces as a missing
 * route is the trap this module exists to close.
 */
export class DuplicateMountError extends Schema.TaggedError<DuplicateMountError>()(
  "@doeixd/effect-agent/http/DuplicateMountError",
  {
    kind: Schema.Literals(["name", "path"]),
    value: Schema.String
  }
) {
  override get message() {
    return this.kind === "name"
      ? `AgentServer: duplicate mount name ${JSON.stringify(this.value)}`
      : `AgentServer: duplicate mount path ${JSON.stringify(this.value)}`
  }
}

/** One agent, at one path, behind one host. */
export interface Mount<Principal> {
  readonly name: string
  readonly path: `/${string}`
  readonly host: AgentSessionHost.Tag<Principal>
}

/**
 * Describe a mount. Default path is `/agents/${name}`.
 *
 * A mount is data: a server can be assembled from configuration, filtered,
 * or extended. It does not start anything.
 */
export const mount = <Principal>(
  name: string,
  options: {
    readonly host: AgentSessionHost.Tag<Principal>
    readonly path?: `/${string}` | undefined
  }
): Mount<Principal> => ({
  name,
  path: options.path ?? `/agents/${name}`,
  host: options.host
})

export interface MakeOptions<Principal> {
  readonly agents: ReadonlyArray<Mount<Principal>>
}

const assertUnique = <Principal>(agents: ReadonlyArray<Mount<Principal>>): void => {
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const agent of agents) {
    if (names.has(agent.name)) {
      throw new DuplicateMountError({ kind: "name", value: agent.name })
    }
    if (paths.has(agent.path)) {
      throw new DuplicateMountError({ kind: "path", value: agent.path })
    }
    names.add(agent.name)
    paths.add(agent.path)
  }
}

/**
 * Compose the mounted agents into one `HttpApi`.
 *
 * The result is a value: the application adds its own routes and middleware
 * and serves it however it likes. Nothing here binds a port.
 *
 * Duplicate names or paths throw `DuplicateMountError` at construction, so
 * the silent replacement `Api.prefix(a).addHttpApi(Api.prefix(b))` is
 * unrepresentable here.
 */
export const make = <Principal>(options: MakeOptions<Principal>) => {
  assertUnique(options.agents)
  const [first, ...rest] = options.agents
  if (first === undefined) return HttpApi.make("AgentServer")
  return rest.reduce(
    (api, agent) => api.addHttpApi(AgentHttp.api({ name: agent.name, path: agent.path })),
    AgentHttp.api({ name: first.name, path: first.path })
  )
}

/**
 * Register every mount's session routes on the current router.
 *
 * Each mount is an `AgentHttp.serverLayer` at that mount's path, so the
 * schema `make` produced and the router agree. Hosts remain the
 * application's: this layer requires every mount's host tag, and does not
 * grow a registry of its own.
 *
 * Session lifetime is the host's. Closing this layer closes each prefixed
 * adapter; the host layers the application provided are released with
 * whatever scope they were built in, which is AS6 when those layers are
 * provided into the same scope as this one.
 */
export const serverLayer = <Principal>(
  options: MakeOptions<Principal>
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentSessionHost.Service<Principal>> => {
  assertUnique(options.agents)
  if (options.agents.length === 0) return Layer.empty
  const layers = options.agents.map((agent) =>
    AgentHttp.serverLayer({ host: agent.host, path: agent.path })
  )
  return Layer.mergeAll(layers[0]!, ...layers.slice(1))
}


