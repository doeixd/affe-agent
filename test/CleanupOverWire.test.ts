import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { BearerHost, bearerHost } from "./helpers.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 57: what does a tool holding a resource do when the *connection*
 * dies, rather than the run?
 *
 * `ToolCleanup` answers the run-interruption question in-process, under
 * replay and under delegation. This is the other event: a client that
 * started a prompt over HTTP drops the request while a tool is holding
 * something. The matrix cell read "not tested" and nobody had asked.
 *
 * **Measured: the run continues, and the resource is released when the tool
 * finishes, once.** That follows from a decision already made elsewhere --
 * an HTTP waiter leaving is not the work being cancelled (`AgentHttp`, "keeps
 * an idempotent prompt alive after an HTTP waiter disconnects") -- and this
 * file pins its consequence for a held resource: nothing is torn down at the
 * disconnect, nothing leaks after it, and a client that wants the work
 * stopped says so with `interrupt`. Written as the decision, since the
 * alternative -- tearing a tool down because a socket closed -- would make
 * every flaky connection a partial write.
 */

const Host = BearerHost("test/CleanupOverWire/host")
const Hold = Tool.make("hold", { parameters: Schema.Struct({}), success: Schema.String })
const headers = { authorization: "Bearer test" } as const

describe("cleanup when the connection dies", () => {
  it.live("a tool holding a resource finishes after the client disconnects, and releases exactly once", () =>
    Effect.gen(function* () {
      const acquired = yield* Ref.make(0)
      const released = yield* Ref.make(0)
      const holding = yield* Deferred.make<void>()
      const letGo = yield* Deferred.make<void>()

      const agent = Agent.make({
        instructions: "Hold something.",
        tools: [
          Agent.tool(Hold, () =>
            Effect.acquireUseRelease(
              Effect.andThen(Ref.update(acquired, (n) => n + 1), Deferred.succeed(holding, void 0)),
              () => Effect.as(Deferred.await(letGo), "held and let go"),
              () => Ref.update(released, (n) => n + 1)
            ))
        ],
        loop: AgentLoop.bounded(3)
      })
      const { layer: model, recorder } = yield* FakeModel.script([
        TestLanguageModel.toolCall("hold", {}, { id: "h1" }),
        TestLanguageModel.text("done")
      ])
      const routes = AgentHttp.serverLayer({ host: Host }).pipe(
        Layer.provide(
          bearerHost(Host, { maxSessions: 4, maxRequestsPerSession: 16 }).pipe(
            Layer.provide(AgentClient.layer(agent)),
            Layer.provide(model)
          )
        )
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
      const id = AgentProtocol.SessionId.make("wire-cleanup")
      yield* api.sessions.createSession({ headers, payload: { requestId: AgentProtocol.RequestId.make("c"), sessionId: id } })

      const request = {
        headers,
        params: { id },
        payload: { requestId: AgentProtocol.RequestId.make("p"), input: AgentProtocol.input("hold it") }
      }
      // The client starts the prompt, and drops it while the tool holds.
      const waiter = yield* Effect.forkChild(api.sessions.prompt(request))
      yield* Deferred.await(holding)
      yield* Fiber.interrupt(waiter)

      // Nothing was torn down at the disconnect: still acquired, not released.
      assert.strictEqual(yield* Ref.get(acquired), 1)
      assert.strictEqual(yield* Ref.get(released), 0, "the disconnect tore the tool down")

      // The work finishes on its own schedule, and a second waiter -- the
      // same request id, the idempotent retry -- gets the answer.
      yield* Deferred.succeed(letGo, void 0)
      const again = yield* api.sessions.prompt(request)
      assert.strictEqual(again.result.text, "done")
      assert.strictEqual(yield* Ref.get(released), 1, "released more or fewer than once")
      assert.strictEqual(yield* Ref.get(acquired), 1, "the tool ran again after the disconnect")
      assert.include(JSON.stringify((yield* recorder.prompts)[1]), "held and let go")
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )
})
