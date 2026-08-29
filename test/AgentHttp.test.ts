import { assert, describe, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Stream
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import {
  FetchHttpClient,
  HttpClientError,
  HttpRouter,
  HttpServer
} from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import * as AgentEvent from "../src/AgentEvent.js"
import * as SseBody from "../src/http/internal/sse.js"
import { AgentBusyError, AgentClosedError, AgentIdleError } from "../src/Errors.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false
type Assert<T extends true> = T

const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sessionId = (value: string) => AgentProtocol.SessionId.make(value)
const headers = { authorization: "Bearer test" } as const
const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const fixture = (options?: {
  readonly blockPrompt?: boolean
  readonly holdEvents?: boolean
  /** The session's event stream fails after its first event. */
  readonly failEvents?: boolean
  /**
   * `events` refuses `after`, the way a session with no delivery log does.
   *
   * The default fixture honours resumption, which cannot tell "resume from
   * 0" apart from "live": both deliver sequence 1 first. A client that
   * refuses can, and that is what the in-process client actually is.
   */
  readonly refuseResume?: boolean
  /** `session(id)` addresses any id, the way a durable client does. */
  readonly adoptable?: boolean
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const released = yield* Ref.make(0)
    const promptCalls = yield* Ref.make(0)
    const promptInputs = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
    const promptStarted = yield* Deferred.make<void>()
    const allowPrompt = yield* Deferred.make<void>()
    const eventStreamReleased = yield* Deferred.make<void>()
    const submissionId = AgentProtocol.SubmissionId.make("submission-http")

    const record = (operation: string) =>
      Ref.update(calls, (all) => [...all, operation])

    const adopted = yield* Ref.make<ReadonlyArray<string>>([])
    const agentClient = Layer.succeed(AgentClient.AgentClient, {
      createSession: (sessionOptions) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Ref.update(released, (count) => count + 1)
          )
          const id = sessionOptions?.sessionId ?? "generated-http-session"
          const brandedId = sessionId(id)
          const events = Stream.fromIterable([
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
          ]).pipe(
            options?.holdEvents === true
              ? Stream.concat(Stream.never)
              : (stream) => stream,
            options?.failEvents === true
              ? Stream.concat(
                  Stream.fail(
                    new AgentClient.AgentTransportError({
                      sessionId: id,
                      detail: "the delivery log went away"
                    })
                  )
                )
              : (stream) => stream,
            Stream.ensuring(Deferred.succeed(eventStreamReleased, void 0))
          )

          return {
            id,
            prompt: (input) =>
              Effect.gen(function* () {
                yield* record("prompt")
                yield* Ref.update(promptInputs, (all) => [...all, Prompt.make(input)])
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
                  text: "http answer",
                  content: []
                }
              }),
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
                  mediaType: "application/octet-stream",
                  data: new Uint8Array([7, 8, 9])
                }]
              }])
            ),
            status: Effect.as(record("status"), "idle" as const),
            /**
             * Honours `after` the way a delivery log does, so a transport test
             * can check the wiring without standing up a real one. What the
             * log itself guarantees at the seam is
             * `DurableAgentClient.test.ts`'s subject, not this one's.
             */
            events: (eventOptions) =>
              eventOptions?.after === undefined
                ? events
                : options?.refuseResume === true
                  ? Stream.fail(
                      new AgentClient.AgentTransportError({
                        sessionId: id,
                        detail: "this session has no delivery log"
                      })
                    )
                  : Stream.filter(events, (e) => e.sequence > eventOptions.after!)
          }
        }),
      session: (id) =>
        options?.adoptable === true
          ? Effect.as(
              Ref.update(adopted, (all) => [...all, id]),
              {
                id,
                prompt: () =>
                  Effect.succeed({
                    submissionId,
                    status: "completed" as const,
                    runs: 1,
                    turns: 1,
                    text: `adopted ${id}`,
                    content: []
                  }),
                steer: () => Effect.void,
                followUp: () => Effect.void,
                interrupt: () => Effect.void,
                respond: () => Effect.succeed(false),
                pending: Effect.succeed([]),
                history: Effect.succeed(Prompt.make("adopted")),
                status: Effect.succeed("idle" as const),
                events: () => Stream.empty
              } satisfies AgentClient.RemoteSession
            )
          : Effect.fail(
              new AgentClient.AgentSessionNotFoundError({ sessionId: id })
            )
    })

    const Host = AgentSessionHost.Tag<string>("test/AgentHttp/host")
    const host = AgentSessionHost.layer(Host, {
      authorization: {
        authorize: ({ operation, principal, sessionId: currentSessionId }) =>
          principal === "Bearer forbidden"
            ? Effect.fail(
                new AgentProtocol.AgentForbiddenError({
                  operation,
                  sessionId: currentSessionId
                })
              )
            : record(`authorize:${operation}`)
      },
      principal: {
        resolve: ({ headers: requestHeaders, operation }) =>
          requestHeaders.authorization === undefined
            ? Effect.fail(
                new AgentProtocol.AgentUnauthorizedError({ operation })
              )
            : Effect.succeed(requestHeaders.authorization)
      },
      maxSessions: 4,
      maxRequestsPerSession: 16
    }).pipe(Layer.provide(agentClient))
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

    return {
      server,
      routes,
      calls,
      adopted,
      released,
      promptCalls,
      promptInputs,
      promptStarted,
      allowPrompt,
      eventStreamReleased
    }
  })

