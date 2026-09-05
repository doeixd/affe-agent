import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { CurrentPrincipal } from "../src/Principal.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { BearerHost } from "./helpers.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 58: does a principal reach a tool over a wire, and only from the host?
 *
 * The design intent, stated in `Principal.ts` and the matrix, is that the
 * wire does **not** carry a principal: one arriving in a request would be a
 * caller asserting its own identity. The serving host establishes it from
 * its own authentication (`AgentSessionHost.Options.subject`) and sets
 * `CurrentPrincipal` around the submission. Until this file that was a
 * sentence about how it is meant to work; the matrix cell read "not tested".
 *
 * Two rows. A host that maps the authenticated principal to a subject puts
 * that subject, and nothing the client wrote, on the tool's fibre. A host
 * that maps nothing puts nothing there, however the client authenticated --
 * the negative that matters, because it is the one a client could try.
 */

const Host = BearerHost("test/PrincipalOverWire/host")
const WhoAmI = Tool.make("who_am_i", { parameters: Schema.Struct({}), success: Schema.String })

const agent = Agent.make({
  instructions: "Say who is asking.",
  tools: [
    Agent.tool(WhoAmI, () =>
      Effect.map(CurrentPrincipal, (principal) => Option.getOrElse(principal, () => "nobody")))
  ],
  loop: AgentLoop.bounded(3)
})

const script = [
  TestLanguageModel.toolCall("who_am_i", {}, { id: "w1" }),
  TestLanguageModel.text("done")
]

/** A real agent behind a real HTTP server, with the host's principal mapping as given. */
const served = (subject: ((principal: string) => string) | undefined) =>
  Effect.gen(function* () {
    const { layer: model, recorder } = yield* FakeModel.script(script)
    const host = AgentSessionHost.layer(Host, {
      authorization: { authorize: () => Effect.void },
      // The host's own authentication: the bearer token names the user.
      principal: {
        resolve: ({ headers, operation }) =>
          headers.authorization === undefined
            ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
            : Effect.succeed(headers.authorization.replace(/^Bearer /, ""))
      },
      ...(subject === undefined ? {} : { subject }),
      maxSessions: 4,
      maxRequestsPerSession: 16
    })
    const routes = AgentHttp.serverLayer({ host: Host }).pipe(
      Layer.provide(host.pipe(Layer.provide(AgentClient.layer(agent)), Layer.provide(model)))
    )
    const runtime = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true }))
      )
    )
    const address = HttpServer.formatAddress(
      (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(runtime))).address
    )
    const api = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl: address })
    return { api, recorder }
  })

/** What the tool reported, as the model was shown it on the next turn. */
const reported = (prompts: ReadonlyArray<unknown>) => JSON.stringify(prompts[1] ?? null)

describe("a principal over a wire", () => {
  it.live("the host's subject reaches the tool, and it is the host's, not the client's", () =>
    Effect.gen(function* () {
      const { api, recorder } = yield* served((principal) => `user:${principal}`)
      const headers = {
        authorization: "Bearer alice",
        // A client asserting an identity in a header of its own invention.
        // Nothing reads it; the point is that nothing can.
        "x-principal": "user:mallory"
      }
      const id = AgentProtocol.SessionId.make("wire-principal")
      yield* api.sessions.createSession({ headers, payload: { requestId: AgentProtocol.RequestId.make("c"), sessionId: id } })
      yield* api.sessions.prompt({
        headers,
        params: { id },
        payload: { requestId: AgentProtocol.RequestId.make("p"), input: AgentProtocol.input("who am I?") }
      })
      const seen = reported(yield* recorder.prompts)
      assert.include(seen, "user:alice", "the host's subject did not reach the tool over HTTP")
      assert.notInclude(seen, "mallory", "a client-asserted identity reached the tool")
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )

  it.live("a host that maps no subject puts nothing on the fibre, however the client authenticated", () =>
    Effect.gen(function* () {
      const { api, recorder } = yield* served(undefined)
      const headers = { authorization: "Bearer alice" }
      const id = AgentProtocol.SessionId.make("wire-no-subject")
      yield* api.sessions.createSession({ headers, payload: { requestId: AgentProtocol.RequestId.make("c"), sessionId: id } })
      yield* api.sessions.prompt({
        headers,
        params: { id },
        payload: { requestId: AgentProtocol.RequestId.make("p"), input: AgentProtocol.input("who am I?") }
      })
      const seen = reported(yield* recorder.prompts)
      assert.include(seen, "nobody")
      assert.notInclude(seen, "alice", "an authenticated principal reached the tool without the host mapping one")
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )
})
