import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk"
import { ClientFactory } from "@a2a-js/sdk/client"
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentA2A } from "../src/a2a/index.js"
import { AgentProtocol } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The A2A server over the durable client, driven by the official SDK client.
 * The transport knows nothing about durability; what it sees is an
 * `AgentClient`. What these tests add to the A2A suite is concurrency and
 * the durable machinery underneath: two contexts parked on approvals at
 * once, a busy context, and a cancel that lands on a *suspended* workflow.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const Wipe = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

const userMessage = (messageId: string, contextId: string, text: string, taskId = ""): Message => ({
  messageId,
  contextId,
  taskId,
  role: Role.ROLE_USER,
  parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "text/plain" }],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
})

const taskText = (task: Task): string =>
  task.artifacts?.flatMap((artifact) =>
    artifact.parts.flatMap((part) => (part.content?.$case === "text" ? [part.content.value] : []))
  ).join("") ?? ""

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const fixture = (
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>
) =>
  Effect.gen(function* () {
    const stores = yield* Effect.all({
      store: DurableChannels.memoryStore,
      sessionStore: DurableSessionStore.memoryStore,
      delivery: DeliveryLog.memoryLog
    })
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const runtime = yield* Layer.build(
      DurableAgentClient.layer("A2ADurable", agent, stores).pipe(
        Layer.provideMerge(Engine),
        Layer.provideMerge(model)
      )
    )
    const routes = AgentA2A.serverLayer({
      card: {
        name: "Durable A2A",
        description: "A durable agent behind A2A",
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
      authorization: { authorize: () => Effect.void },
      principal: {
        resolve: ({ headers }) => Effect.succeed({ subject: headers.authorization ?? "anon" }),
        subject: (principal) => principal.subject
      },
      session: {
        resolve: ({ contextId }) => Effect.succeed(AgentProtocol.SessionId.make(`a2a:${contextId}`))
      },
      maxSessions: 8,
      maxRequestsPerSession: 32
    }).pipe(Layer.provide(Layer.succeedContext(runtime)))
    const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
      )
    )
    const http = yield* Layer.build(server)
    const address = HttpServer.formatAddress(
      (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(http))).address
    )
    const client = yield* promise(() => new ClientFactory().createFromUrl(address))
    return { ...stores, recorder, client }
  })

const until = <A, E>(observation: Effect.Effect<A, E>, predicate: (value: A) => boolean) =>
  Effect.repeat(observation, { until: predicate, schedule: Schedule.spaced(Duration.millis(20)) })

/** Send a message and read the stream until the task pauses or settles. */
const sendAndFollow = (
  client: Awaited<ReturnType<ClientFactory["createFromUrl"]>>,
  message: Message
) =>
  Effect.gen(function* () {
    const responses = client.sendMessageStream({
      tenant: "",
      message,
      configuration: undefined,
      metadata: undefined
    })
    let taskId = ""
    let contextId = ""
    let state: TaskState | undefined
    for (;;) {
      const next = yield* promise(() => responses.next())
      if (next.done) break
      const payload = next.value.payload
      if (payload?.$case === "task") {
        taskId = payload.value.id
        contextId = payload.value.contextId
      }
      if (payload?.$case === "statusUpdate") {
        state = payload.value.status?.state
        if (
          state === TaskState.TASK_STATE_INPUT_REQUIRED ||
          state === TaskState.TASK_STATE_COMPLETED ||
          state === TaskState.TASK_STATE_FAILED ||
          state === TaskState.TASK_STATE_CANCELED
        ) {
          break
        }
      }
    }
    yield* promise(() => responses.return(undefined))
    return { taskId, contextId, state }
  })

