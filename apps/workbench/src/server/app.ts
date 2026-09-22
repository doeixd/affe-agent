/**
 * The workbench server: every agent the product database defines, over
 * `AgentHttp`, and the product database itself over `WorkbenchApi`, on one
 * port, both behind the same bearer tokens.
 *
 * Agents are resolved per revision from the registry against `bindings`: the
 * models and tool capabilities this deployment offers. A conversation runs
 * the revision it was created on (decisions D6), routed by `RoutingClient`.
 *
 * Their sessions are durable, on the same SQLite file as the product records:
 * a restarted server reopens a conversation with its history. Revision
 * clients register their workflow handlers on first access after restart;
 * server startup alone does not resume every unfinished conversation.
 *
 * The `scripted` model needs no key: the first prompt runs a tool that
 * reports progress, the next asks for approval before its tool runs, and the
 * pattern repeats.
 */
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Crypto, Duration, Effect, Layer, Schema } from "effect"
import { SessionDirectory } from "affe-agent/sessions"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import { Tool } from "effect/unstable/ai"
import { Agent, Permission } from "affe-agent"
import { AgentSessionHost } from "affe-agent/client"
import { DeliveryLog, DurableAgentClient, DurableChannels, DurableSessionStore } from "affe-agent/durable"
import { AgentHttp } from "affe-agent/http"
import { TestLanguageModel } from "affe-agent/testing"
import { UserId } from "../domain/WorkbenchIds.js"
import * as AgentDirectory from "../runtime/AgentDirectory.js"
import * as AgentResolver from "../runtime/AgentResolver.js"
import * as AgentRegistry from "../store/AgentRegistry.js"
import * as ConversationStore from "../store/ConversationStore.js"
import * as IdentityStore from "../store/IdentityStore.js"
import * as OrganizationStore from "../store/OrganizationStore.js"
import * as SessionIndex from "../store/SessionIndex.js"
import { authenticated, hostOptions, TokenResolver } from "./Authentication.js"
import { Tokens } from "./Authentication.js"
import * as Identity from "./Identity.js"
import { routes as productRoutes } from "./ProductHandlers.js"
import * as RoutingClient from "./RoutingClient.js"

const Build = Tool.make("build", { parameters: Schema.Struct({}), success: Schema.String })
const Delete = Tool.make("deleteEverything", { parameters: Schema.Struct({}), success: Schema.String })
  .setNeedsApproval(true)

export const buildReply = "Built it. Send another message and I will ask before deleting."
export const approvedReply = "Done -- that was the approved step."

const turns: ReadonlyArray<TestLanguageModel.Turn> = Array.from({ length: 60 }, (_, round) => [
  { reasoning: { text: "Starting with a build." }, toolCalls: [{ id: `build-${round}`, name: "build", params: {} }] },
  TestLanguageModel.text(buildReply),
  { toolCalls: [{ id: `delete-${round}`, name: "deleteEverything", params: {} }] },
  TestLanguageModel.text(approvedReply)
]).flat()

/** What revisions may name on this deployment. */
const bindings = Layer.effect(
  AgentResolver.AgentBindings,
  Effect.map(TestLanguageModel.script(turns), ({ layer: scripted }) => ({
    models: { scripted },
    capabilities: {
      build: [
        Agent.tool(Build, (_params, context) =>
          context.preliminary("compiling").pipe(
            Effect.andThen(Effect.sleep("300 millis")),
            Effect.andThen(context.preliminary("linking")),
            Effect.andThen(Effect.sleep("300 millis")),
            Effect.as("built")
          ))
      ],
      deleteEverything: [Agent.tool(Delete, () => Effect.succeed("deleted"))]
    },
    skills: {}
  }))
)

/** Runner identity needs a `Crypto`; Web Crypto is on every runtime this targets. */
const webCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, data.slice().buffer)))
  })
)

export interface Durability {
  /**
   * How long a stopped server's shard locks outlive it. The production
   * default suits a fleet; a test that restarts in-process shortens it so the
   * next server does not wait out the previous one.
   */
  readonly shardLockExpiration?: Duration.Duration | undefined
  readonly shardLockRefreshInterval?: Duration.Duration | undefined
}

