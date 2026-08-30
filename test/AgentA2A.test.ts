import { NodeHttpServer } from "@effect/platform-node"
import {
  Role,
  TaskState,
  type Message,
  type Task
} from "@a2a-js/sdk"
import { ClientFactory, RestTransportFactory } from "@a2a-js/sdk/client"
import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentA2A } from "../src/a2a/index.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import type * as Elicitation from "../src/Elicitation.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false
type Assert<T extends true> = T

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const collect = <A>(iterable: AsyncIterable<A>) =>
  Stream.fromAsyncIterable(
    iterable,
    (cause) =>
      new AgentA2A.AgentA2ATransportError({ detail: String(cause) })
  ).pipe(
    Stream.runCollect,
    Effect.map((values) => Array.from(values))
  )

const restClient = (url: string) =>
  new ClientFactory({
    transports: [new RestTransportFactory()],
    preferredTransports: ["HTTP+JSON"]
  }).createFromUrl(url)

const RestErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    status: Schema.String,
    message: Schema.String,
    details: Schema.Array(Schema.Unknown)
  })
})

const promptText = (prompt: Prompt.Prompt): string => {
  const message = prompt.content[prompt.content.length - 1]
  if (message?.role !== "user") {
    assert.fail("expected a user prompt")
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const userMessage = (
  messageId: string,
  contextId: string,
  text: string
): Message => ({
  messageId,
  contextId,
  taskId: "",
  role: Role.ROLE_USER,
  parts: [{
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain"
  }],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
})

const taskText = (task: Task): string => {
  const content = task.artifacts[0]?.parts[0]?.content
  if (content?.$case !== "text") {
    assert.fail("expected one text artifact")
  }
  return content.value
}

/**
 * Open one `message:stream` response and expose its frames as they reach the
 * socket.
 *
 * Raw bytes rather than the official client, because the thing under test is
 * an SSE *comment*, and every conforming parser -- the official client's
 * included -- discards it before an application could observe it. That the
 * client is undisturbed by these frames is what the other REST tests in this
 * file assert; this one has to see the wire.
 */
const sseFrames = Effect.fn("AgentA2A.test.sseFrames")(function* (
  url: string,
  messageId: string,
  text: string
) {
  // One controller owns the connection. Aborting it on scope close is what
  // ends a read the server would otherwise keep pending forever -- a
  // keep-alive stream has no natural end -- and a `ReadableStreamDefaultReader`
  // cannot be interrupted by a fibre, only released by its source.
  const controller = new AbortController()
  yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
  const response = yield* Effect.tryPromise({
    try: () =>
    fetch(`${url}/a2a/message:stream`, {
      signal: controller.signal,
      method: "POST",
      headers: {
        "A2A-Version": "1.0",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: {
          messageId,
          role: "ROLE_USER",
          parts: [{ text, mediaType: "text/plain" }]
        }
      })
    }),
    catch: (cause) =>
      new AgentA2A.AgentA2ATransportError({ detail: String(cause) })
  })
  assert.strictEqual(response.status, 200)
  const body = response.body
  if (body === null) {
    return yield* Effect.die(new Error("expected a streaming response body"))
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()

  type Read =
    | { readonly _tag: "frame"; readonly text: string }
    | { readonly _tag: "end" }
    | { readonly _tag: "timeout" }

  /**
   * At most one read is ever pending. A reader queues concurrent reads and
   * answers them in order, so a read abandoned by a timeout would still
   * consume the next chunk and hand it to nobody; keeping the one promise and
   * racing it again is what makes a timed-out wait resumable.
   */
  let pending: Promise<Read> | undefined
  const next = (within: Duration.Duration): Effect.Effect<Read> =>
    Effect.promise(() => {
      pending ??= reader.read().then(
        (chunk): Read =>
          chunk.done
            ? { _tag: "end" }
            : { _tag: "frame", text: decoder.decode(chunk.value) },
        // An abort at teardown rejects the read; nothing is waiting by then.
        (): Read => ({ _tag: "end" })
      )
      const read = pending.then((result) => {
        pending = undefined
        return result
      })
      const timer = new Promise<Read>((resolve) =>
        setTimeout(() => resolve({ _tag: "timeout" }), Duration.toMillis(within))
      )
      return Promise.race([read, timer])
    })

  return {
    next,
    /**
     * Close the connection now, from the client side.
     *
     * The server layer is provided *inside* the test's scope, so it tears down
     * before this helper's finalizer runs; a connection still open at that
     * moment has its response fibre interrupted, and that interruption
     * surfaces as the test's own failure. A test that leaves the stream open
     * on purpose ends it here first. The finalizer stays as the backstop.
     */
    close: Effect.sync(() => controller.abort()),
    /**
     * Read frames until `marker` has been seen, returning everything read, or
     * fail naming what *was* seen. Chunk boundaries do not line up with frame
     * boundaries -- one read can carry two events, or half of one -- so this
     * matches on the accumulated text rather than counting reads.
     */
    drainUntil: (marker: string, within: Duration.Duration) =>
      Effect.gen(function* () {
        let seen = ""
        while (!seen.includes(marker)) {
          const read = yield* next(within)
          if (read._tag !== "frame") {
            return yield* Effect.die(
              new Error(`${read._tag} before ${marker}; saw: ${JSON.stringify(seen)}`)
            )
          }
          seen += read.text
        }
        return seen
      })
  }
})

const serverFixture = Effect.fn("AgentA2A.test.serverFixture")(function* (
  fixtureOptions?: {
    readonly blockFirstPrompt?: boolean
    readonly elicitFirstPrompt?: boolean
    readonly failFirstPrompt?: boolean
    /** With elicitFirstPrompt: the resumed run fails after the answer. */
    readonly failResumedRun?: boolean
    /** With elicitFirstPrompt: the resumed run asks a second question. */
    readonly askAgain?: boolean
    /** Passed straight through to `serverLayer`; otherwise its own default. */
    readonly sseHeartbeat?: Duration.Duration | false
    /** The parts the fake run answers with; default: one text part of its text. */
    readonly replyContent?: ReadonlyArray<Prompt.Part>
  }
) {
  const opened = yield* Ref.make<ReadonlyArray<string>>([])
  const released = yield* Ref.make<ReadonlyArray<string>>([])
  const calls = yield* Ref.make<ReadonlyArray<string>>([])
  const promptStarted = yield* Deferred.make<void>()
  const promptInterrupted = yield* Deferred.make<
    void,
    AgentClient.AgentExecutionError
  >()
  const asked = yield* Deferred.make<void>()
  const answer = yield* Deferred.make<Elicitation.Response>()
  const secondAnswer = yield* Deferred.make<Elicitation.Response>()
  const waiting = yield* Ref.make(new Map<string, Elicitation.Request>())
  const lastText = yield* Ref.make<string | undefined>(undefined)
  const lastInput = yield* Ref.make<Option.Option<Prompt.Prompt>>(Option.none())
  const eventQueue = yield* Queue.unbounded<AgentProtocol.AgentEventEnvelope>()
  /** Every addressed tenant the principal resolver was shown, in order. */
  const resolvedTenants = yield* Ref.make<ReadonlyArray<string | undefined>>([])

  const envelope = (sessionId: string) => {
    let sequence = 0
    return (event: AgentEvent.AgentEvent): AgentProtocol.AgentEventEnvelope => ({
      sessionId: AgentProtocol.SessionId.make(sessionId),
      submissionId: Option.some(
        AgentProtocol.SubmissionId.make(`${sessionId}:submission`)
      ),
      runId: Option.none(),
      turn: Option.none(),
      sequence: ++sequence,
      event
    })
  }

  const agentClient = Layer.succeed(
    AgentClient.AgentClient,
    AgentClient.AgentClient.of({
      createSession: (options) =>
        Effect.gen(function* () {
          const id = options?.sessionId ??
            AgentProtocol.SessionId.make("a2a-generated")
          const promptCount = yield* Ref.make(0)
          const emit = envelope(id)
          yield* Ref.update(opened, (all) => [...all, id])
          yield* Effect.addFinalizer(() =>
            Ref.update(released, (all) => [...all, id])
          )

          return {
            id,
            prompt: (input) =>
              Effect.gen(function* () {
                const text = promptText(Prompt.make(input))
                yield* Ref.set(lastInput, Option.some(Prompt.make(input)))
                const count = yield* Ref.updateAndGet(
                  promptCount,
                  (current) => current + 1
                )
                yield* Ref.update(
                  calls,
                  (all) => [...all, `${id}:${count}:${text}`]
                )
                yield* Ref.set(lastText, `${id}:${count}:${text}`)
                if (
                  fixtureOptions?.blockFirstPrompt === true && count === 1
                ) {
                  yield* Deferred.succeed(promptStarted, void 0)
                  yield* Deferred.await(promptInterrupted)
                }
                if (
                  fixtureOptions?.failFirstPrompt === true && count === 1
                ) {
                  return yield* new AgentClient.AgentExecutionError({
                    sessionId: id,
                    tag: "FixtureFailure",
                    detail: "the run failed",
                    isDefect: false
                  })
                }
                if (
                  fixtureOptions?.elicitFirstPrompt === true && count === 1
                ) {
                  const request: Elicitation.Request = {
                    id: `${id}:elicit:1`,
                    kind: "approval",
                    detail: "may proceed?"
                  }
                  yield* Ref.update(waiting, (all) =>
                    new Map(all).set(request.id, request)
                  )
                  yield* Queue.offer(
                    eventQueue,
                    emit({
                      _tag: "ElicitationRequested",
                      id: request.id,
                      kind: request.kind,
                      detail: request.detail
                    })
                  )
                  yield* Deferred.succeed(asked, void 0)
                  const response = yield* Deferred.await(answer)
                  if (fixtureOptions?.failResumedRun === true) {
                    yield* Queue.offer(
                      eventQueue,
                      emit({
                        _tag: "SubmissionFailed",
                        failure: {
                          tag: "ResumedRunFailure",
                          message: "the resumed run failed",
                          isDefect: false
                        }
                      })
                    )
                    return yield* new AgentClient.AgentExecutionError({
                      sessionId: id,
                      tag: "ResumedRunFailure",
                      detail: "the resumed run failed",
                      isDefect: false
                    })
                  }
                  let finalText =
                    `${id}:${count}:${text}:${String(response.value)}`
                  if (fixtureOptions?.askAgain === true) {
                    const again: Elicitation.Request = {
                      id: `${id}:elicit:2`,
                      kind: "approval",
                      detail: "and once more?"
                    }
                    yield* Ref.update(waiting, (all) =>
                      new Map(all).set(again.id, again)
                    )
                    yield* Queue.offer(
                      eventQueue,
                      emit({
                        _tag: "ElicitationRequested",
                        id: again.id,
                        kind: again.kind,
                        detail: again.detail
                      })
                    )
                    const second = yield* Deferred.await(secondAnswer)
                    finalText = `${finalText}:${String(second.value)}`
                  }
                  yield* Queue.offer(
                    eventQueue,
                    emit({ _tag: "SubmissionCompleted", runs: 1 })
                  )
                  yield* Ref.set(lastText, finalText)
                  return {
                    submissionId: AgentProtocol.SubmissionId.make(
                      `${id}:submission:${count}`
                    ),
                    status: "completed" as const,
                    runs: 1,
                    turns: count,
                    text: finalText,
                    content: fixtureOptions?.replyContent ?? [Prompt.textPart({ text: finalText })]
                  }
                }
                return {
                  submissionId: AgentProtocol.SubmissionId.make(
                    `${id}:submission:${count}`
                  ),
                  status: "completed" as const,
                  runs: 1,
                  turns: count,
                  text: `${id}:${count}:${text}`,
                  content: fixtureOptions?.replyContent ??
                    [Prompt.textPart({ text: `${id}:${count}:${text}` })]
                }
              }),
            submit: () => Effect.die("submit is not part of this fixture"),
            awaitSubmission: () => Effect.die("awaitSubmission is not part of this fixture"),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            interrupt: () =>
              fixtureOptions?.blockFirstPrompt === true
                ? Deferred.fail(
                    promptInterrupted,
                    new AgentClient.AgentExecutionError({
                      sessionId: id,
                      tag: "Interrupted",
                      detail: "fixture prompt interrupted",
                      isDefect: false
                    })
                  ).pipe(Effect.asVoid)
                : Effect.void,
            respond: (response) =>
              Effect.gen(function* () {
                const found = yield* Ref.get(waiting)
                if (!found.has(response.id)) return false
                yield* Ref.update(waiting, (all) => {
                  const next = new Map(all)
                  next.delete(response.id)
                  return next
                })
                if (response.id.endsWith(":elicit:2")) {
                  yield* Deferred.succeed(secondAnswer, response)
                } else {
                  yield* Deferred.succeed(answer, response)
                }
                return true
              }),
            pending: Effect.map(Ref.get(waiting), (all) =>
              Array.from(all.values())
            ),
            history: Effect.map(Ref.get(lastText), (text) =>
              text === undefined
                ? Prompt.empty
                : Prompt.make([{
                  role: "assistant" as const,
                  content: [{ type: "text" as const, text }]
                }])
            ),
            status: Effect.succeed("idle" as const),
            events: () => Stream.fromQueue(eventQueue)
          }
        }),
      session: (id) =>
        Effect.fail(
          new AgentClient.AgentSessionNotFoundError({ sessionId: id })
        )
    })
  )

  const Host = AgentSessionHost.Tag<{
    readonly subject: string
    readonly tenant: string | undefined
  }>("test/AgentA2A/host")
  const host = AgentSessionHost.layer(Host, {
    authorization: { authorize: () => Effect.void },
    principal: {
      // The tenant a principal may act in is a header here; a real deployment
      // would read it from the token. What matters is that the *addressed*
      // tenant reaches the resolver at all, so the join can be made.
      resolve: ({ headers, operation, tenant }) =>
        Effect.flatMap(
          Ref.update(resolvedTenants, (all) => [...all, tenant]),
          () => {
            // A principal with no `x-tenant` is unscoped and may act in any
            // tenant, which is what the rest of this suite's requests are.
            // A scoped one is refused the moment the addressed tenant is not
            // its own -- the join this test exists to prove.
            const owned = headers["x-tenant"]
            return tenant !== undefined && owned !== undefined &&
                tenant !== owned
              ? Effect.fail(
                new AgentProtocol.AgentUnauthorizedError({ operation })
              )
              : Effect.succeed({
                subject: headers.authorization ?? "anonymous",
                tenant: owned
              })
          }
        )
    },
    maxSessions: 4,
    maxRequestsPerSession: 16
  }).pipe(Layer.provide(agentClient))
  const routes = AgentA2A.serverLayer({
    host: Host,
    card: {
      name: "Effect Harness A2A conformance",
      description: "A text-only test agent",
      version: "1.0.0",
      skills: [{
        id: "prompt",
        name: "Prompt",
        description: "Send a text prompt",
        tags: ["text"],
        examples: ["hello"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"]
      }]
    },
    principal: { subject: (principal) => principal.subject },
    ...(fixtureOptions?.sseHeartbeat === undefined
      ? {}
      : { sseHeartbeat: fixtureOptions.sseHeartbeat }),
    session: {
      resolve: ({ principal, contextId }) =>
        Effect.succeed(
          AgentProtocol.SessionId.make(
            `a2a:${principal.subject}:${contextId}`
          )
        )
    }
  }).pipe(Layer.provide(host))

  type _LayerSuccess = Assert<Equal<Layer.Success<typeof routes>, never>>
  type _LayerError = Assert<Equal<Layer.Error<typeof routes>, never>>
  type _LayerContext = Assert<
    Equal<Layer.Services<typeof routes>, HttpRouter.HttpRouter>
  >

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
    opened,
    released,
    calls,
    promptStarted,
    /** Releases a `blockFirstPrompt` run, so a test can end it cleanly. */
    promptInterrupted,
    asked,
    resolvedTenants,
    lastInput
  }
})

describe("AgentA2A v1 server", () => {
  it.effect("serves the official client with context session continuity", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )

          assert.strictEqual(client.protocolVersion, "1.0")
          const first = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: userMessage("message-1", "", "first"),
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in first)) {
            assert.fail("expected SendMessage to return a task")
          }
          assert.strictEqual(
            first.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.strictEqual(
            taskText(first),
            `a2a:anonymous:${first.contextId}:1:first`
          )

          const second = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: userMessage(
                "message-2",
                first.contextId,
                "second"
              ),
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in second)) {
            assert.fail("expected SendMessage to return a task")
          }
          assert.strictEqual(
            second.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.strictEqual(second.contextId, first.contextId)
          assert.strictEqual(
            taskText(second),
            `a2a:anonymous:${first.contextId}:2:second`
          )

          const stored = yield* promise(() =>
            client.getTask({
              tenant: "",
              id: second.id,
              historyLength: 10
            })
          )
          assert.strictEqual(stored.id, second.id)
          assert.strictEqual(stored.contextId, first.contextId)
          assert.strictEqual(
            stored.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.strictEqual(taskText(stored), taskText(second))
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [
        `${opened[0]}:1:first`,
        `${opened[0]}:2:second`
      ])
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("serves send, get, list, and stream through the official REST client", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const url = HttpServer.formatAddress(server.address)
          const client = yield* promise(() => restClient(url))
          const card = yield* promise(() => client.getAgentCard())

          assert.strictEqual(client.protocolVersion, "1.0")
          assert.deepStrictEqual(
            card.supportedInterfaces.map((entry) => entry.protocolBinding),
            ["JSONRPC", "HTTP+JSON"]
          )

          const sent = yield* promise(() =>
            client.sendMessage({
              tenant: "tenant-a",
              message: userMessage("rest-message", "", "rest"),
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in sent)) {
            assert.fail("expected REST SendMessage to return a task")
          }
          assert.strictEqual(
            sent.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.strictEqual(
            taskText(sent),
            `a2a:anonymous:${sent.contextId}:1:rest`
          )

          const stored = yield* promise(() =>
            client.getTask({
              tenant: "tenant-a",
              id: sent.id,
              historyLength: 1
            })
          )
          assert.strictEqual(stored.id, sent.id)
          assert.strictEqual(stored.history.length, 1)

          const listed = yield* promise(() =>
            client.listTasks({
              tenant: "tenant-a",
              contextId: sent.contextId,
              status: TaskState.TASK_STATE_COMPLETED,
              pageToken: "",
              statusTimestampAfter: undefined,
              includeArtifacts: true
            })
          )
          assert.deepStrictEqual(listed.tasks.map((task) => task.id), [sent.id])
          const listedTask = listed.tasks[0]
          if (listedTask === undefined) {
            assert.fail("expected the REST task in the list")
          }
          assert.strictEqual(taskText(listedTask), taskText(sent))

          const events = yield* collect(
            client.sendMessageStream({
              tenant: "tenant-a",
              message: userMessage("rest-stream", sent.contextId, "stream"),
              configuration: undefined,
              metadata: undefined
            })
          )
          assert.deepStrictEqual(
            events.map((event) => event.payload?.$case),
            ["task", "statusUpdate", "artifactUpdate", "statusUpdate"]
          )
          const completed = events[3]?.payload
          if (completed?.$case !== "statusUpdate") {
            assert.fail("expected the REST stream to complete")
          }
          assert.strictEqual(
            completed.value.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [
        `${opened[0]}:1:rest`,
        `${opened[0]}:2:stream`
      ])
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("returns protocol-shaped REST errors for invalid requests", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const url = HttpServer.formatAddress(server.address)

          const malformed = yield* promise(() =>
            fetch(`${url}/a2a/message:send`, {
              method: "POST",
              headers: {
                "A2A-Version": "1.0",
                "Content-Type": "application/json"
              },
              body: "{}"
            })
          )
          assert.strictEqual(malformed.status, 400)
          assert.strictEqual(
            malformed.headers.get("content-type"),
            "application/a2a+json"
          )
          const malformedBody = Schema.decodeUnknownSync(RestErrorBody)(
            yield* promise(() => malformed.json())
          )
          assert.strictEqual(malformedBody.error.status, "INVALID_ARGUMENT")
          assert.include(malformedBody.error.message, "message is required")

          const unsupportedContent = yield* promise(() =>
            fetch(`${url}/a2a/message:send`, {
              method: "POST",
              headers: {
                "A2A-Version": "1.0",
                "Content-Type": "text/plain"
              },
              body: "{}"
            })
          )
          assert.strictEqual(unsupportedContent.status, 400)
          const unsupportedBody = Schema.decodeUnknownSync(RestErrorBody)(
            yield* promise(() => unsupportedContent.json())
          )
          assert.strictEqual(unsupportedBody.error.status, "INVALID_ARGUMENT")
          assert.include(unsupportedBody.error.message, "Unsupported Content-Type")

          const wrongVersion = yield* promise(() =>
            fetch(`${url}/a2a/tasks/missing`, {
              headers: { "A2A-Version": "9.9" }
            })
          )
          assert.strictEqual(wrongVersion.status, 400)
          const versionBody = Schema.decodeUnknownSync(RestErrorBody)(
            yield* promise(() => wrongVersion.json())
          )
          assert.strictEqual(versionBody.error.status, "FAILED_PRECONDITION")
          assert.include(versionBody.error.message, "9.9")

          const missing = yield* promise(() =>
            fetch(`${url}/a2a/tasks/missing`, {
              headers: { "A2A-Version": "1.0" }
            })
          )
          assert.strictEqual(missing.status, 404)
          const missingBody = Schema.decodeUnknownSync(RestErrorBody)(
            yield* promise(() => missing.json())
          )
          assert.strictEqual(missingBody.error.status, "NOT_FOUND")
          assert.strictEqual(
            missingBody.error.details[0] !== undefined,
            true
          )

          const push = yield* promise(() =>
            fetch(`${url}/a2a/tasks/missing/pushNotificationConfigs`, {
              method: "POST",
              headers: {
                "A2A-Version": "1.0",
                "Content-Type": "application/json"
              },
              body: "{}"
            })
          )
          assert.strictEqual(push.status, 400)
          const pushBody = Schema.decodeUnknownSync(RestErrorBody)(
            yield* promise(() => push.json())
          )
          assert.strictEqual(pushBody.error.status, "FAILED_PRECONDITION")
          assert.include(pushBody.error.message.toLowerCase(), "push notification")
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )

  it.effect("presents the addressed tenant to the principal resolver", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const url = HttpServer.formatAddress(server.address)

          const send = (tenantPath: string, owned: string | undefined) =>
            promise(() =>
              fetch(`${url}/a2a${tenantPath}/message:send`, {
                method: "POST",
                headers: {
                  "A2A-Version": "1.0",
                  "Content-Type": "application/json",
                  ...(owned === undefined ? {} : { "X-Tenant": owned })
                },
                body: JSON.stringify({
                  message: {
                    messageId: "tenant-1",
                    role: "ROLE_USER",
                    content: [{ text: "hello" }]
                  }
                })
              })
            )

          // A principal that owns "acme" reaching into "globex" is refused by
          // the resolver -- which can only happen because the path segment is
          // now part of the principal decision.
          const crossTenant = yield* send("/globex", "acme")
          assert.strictEqual(crossTenant.status, 401)
          const crossBody = Schema.decodeUnknownSync(RestErrorBody)(
            yield* promise(() => crossTenant.json())
          )
          assert.strictEqual(crossBody.error.code, 401)
          // The SDK's `toRestErrorBody` names only NOT_FOUND, INTERNAL and
          // INVALID_ARGUMENT from an HTTP status, so an authentication refusal
          // is UNKNOWN in its vocabulary. The 401 and the message carry it.
          assert.strictEqual(crossBody.error.status, "UNKNOWN")
          assert.include(
            crossBody.error.message,
            "Authentication is required to prompt"
          )

          const matching = yield* send("/acme", "acme")
          assert.strictEqual(matching.status, 200)

          // The tenantless route addresses no tenant at all, which is not the
          // same as addressing the tenant named by the empty string.
          const untenanted = yield* send("", undefined)
          assert.strictEqual(untenanted.status, 200)

          assert.deepStrictEqual(
            yield* Ref.get(fixture.resolvedTenants),
            ["globex", "acme", undefined]
          )
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )

  it.effect("cancels an active task through the official REST client", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({ blockFirstPrompt: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            restClient(HttpServer.formatAddress(server.address))
          )
          const submitted = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: userMessage("rest-cancel", "", "block"),
              configuration: {
                acceptedOutputModes: ["text/plain"],
                taskPushNotificationConfig: undefined,
                returnImmediately: true
              },
              metadata: undefined
            })
          )
          if (!("id" in submitted)) {
            assert.fail("expected REST SendMessage to return a task")
          }
          yield* Deferred.await(fixture.promptStarted)

          const canceled = yield* promise(() =>
            client.cancelTask({
              tenant: "",
              id: submitted.id,
              metadata: undefined
            })
          )
          assert.strictEqual(
            canceled.status?.state,
            TaskState.TASK_STATE_CANCELED
          )
          const stored = yield* promise(() =>
            client.getTask({ tenant: "", id: submitted.id })
          )
          assert.strictEqual(
            stored.status?.state,
            TaskState.TASK_STATE_CANCELED
          )
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("streams the exact official task lifecycle and stores its result", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )

          const responses = yield* collect(
            client.sendMessageStream({
              tenant: "",
              message: userMessage("stream-message", "", "stream"),
              configuration: undefined,
              metadata: undefined
            })
          )
          assert.deepStrictEqual(
            responses.map((response) => response.payload?.$case),
            ["task", "statusUpdate", "artifactUpdate", "statusUpdate"]
          )

          const submitted = responses[0]?.payload
          const working = responses[1]?.payload
          const artifact = responses[2]?.payload
          const completed = responses[3]?.payload
          if (submitted?.$case !== "task") {
            assert.fail("expected a submitted task")
          }
          if (working?.$case !== "statusUpdate") {
            assert.fail("expected a working status")
          }
          if (artifact?.$case !== "artifactUpdate") {
            assert.fail("expected an artifact update")
          }
          if (completed?.$case !== "statusUpdate") {
            assert.fail("expected a completed status")
          }

          assert.strictEqual(
            submitted.value.status?.state,
            TaskState.TASK_STATE_SUBMITTED
          )
          assert.strictEqual(
            working.value.status?.state,
            TaskState.TASK_STATE_WORKING
          )
          assert.strictEqual(
            completed.value.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.strictEqual(working.value.taskId, submitted.value.id)
          assert.strictEqual(artifact.value.taskId, submitted.value.id)
          assert.strictEqual(completed.value.taskId, submitted.value.id)
          assert.strictEqual(working.value.contextId, submitted.value.contextId)
          assert.strictEqual(artifact.value.contextId, submitted.value.contextId)
          assert.strictEqual(completed.value.contextId, submitted.value.contextId)

          const artifactContent = artifact.value.artifact?.parts[0]?.content
          if (artifactContent?.$case !== "text") {
            assert.fail("expected a text artifact update")
          }
          assert.strictEqual(
            artifactContent.value,
            `a2a:anonymous:${submitted.value.contextId}:1:stream`
          )

          const stored = yield* promise(() =>
            client.getTask({ tenant: "", id: submitted.value.id })
          )
          assert.strictEqual(
            stored.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.strictEqual(taskText(stored), artifactContent.value)
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [
        `${opened[0]}:1:stream`
      ])
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("cancels only the active task and keeps its session usable", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({ blockFirstPrompt: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )

          const submitted = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: userMessage("cancel-message", "", "block"),
              configuration: {
                acceptedOutputModes: ["text/plain"],
                taskPushNotificationConfig: undefined,
                returnImmediately: true
              },
              metadata: undefined
            })
          )
          if (!("id" in submitted)) {
            assert.fail("expected SendMessage to return a task")
          }
          yield* Deferred.await(fixture.promptStarted)

          const canceled = yield* promise(() =>
            client.cancelTask({
              tenant: "",
              id: submitted.id,
              metadata: undefined
            })
          )
          assert.strictEqual(canceled.id, submitted.id)
          assert.strictEqual(canceled.contextId, submitted.contextId)
          assert.strictEqual(
            canceled.status?.state,
            TaskState.TASK_STATE_CANCELED
          )

          const storedCanceled = yield* promise(() =>
            client.getTask({ tenant: "", id: submitted.id })
          )
          assert.strictEqual(
            storedCanceled.status?.state,
            TaskState.TASK_STATE_CANCELED
          )

          const followUp = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: userMessage(
                "after-cancel-message",
                submitted.contextId,
                "after"
              ),
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in followUp)) {
            assert.fail("expected SendMessage to return a task")
          }
          assert.strictEqual(
            followUp.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.strictEqual(
            taskText(followUp),
            `a2a:anonymous:${submitted.contextId}:2:after`
          )

          const stillCanceled = yield* promise(() =>
            client.getTask({ tenant: "", id: submitted.id })
          )
          assert.strictEqual(
            stillCanceled.status?.state,
            TaskState.TASK_STATE_CANCELED
          )
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [
        `${opened[0]}:1:block`,
        `${opened[0]}:2:after`
      ])
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("disconnects a stream observer without canceling its task", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({ blockFirstPrompt: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )
          const responses = client.sendMessageStream({
            tenant: "",
            message: userMessage("disconnect-message", "", "stay-running"),
            configuration: undefined,
            metadata: undefined
          })

          const first = yield* promise(() => responses.next())
          const second = yield* promise(() => responses.next())
          if (first.done || first.value.payload?.$case !== "task") {
            assert.fail("expected a submitted task")
          }
          if (second.done || second.value.payload?.$case !== "statusUpdate") {
            assert.fail("expected a working status")
          }
          const taskId = first.value.payload.value.id
          assert.strictEqual(
            second.value.payload.value.status?.state,
            TaskState.TASK_STATE_WORKING
          )
          yield* Deferred.await(fixture.promptStarted)
          yield* promise(() => responses.return(undefined))

          const stillWorking = yield* promise(() =>
            client.getTask({ tenant: "", id: taskId })
          )
          assert.strictEqual(
            stillWorking.status?.state,
            TaskState.TASK_STATE_WORKING
          )
          assert.deepStrictEqual(yield* Ref.get(fixture.released), [])
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [
        `${opened[0]}:1:stay-running`
      ])
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("ends a canceled stream with one canceled terminal status", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({ blockFirstPrompt: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )
          const responses = client.sendMessageStream({
            tenant: "",
            message: userMessage("stream-cancel-message", "", "cancel-stream"),
            configuration: undefined,
            metadata: undefined
          })

          const first = yield* promise(() => responses.next())
          const second = yield* promise(() => responses.next())
          if (first.done || first.value.payload?.$case !== "task") {
            assert.fail("expected a submitted task")
          }
          if (second.done || second.value.payload?.$case !== "statusUpdate") {
            assert.fail("expected a working status")
          }
          const taskId = first.value.payload.value.id
          yield* Deferred.await(fixture.promptStarted)

          const canceled = yield* promise(() =>
            client.cancelTask({
              tenant: "",
              id: taskId,
              metadata: undefined
            })
          )
          const terminal = yield* promise(() => responses.next())
          const end = yield* promise(() => responses.next())
          if (
            terminal.done ||
            terminal.value.payload?.$case !== "statusUpdate"
          ) {
            assert.fail("expected a canceled terminal status")
          }
          assert.strictEqual(
            terminal.value.payload.value.status?.state,
            TaskState.TASK_STATE_CANCELED
          )
          assert.strictEqual(canceled.status?.state, TaskState.TASK_STATE_CANCELED)
          assert.isTrue(end.done)

          const stored = yield* promise(() =>
            client.getTask({ tenant: "", id: taskId })
          )
          assert.strictEqual(
            stored.status?.state,
            TaskState.TASK_STATE_CANCELED
          )
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("pauses a run as input-required and completes it from a continuation message", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({ elicitFirstPrompt: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )
          const responses = client.sendMessageStream({
            tenant: "",
            message: userMessage("pause-message", "", "ask"),
            configuration: undefined,
            metadata: undefined
          })

          const first = yield* promise(() => responses.next())
          const second = yield* promise(() => responses.next())
          if (first.done || first.value.payload?.$case !== "task") {
            assert.fail("expected a submitted task")
          }
          if (second.done || second.value.payload?.$case !== "statusUpdate") {
            assert.fail("expected a working status")
          }
          const taskId = first.value.payload.value.id
          const contextId = first.value.payload.value.contextId
          assert.strictEqual(
            second.value.payload.value.status?.state,
            TaskState.TASK_STATE_WORKING
          )

          const third = yield* promise(() => responses.next())
          if (third.done || third.value.payload?.$case !== "statusUpdate") {
            assert.fail("expected an input-required status")
          }
          assert.strictEqual(
            third.value.payload.value.status?.state,
            TaskState.TASK_STATE_INPUT_REQUIRED
          )
          const question =
            third.value.payload.value.status?.message?.parts[0]?.content
          if (question?.$case !== "text") {
            assert.fail("expected the question rendered as text")
          }
          assert.include(question.value, "approval")
          yield* promise(() => responses.return(undefined))

          const stored = yield* promise(() =>
            client.getTask({ tenant: "", id: taskId })
          )
          assert.strictEqual(
            stored.status?.state,
            TaskState.TASK_STATE_INPUT_REQUIRED
          )

          const continued = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: {
                ...userMessage("answer-message", contextId, "yes"),
                taskId
              },
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in continued)) {
            assert.fail("expected the continuation to return a task")
          }
          assert.strictEqual(continued.id, taskId)
          assert.strictEqual(
            continued.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.include(taskText(continued), ":yes")

          const storedCompleted = yield* promise(() =>
            client.getTask({ tenant: "", id: taskId })
          )
          assert.strictEqual(
            storedCompleted.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.calls), [
        `${opened[0]}:1:ask`
      ])
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("a resumed run that asks again is input-required again, then completes", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({
        elicitFirstPrompt: true,
        askAgain: true
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )
          const responses = client.sendMessageStream({
            tenant: "",
            message: userMessage("twice-message", "", "ask"),
            configuration: undefined,
            metadata: undefined
          })
          const first = yield* promise(() => responses.next())
          if (first.done || first.value.payload?.$case !== "task") {
            assert.fail("expected a submitted task")
          }
          const taskId = first.value.payload.value.id
          const contextId = first.value.payload.value.contextId
          yield* promise(() => responses.next())
          const paused = yield* promise(() => responses.next())
          if (paused.done || paused.value.payload?.$case !== "statusUpdate") {
            assert.fail("expected an input-required status")
          }
          assert.strictEqual(
            paused.value.payload.value.status?.state,
            TaskState.TASK_STATE_INPUT_REQUIRED
          )
          yield* promise(() => responses.return(undefined))

          // The first answer does not finish the run: it asks again. The
          // continuation must come back as input-required rather than hang.
          const askedAgain = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: { ...userMessage("answer-1", contextId, "yes"), taskId },
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in askedAgain)) {
            assert.fail("expected the continuation to return a task")
          }
          assert.strictEqual(
            askedAgain.status?.state,
            TaskState.TASK_STATE_INPUT_REQUIRED
          )
          const question = askedAgain.status?.message?.parts[0]?.content
          if (question?.$case !== "text") {
            assert.fail("expected the second question rendered as text")
          }
          assert.include(question.value, "approval")

          const completed = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: { ...userMessage("answer-2", contextId, "also"), taskId },
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in completed)) {
            assert.fail("expected the second continuation to return a task")
          }
          assert.strictEqual(
            completed.status?.state,
            TaskState.TASK_STATE_COMPLETED
          )
          assert.include(taskText(completed), ":yes:also")

          // Once, not twice: the run produced a single terminal state.
          const stored = yield* promise(() =>
            client.getTask({ tenant: "", id: taskId })
          )
          assert.strictEqual(stored.status?.state, TaskState.TASK_STATE_COMPLETED)
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )

  it.effect("reports a failed run as a failed task", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({ failFirstPrompt: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )

          const failed = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: userMessage("fail-message", "", "break"),
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in failed)) {
            assert.fail("expected SendMessage to return a task")
          }
          assert.strictEqual(
            failed.status?.state,
            TaskState.TASK_STATE_FAILED
          )

          const stored = yield* promise(() =>
            client.getTask({ tenant: "", id: failed.id })
          )
          assert.strictEqual(stored.status?.state, TaskState.TASK_STATE_FAILED)
        }).pipe(Effect.provide(fixture.server))
      )

      const opened = yield* Ref.get(fixture.opened)
      assert.strictEqual(opened.length, 1)
      assert.deepStrictEqual(yield* Ref.get(fixture.released), opened)
    })
  )

  it.effect("a resumed run that fails leaves the task failed, not completed", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({
        elicitFirstPrompt: true,
        failResumedRun: true
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(
              HttpServer.formatAddress(server.address)
            )
          )

          const responses = client.sendMessageStream({
            tenant: "",
            message: userMessage("pause-fail-message", "", "ask"),
            configuration: undefined,
            metadata: undefined
          })
          const first = yield* promise(() => responses.next())
          if (first.done || first.value.payload?.$case !== "task") {
            assert.fail("expected a submitted task")
          }
          const taskId = first.value.payload.value.id
          const contextId = first.value.payload.value.contextId
          for (;;) {
            const next = yield* promise(() => responses.next())
            if (next.done) break
            if (
              next.value.payload?.$case === "statusUpdate" &&
              next.value.payload.value.status?.state ===
                TaskState.TASK_STATE_INPUT_REQUIRED
            ) {
              yield* promise(() => responses.return(undefined))
              break
            }
          }

          const continued = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: { ...userMessage("answer-2", contextId, "yes"), taskId },
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in continued)) {
            assert.fail("expected the continuation to return a task")
          }
          // The run failed after the answer was delivered; reporting a
          // completed task here would invent an artifact that never existed.
          assert.strictEqual(
            continued.status?.state,
            TaskState.TASK_STATE_FAILED
          )
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )

  /**
   * A push notification config is not status.
   *
   * It names a URL this server will later POST task content to, and carries a
   * `token` and `authentication` block besides. Reading one leaks a
   * credential; writing one arranges for task content to keep arriving at an
   * address of the caller's choosing, after the grant that allowed it is gone.
   *
   * So all four endpoints authorize as `configure`, not `status`, and the URL
   * is checked before it is stored.
   */
  describe("push notification configuration", () => {
    it("is a distinct operation from reading status", () => {
      const operations = AgentProtocol.Operation.literals
      assert.include(operations, "configure")
      assert.include(operations, "status")
      assert.notStrictEqual(
        "configure",
        "status",
        "a read-only grant must not imply the ability to configure delivery"
      )
    })

    describe("target validation", () => {
      const rejected: ReadonlyArray<readonly [unknown, string]> = [
        [undefined, "a missing url"],
        ["", "an empty url"],
        [42, "a non-string url"],
        ["not a url", "an unparseable url"],
        ["http://example.com/hook", "plain http, which exposes task content"],
        ["https://localhost/hook", "loopback by name"],
        ["https://127.0.0.1/hook", "loopback by address"],
        ["https://10.0.0.5/hook", "an RFC1918 address"],
        ["https://192.168.1.10/hook", "an RFC1918 address"],
        ["https://172.16.0.9/hook", "an RFC1918 address"],
        ["https://169.254.169.254/latest/meta-data", "the cloud metadata endpoint"],
        ["https://[::1]/hook", "IPv6 loopback"],
        // The WHATWG URL parser canonicalises every IPv4 spelling before the
        // check sees it, so these arrive as 127.0.0.1. Pinned rather than
        // assumed: the guard would be wrong to rely on it if it ever changed.
        ["https://2130706433/hook", "loopback as a 32-bit integer"],
        ["https://0x7f000001/hook", "loopback in hex"],
        ["https://0177.0.0.1/hook", "loopback with an octal octet"],
        ["https://127.1/hook", "loopback in short form"],
        // These are not normalised, and each was a live bypass.
        ["https://[::ffff:127.0.0.1]/hook", "IPv4-mapped IPv6 loopback"],
        ["https://[::ffff:7f00:1]/hook", "the same, in hextet form"],
        ["https://metadata.google.internal/x", "a metadata endpoint by name"],
        ["https://metadata.goog/x", "the same, short form"],
        ["https://[::]/hook", "the unspecified address"],
        ["https://[fe80::1]/hook", "IPv6 link-local"],
        ["https://localhost./hook", "a trailing dot on localhost"],
        ["https://LOCALHOST/hook", "localhost in caps"],
        ["https://sub.localhost/hook", "a subdomain of localhost"],
        ["https://0.0.0.0/hook", "the any-address"],
        ["https://evil.com@127.0.0.1/hook", "userinfo disguising the host"]
      ]

      for (const [url, why] of rejected) {
        it(`rejects ${JSON.stringify(url)} — ${why}`, () => {
          const reason = AgentA2A.rejectPushUrl(url)
          assert.isTrue(Option.isSome(reason), why)
        })
      }

      it("accepts an ordinary https endpoint", () => {
        assert.isTrue(
          Option.isNone(AgentA2A.rejectPushUrl("https://hooks.example.com/a2a"))
        )
      })

      it("an allowHosts entry opts one host back in, and only that host", () => {
        const policy = { allowHosts: ["collector.internal"] }
        assert.isTrue(
          Option.isNone(
            AgentA2A.rejectPushUrl("https://collector.internal/hook", policy)
          )
        )
        // A neighbour on the same private network is still refused: the opt-in
        // is per host, not a switch that reopens the range.
        assert.isTrue(
          Option.isSome(
            AgentA2A.rejectPushUrl("https://10.0.0.5/hook", policy)
          )
        )
      })

      it("allowInsecure permits http without permitting private targets", () => {
        const policy = { allowInsecure: true }
        assert.isTrue(
          Option.isNone(
            AgentA2A.rejectPushUrl("http://hooks.example.com/a2a", policy)
          )
        )
        assert.isTrue(
          Option.isSome(
            AgentA2A.rejectPushUrl("http://127.0.0.1/a2a", policy)
          ),
          "relaxing the scheme must not also relax the address range"
        )
      })

      it("says why, so an operator is not left guessing", () => {
        const scheme = AgentA2A.rejectPushUrl("http://example.com/hook")
        const address = AgentA2A.rejectPushUrl("https://127.0.0.1/hook")
        assert.isTrue(Option.isSome(scheme) && Option.isSome(address))
        if (Option.isSome(scheme)) assert.include(scheme.value, "https")
        if (Option.isSome(address)) assert.include(address.value, "127.0.0.1")
      })
    })
  })

  /**
   * An idle SSE stream is indistinguishable from a dead one to a proxy with
   * an idle timeout, and a task parked on input-required can be idle for
   * minutes. The keep-alive frame is an SSE *comment* -- `: keep-alive` --
   * which the official client skips, so it costs nothing at the protocol
   * level and is never mistaken for an event.
   *
   * Driven by a short real interval rather than `TestClock`: the stream is
   * read through a real HTTP connection, and what is being asserted is that
   * bytes reach the wire while the run is blocked. A 40 ms interval against a
   * bounded read is deterministic enough -- the frame either arrives within
   * the bound or the test fails, it cannot pass by accident.
   */
  /**
   * `it.live`, not `it.effect`: the effect runner provides a `TestClock`, under
   * which no `Effect.sleep` fires unless the test advances it -- and the
   * server under test is built inside the same runtime, so its heartbeat
   * would never tick either. A real HTTP connection wants a real clock. The
   * bounded reads are what keep this deterministic: a frame either arrives
   * within the bound or the test fails, it cannot pass by accident.
   */
  describe("SSE keep-alive", () => {
    it.live("writes a comment frame while the run is idle", () =>
      Effect.gen(function* () {
        const fixture = yield* serverFixture({
          blockFirstPrompt: true,
          sseHeartbeat: Duration.millis(40)
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer
            const url = HttpServer.formatAddress(server.address)
            const frames = yield* sseFrames(url, "keep-alive-1", "stay-running")
            yield* Deferred.await(fixture.promptStarted)
            // Nothing else is written while the prompt is blocked, so the
            // next thing on the wire has to be the heartbeat.
            const seen = yield* frames.drainUntil(
              ": keep-alive",
              Duration.seconds(3)
            )
            assert.include(seen, ": keep-alive\n\n")
            // A comment, not an event: no `data:` line belongs to it.
            const afterHeartbeat = seen.slice(seen.indexOf(": keep-alive"))
            assert.notInclude(afterHeartbeat, "data:")
            // End the run and close the connection before the server layer
            // tears down; either left open would surface as an interruption
            // of the test itself.
            yield* Deferred.succeed(fixture.promptInterrupted, void 0)
            yield* frames.close
          }).pipe(Effect.provide(fixture.server))
        )
      })
    )

    it.live("is silent when disabled", () =>
      Effect.gen(function* () {
        const fixture = yield* serverFixture({
          blockFirstPrompt: true,
          sseHeartbeat: false
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer
            const url = HttpServer.formatAddress(server.address)
            const frames = yield* sseFrames(url, "keep-alive-2", "stay-running")
            yield* Deferred.await(fixture.promptStarted)
            // Drain what the run itself writes before it blocks, then the
            // wire must go quiet: a read that times out is the assertion.
            yield* frames.drainUntil("TASK_STATE_WORKING", Duration.seconds(3))
            const next = yield* frames.next(Duration.millis(300))
            assert.strictEqual(
              next._tag,
              "timeout",
              `expected silence with the heartbeat disabled, saw: ${JSON.stringify(next)}`
            )
            yield* Deferred.succeed(fixture.promptInterrupted, void 0)
            yield* frames.close
          }).pipe(Effect.provide(fixture.server))
        )
      })
    )

    it.live("stops when the stream ends", () =>
      Effect.gen(function* () {
        const fixture = yield* serverFixture({
          failFirstPrompt: true,
          sseHeartbeat: Duration.millis(20)
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer
            const url = HttpServer.formatAddress(server.address)
            const frames = yield* sseFrames(url, "keep-alive-3", "fail-fast")
            yield* frames.drainUntil("TASK_STATE_FAILED", Duration.seconds(3))
            // The response closes. A heartbeat fibre that outlived the pump
            // would hold the connection open and this read would see a
            // keep-alive, or time out, instead of the end.
            const end = yield* frames.next(Duration.seconds(2))
            assert.strictEqual(
              end._tag,
              "end",
              `the stream must close once the run is terminal, saw: ${JSON.stringify(end)}`
            )
          }).pipe(Effect.provide(fixture.server))
        )
      })
    )
  })
})

