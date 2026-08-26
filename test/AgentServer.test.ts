import { assert, describe, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Ref, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp, AgentServer } from "../src/http/index.js"

const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sessionId = (value: string) => AgentProtocol.SessionId.make(value)
const headers = { authorization: "Bearer test" } as const

const hostOptions = {
  authorization: {
    authorize: () => Effect.void
  },
  principal: {
    resolve: ({ headers: requestHeaders, operation }: AgentSessionHost.PrincipalContext) =>
      requestHeaders.authorization === undefined
        ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
        : Effect.succeed(requestHeaders.authorization)
  },
  maxSessions: 4,
  maxRequestsPerSession: 16
}

const idleSession = (id: AgentProtocol.SessionId): AgentClient.RemoteSession => ({
  id,
  prompt: () =>
    Effect.succeed({
      submissionId: AgentProtocol.SubmissionId.make("sub"),
      status: "completed",
      runs: 1,
      turns: 1,
      text: "ok"
    }),
  steer: () => Effect.void,
  followUp: () => Effect.void,
  interrupt: () => Effect.void,
  respond: () => Effect.succeed(false),
  pending: Effect.succeed([]),
  history: Effect.succeed(Prompt.empty),
  status: Effect.succeed("idle"),
  events: () => Stream.empty
})

describe("AgentHttp.api", () => {
  it("prefixing the single-agent Api twice silently keeps one group", () => {
    // The trap documented in plan-agent-server.md. Anyone wiring two agents
    // by hand hits this as "my second agent 404s".
    const combined = AgentHttp.Api.prefix("/agents/alpha").addHttpApi(
      AgentHttp.Api.prefix("/agents/beta")
    )
    assert.deepStrictEqual(Object.keys(combined.groups), ["sessions"])
  })

  it("names the group per agent so two mounts both survive (AS1)", () => {
    const alpha = AgentHttp.api({ name: "alpha" })
    const beta = AgentHttp.api({ name: "beta" })
    const combined = alpha.addHttpApi(beta)
    assert.deepStrictEqual(Object.keys(combined.groups).sort(), ["alpha", "beta"])
    assert.strictEqual(
      combined.groups.alpha.endpoints.createSession.path,
      "/agents/alpha/sessions"
    )
    assert.strictEqual(
      combined.groups.beta.endpoints.createSession.path,
      "/agents/beta/sessions"
    )
  })

  it("refuses a name that cannot be a group id", () => {
    assert.throws(() => AgentHttp.api({ name: "a/b" }))
    assert.throws(() => AgentHttp.api({ name: "" }))
  })
})

describe("AgentServer", () => {
  it("make composes N mounts into N groups", () => {
    const Alpha = AgentSessionHost.Tag<string>("test/AgentServer/make-alpha")
    const Beta = AgentSessionHost.Tag<string>("test/AgentServer/make-beta")
    const api = AgentServer.make({
      agents: [
        AgentServer.mount("alpha", { host: Alpha }),
        AgentServer.mount("beta", { host: Beta, path: "/internal" })
      ]
    })
    assert.deepStrictEqual(Object.keys(api.groups).sort(), ["alpha", "beta"])
    const alpha = AgentHttp.api({ name: "alpha" })
    const beta = AgentHttp.api({ name: "beta", path: "/internal" })
    assert.strictEqual(alpha.groups.alpha.endpoints.createSession.path, "/agents/alpha/sessions")
    assert.strictEqual(beta.groups.beta.endpoints.createSession.path, "/internal/sessions")
  })

  it("a duplicate name fails at construction, naming the collision", () => {
    const Host = AgentSessionHost.Tag<string>("test/AgentServer/dup-name")
    try {
      AgentServer.make({
        agents: [
          AgentServer.mount("support", { host: Host }),
          AgentServer.mount("support", { host: Host, path: "/other" })
        ]
      })
      assert.fail("expected DuplicateMountError")
    } catch (error) {
      assert.strictEqual(
        (error as AgentServer.DuplicateMountError)._tag,
        "@doeixd/effect-agent/http/DuplicateMountError"
      )
      const failure = error as AgentServer.DuplicateMountError
      assert.strictEqual(failure.kind, "name")
      assert.strictEqual(failure.value, "support")
      assert.include(failure.message, "support")
    }
  })

  it("a duplicate path fails at construction, naming the collision", () => {
    const Host = AgentSessionHost.Tag<string>("test/AgentServer/dup-path")
    try {
      AgentServer.make({
        agents: [
          AgentServer.mount("alpha", { host: Host, path: "/same" }),
          AgentServer.mount("beta", { host: Host, path: "/same" })
        ]
      })
      assert.fail("expected DuplicateMountError")
    } catch (error) {
      const failure = error as AgentServer.DuplicateMountError
      assert.strictEqual(failure.kind, "path")
      assert.strictEqual(failure.value, "/same")
      assert.include(failure.message, "/same")
    }
  })

  it.effect("two mounts are both reachable, each on its own path (SS1)", () =>
    Effect.gen(function*() {
      const Alpha = AgentSessionHost.Tag<string>("test/AgentServer/live-alpha")
      const Beta = AgentSessionHost.Tag<string>("test/AgentServer/live-beta")
      const released = yield* Ref.make(0)
      const client = Layer.succeed(AgentClient.AgentClient, {
        createSession: (options) =>
          Effect.gen(function*() {
            yield* Effect.addFinalizer(() => Ref.update(released, (n) => n + 1))
            return idleSession(sessionId(options?.sessionId ?? "generated"))
          }),
        session: (id: string) =>
          Effect.fail(new AgentClient.AgentSessionNotFoundError({ sessionId: id }))
      })

      const mounts = {
        agents: [
          AgentServer.mount("alpha", { host: Alpha }),
          AgentServer.mount("beta", { host: Beta })
        ]
      }
      const routes = AgentServer.serverLayer(mounts).pipe(
        Layer.provide(
          AgentSessionHost.layer(Alpha, hostOptions).pipe(Layer.provide(client))
        ),
        Layer.provide(
          AgentSessionHost.layer(Beta, hostOptions).pipe(Layer.provide(client))
        )
      )
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

      const created = yield* Effect.scoped(
        Effect.gen(function*() {
          const httpServer = yield* HttpServer.HttpServer
          const base = HttpServer.formatAddress(httpServer.address)
          const post = (path: string, session: string) =>
            Effect.promise(() =>
              fetch(`${base}${path}`, {
                method: "POST",
                headers: {
                  ...headers,
                  "content-type": "application/json"
                },
                body: JSON.stringify({
                  requestId: requestId(`create-${session}`),
                  sessionId: sessionId(session)
                })
              })
            )
          const alpha = yield* post("/agents/alpha/sessions", "alpha-session")
          const beta = yield* post("/agents/beta/sessions", "beta-session")
          return { alpha: alpha.status, beta: beta.status }
        }).pipe(Effect.provide(Layer.mergeAll(server, FetchHttpClient.layer)))
      )

      assert.strictEqual(created.alpha, 200)
      assert.strictEqual(created.beta, 200)
      // AS6: after the server scope closed, both hosted sessions are gone.
      assert.strictEqual(yield* Ref.get(released), 2)
    }))
})
