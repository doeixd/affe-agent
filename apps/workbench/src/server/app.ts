/**
 * The workbench server: every agent the product database defines, over
 * `AgentHttp`, and the product database itself over `WorkbenchApi`, on one
 * port, both behind the same bearer tokens.
 *
 * Agents are resolved per revision from the registry against `bindings`: the
 * models and tool capabilities this deployment offers. A conversation runs
 * the revision it was created on (decisions D6), routed by `RoutingClient`.
 *
 * The `scripted` model needs no key: the first prompt runs a tool that
 * reports progress, the next asks for approval before its tool runs, and the
 * pattern repeats.
 */
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Tool } from "effect/unstable/ai"
import { Agent, Permission } from "affe-agent"
import { AgentSessionHost } from "affe-agent/client"
import { AgentHttp } from "affe-agent/http"
import { TestLanguageModel } from "affe-agent/testing"
import type { UserId } from "../domain/WorkbenchIds.js"
import * as AgentDirectory from "../runtime/AgentDirectory.js"
import * as AgentResolver from "../runtime/AgentResolver.js"
import * as AgentRegistry from "../store/AgentRegistry.js"
import * as ConversationStore from "../store/ConversationStore.js"
import { authenticated, hostOptions, Tokens } from "./Authentication.js"
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

const Host = AgentSessionHost.Tag<UserId>("workbench/server")

const host = Layer.unwrap(Effect.gen(function*() {
  const known = yield* Tokens
  const store = yield* ConversationStore.ConversationStore
  return AgentSessionHost.layer(Host, { ...hostOptions(known, store), maxSessions: 64, maxRequestsPerSession: 1024 })
})).pipe(Layer.provide(RoutingClient.layer))

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

/** The product stores over a SQLite file (`:memory:` for a throwaway one). */
const stores = (database: string) =>
  Layer.mergeAll(AgentRegistry.layerSql, ConversationStore.layerSql).pipe(
    Layer.provide(SqliteClient.layer({ filename: database }))
  )

export const serve = (options: { readonly port: number; readonly database: string }) =>
  HttpRouter.serve(
    Layer.mergeAll(
      AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host)),
      productRoutes.pipe(Layer.provide(authenticated)),
      seedAgents
    ).pipe(
      Layer.provideMerge(AgentDirectory.layer),
      Layer.provideMerge(AgentResolver.layer),
      Layer.provideMerge(stores(options.database)),
      Layer.provide(bindings)
    ),
    { disableLogger: true }
  ).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port: options.port })))
