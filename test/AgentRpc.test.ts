import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Stream,
  Tracer
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { Socket } from "effect/unstable/socket"
import { NodeHttpServer } from "@effect/platform-node"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer
} from "effect/unstable/http"
import {
  RpcClient,
  RpcClientError,
  RpcSerialization,
  RpcServer,
  RpcTest
} from "effect/unstable/rpc"
import { createServer } from "node:http"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { AgentRpc } from "../src/rpc/index.js"
import * as Contract from "./AgentClientContract.js"
import { promptOf } from "./helpers.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false
type Assert<T extends true> = T

const spanNames = (span: Tracer.AnySpan): ReadonlyArray<string> => {
  const names: Array<string> = []
  let current: Option.Option<Tracer.AnySpan> = Option.some(span)
  while (Option.isSome(current)) {
    if (current.value._tag === "Span") {
      names.push(current.value.name)
      current = current.value.parent
    } else {
      current = Option.none()
    }
  }
  return names
}

const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sessionId = (value: string) => AgentProtocol.SessionId.make(value)

const fixture = (options?: { readonly blockPrompt?: boolean }) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const authentication = yield* Ref.make<ReadonlyArray<string>>([])
    const released = yield* Ref.make(0)
    const promptCalls = yield* Ref.make(0)
    const promptInputs = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
    const promptStarted = yield* Deferred.make<void>()
    const promptSpan = yield* Deferred.make<{
      readonly names: ReadonlyArray<string>
      readonly traceId: string
    }>()
    const allowPrompt = yield* Deferred.make<void>()
    const submissionId = AgentProtocol.SubmissionId.make("submission-rpc")

    const record = (operation: string) =>
      Ref.update(calls, (all) => [...all, operation])

    const layer = Layer.succeed(AgentClient.AgentClient, {
      createSession: (sessionOptions) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Ref.update(released, (count) => count + 1)
          )
          const id = sessionOptions?.sessionId ?? "generated-rpc-session"
          const brandedId = sessionId(id)
          const events = [
            {
              sessionId: brandedId,
              submissionId: Option.none<AgentEvent.SubmissionId>(),
              runId: Option.none<AgentEvent.RunId>(),
              turn: Option.none<number>(),
              sequence: 1,
              event: { _tag: "SessionStarted" } as const
            },
            {
              sessionId: brandedId,
              submissionId: Option.some(submissionId),
              runId: Option.none<AgentEvent.RunId>(),
              turn: Option.none<number>(),
              sequence: 2,
              event: { _tag: "SubmissionStarted" } as const
            }
          ]

          return {
            id,
            prompt: (input) =>
              Effect.gen(function* () {
                yield* record("prompt")
                yield* Ref.update(promptInputs, (all) => [...all, promptOf(input)])
                const currentSpan = yield* Effect.option(Effect.currentSpan)
                if (Option.isSome(currentSpan)) {
                  yield* Deferred.succeed(
                    promptSpan,
                    {
                      names: spanNames(currentSpan.value),
                      traceId: currentSpan.value.traceId
                    }
                  )
                }
                yield* Ref.update(promptCalls, (count) => count + 1)
                yield* Deferred.succeed(promptStarted, void 0)
                if (options?.blockPrompt === true) {
                  yield* Deferred.await(allowPrompt)
                }
                return {
                  submissionId,
                  status: "completed" as const,
                  runs: 1,
                  turns: 1,
                  text: "rpc answer",
                  content: []
                }
              }),
            submit: () => Effect.die("submit is not part of this fixture"),
            awaitSubmission: () => Effect.die("awaitSubmission is not part of this fixture"),
            steer: () => record("steer"),
            followUp: () => record("followUp"),
            interrupt: () => record("interrupt"),
            respond: () => Effect.as(record("respond"), true),
            pending: Effect.as(record("pending"), [
              { id: "approval-1", kind: "approval", detail: "check" }
            ]),
            history: Effect.as(
              record("history"),
              Prompt.make([{
                role: "assistant",
                content: [{
                  type: "file",
                  mediaType: "text/plain",
                  data: new URL("https://example.com/result.txt")
                }]
              }])
            ),
            status: Effect.as(record("status"), "idle" as const),
            events: () => Stream.fromIterable(events)
          }
        }),
      session: (id) =>
        Effect.fail(
          new AgentClient.AgentSessionNotFoundError({ sessionId: id })
        )
    })

    const Host = AgentSessionHost.Tag<string>("test/AgentRpc/host")
    const host = AgentSessionHost.layer(Host, {
      authorization: {
        authorize: ({ operation }) => record(`authorize:${operation}`)
      },
      principal: {
        resolve: ({ headers, operation }) => {
          const authorization = headers.authorization
          if (authorization === undefined) {
            return Effect.fail(
              new AgentProtocol.AgentUnauthorizedError({ operation })
            )
          }
          return Effect.as(
            Ref.update(authentication, (all) => [
              ...all,
              `${operation}:${authorization}`
            ]),
            authorization
          )
        }
      },
      maxSessions: 4,
      maxRequestsPerSession: 16
    }).pipe(Layer.provide(layer))
    const server = AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host))

    return {
      server,
      calls,
      authentication,
      released,
      promptCalls,
      promptInputs,
      promptStarted,
      promptSpan,
      allowPrompt
    }
  })