describe("AgentA2A multimodal parts", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it.effect("file parts in a message reach the agent, and a file in the answer is a raw part of the artifact", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture({
        replyContent: [
          Prompt.textPart({ text: "here is the diagram" }),
          Prompt.filePart({ mediaType: "image/png", data: png, fileName: "diagram.png" }),
          Prompt.filePart({ mediaType: "image/svg+xml", data: new URL("https://example.test/diagram.svg") })
        ]
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(HttpServer.formatAddress(server.address))
          )
          const task = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: {
                messageId: "media-1",
                contextId: "",
                taskId: "",
                role: Role.ROLE_USER,
                parts: [
                  { content: { $case: "text", value: "describe this" }, metadata: undefined, filename: "", mediaType: "text/plain" },
                  { content: { $case: "raw", value: Buffer.from(png) }, metadata: undefined, filename: "shot.png", mediaType: "image/png" },
                  { content: { $case: "url", value: "https://example.test/spec.pdf" }, metadata: undefined, filename: "", mediaType: "application/pdf" }
                ],
                metadata: undefined,
                extensions: [],
                referenceTaskIds: []
              },
              configuration: undefined,
              metadata: undefined
            })
          )
          if (!("id" in task)) assert.fail("expected a task")
          assert.strictEqual(task.status?.state, TaskState.TASK_STATE_COMPLETED)

          // In: text, bytes with their name and type, a URL with its type.
          const input = yield* Ref.get(fixture.lastInput)
          if (Option.isNone(input)) assert.fail("the agent was not prompted")
          const user = input.value.content[input.value.content.length - 1]
          if (user?.role !== "user") assert.fail("expected a user message")
          assert.deepStrictEqual(user.content.map((part) => part.type), ["text", "file", "file"])
          const files = user.content.flatMap((part) => (part.type === "file" ? [part] : []))
          assert.strictEqual(files[0]?.mediaType, "image/png")
          assert.strictEqual(files[0]?.fileName, "shot.png")
          assert.deepStrictEqual(Array.from(files[0]?.data instanceof Uint8Array ? files[0].data : []), Array.from(png))
          assert.strictEqual(files[1]?.mediaType, "application/pdf")
          assert.isTrue(files[1]?.data instanceof URL)

          // Out: the artifact carries the text, the bytes as `raw`, the URL as `url`.
          const parts = task.artifacts[0]?.parts ?? []
          assert.deepStrictEqual(parts.map((part) => part.content?.$case), ["text", "raw", "url"])
          const raw = parts[1]
          assert.strictEqual(raw?.mediaType, "image/png")
          assert.strictEqual(raw?.filename, "diagram.png")
          if (raw?.content?.$case === "raw") {
            assert.deepStrictEqual(Array.from(raw.content.value), Array.from(png))
          }
          const url = parts[2]
          assert.strictEqual(url?.mediaType, "image/svg+xml")
          if (url?.content?.$case === "url") {
            assert.strictEqual(url.content.value, "https://example.test/diagram.svg")
          }
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )

  it.effect("a structured data part is still refused, naming it", () =>
    Effect.gen(function* () {
      const fixture = yield* serverFixture()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer
          const client = yield* promise(() =>
            new ClientFactory().createFromUrl(HttpServer.formatAddress(server.address))
          )
          const task = yield* promise(() =>
            client.sendMessage({
              tenant: "",
              message: {
                messageId: "data-1",
                contextId: "",
                taskId: "",
                role: Role.ROLE_USER,
                parts: [{ content: { $case: "data", value: { a: 1 } }, metadata: undefined, filename: "", mediaType: "application/json" }],
                metadata: undefined,
                extensions: [],
                referenceTaskIds: []
              },
              configuration: undefined,
              metadata: undefined
            })
          )
          // The SDK reports it as a failed task whose status message names
          // the kind, so a client sees what was refused, not a bare error.
          if (!("id" in task)) assert.fail("expected a task")
          assert.strictEqual(task.status?.state, TaskState.TASK_STATE_FAILED)
          const said = task.status?.message?.parts
            .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
            .join(" ") ?? ""
          assert.include(said, "data")
          assert.isTrue(Option.isNone(yield* Ref.get(fixture.lastInput)))
        }).pipe(Effect.provide(fixture.server))
      )
    })
  )
})
