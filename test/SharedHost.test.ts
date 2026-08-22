import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"
import { AgentAgUi } from "../src/ag-ui/index.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The point of #12 item 2: two transport adapters over one host share one
 * registry and one capacity limit. Before, each adapter built its own host,
 * so `maxSessions` counted per adapter and a session was invisible across
 * them. Here HTTP and AG-UI mount on one `AgentSessionHost` tag.
 */

const headers = { authorization: "Bearer test" } as const
const requestId = (v: string) => AgentProtocol.RequestId.make(v)

const Host = AgentSessionHost.Tag<string>("test/SharedHost/host")

const fixture = (turns: ReadonlyArray<TestLanguageModel.Turn>, maxSessions: number) =>
  Effect.gen(function* () {
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const host = AgentSessionHost.layer(Host, {
      authorization: { authorize: () => Effect.void },
      principal: {
        resolve: ({ headers: h, operation }) =>
          h.authorization === undefined
            ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
            : Effect.succeed(h.authorization)
      },
      maxSessions,
      maxRequestsPerSession: 16
    }).pipe(
      Layer.provide(AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) }))),
      Layer.provide(model)
    )
    // Both adapters on the *same* host tag, one HTTP router, one server.
    const routes = Layer.mergeAll(
      AgentHttp.serverLayer({ host: Host }),
      AgentAgUi.serverLayer({
        host: Host,
        session: {
          resolve: ({ input }) =>
            Effect.succeed(AgentProtocol.SessionId.make(input.threadId))
        }
      })
    ).pipe(Layer.provide(host))
    const built = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
        )
      )
    )
    const address = HttpServer.formatAddress(
      (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(built))).address
    )
    const api = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl: address })
    return { address, api, recorder }
  })

const runAgUi = (address: string, threadId: string, text: string) =>
  Effect.promise(() =>
    fetch(`${address}/ag-ui`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        threadId,
        runId: `run-${threadId}`,
        messages: [{ id: "u1", role: "user", content: text }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {}
      })
    }).then((r) => r.text())
  )

describe("two adapters over one AgentSessionHost", () => {
  it.live("share one capacity limit: a session created via HTTP fills the slot AG-UI would use", () =>
    Effect.gen(function* () {
      const f = yield* fixture([TestLanguageModel.text("ok")], 1)
      // One session created over HTTP fills the single slot.
      yield* f.api.sessions.createSession({
        headers,
        payload: { requestId: requestId("c"), sessionId: AgentProtocol.SessionId.make("http-one") }
      })
      // AG-UI on a *new* thread wants a second session; the shared host is
      // full, so it is refused for capacity. With per-adapter hosts it would
      // have its own free slot and succeed -- which is exactly the bug.
      const body = yield* runAgUi(f.address, "agui-two", "hi")
      assert.include(body, "AgentCapacityExceededError")
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )

  it.live("share one registry: a session created via HTTP is reachable via AG-UI", () =>
    Effect.gen(function* () {
      const f = yield* fixture([TestLanguageModel.text("from-agui")], 4)
      const id = AgentProtocol.SessionId.make("shared-session")
      yield* f.api.sessions.createSession({
        headers,
        payload: { requestId: requestId("c"), sessionId: id }
      })
      // AG-UI's resolver maps the thread to that same session id, so a run
      // adopts the HTTP-created session rather than making a new one.
      const body = yield* runAgUi(f.address, "shared-session", "reach it")
      assert.include(body, "from-agui")
      // One session ever existed: the model ran once, for the AG-UI run.
      assert.strictEqual(yield* f.recorder.calls, 1)
      // And HTTP still sees it as the same session.
      const history = yield* f.api.sessions.history({ params: { id }, headers })
      assert.deepStrictEqual(TestLanguageModel.userTexts(history.history), ["reach it"])
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )
})

