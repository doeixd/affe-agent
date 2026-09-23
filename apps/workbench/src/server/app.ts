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
 * clients register their workflow handlers on first access after restart,
 * and at startup the server makes that access itself for every session the
 * index says was running (`resumeActive`), so unfinished runs resume.
 *
 * The `scripted` model needs no key: the first prompt runs a tool that
 * reports progress, the next asks for approval before its tool runs, and the
 * pattern repeats.
 */
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Crypto, Duration, Effect, Layer, Option, Schema } from "effect"
import { SessionDirectory } from "affe-agent/sessions"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { HttpRouter } from "effect/unstable/http"
import { Tool } from "effect/unstable/ai"
import { Agent, Permission } from "affe-agent"
import { AgentProtocol, AgentSessionHost } from "affe-agent/client"
import { DeliveryLog, DurableAgentClient, DurableChannels, DurableSessionStore } from "affe-agent/durable"
import { AgentHttp } from "affe-agent/http"
import { TestLanguageModel } from "affe-agent/testing"
import { UserId } from "../domain/WorkbenchIds.js"
import * as AgentDirectory from "../runtime/AgentDirectory.js"
import * as AgentResolver from "../runtime/AgentResolver.js"
import { conversationIdOf } from "../runtime/ConversationSessions.js"
import * as Catalog from "../runtime/Catalog.js"
import * as InboxProjection from "../runtime/InboxProjection.js"
import * as TaskRunner from "../runtime/TaskRunner.js"
import * as TaskWorker from "../runtime/TaskWorker.js"
import * as AgentRegistry from "../store/AgentRegistry.js"
import * as ConversationStore from "../store/ConversationStore.js"
import * as FeedbackStore from "../store/FeedbackStore.js"
import * as IdentityStore from "../store/IdentityStore.js"
import * as InboxStore from "../store/InboxStore.js"
import * as OrganizationStore from "../store/OrganizationStore.js"
import * as SessionIndex from "../store/SessionIndex.js"
import * as TaskStore from "../store/TaskStore.js"
import * as WorkQueue from "../store/WorkQueue.js"
import { authenticated, hostOptions, TokenResolver } from "./Authentication.js"
import { Host } from "./Host.js"
import * as HostAttempts from "./HostAttempts.js"
import { Tokens } from "./Authentication.js"
import * as Identity from "./Identity.js"
import { routes as productRoutes } from "./ProductHandlers.js"
import * as RoutingClient from "./RoutingClient.js"

const Build = Tool.make("build", { parameters: Schema.Struct({}), success: Schema.String })
const Delete = Tool.make("deleteEverything", { parameters: Schema.Struct({}), success: Schema.String })
  .setNeedsApproval(true)

export const buildReply = "Built it. Send another message and I will ask before deleting."
export const approvedReply = "Done -- that was the approved step."
/** What the `alternate` model always answers: a second profile, so choosing a model is observable. */
export const alternateReply = "Answered by the alternate model."

const turns: ReadonlyArray<TestLanguageModel.Turn> = Array.from({ length: 60 }, (_, round) => [
  { reasoning: { text: "Starting with a build." }, toolCalls: [{ id: `build-${round}`, name: "build", params: {} }] },
  TestLanguageModel.text(buildReply),
  { toolCalls: [{ id: `delete-${round}`, name: "deleteEverything", params: {} }] },
  TestLanguageModel.text(approvedReply)
]).flat()

