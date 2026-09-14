/**
 * One agent served over `AgentHttp`, for the W0 page and its smoke test.
 *
 * The model is scripted so the page runs with no key: the first prompt runs a
 * tool that reports progress, the next asks for approval before its tool
 * runs -- the things the page exists to show -- and the pattern repeats.
 */
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Tool } from "effect/unstable/ai"
import { Agent, AgentLoop } from "affe-agent"
import { AgentClient, AgentSessionHost } from "affe-agent/client"
import * as Elicitation from "affe-agent/elicitation"
import { AgentHttp } from "affe-agent/http"
import { TestLanguageModel } from "affe-agent/testing"

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

export const serve = (port: number) =>
  HttpRouter.serve(AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host)), {
    disableLogger: true
  }).pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })))
