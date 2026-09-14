/**
 * The workbench server: one agent over `AgentHttp`, and the product database
 * over `WorkbenchApi`, on one port.
 *
 * The model is scripted so the page runs with no key: the first prompt runs a
 * tool that reports progress, the next asks for approval before its tool
 * runs -- the things the page exists to show -- and the pattern repeats.
 */
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Tool } from "effect/unstable/ai"
import { Agent, AgentLoop, Permission } from "affe-agent"
import { AgentClient, AgentSessionHost } from "affe-agent/client"
import * as Elicitation from "affe-agent/elicitation"
import { AgentHttp } from "affe-agent/http"
import { TestLanguageModel } from "affe-agent/testing"
import { UserId } from "../domain/WorkbenchIds.js"
import * as AgentRegistry from "../store/AgentRegistry.js"
import * as ConversationStore from "../store/ConversationStore.js"
import { routes as productRoutes } from "./ProductHandlers.js"

/** Until auth arrives, every request is this one person's. */
export const localOwner = UserId.make("local")

const Build = Tool.make("build", { parameters: Schema.Struct({}), success: Schema.String })
const Delete = Tool.make("deleteEverything", { parameters: Schema.Struct({}), success: Schema.String })
  .setNeedsApproval(true)

const agent = Agent.make({
  instructions: "A scripted agent for the workbench page.",
  tools: [
    Agent.tool(Build, (_params, context) =>
      context.preliminary("compiling").pipe(
        Effect.andThen(Effect.sleep("300 millis")),
        Effect.andThen(context.preliminary("linking")),
        Effect.andThen(Effect.sleep("300 millis")),
        Effect.as("built")
      )),
    Agent.tool(Delete, () => Effect.succeed("deleted"))
  ],
  loop: AgentLoop.bounded(4)
})

export const buildReply = "Built it. Send another message and I will ask before deleting."
export const approvedReply = "Done -- that was the approved step."

const turns: ReadonlyArray<TestLanguageModel.Turn> = Array.from({ length: 60 }, (_, round) => [
  { reasoning: { text: "Starting with a build." }, toolCalls: [{ id: `build-${round}`, name: "build", params: {} }] },
  TestLanguageModel.text(buildReply),
  { toolCalls: [{ id: `delete-${round}`, name: "deleteEverything", params: {} }] },
  TestLanguageModel.text(approvedReply)
]).flat()

const Host = AgentSessionHost.Tag<string>("workbench/server")

const host = AgentSessionHost.layer(Host, {
  principal: { resolve: () => Effect.succeed("local") },
  authorization: AgentSessionHost.allowAll(),
  maxSessions: 64,
  maxRequestsPerSession: 1024
}).pipe(
  Layer.provide(AgentClient.layer(agent, { elicitation: Elicitation.memory })),
  Layer.provide(Layer.unwrap(Effect.map(TestLanguageModel.script(turns), ({ layer }) => layer)))
)

/** The served agent, named in the registry once, so conversations have an agent to record. */
const seedAgent = Layer.effectDiscard(Effect.gen(function*() {
  const registry = yield* AgentRegistry.AgentRegistry
  if ((yield* registry.list(localOwner)).length > 0) return
  yield* registry.create({
    ownerId: localOwner,
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
}).pipe(Effect.orDie))

/** The product stores over a SQLite file (`:memory:` for a throwaway one). */
const stores = (database: string) =>
  Layer.mergeAll(AgentRegistry.layerSql, ConversationStore.layerSql).pipe(
    Layer.provide(SqliteClient.layer({ filename: database }))
  )

export const serve = (options: { readonly port: number; readonly database: string }) =>
  HttpRouter.serve(
    Layer.mergeAll(
      AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host)),
      productRoutes,
      seedAgent
    ).pipe(Layer.provide(stores(options.database))),
    { disableLogger: true }
  ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: options.port })))