/** Durable clients: sessions, input channels and the delivery log in SQL, run by a workflow engine over the same database. */
const durableClients = (durability: Durability | undefined) =>
  Layer.effect(
    AgentResolver.AgentClientFactory,
    Effect.gen(function*() {
      const store = yield* DurableChannels.sqlStoreWithTable()
      const sessionStore = yield* DurableSessionStore.sqlStoreWithTables()
      const delivery = yield* DeliveryLog.sqlLogWithTable()
      const engine = yield* Layer.build(
        ClusterWorkflowEngine.layer.pipe(
          Layer.provide(
            SingleRunner.layer({
              runnerStorage: "sql",
              shardingConfig: {
                ...(durability?.shardLockExpiration === undefined
                  ? {}
                  : { shardLockExpiration: durability.shardLockExpiration }),
                ...(durability?.shardLockRefreshInterval === undefined
                  ? {}
                  : { shardLockRefreshInterval: durability.shardLockRefreshInterval })
              }
            })
          ),
          Layer.provide(webCrypto)
        )
      )
      return AgentResolver.AgentClientFactory.of({
        make: (name, agent) =>
          DurableAgentClient.layer(name, agent, { store, sessionStore, delivery }).pipe(
            Layer.provide(Layer.succeedContext(engine))
          )
      })
    })
  )

const Host = AgentSessionHost.Tag<UserId>("workbench/server")

/**
 * The server's own principal, for the one host-wide operation the index
 * needs. Fresh per process and never a token's, so no request resolves to it.
 */
class Indexer extends Context.Service<Indexer, UserId>()("workbench/Indexer") {}
const indexer = Layer.sync(Indexer, () => UserId.make(`indexer:${globalThis.crypto.randomUUID()}`))

const host = Layer.unwrap(Effect.gen(function*() {
  const resolve = yield* TokenResolver
  const store = yield* ConversationStore.ConversationStore
  const indexer = yield* Indexer
  return AgentSessionHost.layer(Host, {
    ...hostOptions(resolve, store, { indexer }),
    maxSessions: 64,
    maxRequestsPerSession: 1024
  })
})).pipe(Layer.provide(RoutingClient.layer))

/**
 * Keep the session index current from the host's events, for as long as the
 * server runs. A directory that cannot be written ends the follower and is
 * logged; the sessions themselves are unaffected, which is the point of an
 * index that is not an execution authority.
 */
const followSessions = Layer.effectDiscard(Effect.gen(function*() {
  const hostService = yield* Host
  const index = yield* SessionIndex.SessionIndex
  const events = yield* hostService.hostEvents(yield* Indexer).pipe(Effect.orDie)
  yield* SessionDirectory.follow(index, events).pipe(
    Effect.tapError((error) => Effect.logError("workbench: the session index stopped following", error)),
    Effect.forkScoped
  )
}))

/** Each person starts with one agent, so their first conversation has something to run. */
const seedAgents = Layer.effectDiscard(Effect.gen(function*() {
  const registry = yield* AgentRegistry.AgentRegistry
  const people = new Set((yield* Tokens).values())
  yield* Effect.forEach(people, (ownerId) =>
    Effect.gen(function*() {
      if ((yield* registry.list(ownerId)).length > 0) return
      yield* registry.create({
        ownerId,
        name: "Workbench agent",
        revision: {
          instructions: "A scripted agent for the workbench page.",
          modelPolicy: { profile: "scripted" },
          capabilities: [{ id: "build" }, { id: "deleteEverything" }],
          skills: [],
          permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
          maxTurns: 4
        }
      })
    }))
}).pipe(Effect.orDie))

export const serve = (options: {
  readonly port: number
  /** A SQLite file for product records and durable sessions alike (`:memory:` for a throwaway one). */
  readonly database: string
  readonly durability?: Durability | undefined
  /** How long a login's token works. */
  readonly identity?: Identity.Options | undefined
}) =>
  HttpRouter.serve(
    Layer.mergeAll(
      AgentHttp.serverLayer({ host: Host }),
      productRoutes.pipe(Layer.provide(authenticated)),
      seedAgents,
      followSessions
    ).pipe(
      Layer.provide(host),
      Layer.provideMerge(Identity.tokenResolver),
      Layer.provideMerge(Identity.layer(options.identity)),
      Layer.provideMerge(AgentDirectory.layer),
      Layer.provideMerge(AgentResolver.layerWith),
      Layer.provideMerge(
        Layer.mergeAll(
          AgentRegistry.layerSql,
          ConversationStore.layerSql,
          OrganizationStore.layerSql,
          IdentityStore.layerSql,
          SessionIndex.layerSql,
          durableClients(options.durability)
        )
      ),
      Layer.provide(indexer),
      Layer.provide(bindings),
      // One connection for everything: SQLite serializes writers anyway, and
      // a second client over the same file would contend for its lock.
      Layer.provide(SqliteClient.layer({ filename: options.database }))
    ),
    { disableLogger: true }
  ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: options.port })))
