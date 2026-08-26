import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import { AgentClient, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import * as Contract from "./AgentClientContract.js"

/**
 * HTTP as an `AgentClient` — plan-agent-server.md S3 / AS3.
 *
 * A mount is backed by an `AgentClient`, not by HTTP. Wrapping the generated
 * HTTP client in that seam means a remote agent is indistinguishable from a
 * local one at the host, and the shared contract is the proof rather than a
 * second suite of HTTP assertions.
 */

const harness: Contract.Harness = {
  name: "http",
  // SSE connects asynchronously; the contract's one `yieldNow` before
  // `prompt` is not a connection latch. Lifecycle events still run.
  observesStreamDeltas: false,
  layer: ({ agent, turns, elicitation }) =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script(turns)
      const Host = AgentSessionHost.Tag<string>(
        `test/AgentHttpClient/${globalThis.crypto.randomUUID()}`
      )
      const host = AgentSessionHost.layer(Host, {
        principal: { resolve: () => Effect.succeed("http-contract") },
        authorization: AgentSessionHost.allowAll(),
        maxSessions: 32,
        maxRequestsPerSession: 256
      }).pipe(
        Layer.provide(
          AgentClient.layer(agent, elicitation ? { elicitation } : undefined)
        ),
        Layer.provide(model)
      )
      const routes = AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host))
      const server = HttpRouter.serve(routes, {
        disableLogger: true,
        disableListenLog: true
      }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, {
            port: 0,
            gracefulShutdownTimeout: 100
          })
        )
      )
      /**
       * A server that cannot bind is a broken fixture, not a case.
       *
       * `HttpRouter.serve` carries `ServeError`, and the shared harness
       * contract asks for a `Layer<AgentClient>` with nothing in its error
       * channel -- rightly, since every other backing (in-process, durable)
       * has nothing to fail with at construction. There is no caller here who
       * could do anything with a bind failure except stop, which is what
       * dying does.
       */
      return AgentHttp.agentClientFromServer().pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.orDie(server))
      )
    })
}

Contract.run(harness)