const authenticated = { headers: { authorization: "Bearer test" } } as const

describe("AgentRpc", () => {
  it.effect("serves the complete typed session API and ordered event stream", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const id = sessionId("rpc-session")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(AgentRpc.Protocol)
          const created = yield* client.createSession(
            { requestId: requestId("create"), sessionId: id },
            authenticated
          )
          type _Created = Assert<
            Equal<typeof created, AgentProtocol.CreateSessionResponse>
          >
          assert.strictEqual(created.session.sessionId, id)

          const found = yield* client.getSession({ sessionId: id }, authenticated)
          assert.strictEqual(found.status, "idle")

          const outboundBytes = new Uint8Array([10, 11, 12])
          const traced = yield* Effect.gen(function* () {
            const span = yield* Effect.currentSpan
            const result = yield* client.prompt(
              {
                requestId: requestId("prompt"),
                sessionId: id,
                input: Prompt.make([{
                  role: "user",
                  content: [{
                    type: "file",
                    mediaType: "application/octet-stream",
                    data: outboundBytes
                  }]
                }])
              },
              authenticated
            )
            return { result, traceId: span.traceId }
          }).pipe(Effect.withSpan("AgentRpc.test"))
          assert.strictEqual(traced.result.result.text, "rpc answer")
          const receivedPrompt = (yield* Ref.get(test.promptInputs))[0]
          assert.isDefined(receivedPrompt)
          const receivedData = receivedPrompt?.content.flatMap((message) =>
            message.role === "user"
              ? message.content.flatMap((part) => part.type === "file" ? [part.data] : [])
              : []
          )[0]
          assert.isTrue(receivedData instanceof Uint8Array)
          if (receivedData instanceof Uint8Array) {
            assert.deepStrictEqual(Array.from(receivedData), Array.from(outboundBytes))
          }
          const serverSpan = yield* Deferred.await(test.promptSpan)
          assert.strictEqual(serverSpan.traceId, traced.traceId)
          assert.deepStrictEqual(serverSpan.names, [
            "AgentSessionHost.mutate",
            "AgentSessionHost.prompt",
            "RpcServer.prompt"
          ])

          assert.isTrue(
            (yield* client.steer(
              {
                requestId: requestId("steer"),
                sessionId: id,
                input: Prompt.make("steer")
              },
              authenticated
            )).accepted
          )
          assert.isTrue(
            (yield* client.followUp(
              {
                requestId: requestId("follow-up"),
                sessionId: id,
                input: Prompt.make("more")
              },
              authenticated
            )).accepted
          )
          assert.isTrue(
            (yield* client.interrupt(
              { requestId: requestId("interrupt"), sessionId: id },
              authenticated
            )).accepted
          )
          assert.isTrue(
            (yield* client.respond(
              {
                requestId: requestId("respond"),
                sessionId: id,
                response: { id: "approval-1", granted: true }
              },
              authenticated
            )).matched
          )

          assert.deepStrictEqual(
            (yield* client.pending({ sessionId: id }, authenticated)).requests,
            [{ id: "approval-1", kind: "approval", detail: "check" }]
          )
          const remoteHistory = (
            yield* client.history({ sessionId: id }, authenticated)
          ).history
          assert.strictEqual(remoteHistory.content[0]?.role, "assistant")
          const remoteData = remoteHistory.content.flatMap((message) =>
            message.role === "assistant"
              ? message.content.flatMap((part) => part.type === "file" ? [part.data] : [])
              : []
          )[0]
          assert.isTrue(remoteData instanceof URL)
          if (remoteData instanceof URL) {
            assert.strictEqual(remoteData.href, "https://example.com/result.txt")
          }
          assert.strictEqual(
            (yield* client.status({ sessionId: id }, authenticated)).status,
            "idle"
          )

          const events = yield* Stream.runCollect(
            client.events({ sessionId: id }, authenticated)
          )
          assert.deepStrictEqual(
            events.map((event) => [event.sequence, event.event._tag]),
            [
              [1, "SessionStarted"],
              [2, "SubmissionStarted"]
            ]
          )

          const closed = yield* client.closeSession(
            { requestId: requestId("close"), sessionId: id },
            authenticated
          )
          assert.isTrue(closed.closed)
        }).pipe(Effect.provide(test.server))
      )

      assert.strictEqual(yield* Ref.get(test.released), 1)
      assert.deepStrictEqual(yield* Ref.get(test.calls), [
        "authorize:createSession",
        "status",
        "authorize:getSession",
        "status",
        "authorize:prompt",
        "prompt",
        "authorize:steer",
        "steer",
        "authorize:followUp",
        "followUp",
        "authorize:interrupt",
        "interrupt",
        "authorize:respond",
        "respond",
        "authorize:pending",
        "pending",
        "authorize:history",
        "history",
        "authorize:status",
        "status",
        "authorize:events",
        "authorize:closeSession"
      ])
      assert.deepStrictEqual(
        (yield* Ref.get(test.authentication)).map((entry) =>
          entry.slice(0, entry.indexOf(":"))
        ),
        [
          "createSession",
          "getSession",
          "prompt",
          "steer",
          "followUp",
          "interrupt",
          "respond",
          "pending",
          "history",
          "status",
          "events",
          "closeSession"
        ]
      )
    })
  )

  it.effect("preserves domain errors and keeps transport errors in the client type", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const missing = sessionId("missing")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(AgentRpc.Protocol)
          const missingCall = client.status({ sessionId: missing }, authenticated)
          type _DomainError = Assert<
            Equal<Effect.Error<typeof missingCall>, AgentProtocol.RemoteError>
          >
          const missingError = yield* Effect.flip(missingCall)
          assert.strictEqual(missingError._tag, "AgentSessionNotFoundError")

          const unauthorized = yield* Effect.flip(
            client.status({ sessionId: missing })
          )
          assert.strictEqual(unauthorized._tag, "AgentUnauthorizedError")

          const publicClient = yield* AgentRpc.Client
          const publicCall = publicClient.status({ sessionId: missing })
          type _PublicError = Assert<
            Equal<
              Effect.Error<typeof publicCall>,
              AgentProtocol.RemoteError | RpcClientError.RpcClientError
            >
          >
          assert.isTrue(Effect.isEffect(publicCall))
        }).pipe(
          Effect.provideServiceEffect(
            AgentRpc.Client,
            RpcTest.makeClient(AgentRpc.Protocol)
          ),
          Effect.provide(test.server)
        )
      )
    })
  )

  it.effect("lets a retry finish after the first RPC waiter is interrupted", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ blockPrompt: true })
      const id = sessionId("durable-request")
      const request = {
        requestId: requestId("shared-prompt"),
        sessionId: id,
        input: Prompt.make("once")
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(AgentRpc.Protocol)
          yield* client.createSession(
            { requestId: requestId("create"), sessionId: id },
            authenticated
          )
          const first = yield* Effect.forkChild(client.prompt(request, authenticated))
          yield* Deferred.await(test.promptStarted)
          yield* Fiber.interrupt(first)

          const retry = yield* Effect.forkChild(client.prompt(request, authenticated))
          yield* Deferred.succeed(test.allowPrompt, void 0)
          const result = yield* Fiber.join(retry)
          assert.strictEqual(result.result.text, "rpc answer")
          assert.strictEqual(yield* Ref.get(test.promptCalls), 1)
        }).pipe(Effect.provide(test.server))
      )
    })
  )

  it.effect("closes acquired sessions but not attached sessions", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const owned = sessionId("owned")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const raw = yield* RpcTest.makeClient(AgentRpc.Protocol)
          yield* Effect.scoped(
            AgentRpc.acquireSession({
              requestId: requestId("create-owned"),
              sessionId: owned
            }, authenticated).pipe(Effect.provideService(AgentRpc.Client, raw))
          )
          assert.strictEqual(yield* Ref.get(test.released), 1)

          const attached = sessionId("attached")
          yield* raw.createSession(
            { requestId: requestId("create-attached"), sessionId: attached },
            authenticated
          )
          yield* raw.getSession({ sessionId: attached }, authenticated)
          assert.strictEqual(yield* Ref.get(test.released), 1)
        }).pipe(Effect.provide(test.server))
      )

      assert.strictEqual(yield* Ref.get(test.released), 2)
    })
  )

  it.effect("round-trips schemas and streams over a real HTTP server", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const id = sessionId("http-session")
      const rpcRoutes = RpcServer.layerHttp({
        group: AgentRpc.Protocol,
        path: "/rpc",
        protocol: "http"
      }).pipe(
        Layer.provide(test.server),
        Layer.provide(RpcSerialization.layerNdjson)
      )
      const httpServer = HttpRouter.serve(rpcRoutes, {
        disableLogger: true,
        disableListenLog: true
      }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { port: 0 })
        )
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const http = yield* HttpClient.HttpClient
          const protocol = yield* RpcClient.makeProtocolHttp(
            HttpClient.mapRequest(
              http,
              HttpClientRequest.prependUrl(
                `${HttpServer.formatAddress(server.address)}/rpc`
              )
            )
          )
          const client = yield* RpcClient.make(AgentRpc.Protocol).pipe(
            Effect.provideService(RpcClient.Protocol, protocol)
          )
          const created = yield* client.createSession(
            { requestId: requestId("http-create"), sessionId: id },
            authenticated
          )
          assert.strictEqual(created.session.sessionId, id)

          const result = yield* client.prompt(
            {
              requestId: requestId("http-prompt"),
              sessionId: id,
              input: Prompt.make("through HTTP")
            },
            authenticated
          )
          assert.strictEqual(result.result.text, "rpc answer")

          const events = yield* Stream.runCollect(
            client.events({ sessionId: id }, authenticated)
          )
          assert.deepStrictEqual(
            events.map((event) => event.sequence),
            [1, 2]
          )

          const missing = yield* Effect.flip(
            client.status({ sessionId: sessionId("http-missing") }, authenticated)
          )
          assert.strictEqual(missing._tag, "AgentSessionNotFoundError")
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              RpcSerialization.layerNdjson,
              FetchHttpClient.layer,
              httpServer
            )
          )
        )
      )

      assert.strictEqual(yield* Ref.get(test.released), 1)
    })
  )

  it.effect("keeps an idempotent mutation alive across an HTTP disconnect", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ blockPrompt: true })
      const id = sessionId("http-retry-session")
      const request = {
        requestId: requestId("http-shared-prompt"),
        sessionId: id,
        input: Prompt.make("once over HTTP")
      }
      const rpcRoutes = RpcServer.layerHttp({
        group: AgentRpc.Protocol,
        path: "/rpc",
        protocol: "http"
      }).pipe(
        Layer.provide(test.server),
        Layer.provide(RpcSerialization.layerNdjson)
      )
      const httpServer = HttpRouter.serve(rpcRoutes, {
        disableLogger: true,
        disableListenLog: true
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const http = yield* HttpClient.HttpClient
          const protocol = yield* RpcClient.makeProtocolHttp(
            HttpClient.mapRequest(
              http,
              HttpClientRequest.prependUrl(
                `${HttpServer.formatAddress(server.address)}/rpc`
              )
            )
          )
          const client = yield* RpcClient.make(AgentRpc.Protocol).pipe(
            Effect.provideService(RpcClient.Protocol, protocol)
          )

          yield* client.createSession(
            { requestId: requestId("http-retry-create"), sessionId: id },
            authenticated
          )
          const disconnected = yield* Effect.forkChild(
            client.prompt(request, authenticated)
          )
          yield* Deferred.await(test.promptStarted)
          yield* Fiber.interrupt(disconnected)

          const retry = yield* Effect.forkChild(
            client.prompt(request, authenticated)
          )
          yield* Deferred.succeed(test.allowPrompt, void 0)
          assert.strictEqual(
            (yield* Fiber.join(retry)).result.text,
            "rpc answer"
          )
          assert.strictEqual(yield* Ref.get(test.promptCalls), 1)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              RpcSerialization.layerNdjson,
              FetchHttpClient.layer,
              httpServer
            )
          )
        )
      )

      assert.strictEqual(yield* Ref.get(test.released), 1)
    })
  )

  it.effect("runs bidirectional calls and event streaming over WebSocket", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const id = sessionId("websocket-session")
      const rpcRoutes = RpcServer.layerHttp({
        group: AgentRpc.Protocol,
        path: "/rpc",
        protocol: "websocket"
      }).pipe(
        Layer.provide(test.server),
        Layer.provide(RpcSerialization.layerNdjson)
      )
      const httpServer = HttpRouter.serve(rpcRoutes, {
        disableLogger: true,
        disableListenLog: true
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
      )
      const opened = { current: Option.none<globalThis.WebSocket>() }
      const webSocketConstructor = Layer.succeed(
        Socket.WebSocketConstructor,
        (url, protocols) => {
          const webSocket = new globalThis.WebSocket(url, protocols)
          opened.current = Option.some(webSocket)
          return webSocket
        }
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const address = HttpServer.formatAddress(server.address)
          const socket = yield* Socket.makeWebSocket(
            `${address.replace(/^http/, "ws")}/rpc`
          )
          const protocol = yield* RpcClient.makeProtocolSocket().pipe(
            Effect.provideService(Socket.Socket, socket)
          )
          const client = yield* RpcClient.make(AgentRpc.Protocol).pipe(
            Effect.provideService(RpcClient.Protocol, protocol)
          )

          yield* client.createSession(
            { requestId: requestId("ws-create"), sessionId: id },
            authenticated
          )
          const events = yield* Stream.runCollect(
            client.events({ sessionId: id }, authenticated)
          )
          assert.deepStrictEqual(
            events.map((event) => event.event._tag),
            ["SessionStarted", "SubmissionStarted"]
          )
          assert.strictEqual(
            (yield* client.status({ sessionId: id }, authenticated)).status,
            "idle"
          )
          yield* Effect.sync(() => {
            if (Option.isSome(opened.current)) {
              opened.current.value.close(1000)
            }
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              webSocketConstructor,
              RpcSerialization.layerNdjson,
              httpServer
            )
          )
        )
      )

      assert.strictEqual(yield* Ref.get(test.released), 1)
    })
  )
})