/** What revisions may name on this deployment. */
const bindings = Layer.effect(
  AgentResolver.AgentBindings,
  Effect.map(Effect.all([
    TestLanguageModel.script(turns),
    TestLanguageModel.script(Array.from({ length: 60 }, () => TestLanguageModel.text(alternateReply)))
  ]), ([{ layer: scripted }, { layer: alternate }]) => ({
    models: { scripted, alternate },
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
  const inbox = yield* InboxStore.InboxStore
  const conversations = yield* ConversationStore.ConversationStore
  const indexer = yield* Indexer
  // Two subscriptions, two read models: neither can slow or stop the other.
  const forIndex = yield* hostService.hostEvents(indexer).pipe(Effect.orDie)
  yield* SessionDirectory.follow(index, forIndex).pipe(
    Effect.tapError((error) => Effect.logError("workbench: the session index stopped following", error)),
    Effect.forkScoped
  )
  const forInbox = yield* hostService.hostEvents(indexer).pipe(Effect.orDie)
  yield* InboxProjection.follow(inbox, conversations, forInbox).pipe(
    Effect.tapError((error) => Effect.logError("workbench: the inbox stopped following", error)),
    Effect.forkScoped
  )
  const tasks = yield* TaskStore.TaskStore
  const forTasks = yield* hostService.hostEvents(indexer).pipe(Effect.orDie)
  yield* TaskRunner.follow(tasks, forTasks).pipe(
    Effect.tapError((error) => Effect.logError("workbench: task status stopped following", error)),
    Effect.forkScoped
  )
  // Now that every read model is listening, reopen what was running when the
  // last server stopped. A durable run resumes only once its revision's client
  // is reached, and its events reach the followers only through the host: left
  // alone, a task in flight at a restart would never settle.
  yield* resumeActive(hostService, index, conversations).pipe(Effect.forkScoped)
}))

/**
 * Open, through the host and as its owner, every conversation's session the
 * index says was running work. One that cannot be reopened is logged and
 * skipped: the others still resume, and the person can still open it.
 */
const resumeActive = (
  hostService: AgentSessionHost.Service<UserId>,
  index: SessionDirectory.SessionDirectory,
  conversations: ConversationStore.Service
) =>
  Effect.gen(function*() {
    let after: string | undefined = undefined
    do {
      const page: SessionDirectory.Page = yield* index.active({ limit: SessionDirectory.maxLimit, ...(after === undefined ? {} : { after: AgentProtocol.SessionId.make(after) }) })
      for (const entry of page.entries) {
        const conversationId = conversationIdOf(entry.sessionId)
        if (Option.isNone(conversationId)) continue
        const conversation = yield* conversations.get(conversationId.value)
        if (Option.isNone(conversation)) continue
        yield* hostService.session(conversation.value.ownerId, { sessionId: entry.sessionId }).pipe(
          Effect.tapError((error) => Effect.logWarning("workbench: an active session could not be reopened", { sessionId: entry.sessionId, error })),
          Effect.ignore
        )
      }
      after = Option.getOrUndefined(page.next)
    } while (after !== undefined)
  }).pipe(Effect.catchCause((cause) => Effect.logError("workbench: resuming active sessions failed", cause)))

/**
 * The worker over the operational queue, for as long as the server runs.
 * Its lease name is the indexer principal: unique per process, so two
 * servers on one database are two workers.
 */
const runWorker = Layer.effectDiscard(Effect.gen(function*() {
  const worker = yield* Indexer
  yield* TaskWorker.run({ worker, lease: "30 seconds", poll: "500 millis" }).pipe(Effect.forkScoped)
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
      followSessions,
      runWorker
    ).pipe(
      // Attempts go through the host, as a browser's sessions do, so the followers see them.
      Layer.provideMerge(HostAttempts.layer),
      Layer.provide(host),
      Layer.provideMerge(Identity.tokenResolver),
      Layer.provideMerge(Identity.layer(options.identity)),
      Layer.provideMerge(AgentDirectory.layer),
      Layer.provideMerge(Catalog.layer),
      Layer.provideMerge(AgentResolver.layerWith),
      Layer.provideMerge(
        Layer.mergeAll(
          AgentRegistry.layerSql,
          ConversationStore.layerSql,
          OrganizationStore.layerSql,
          IdentityStore.layerSql,
          InboxStore.layerSql,
          SessionIndex.layerSql,
          TaskStore.layerSql,
          WorkQueue.layerSql,
          FeedbackStore.layerSql,
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
