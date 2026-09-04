import { Duration, Effect, Layer, Option, Result, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup
} from "effect/unstable/httpapi"
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
  "affe-agent/http/DuplicateMountError",
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

export class InvalidMountNameError extends Schema.TaggedError<InvalidMountNameError>()(
  "affe-agent/http/InvalidMountNameError",
  { name: Schema.String }
) {
  override get message() {
    return `AgentServer: mount name ${
      JSON.stringify(this.name)
    } is not a valid route segment; use letters, digits, '-' and '_', starting with a letter, or pass an explicit path`
  }
}

/** One agent, at one path, behind one host. */
export interface Mount<Principal> {
  readonly name: string
  readonly path: `/${string}`
  readonly host: AgentSessionHost.Tag<Principal>
}

/**
 * A mount name is a route segment and an `HttpApi` group id, so it has to be
 * safe as both.
 *
 * The name is interpolated into the default path, which made `mount("../admin")`
 * produce `/agents/../admin` and `mount("a/b")` produce a nested route nobody
 * asked for. Whether a router normalises those away is not something a caller
 * should have to know.
 *
 * Deliberately narrow: an identifier, which is what a group id has to be
 * anyway. A caller who wants a path this does not allow can pass `path`
 * explicitly, which says so.
 */
const validMountName = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/**
 * Describe a mount. Default path is `/agents/${name}`.
 *
 * A mount is data: a server can be assembled from configuration, filtered,
 * or extended. It does not start anything.
 *
 * Rejects a name that cannot safely be a route segment. Construction-time,
 * for the same reason `DuplicateMountError` is: a mount that resolves
 * somewhere unintended is a 404 at best and a shadowed route at worst, and
 * neither points back at the name that caused it.
 */
export const mount = <Principal>(
  name: string,
  options: {
    readonly host: AgentSessionHost.Tag<Principal>
    readonly path?: `/${string}` | undefined
  }
): Mount<Principal> => {
  if (!validMountName.test(name)) {
    throw new InvalidMountNameError({ name })
  }
  return {
    name,
    path: options.path ?? `/agents/${name}`,
    host: options.host
  }
}

export interface MakeOptions<Principal> {
  readonly agents: ReadonlyArray<Mount<Principal>>
}

/**
 * How long one mount's host has to answer `size` before inventory gives up.
 *
 * `/inventory` is a fleet view: an operator asks it *because* something may be
 * wrong, so it must answer about the mounts that are healthy even when one is
 * not. A host's `size` is a `Ref` read behind a service the application
 * supplied -- ordinarily instant, and a remote-backed mount can make it a
 * network call -- so the deadline is short and fixed rather than configurable:
 * one second is far longer than a healthy read and far shorter than an
 * operator's patience, and a knob here would only invite tuning around a mount
 * that is already broken.
 */
const sizeTimeout = Duration.seconds(1)

/**
 * One mounted agent, as inventory sees it.
 *
 * `remaining` is `maxSessions - sessions`. The host refuses new sessions at
 * `maxSessions`; inventory does not change that bound.
 *
 * `sessions` and `remaining` are nullable because a count that could not be
 * read is not a count. A mount whose host did not answer within `sizeTimeout`
 * reports `null` for both -- and still reports its name, path and bound, which
 * is what tells an operator *which* mount stopped answering. Reporting `0`
 * there would be worse than useless: it reads as an idle agent.
 *
 * `null` rather than `Option` because this schema *is* a wire format: it is the
 * body of `GET /inventory`, read by curl and by dashboards as much as by this
 * package. `Schema.Option`'s encoded form is the `Option` itself, so a JSON
 * client cannot decode what it produces, and projecting absence to `null` at a
 * serialization boundary is what the house rule already allows.
 */
export const MountSnapshot = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  sessions: Schema.NullOr(Schema.Number),
  maxSessions: Schema.Number,
  remaining: Schema.NullOr(Schema.Number)
})
export type MountSnapshot = typeof MountSnapshot.Type

/**
 * Read-only fleet view. `ok` means every mount's host could be read.
 *
 * It used to be the constant `true`, which made the sentence above
 * unfalsifiable and any test asserting it an assertion that could not fail.
 * `host.size` has no error channel, so "could be read" needed something that
 * can actually go wrong: it is now `false` when any mount's `size` did not
 * arrive within `sizeTimeout`, or failed as a defect, and that mount's
 * snapshot says `None`.
 */
export const Inventory = Schema.Struct({
  ok: Schema.Boolean,
  agents: Schema.Array(MountSnapshot)
})
export type Inventory = typeof Inventory.Type

const inventoryGroup = HttpApiGroup.make("inventory").add(
  HttpApiEndpoint.get("get", "/inventory", {
    success: Inventory
  })
)

