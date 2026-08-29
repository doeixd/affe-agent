import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import * as AgentClient from "../../../src/client/AgentClient.js"
import * as AgentHttp from "../../../src/http/AgentHttp.js"
import { make, type Connect } from "./command.js"

const connect: Connect<never, HttpClient> = (options) =>
  Layer.build(
    AgentHttp.agentClientLayer({
      baseUrl: options.url,
      ...(Option.isNone(options.token)
        ? {}
        : {
          headers: {
            authorization: `Bearer ${Redacted.value(options.token.value)}`
          }
        })
    })
  ).pipe(Effect.map(Context.get(AgentClient.AgentClient)))

make(connect).pipe(
  Command.run({ version: "0.0.1" }),
  Effect.provide([FetchHttpClient.layer, NodeServices.layer]),
  NodeRuntime.runMain
)