/**
 * RPC as an `AgentClient` -- `docs/plan-failure-paths.md` 48f.
 *
 * Until this existed, RPC was the one advertised transport whose client side
 * no suite could see: this file ran only the protocol-error contract below,
 * and `AgentClientConformance` covered the in-process, HTTP and durable
 * clients. The adapter is thin, so what is really under test here is that the
 * seam's twenty rows hold over a real request/response protocol -- and, in
 * `test/RelayContract.test.ts`, over that protocol carried by the relay.
 */
const contractHarness: Contract.Harness = {
  name: "rpc",
  layer: ({ agent, turns, elicitation, maxRetainedSubmissions }) =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script(turns)
      const Host = AgentSessionHost.Tag<string>(
        `test/AgentRpc/contract/${globalThis.crypto.randomUUID()}`
      )
      const host = AgentSessionHost.layer(Host, {
        principal: { resolve: () => Effect.succeed("rpc-contract") },
        authorization: AgentSessionHost.allowAll(),
        maxSessions: 32,
        maxRequestsPerSession: 256
      }).pipe(
        Layer.provide(
          AgentClient.layer(agent, {
            ...(elicitation ? { elicitation } : {}),
            ...(maxRetainedSubmissions === undefined ? {} : { maxRetainedSubmissions })
          }).pipe(Layer.provide(model))
        )
      )
      const client = Layer.effect(AgentRpc.Client, RpcTest.makeClient(AgentRpc.Protocol)).pipe(
        Layer.provide(AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host)))
      )
      return AgentRpc.agentClientLayer().pipe(Layer.provide(client))
    })
}