const json = <S extends Schema.Constraint>(response: Response, schema: S) =>
  promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema)))
  )

describe("AgentHttp", () => {
  it.live("bounds the SSE queue, so a stalled reader cannot run the producer away", () =>
    Effect.gen(function* () {
      const produced = yield* Ref.make(0)
      // Completed only if the producer gets further ahead than the bound
      // allows. Waiting on it -- rather than sleeping and counting -- is what
      // makes "the producer blocked" the thing being asserted.
      const overran = yield* Deferred.make<void>()
      // Never completed: the reader takes one frame and stalls, which is the
      // sleeping laptop this bound exists for.
      const stalled = yield* Deferred.make<void>()

      const source = Stream.unfold(0, (seed) =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(produced, (n) => n + 1)
          if (count > SseBody.frameCapacity + 8) {
            yield* Deferred.succeed(overran, void 0)
          }
          return [`data: ${count}

`, seed + 1]
        })
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* Effect.forkChild(
            Stream.runForEach(SseBody.body(source), () => Deferred.await(stalled))
          )
          const ran = yield* Effect.timeoutOption(
            Deferred.await(overran),
            Duration.millis(250)
          )
          // The producer is blocked on the queue, not merely slow.
          assert.isTrue(Option.isNone(ran))
          // And it is blocked *near the bound*: a queue an order of magnitude
          // larger would also never reach the deferred within the window.
          assert.isAtMost(
            yield* Ref.get(produced),
            SseBody.frameCapacity + 8
          )
          yield* Fiber.interrupt(reader)
        })
      )
    })
  )

  it("assigns a stable status to every declared remote error", () => {
    const id = sessionId("status-map")
    const mutationId = requestId("status-map-request")
    const errors: ReadonlyArray<
      readonly [AgentProtocol.RemoteError, number]
    > = [
      [new AgentProtocol.AgentInvalidRequestError({ operation: "prompt", detail: "bad" }), 400],
      [new AgentProtocol.AgentProtocolCodecError({ operation: "events", phase: "response", detail: "bad" }), 400],
      [new AgentProtocol.AgentUnauthorizedError({ operation: "status" }), 401],
      [new AgentProtocol.AgentForbiddenError({ operation: "status", sessionId: Option.some(id) }), 403],
      [new AgentProtocol.AgentSessionNotFoundError({ sessionId: id }), 404],
      [new AgentProtocol.AgentSessionAlreadyExistsError({ sessionId: id }), 409],
      [new AgentProtocol.AgentRequestConflictError({ sessionId: Option.some(id), requestId: mutationId }), 409],
      [new AgentBusyError({ sessionId: id }), 409],
      [new AgentIdleError({ sessionId: id, operation: "steer" }), 409],
      [new AgentClosedError({ sessionId: id }), 409],
      [new AgentProtocol.AgentRequestCapacityExceededError({ sessionId: Option.some(id), capacity: 1 }), 429],
      [new AgentProtocol.AgentCapacityExceededError({ capacity: 1 }), 429],
      [new AgentClient.AgentExecutionError({ sessionId: id, tag: "ToolError", detail: "failed", isDefect: false }), 422],
      [new AgentClient.AgentTransportError({ sessionId: id, detail: "offline" }), 503]
    ]

    assert.deepStrictEqual(
      errors.map(([error]) => error._tag),
      [
        "AgentInvalidRequestError",
        "AgentProtocolCodecError",
        "AgentUnauthorizedError",
        "AgentForbiddenError",
        "AgentSessionNotFoundError",
        "AgentSessionAlreadyExistsError",
        "AgentRequestConflictError",
        "AgentBusyError",
        "AgentIdleError",
        "AgentClosedError",
        "AgentRequestCapacityExceededError",
        "AgentCapacityExceededError",
        "AgentExecutionError",
        "AgentTransportError"
      ]
    )
    for (const [error, status] of errors) {
      assert.strictEqual(AgentHttp.errorStatus(error), status)
    }
  })

  it.effect("serves every route through the schema-generated Effect client", () =>
    Effect.gen(function* () {
      const test = yield* fixture()
      const id = sessionId("generated-client")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const client = yield* HttpApiClient.make(AgentHttp.Api, {
            baseUrl: HttpServer.formatAddress(httpServer.address)
          })

          const created = yield* client.sessions.createSession({
            headers,
            payload: { requestId: requestId("create"), sessionId: id }
          })
          type _Created = Assert<
            Equal<typeof created, AgentProtocol.CreateSessionResponse>
          >
          assert.strictEqual(created.session.sessionId, id)

          assert.strictEqual(
            (yield* client.sessions.getSession({ params: { id }, headers }))
              .status,
            "idle"
          )
          /**
           * All three file-data variants across the HTTP boundary.
           *
           * The URL case is the one that fails silently: `PromptWire` accepts
           * a bare string on read for backward compatibility, so a URL that
           * did not encode as `{_tag:"Url"}` arrives as a *string* rather than
           * as an error -- and a string is a legal `FilePart.data`, so nothing
           * further along would notice.
           */
          const outboundBytes = new Uint8Array([1, 2, 3])
          const outboundUrl = new URL("https://cdn.example.com/a.png")
          const outboundString = "inline string payload"
          assert.strictEqual(
            (yield* client.sessions.prompt({
              params: { id },
              headers,
              payload: {
                requestId: requestId("prompt"),
                input: Prompt.make([{
                  role: "user",
                  content: [
                    {
                      type: "file",
                      mediaType: "application/octet-stream",
                      data: outboundBytes
                    },
                    { type: "file", mediaType: "image/png", data: outboundUrl },
                    { type: "file", mediaType: "text/plain", data: outboundString }
                  ]
                }])
              }
            })).result.text,
            "http answer"
          )
          const receivedPrompt = (yield* Ref.get(test.promptInputs))[0]
          assert.isDefined(receivedPrompt)
          const receivedData = receivedPrompt?.content.flatMap((message) =>
            message.role === "user"
              ? message.content.flatMap((part) => part.type === "file" ? [part.data] : [])
              : []
          ) ?? []
          assert.strictEqual(receivedData.length, 3)
          assert.isTrue(receivedData[0] instanceof Uint8Array)
          if (receivedData[0] instanceof Uint8Array) {
            assert.deepStrictEqual(Array.from(receivedData[0]), Array.from(outboundBytes))
          }
          assert.isTrue(
            receivedData[1] instanceof URL,
            "a URL must arrive as a URL, not as a string"
          )
          if (receivedData[1] instanceof URL) {
            assert.strictEqual(receivedData[1].href, outboundUrl.href)
          }
          assert.strictEqual(receivedData[2], outboundString)
          assert.isTrue(
            (yield* client.sessions.steer({
              params: { id },
              headers,
              payload: {
                requestId: requestId("steer"),
                input: Prompt.make("steer")
              }
            })).accepted
          )
          assert.isTrue(
            (yield* client.sessions.followUp({
              params: { id },
              headers,
              payload: {
                requestId: requestId("follow-up"),
                input: Prompt.make("more")
              }
            })).accepted
          )
          assert.isTrue(
            (yield* client.sessions.interrupt({
              params: { id },
              headers,
              payload: { requestId: requestId("interrupt") }
            })).accepted
          )
          assert.isTrue(
            (yield* client.sessions.respond({
              params: { id },
              headers,
              payload: {
                requestId: requestId("respond"),
                response: { id: "approval-1", granted: true }
              }
            })).matched
          )
          assert.deepStrictEqual(
            (yield* client.sessions.pending({ params: { id }, headers }))
              .requests,
            [{ id: "approval-1", kind: "approval", detail: "check" }]
          )
          const remoteHistory = (
            yield* client.sessions.history({ params: { id }, headers })
          ).history
          assert.strictEqual(remoteHistory.content[0]?.role, "assistant")
          const remoteData = remoteHistory.content.flatMap((message) =>
            message.role === "assistant"
              ? message.content.flatMap((part) => part.type === "file" ? [part.data] : [])
              : []
          )[0]
          assert.isTrue(remoteData instanceof Uint8Array)
          if (remoteData instanceof Uint8Array) {
            assert.deepStrictEqual(Array.from(remoteData), [7, 8, 9])
          }
          assert.strictEqual(
            (yield* client.sessions.status({ params: { id }, headers })).status,
            "idle"
          )

          const eventStream = yield* client.sessions.events({
            params: { id },
            headers
          })
          type _Events = Assert<
            Equal<
              Stream.Success<typeof eventStream>,
              AgentProtocol.AgentEventEnvelope
            >
          >
          const events = yield* Stream.runCollect(eventStream)
          assert.deepStrictEqual(
            events.map((event) => [event.sequence, event.event._tag]),
            [
              [1, "SessionStarted"],
              [2, "SubmissionStarted"]
            ]
          )

          const missingCall = client.sessions.status({
            params: { id: sessionId("generated-missing") },
            headers
          })
          type _Error = Assert<
            Equal<
              Effect.Error<typeof missingCall>,
              | AgentProtocol.RemoteError
              | HttpClientError.HttpClientError
              | Schema.SchemaError
            >
          >
          assert.strictEqual(
            (yield* Effect.flip(missingCall))._tag,
            "AgentSessionNotFoundError"
          )

          assert.isTrue(
            (yield* client.sessions.closeSession({
              params: { id },
              headers,
              payload: { requestId: requestId("close") }
            })).closed
          )
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
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
        "authorize:status",
        "authorize:closeSession"
      ])
    })
  )

  it.effect("a failing event stream reaches the generated client as its typed error", () =>
    Effect.gen(function* () {
      // A durable-backed session's `events` can fail with a transport error.
      // The Api declares that error for the stream; the generated client only
      // recognises it in the reserved failure frame, so anything else arrives
      // as an envelope that does not decode.
      const test = yield* fixture({ failEvents: true })
      const id = sessionId("failing-events")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const client = yield* HttpApiClient.make(AgentHttp.Api, {
            baseUrl: HttpServer.formatAddress(httpServer.address)
          })
          yield* client.sessions.createSession({
            headers,
            payload: { requestId: requestId("create-failing"), sessionId: id }
          })
          const eventStream = yield* client.sessions.events({
            params: { id },
            headers
          })
          const seen: Array<string> = []
          const failure = yield* Effect.flip(
            Stream.runForEach(eventStream, (event) =>
              Effect.sync(() => {
                seen.push(event.event._tag)
              })
            )
          )
          // Everything before the failure was delivered, and the failure is
          // the declared error, not a decode error about a strange frame.
          assert.deepStrictEqual(seen, ["SessionStarted", "SubmissionStarted"])
          assert.strictEqual(failure._tag, "AgentTransportError")
          if (failure._tag === "AgentTransportError") {
            assert.include(failure.detail, "delivery log")
          }
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
      )
    })
  )

  it.effect("adopts sessions the client can address, once, and within capacity", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ adoptable: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const client = yield* HttpApiClient.make(AgentHttp.Api, {
            baseUrl: HttpServer.formatAddress(httpServer.address)
          })
          const id = sessionId("elsewhere")

          // Never created here. Several requests arrive for it at once: the
          // client is asked once, and every request is served the same
          // handle.
          const statuses = yield* Effect.all(
            Array.from({ length: 5 }, () =>
              client.sessions.status({ params: { id }, headers })
            ),
            { concurrency: "unbounded" }
          )
          assert.deepStrictEqual(statuses.map((s) => s.status), Array(5).fill("idle"))
          assert.deepStrictEqual(yield* Ref.get(test.adopted), ["elsewhere"])

          // Adopted sessions are ordinary afterwards: prompt, then close.
          const prompted = yield* client.sessions.prompt({
            params: { id },
            headers,
            payload: { requestId: requestId("adopted-prompt"), input: Prompt.make("hi") }
          })
          assert.strictEqual(prompted.result.text, "adopted elsewhere")
          const closed = yield* client.sessions.closeSession({
            params: { id },
            headers,
            payload: { requestId: requestId("adopted-close") }
          })
          assert.isTrue(closed.closed)
          // Closed here, it is asked for again -- the registry forgot it, and
          // the client is the authority on whether it still exists.
          yield* client.sessions.status({ params: { id }, headers })
          assert.deepStrictEqual(yield* Ref.get(test.adopted), ["elsewhere", "elsewhere"])

          // Adoption respects the host's capacity exactly as creation does.
          // maxSessions is 4: one adopted above, three more fit, the fifth
          // is refused.
          for (const extra of ["a", "b", "c"]) {
            yield* client.sessions.status({ params: { id: sessionId(extra) }, headers })
          }
          const refused = yield* Effect.flip(
            client.sessions.status({ params: { id: sessionId("one-too-many") }, headers })
          )
          assert.strictEqual(refused._tag, "AgentCapacityExceededError")
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
      )
    })
  )

  it.effect("is usable with plain fetch and returns stable JSON errors", () =>
    Effect.gen(function* () {
      const test = yield* fixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const baseUrl = HttpServer.formatAddress(httpServer.address)
          const id = sessionId("plain-fetch")
          const createdResponse = yield* promise(() =>
            fetch(`${baseUrl}/sessions`, {
              method: "POST",
              headers: {
                authorization: headers.authorization,
                "content-type": "application/json"
              },
              body: JSON.stringify({
                requestId: "plain-create",
                sessionId: id
              })
            })
          )
          assert.strictEqual(createdResponse.status, 200)
          assert.strictEqual(
            (yield* json(createdResponse, AgentProtocol.CreateSessionResponse))
              .session.sessionId,
            id
          )

          const statusResponse = yield* promise(() =>
            fetch(`${baseUrl}/sessions/${id}/status`, {
              headers: { authorization: headers.authorization }
            })
          )
          assert.strictEqual(statusResponse.status, 200)
          assert.strictEqual(
            (yield* json(statusResponse, AgentProtocol.StatusResponse)).status,
            "idle"
          )

          const malformed = yield* promise(() =>
            fetch(`${baseUrl}/sessions`, {
              method: "POST",
              headers: {
                authorization: headers.authorization,
                "content-type": "application/json"
              },
              body: "{"
            })
          )
          assert.strictEqual(malformed.status, 400)
          assert.strictEqual(
            (yield* json(malformed, AgentProtocol.RemoteError))._tag,
            "AgentInvalidRequestError"
          )

          const unauthorized = yield* promise(() =>
            fetch(`${baseUrl}/sessions/${id}/status`)
          )
          assert.strictEqual(unauthorized.status, 401)
          assert.strictEqual(
            (yield* json(unauthorized, AgentProtocol.RemoteError))._tag,
            "AgentUnauthorizedError"
          )

          const forbidden = yield* promise(() =>
            fetch(`${baseUrl}/sessions/${id}/status`, {
              headers: { authorization: "Bearer forbidden" }
            })
          )
          assert.strictEqual(forbidden.status, 403)
          assert.strictEqual(
            (yield* json(forbidden, AgentProtocol.RemoteError))._tag,
            "AgentForbiddenError"
          )

          const missing = yield* promise(() =>
            fetch(`${baseUrl}/sessions/missing/status`, {
              headers: { authorization: headers.authorization }
            })
          )
          assert.strictEqual(missing.status, 404)
          assert.strictEqual(
            (yield* json(missing, AgentProtocol.RemoteError))._tag,
            "AgentSessionNotFoundError"
          )
        }).pipe(Effect.provide(test.server))
      )
    })
  )

  it.effect("parses ordered SSE metadata and releases only the disconnected observer", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ holdEvents: true })
      const id = sessionId("sse-disconnect")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const baseUrl = HttpServer.formatAddress(httpServer.address)
          const client = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl })
          yield* client.sessions.createSession({
            headers,
            payload: { requestId: requestId("sse-create"), sessionId: id }
          })

          const controller = new AbortController()
          const response = yield* promise(() =>
            fetch(`${baseUrl}/sessions/${id}/events`, {
              headers: { authorization: headers.authorization },
              signal: controller.signal
            })
          )
          assert.strictEqual(
            response.headers.get("content-type"),
            "text/event-stream"
          )
          const body = response.body
          if (body === null) {
            return yield* Effect.die(new Error("SSE response had no body"))
          }
          const reader = body.getReader()
          const decoder = new TextDecoder()
          const parsed: Array<Sse.Event> = []
          const parser = Sse.makeParser((event) => {
            if (event._tag === "Event") parsed.push(event)
          })

          while (parsed.length < 2) {
            const chunk = yield* promise(() => reader.read())
            if (chunk.done) {
              return yield* Effect.die(new Error("SSE response ended early"))
            }
            const parseError = parser.feed(decoder.decode(chunk.value))
            if (parseError !== undefined) return yield* parseError
          }

          assert.deepStrictEqual(
            parsed.map((event) => [event.id, event.event]),
            [
              ["1", "SessionStarted"],
              ["2", "SubmissionStarted"]
            ]
          )
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.toCodecJson(AgentProtocol.AgentEventEnvelope)
          )(JSON.parse(parsed[1]?.data ?? ""))
          assert.strictEqual(decoded.sequence, 2)

          yield* promise(() => reader.cancel())
          controller.abort()
          yield* Deferred.await(test.eventStreamReleased)

          const status = yield* client.sessions.status({
            params: { id },
            headers
          })
          assert.strictEqual(status.status, "idle")
          assert.strictEqual(yield* Ref.get(test.released), 0)
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
      )

      assert.strictEqual(yield* Ref.get(test.released), 1)
    })
  )

  it.effect("keeps an idempotent prompt alive after an HTTP waiter disconnects", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ blockPrompt: true })
      const id = sessionId("http-retry")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const client = yield* HttpApiClient.make(AgentHttp.Api, {
            baseUrl: HttpServer.formatAddress(httpServer.address)
          })
          yield* client.sessions.createSession({
            headers,
            payload: { requestId: requestId("retry-create"), sessionId: id }
          })
          const request = {
            params: { id },
            headers,
            payload: {
              requestId: requestId("shared-prompt"),
              input: Prompt.make("once")
            }
          }
          const first = yield* Effect.forkChild(client.sessions.prompt(request))
          yield* Deferred.await(test.promptStarted)
          yield* Fiber.interrupt(first)

          const retry = yield* Effect.forkChild(client.sessions.prompt(request))
          yield* Deferred.succeed(test.allowPrompt, void 0)
          assert.strictEqual(
            (yield* Fiber.join(retry)).result.text,
            "http answer"
          )
          assert.strictEqual(yield* Ref.get(test.promptCalls), 1)
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
      )
    })
  )

  it.effect("handles control operations while a prompt is active over HTTP", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ blockPrompt: true })
      const id = sessionId("http-concurrent-controls")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const client = yield* HttpApiClient.make(AgentHttp.Api, {
            baseUrl: HttpServer.formatAddress(httpServer.address)
          })
          yield* client.sessions.createSession({
            headers,
            payload: { requestId: requestId("controls-create"), sessionId: id }
          })
          const prompt = yield* Effect.forkChild(
            client.sessions.prompt({
              params: { id },
              headers,
              payload: {
                requestId: requestId("controls-prompt"),
                input: Prompt.make("wait")
              }
            })
          )
          yield* Deferred.await(test.promptStarted)

          const controls = yield* Effect.all(
            [
              client.sessions.steer({
                params: { id },
                headers,
                payload: {
                  requestId: requestId("controls-steer"),
                  input: Prompt.make("new direction")
                }
              }),
              client.sessions.interrupt({
                params: { id },
                headers,
                payload: { requestId: requestId("controls-interrupt") }
              }),
              client.sessions.respond({
                params: { id },
                headers,
                payload: {
                  requestId: requestId("controls-respond"),
                  response: { id: "approval-1", granted: true }
                }
              })
            ],
            { concurrency: "unbounded" }
          )
          assert.deepStrictEqual(
            controls.map((response) =>
              "accepted" in response ? response.accepted : response.matched
            ),
            [true, true, true]
          )

          yield* Deferred.succeed(test.allowPrompt, void 0)
          assert.strictEqual((yield* Fiber.join(prompt)).result.text, "http answer")
          assert.strictEqual(yield* Ref.get(test.promptCalls), 1)
          assert.deepStrictEqual(
            (yield* Ref.get(test.calls)).filter((call) =>
              ["prompt", "steer", "interrupt", "respond"].includes(call)
            ).sort(),
            ["interrupt", "prompt", "respond", "steer"]
          )
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
      )
    })
  )

  it.effect("server shutdown closes open SSE subscriptions and session scopes", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ holdEvents: true })
      const id = sessionId("sse-shutdown")

      const app = HttpRouter.toWebHandler(test.routes, {
        disableLogger: true
      })
      const created = yield* promise(() =>
        app.handler(
          new Request("http://localhost/sessions", {
            method: "POST",
            headers: {
              authorization: headers.authorization,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              requestId: "shutdown-create",
              sessionId: id
            })
          })
        )
      )
      assert.strictEqual(created.status, 200)
      const response = yield* promise(() =>
        app.handler(
          new Request(`http://localhost/sessions/${id}/events`, {
            headers: { authorization: headers.authorization }
          })
        )
      )
      const body = response.body
      if (body === null) {
        return yield* Effect.die(new Error("SSE response had no body"))
      }
      const first = yield* promise(() => body.getReader().read())
      assert.isFalse(first.done)

      yield* promise(app.dispose)

      yield* Deferred.await(test.eventStreamReleased)
      assert.strictEqual(yield* Ref.get(test.released), 1)
    })
  )

  /**
   * H5/SD5 -- a reconnecting `EventSource` resumes where it left off.
   *
   * The ids this adapter writes are the envelope's sequence, and a browser
   * echoes the last one it saw back as `Last-Event-ID` with no cooperation
   * from page code. So the whole of resumption over SSE is: read that header,
   * hand it to the log as `after`. Before this, the header was ignored and
   * every reconnect silently restarted from "now" -- which for a client that
   * dropped mid-run means the events in the gap simply never existed.
   *
   * Three cases, because the wrong answer differs in each:
   *
   *   - a resume, which must skip what was already delivered and nothing else;
   *   - `?after=`, for the callers that cannot set a header;
   *   - a header that is not a sequence, which must fall back to live delivery
   *     rather than refusing the connection. It is echoed from whatever server
   *     wrote it, so an unparseable one means the client is resuming against
   *     something that did not write these ids -- and stranding it would
   *     punish a reconnect to the wrong place.
   */
  const firstEventOf = (
    baseUrl: string,
    id: string,
    init: RequestInit
  ) =>
    Effect.gen(function* () {
      const response = yield* promise(() =>
        fetch(`${baseUrl}/sessions/${id}/events`, init))
      assert.strictEqual(response.headers.get("content-type"), "text/event-stream")
      const body = response.body
      if (body === null) return yield* Effect.die(new Error("SSE response had no body"))
      const reader = body.getReader()
      const decoder = new TextDecoder()
      const parsed: Array<Sse.Event> = []
      const parser = Sse.makeParser((event) => {
        if (event._tag === "Event") parsed.push(event)
      })
      while (parsed.length < 1) {
        const chunk = yield* promise(() => reader.read())
        if (chunk.done) return yield* Effect.die(new Error("SSE response ended early"))
        const parseError = parser.feed(decoder.decode(chunk.value))
        if (parseError !== undefined) return yield* parseError
      }
      yield* promise(() => reader.cancel())
      return parsed[0]!
    })

  it.effect("a reconnect resumes from Last-Event-ID rather than restarting", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ holdEvents: true })
      const id = sessionId("sse-resume")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const baseUrl = HttpServer.formatAddress(httpServer.address)
          const client = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl })
          yield* client.sessions.createSession({
            headers,
            payload: { requestId: requestId("sse-resume-create"), sessionId: id }
          })
          const auth = { authorization: headers.authorization }

          // A fresh connection starts at the beginning.
          const fresh = yield* firstEventOf(baseUrl, id, { headers: auth })
          assert.strictEqual(fresh.id, "1")

          // Having seen 1, a reconnect must be handed 2 -- not 1 again, and
          // not whatever happens to be next.
          const resumed = yield* firstEventOf(baseUrl, id, {
            headers: { ...auth, "last-event-id": "1" }
          })
          assert.strictEqual(resumed.id, "2")

          // The same, for a caller that cannot set request headers.
          const byQuery = yield* firstEventOf(baseUrl, id, { headers: auth })
          assert.strictEqual(byQuery.id, "1")
          const resumedByQuery = yield* Effect.gen(function* () {
            const response = yield* promise(() =>
              fetch(`${baseUrl}/sessions/${id}/events?after=1`, { headers: auth }))
            const body = response.body
            if (body === null) return yield* Effect.die(new Error("no body"))
            const reader = body.getReader()
            const decoder = new TextDecoder()
            const parsed: Array<Sse.Event> = []
            const parser = Sse.makeParser((event) => {
              if (event._tag === "Event") parsed.push(event)
            })
            while (parsed.length < 1) {
              const chunk = yield* promise(() => reader.read())
              if (chunk.done) return yield* Effect.die(new Error("ended early"))
              const parseError = parser.feed(decoder.decode(chunk.value))
              if (parseError !== undefined) return yield* parseError
            }
            yield* promise(() => reader.cancel())
            return parsed[0]!
          })
          assert.strictEqual(resumedByQuery.id, "2")

          // A header that is not a sequence is ignored, not refused.
          const nonsense = yield* firstEventOf(baseUrl, id, {
            headers: { ...auth, "last-event-id": "not-a-number" }
          })
          assert.strictEqual(nonsense.id, "1")
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
      )
    })
  )

  /**
   * A blank resume cursor is absent, not zero.
   *
   * `Number("")` is `0`, so an empty `Last-Event-ID` -- what a proxy that
   * normalises headers forwards, and what `?after=` with nothing after it
   * says -- read as "resume from the beginning". A session with no delivery
   * log refuses that, so a client which had asked for nothing at all got a
   * failure frame instead of the live stream it meant. The fixture refuses
   * resumption here for exactly that reason: honouring it would deliver
   * sequence 1 either way and prove nothing.
   */
  it.effect("a blank Last-Event-ID or ?after= subscribes live rather than refusing", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ holdEvents: true, refuseResume: true })
      const id = sessionId("sse-blank-cursor")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const baseUrl = HttpServer.formatAddress(httpServer.address)
          const client = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl })
          yield* client.sessions.createSession({
            headers,
            payload: { requestId: requestId("sse-blank-create"), sessionId: id }
          })
          const auth = { authorization: headers.authorization }

          const blankHeader = yield* firstEventOf(baseUrl, id, {
            headers: { ...auth, "last-event-id": "" }
          })
          assert.strictEqual(blankHeader.event, "SessionStarted")
          assert.strictEqual(blankHeader.id, "1")

          const blankQuery = yield* Effect.gen(function* () {
            const response = yield* promise(() =>
              fetch(`${baseUrl}/sessions/${id}/events?after=`, { headers: auth }))
            const body = response.body
            if (body === null) return yield* Effect.die(new Error("no body"))
            const reader = body.getReader()
            const decoder = new TextDecoder()
            const parsed: Array<Sse.Event> = []
            const parser = Sse.makeParser((event) => {
              if (event._tag === "Event") parsed.push(event)
            })
            while (parsed.length < 1) {
              const chunk = yield* promise(() => reader.read())
              if (chunk.done) return yield* Effect.die(new Error("ended early"))
              const parseError = parser.feed(decoder.decode(chunk.value))
              if (parseError !== undefined) return yield* parseError
            }
            yield* promise(() => reader.cancel())
            return parsed[0]!
          })
          assert.strictEqual(blankQuery.event, "SessionStarted")
          assert.strictEqual(blankQuery.id, "1")

          // The refusal is still real for a cursor that was actually sent.
          const refused = yield* firstEventOf(baseUrl, id, {
            headers: { ...auth, "last-event-id": "1" }
          })
          assert.strictEqual(refused.event, "effect/httpapi/stream/failure")
        }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, test.server)))
      )
    })
  )
})