describe("durable client behind the A2A server", () => {
  it.live("two contexts park on approvals at once and are answered in the other order", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make<Array<string>>([])
      const agent = Agent.make({
        toolkit: Agent.toolkit([Wipe], {
          wipe: () => Ref.update(wiped, (all) => [...all, "x"]).pipe(Effect.as("wiped"))
        }),
        loop: AgentLoop.bounded(4)
      })
      // One scripted model serves both contexts; the entries are symmetric
      // so the interleaving of the two runs does not matter.
      const f = yield* fixture(agent, [
        { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
        { toolCalls: [{ id: "w2", name: "wipe", params: {} }] },
        TestLanguageModel.text("done"),
        TestLanguageModel.text("done")
      ])

      const [a, b] = yield* Effect.all(
        [
          sendAndFollow(f.client, userMessage("m-a", "ctx-a", "wipe a")),
          sendAndFollow(f.client, userMessage("m-b", "ctx-b", "wipe b"))
        ],
        { concurrency: "unbounded" }
      )
      assert.strictEqual(a.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      assert.strictEqual(b.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      assert.notStrictEqual(a.taskId, b.taskId)
      // Both sessions are parked, durably: the store says so for each.
      assert.strictEqual((yield* f.sessionStore.pendingRequests("a2a:ctx-a")).length, 1)
      assert.strictEqual((yield* f.sessionStore.pendingRequests("a2a:ctx-b")).length, 1)
      assert.deepStrictEqual(yield* Ref.get(wiped), [])

      // Answer B, then A. Each continuation completes its own task only.
      const bDone = yield* promise(() =>
        f.client.sendMessage({
          tenant: "",
          message: userMessage("ans-b", b.contextId, "yes", b.taskId),
          configuration: undefined,
          metadata: undefined
        })
      )
      if (!("id" in bDone)) return assert.fail("expected a task")
      assert.strictEqual(bDone.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.strictEqual((yield* f.sessionStore.pendingRequests("a2a:ctx-a")).length, 1)
      const aRecord = yield* f.sessionStore.get("a2a:ctx-a")
      assert.strictEqual(aRecord._tag === "Some" ? aRecord.value.status : "", "running")

      const aDone = yield* promise(() =>
        f.client.sendMessage({
          tenant: "",
          message: userMessage("ans-a", a.contextId, "yes", a.taskId),
          configuration: undefined,
          metadata: undefined
        })
      )
      if (!("id" in aDone)) return assert.fail("expected a task")
      assert.strictEqual(aDone.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.include(taskText(aDone), "done")
      assert.strictEqual((yield* Ref.get(wiped)).length, 2)
      // Four real model calls: two tool turns, two completions, none re-issued.
      assert.strictEqual(yield* f.recorder.calls, 4)
    }).pipe(Effect.scoped),
    20_000
  )

  it.live("a second message on a busy context fails its task; the first finishes; the context is reusable", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(2) }), [
        { text: "first", started: entered, during: Deferred.await(release) },
        TestLanguageModel.text("third")
      ])

      const first = yield* Effect.forkChild(
        sendAndFollow(f.client, userMessage("m1", "busy", "one"))
      )
      yield* Deferred.await(entered)
      const second = yield* sendAndFollow(f.client, userMessage("m2", "busy", "two"))
      assert.strictEqual(second.state, TaskState.TASK_STATE_FAILED)
      const secondTask = yield* promise(() => f.client.getTask({ tenant: "", id: second.taskId }))
      assert.include(secondTask.status?.message?.parts[0]?.content?.$case === "text"
        ? secondTask.status.message.parts[0].content.value
        : "", "busy")

      yield* Deferred.succeed(release, void 0)
      const firstOutcome = yield* Fiber.join(first)
      assert.strictEqual(firstOutcome.state, TaskState.TASK_STATE_COMPLETED)

      const third = yield* sendAndFollow(f.client, userMessage("m3", "busy", "three"))
      assert.strictEqual(third.state, TaskState.TASK_STATE_COMPLETED)
      const stored = yield* promise(() => f.client.getTask({ tenant: "", id: third.taskId }))
      assert.include(taskText(stored), "third")
      // Two accepted submissions on the session; the busy one never claimed.
      const record = yield* f.sessionStore.get("a2a:busy")
      assert.strictEqual(record._tag === "Some" ? record.value.submissionCount : 0, 2)
    }).pipe(Effect.scoped),
    20_000
  )

  it.live("cancelling a task parked on an approval ends it without running the tool, and the context goes on", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const agent = Agent.make({
        toolkit: Agent.toolkit([Wipe], {
          wipe: () => Ref.update(wiped, (n) => n + 1).pipe(Effect.as("wiped"))
        }),
        loop: AgentLoop.bounded(4)
      })
      const f = yield* fixture(agent, [
        { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
        TestLanguageModel.text("after")
      ])

      const parked = yield* sendAndFollow(f.client, userMessage("m1", "cancel-me", "wipe"))
      assert.strictEqual(parked.state, TaskState.TASK_STATE_INPUT_REQUIRED)
      // The workflow is suspended: nothing is executing. Cancel must still
      // take effect now -- the durable interrupt wakes the run by refusing
      // the question -- rather than when someone answers.
      const cancelled = yield* promise(() =>
        f.client.cancelTask({ tenant: "", id: parked.taskId, metadata: undefined })
      )
      assert.strictEqual(cancelled.status?.state, TaskState.TASK_STATE_CANCELED)
      assert.strictEqual(
        yield* until(
          Effect.map(f.sessionStore.get("a2a:cancel-me"), (r) =>
            r._tag === "Some" ? r.value.status : "missing"
          ),
          (status) => status === "idle"
        ),
        "idle"
      )
      assert.strictEqual(yield* Ref.get(wiped), 0)
      assert.deepStrictEqual(yield* f.sessionStore.pendingRequests("a2a:cancel-me"), [])

      const next = yield* sendAndFollow(f.client, userMessage("m2", "cancel-me", "again"))
      assert.strictEqual(next.state, TaskState.TASK_STATE_COMPLETED)
      const stored = yield* promise(() => f.client.getTask({ tenant: "", id: next.taskId }))
      assert.include(taskText(stored), "after")
    }).pipe(Effect.scoped),
    20_000
  )
})
