import { assert, describe, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Ref, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp, AgentServer } from "../src/http/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

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
    assert.deepStrictEqual(Object.keys(api.groups).sort(), ["alpha", "beta", "inventory"])
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
      const sessionsReleased = yield* Ref.make(0)
      const mountLayersReleased = yield* Ref.make(0)
      const client = Layer.succeed(AgentClient.AgentClient, {
        createSession: (options) =>
          Effect.gen(function*() {
            yield* Effect.addFinalizer(() =>
              Ref.update(sessionsReleased, (n) => n + 1)
            )
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
      const mountLifetime = () =>
        Layer.effectDiscard(
          Effect.addFinalizer(() =>
            Ref.update(mountLayersReleased, (n) => n + 1)
          )
        )
      const hosts = Layer.mergeAll(
        Layer.merge(
          AgentSessionHost.layer(Alpha, hostOptions).pipe(Layer.provide(client)),
          mountLifetime()
        ),
        Layer.merge(
          AgentSessionHost.layer(Beta, hostOptions).pipe(Layer.provide(client)),
          mountLifetime()
        )
      )
      const routes = AgentServer.serverLayer(mounts).pipe(
        Layer.provide(hosts)
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
      // AS6: after the server scope closed, both hosted sessions and both
      // application-supplied mount layers are gone. Counting both sides keeps
      // this from passing merely because the HTTP listener released.
      assert.strictEqual(yield* Ref.get(sessionsReleased), 2)
      assert.strictEqual(yield* Ref.get(mountLayersReleased), 2)
    }))

  it.effect("inventory lists mounts, live session counts, and remaining capacity (S4)", () =>
    Effect.gen(function*() {
      const Alpha = AgentSessionHost.Tag<string>("test/AgentServer/inventory-alpha")
      const Beta = AgentSessionHost.Tag<string>("test/AgentServer/inventory-beta")
      const client = Layer.succeed(AgentClient.AgentClient, {
        createSession: (options) =>
          Effect.succeed(idleSession(sessionId(options?.sessionId ?? "generated"))),
        session: (id: string) =>
          Effect.fail(new AgentClient.AgentSessionNotFoundError({ sessionId: id }))
      })
      const hosts = Layer.mergeAll(
        AgentSessionHost.layer(Alpha, { ...hostOptions, maxSessions: 4 }).pipe(
          Layer.provide(client)
        ),
        AgentSessionHost.layer(Beta, { ...hostOptions, maxSessions: 2 }).pipe(
          Layer.provide(client)
        )
      )
      const mounts = {
        agents: [
          AgentServer.mount("alpha", { host: Alpha }),
          AgentServer.mount("beta", { host: Beta })
        ]
      }
      const routes = AgentServer.serverLayer(mounts).pipe(Layer.provide(hosts))
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

      const body = yield* Effect.scoped(
        Effect.gen(function*() {
          const httpServer = yield* HttpServer.HttpServer
          const base = HttpServer.formatAddress(httpServer.address)
          const empty = yield* Effect.promise(() => fetch(`${base}/inventory`))
          assert.strictEqual(empty.status, 200)
          const before = (yield* Effect.promise(() => empty.json())) as AgentServer.Inventory
          assert.strictEqual(before.ok, true)
          assert.deepStrictEqual(
            before.agents.map((agent) => ({
              name: agent.name,
              sessions: agent.sessions,
              maxSessions: agent.maxSessions,
              remaining: agent.remaining
            })),
            [
              { name: "alpha", sessions: 0, maxSessions: 4, remaining: 4 },
              { name: "beta", sessions: 0, maxSessions: 2, remaining: 2 }
            ]
          )

          const created = yield* Effect.promise(() =>
            fetch(`${base}/agents/alpha/sessions`, {
              method: "POST",
              headers: {
                ...headers,
                "content-type": "application/json"
              },
              body: JSON.stringify({
                requestId: requestId("inventory-create"),
                sessionId: sessionId("inventory-alpha-1")
              })
            })
          )
          assert.strictEqual(created.status, 200)

          const afterRes = yield* Effect.promise(() => fetch(`${base}/inventory`))
          const after = (yield* Effect.promise(() => afterRes.json())) as AgentServer.Inventory
          const alpha = after.agents.find((agent) => agent.name === "alpha")
          const beta = after.agents.find((agent) => agent.name === "beta")
          assert.strictEqual(alpha?.sessions, 1)
          assert.strictEqual(alpha?.remaining, 3)
          assert.strictEqual(beta?.sessions, 0)
          assert.strictEqual(beta?.remaining, 2)
          return after
        }).pipe(Effect.provide(Layer.mergeAll(server, FetchHttpClient.layer)))
      )

      assert.strictEqual(body.ok, true)
    }))

  it.effect("a local mount and a remote-backed mount are both reachable (AS3)", () =>
    Effect.gen(function*() {
      const { layer: innerModel } = yield* TestLanguageModel.script([
        TestLanguageModel.text("from-remote")
      ])
      const { layer: localModel } = yield* TestLanguageModel.script([
        TestLanguageModel.text("from-local")
      ])
      const InnerHost = AgentSessionHost.Tag<string>("test/AgentServer/mixed-inner")
      const LocalHost = AgentSessionHost.Tag<string>("test/AgentServer/mixed-local")
      const RemoteHost = AgentSessionHost.Tag<string>("test/AgentServer/mixed-remote")
      const agent = Agent.make({ loop: AgentLoop.bounded(4) })

      const innerHost = AgentSessionHost.layer(InnerHost, hostOptions).pipe(
        Layer.provide(AgentClient.layer(agent)),
        Layer.provide(innerModel)
      )
      const innerRoutes = AgentHttp.serverLayer({ host: InnerHost }).pipe(
        Layer.provide(innerHost)
      )
      const innerServer = HttpRouter.serve(innerRoutes, {
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

      yield* Effect.scoped(
        Effect.gen(function*() {
          const innerHttp = yield* HttpServer.HttpServer
          const remoteClient = AgentHttp.agentClientLayer({
            baseUrl: HttpServer.formatAddress(innerHttp.address),
            headers
          }).pipe(Layer.provide(FetchHttpClient.layer))

          const localHost = AgentSessionHost.layer(LocalHost, hostOptions).pipe(
            Layer.provide(AgentClient.layer(agent)),
            Layer.provide(localModel)
          )
          const remoteHost = AgentSessionHost.layer(RemoteHost, hostOptions).pipe(
            Layer.provide(remoteClient)
          )
          const mounts = {
            agents: [
              AgentServer.mount("local", { host: LocalHost }),
              AgentServer.mount("remote", { host: RemoteHost })
            ]
          }
          const outer = AgentServer.serverLayer(mounts).pipe(
            Layer.provide(Layer.mergeAll(localHost, remoteHost))
          )
          const outerServer = HttpRouter.serve(outer, {
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

          const results = yield* Effect.scoped(
            Effect.gen(function*() {
              const outerHttp = yield* HttpServer.HttpServer
              const base = HttpServer.formatAddress(outerHttp.address)
              const localApi = yield* HttpApiClient.make(
                AgentHttp.api({ name: "local" }),
                { baseUrl: base }
              )
              const remoteApi = yield* HttpApiClient.make(
                AgentHttp.api({ name: "remote" }),
                { baseUrl: base }
              )
              const localId = sessionId("mixed-local")
              const remoteId = sessionId("mixed-remote")
              yield* localApi.local.createSession({
                headers,
                payload: { requestId: requestId("create-local"), sessionId: localId }
              })
              yield* remoteApi.remote.createSession({
                headers,
                payload: { requestId: requestId("create-remote"), sessionId: remoteId }
              })
              const local = yield* localApi.local.prompt({
                params: { id: localId },
                headers,
                payload: {
                  requestId: requestId("prompt-local"),
                  input: Prompt.make("hi")
                }
              })
              const remote = yield* remoteApi.remote.prompt({
                params: { id: remoteId },
                headers,
                payload: {
                  requestId: requestId("prompt-remote"),
                  input: Prompt.make("hi")
                }
              })
              return { local: local.result.text, remote: remote.result.text }
            }).pipe(
              Effect.provide(Layer.mergeAll(outerServer, FetchHttpClient.layer))
            )
          )

          assert.strictEqual(results.local, "from-local")
          assert.strictEqual(results.remote, "from-remote")
        }).pipe(Effect.provide(Layer.mergeAll(innerServer, FetchHttpClient.layer)))
      )
    }))
})
