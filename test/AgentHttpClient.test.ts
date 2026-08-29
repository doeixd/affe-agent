import { assert, describe, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Ref } from "effect"
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

/**
 * Issue #73: every protocol error survives the HTTP round trip as itself.
 *
 * A real server on a real socket, because the collapse this checks happened in
 * the *client's* decoding of a response the server had already encoded
 * correctly. An in-process fake would never have shown it.
 */
const protocolErrors: Contract.ProtocolErrorHarness = {
  name: "http",
  failure: (error) =>
    Effect.gen(function* () {
      const Host = AgentSessionHost.Tag<string>(
        `test/AgentHttpClient/errors/${globalThis.crypto.randomUUID()}`
      )
      const host = Layer.succeed(
        Host,
        Contract.failingHost("http-errors", error)
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
      return yield* Effect.scoped(
        Effect.flatMap(Effect.service(AgentClient.AgentClient), (client) =>
          // A host that fails every operation returning a session is a broken
          // fixture, not a case this contract has an answer for.
          Effect.orDie(Effect.flip(client.session("protocol-errors")))
        ).pipe(
          Effect.provide(
            AgentHttp.agentClientFromServer().pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Layer.orDie(server))
            )
          )
        )
      )
    })
}

Contract.runProtocolErrors(protocolErrors)

/**
 * The request id is the idempotency key, and it survives a retry.
 *
 * A durable store answers a repeated claim only if both attempts arrive under
 * the same name. Minting a fresh id per attempt -- or per call, when the caller
 * has already named the request -- would turn the retry a caller intends as one
 * claim into a second submission, which is precisely the lost-acknowledgement
 * case idempotency exists for.
 */
describe("AgentHttp prompt idempotency", () => {
  const recordingHost = (
    seen: Ref.Ref<ReadonlyArray<string>>
  ): AgentSessionHost.Service<string> => ({
    ...Contract.failingHost(
      "idempotency",
      new AgentClient.AgentTransportError({
        sessionId: "retry",
        detail: "unused"
      })
    ),
    session: (_principal, request) =>
      Effect.succeed({ sessionId: request.sessionId, status: "idle" as const }),
    prompt: (_principal, request) =>
      Effect.flatMap(
        Ref.update(seen, (all) => [...all, request.requestId]),
        () =>
          // Retryable on purpose: the caller's retry policy is what puts the
          // second request on the wire.
          Effect.fail(
            new AgentClient.AgentTransportError({
              sessionId: request.sessionId,
              detail: "connection reset"
            })
          )
      )
  })

  const withRecordingClient = <A>(
    use: (
      client: AgentClient.Service,
      seen: Ref.Ref<ReadonlyArray<string>>
    ) => Effect.Effect<A>
  ) =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const Host = AgentSessionHost.Tag<string>(
        `test/AgentHttpClient/idempotency/${globalThis.crypto.randomUUID()}`
      )
      const routes = AgentHttp.serverLayer({ host: Host }).pipe(
        Layer.provide(Layer.succeed(Host, recordingHost(seen)))
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
      return yield* Effect.scoped(
        Effect.flatMap(Effect.service(AgentClient.AgentClient), (client) =>
          use(client, seen)
        ).pipe(
          Effect.provide(
            AgentHttp.agentClientFromServer().pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Layer.orDie(server))
            )
          )
        )
      )
    })

  it.live("a retried prompt reaches the server under the same request id", () =>
    withRecordingClient((client, seen) =>
      Effect.gen(function* () {
        const session = yield* Effect.orDie(client.session("retry"))
        yield* Effect.orDie(
          Effect.flip(Effect.retry(session.prompt("go"), { times: 1 }))
        )
        const ids = yield* Ref.get(seen)
        assert.strictEqual(ids.length, 2)
        // The same claim twice, not two claims.
        assert.strictEqual(ids[0], ids[1])
      })
    )
  )

  it.live("a caller's idempotency key is the request id on the wire", () =>
    withRecordingClient((client, seen) =>
      Effect.gen(function* () {
        const session = yield* Effect.orDie(client.session("retry"))
        yield* Effect.orDie(
          Effect.flip(session.prompt("go", { idempotencyKey: "caller-key" }))
        )
        assert.deepStrictEqual(yield* Ref.get(seen), ["caller-key"])
      })
    )
  )
})
