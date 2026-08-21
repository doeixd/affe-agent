import { NodeHttpServer } from "@effect/platform-node"
import {
  Role,
  TaskState,
  type Message,
  type Task
} from "@a2a-js/sdk"
import { ClientFactory } from "@a2a-js/sdk/client"
import { assert, describe, it } from "@effect/vitest"
import {
  Deferred,
  Effect,
  Layer,
  Ref,
  Stream
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { AgentA2A } from "../src/a2a/index.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"

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

const serverFixture = Effect.fn("AgentA2A.test.serverFixture")(function* (
  fixtureOptions?: { readonly blockFirstPrompt?: boolean }
) {
  const opened = yield* Ref.make<ReadonlyArray<string>>([])
  const released = yield* Ref.make<ReadonlyArray<string>>([])
  const calls = yield* Ref.make<ReadonlyArray<string>>([])
  const promptStarted = yield* Deferred.make<void>()
  const promptInterrupted = yield* Deferred.make<
    void,
    AgentClient.AgentExecutionError
  >()

  const agentClient = Layer.succeed(
    AgentClient.AgentClient,
    AgentClient.AgentClient.of({
      createSession: (options) =>
        Effect.gen(function* () {
          const id = options?.sessionId ??
            AgentProtocol.SessionId.make("a2a-generated")
          const promptCount = yield* Ref.make(0)
          yield* Ref.update(opened, (all) => [...all, id])
          yield* Effect.addFinalizer(() =>
            Ref.update(released, (all) => [...all, id])
          )

          return {
            id,
            prompt: (input) =>
              Effect.gen(function* () {
                const text = promptText(Prompt.make(input))
                const count = yield* Ref.updateAndGet(
                  promptCount,
                  (current) => current + 1
                )
                yield* Ref.update(
                  calls,
                  (all) => [...all, `${id}:${count}:${text}`]
                )
                if (
                  fixtureOptions?.blockFirstPrompt === true && count === 1
                ) {
                  yield* Deferred.succeed(promptStarted, void 0)
                  yield* Deferred.await(promptInterrupted)
                }
                return {
                  submissionId: AgentProtocol.SubmissionId.make(
                    `${id}:submission:${count}`
                  ),
                  status: "completed",
                  runs: 1,
                  turns: count,
                  text: `${id}:${count}:${text}`
                }
              }),
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
            respond: () => Effect.succeed(false),
            pending: Effect.succeed([]),
            history: Effect.succeed(Prompt.empty),
            status: Effect.succeed("idle"),
            events: Stream.empty
          }
        }),
      session: (id) =>
        Effect.fail(
          new AgentClient.AgentTransportError({
            sessionId: id,
            detail: "fixture sessions are owned by AgentA2A"
          })
        )
    })
  )

  const routes = AgentA2A.serverLayer({
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
    authorization: {
      authorize: () => Effect.void
    },
    principal: {
      resolve: ({ headers }) =>
        Effect.succeed({ subject: headers.authorization ?? "anonymous" }),
      subject: (principal) => principal.subject
    },
    session: {
      resolve: ({ principal, contextId }) =>
        Effect.succeed(
          AgentProtocol.SessionId.make(
            `a2a:${principal.subject}:${contextId}`
          )
        )
    },
    maxSessions: 4,
    maxRequestsPerSession: 16
  }).pipe(Layer.provide(agentClient))

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

  return { server, opened, released, calls, promptStarted }
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
})