Contract.run(contractHarness)

/**
 * Issue #73: the same protocol-error contract the HTTP client is held to.
 *
 * RPC never collapsed these -- it exposes the protocol group's own error
 * union -- and that is exactly why it belongs here. The two transports
 * disagreeing about what a 403 is was invisible for as long as each was
 * checked by its own suite; running one contract over both is what makes a
 * future divergence a failing test rather than a review comment.
 */
const rpcProtocolErrors: Contract.ProtocolErrorHarness = {
  name: "rpc",
  failure: (error) =>
    Effect.gen(function* () {
      const Host = AgentSessionHost.Tag<string>(
        `test/AgentRpc/errors/${globalThis.crypto.randomUUID()}`
      )
      const handlers = AgentRpc.serverLayer({ host: Host }).pipe(
        Layer.provide(Layer.succeed(Host, Contract.failingHost("rpc-errors", error)))
      )
      return yield* Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(AgentRpc.Protocol)
        // A host that fails every operation and still answers with a session
        // is a broken fixture, not a case this contract has an answer for.
        return yield* Effect.orDie(
          Effect.flip(
            client.getSession(
              { sessionId: sessionId("protocol-errors") },
              { headers: { authorization: "Bearer test" } }
            )
          )
        )
      }).pipe(Effect.provide(handlers), Effect.scoped)
    })
}

Contract.runProtocolErrors(rpcProtocolErrors)