const assertUnique = <Principal>(agents: ReadonlyArray<Mount<Principal>>): void => {
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const agent of agents) {
    if (names.has(agent.name)) {
      throw new DuplicateMountError({ kind: "name", value: agent.name })
    }
    // Trailing slashes are not a second route, so `/a` and `/a/` collide.
    const normalised = agent.path.replace(/\/+$/, "") || "/"
    if (paths.has(normalised)) {
      throw new DuplicateMountError({ kind: "path", value: agent.path })
    }
    /**
     * A prefix of another mount is not a duplicate, and can still swallow it.
     *
     * `/agents/a` and `/agents/a/b` are different strings, so the exact check
     * above passes -- and then, depending on how the router orders prefixes,
     * one mount receives traffic meant for the other. That is the same silent
     * drop `DuplicateMountError` exists to make loud, so it is loud here too
     * rather than left to be discovered as a mysterious 404.
     */
    for (const existing of paths) {
      const [shorter, longer] = existing.length <= normalised.length
        ? [existing, normalised]
        : [normalised, existing]
      if (longer.startsWith(`${shorter}/`)) {
        throw new DuplicateMountError({ kind: "path", value: agent.path })
      }
    }
    names.add(agent.name)
    paths.add(normalised)
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
  const withInventory = HttpApi.make("AgentServer").add(inventoryGroup)
  const [first, ...rest] = options.agents
  if (first === undefined) return withInventory
  return rest.reduce(
    (api, agent) => api.addHttpApi(AgentHttp.api({ name: agent.name, path: agent.path })),
    withInventory.addHttpApi(AgentHttp.api({ name: first.name, path: first.path }))
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
const inventoryLayer = <Principal>(
  options: MakeOptions<Principal>
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentSessionHost.Service<Principal>> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      /**
       * The hosts are resolved here, not inside the handler.
       *
       * A requirement discharged inside a route becomes a requirement of the
       * *request* -- `HttpRouter.Request<"Requires", ...>` -- rather than of
       * the layer, and then this no longer matches the type
       * `AgentHttp.serverLayer` declares for the same shape of thing. It is
       * also the wrong lifetime: a host is a property of the mount, fixed when
       * the layer is built, so resolving it per request would look up the same
       * service on every call to `/inventory`.
       */
      const mounts = yield* Effect.forEach(options.agents, (agent) =>
        Effect.map(agent.host, (host) => ({ agent, host })))

      yield* router.add("GET", "/inventory", () =>
        Effect.gen(function* () {
          /**
           * Each mount is read on its own deadline, and concurrently.
           *
           * Sequentially, one stalled host would spend its whole second before
           * the next was even asked, so a fleet of ten would take ten seconds
           * to report that one of them is stuck. The point of the endpoint is
           * to say which mount stopped answering, quickly.
           *
           * `Effect.result` rather than a `catch`: a host's `size` declares no
           * error, so what is being caught is a *defect* -- a service the
           * application supplied misbehaving -- and inventory reporting that
           * mount as unreadable is more useful than the whole endpoint dying.
           */
          const agents = yield* Effect.forEach(
            mounts,
            ({ agent, host }) =>
              host.size.pipe(
                Effect.timeoutOption(sizeTimeout),
                Effect.result,
                Effect.map((read) => {
                  const sessions = Result.isSuccess(read)
                    ? Option.getOrNull(read.success)
                    : null
                  return {
                    name: agent.name,
                    path: agent.path,
                    sessions,
                    maxSessions: host.maxSessions,
                    remaining: sessions === null
                      ? null
                      : host.maxSessions - sessions
                  }
                })
              ),
            { concurrency: "unbounded" }
          )
          /**
           * Encoding a value we just built is a defect, not a condition.
           *
           * `schemaJson` can fail with `HttpBodyError`, which would otherwise
           * appear in this layer's requirements as `Request<"Error", ...>` and
           * not match the type `AgentHttp.serverLayer` declares for the same
           * shape of layer. There is no caller who could act on it either: the
           * payload is assembled here, from `Inventory`, out of a host's own
           * counts -- if that will not encode, the schema and the value have
           * drifted apart and the server is wrong, not the request.
           */
          return yield* HttpServerResponse.schemaJson(Inventory)({
            // `ok` is exactly "every mount answered", which is now something
            // that can be false.
            ok: agents.every((snapshot) => snapshot.sessions !== null),
            agents
          }).pipe(Effect.orDie)
        })
      )
    })
  )

export const serverLayer = <Principal>(
  options: MakeOptions<Principal>
): Layer.Layer<never, never, HttpRouter.HttpRouter | AgentSessionHost.Service<Principal>> => {
  assertUnique(options.agents)
  const sessionLayers = options.agents.map((agent) =>
    AgentHttp.serverLayer({ host: agent.host, path: agent.path })
  )
  if (sessionLayers.length === 0) return inventoryLayer(options)
  return Layer.mergeAll(inventoryLayer(options), sessionLayers[0]!, ...sessionLayers.slice(1))
}


