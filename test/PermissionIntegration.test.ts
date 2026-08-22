import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Ref, Schedule, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { AgentHttp } from "../src/http/index.js"
import { OpenAiAgent } from "../src/openai/index.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { completion, errorBody, post } from "./OpenAiHelpers.js"

/**
 * Permission across the boundaries a real deployment has: the durable
 * client (decisions journalled, grants passed through, interruption while
 * parked), the HTTP transport (the question and its "remember" answer
 * crossing the wire), and the OpenAI surface (a denial as an honest status).
 * `Permission.test.ts` proves the semantics in-process; this proves they
 * survive the seams.
 */

const Bash = Permission.annotate(
  Tool.make("bash", {
    parameters: Schema.Struct({ command: Schema.String }),
    success: Schema.String
  }),
  { action: "shell", resource: ({ command }) => command }
)

const call = (id: string, command: string): TestLanguageModel.Turn => ({
  toolCalls: [{ id, name: "bash", params: { command } }]
})

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(Permission.ApprovalDetail))

const until = <A, E, R>(
  observation: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean
): Effect.Effect<A, E, R> =>
  Effect.repeat(observation, {
    until: predicate,
    schedule: Schedule.spaced(Duration.millis(10))
  })

const agentWith = <PR>(
  ran: Ref.Ref<Array<string>>,
  options: {
    readonly permission: Permission.Policy<PR>
    readonly toolDenialPolicy?: ToolExecution.FailurePolicy
  }
) =>
  Agent.make({
    toolkit: Agent.toolkit([Bash], {
      bash: ({ command }) =>
        Ref.update(ran, (all) => [...all, command]).pipe(Effect.as(`ran ${command}`))
    }),
    loop: AgentLoop.bounded(6),
    permission: options.permission,
    ...(options.toolDenialPolicy === undefined ? {} : { toolDenialPolicy: options.toolDenialPolicy })
  })

// ---------------------------------------------------------------------------
// Durable
// ---------------------------------------------------------------------------

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const durable = (
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
      DurableAgentClient.layer("PermissionDurable", agent, stores).pipe(
        Layer.provideMerge(Engine),
        Layer.provideMerge(model)
      )
    )
    const client = yield* AgentClient.AgentClient.pipe(Effect.provide(runtime))
    return { ...stores, recorder, client }
  })

describe("Permission over the durable client", () => {
  it.live("an Ask parks the submission with the projected detail; remember carries across submissions", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])
      const policy = yield* Permission.remembered(
        Permission.rules([{ resource: /^git push/, decision: Permission.ask("remote") }], {
          otherwise: Permission.allow
        })
      )
      const f = yield* durable(agentWith(ran, { permission: policy }), [
        call("c1", "git push"),
        TestLanguageModel.text("pushed"),
        call("c2", "git push"),
        TestLanguageModel.text("pushed again")
      ])
      const session = yield* Effect.scoped(f.client.createSession({ sessionId: "d" }))
      const first = yield* Effect.forkChild(session.prompt("push"))
      const pending = yield* until(session.pending, (p) => p.length > 0)
      assert.strictEqual(pending[0]!.kind, "tool-approval")
      assert.deepStrictEqual(decodeDetail(pending[0]!.detail), {
        toolName: "bash",
        toolCallId: "c1",
        action: "shell",
        resource: "git push",
        reason: "remote"
      })
      assert.deepStrictEqual(yield* Ref.get(ran), [])
      assert.isTrue(
        yield* session.respond({ id: pending[0]!.id, granted: true, value: { remember: true } })
      )
      assert.strictEqual((yield* Fiber.join(first)).text, "pushed")
      // The grant made under the durable wrapper reached the policy: the
      // next submission's identical call is not a question.
      const second = yield* session.prompt("push again")
      assert.strictEqual(second.text, "pushed again")
      assert.deepStrictEqual(yield* Ref.get(ran), ["git push", "git push"])
      const events = yield* f.delivery.read("d")
      assert.strictEqual(events.filter((e) => e.event._tag === "ElicitationRequested").length, 1)
      assert.strictEqual(events.filter((e) => e.event._tag === "ToolCallSucceeded").length, 2)
    }).pipe(Effect.scoped),
    20_000
  )

  it.live("a Deny crosses the boundary as an execution failure carrying the tag, and the session is free", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])
      const f = yield* durable(agentWith(ran, { permission: Permission.denyAll }), [
        call("c1", "ls"),
        TestLanguageModel.text("never")
      ])
      const session = yield* Effect.scoped(f.client.createSession({ sessionId: "deny" }))
      const error = yield* Effect.flip(session.prompt("go"))
      assert.strictEqual(error._tag, "AgentExecutionError")
      if (error._tag === "AgentExecutionError") {
        assert.strictEqual(error.tag, "ToolPermissionDeniedError")
        assert.isFalse(error.isDefect)
        assert.include(error.detail, "shell on ls")
      }
      assert.deepStrictEqual(yield* Ref.get(ran), [])
      assert.strictEqual(yield* session.status, "idle")
      assert.deepStrictEqual(yield* session.pending, [])
      // Nothing of the failed submission reached history but the user's turn.
      assert.deepStrictEqual(TestLanguageModel.userTexts(yield* session.history), ["go"])
      const events = yield* f.delivery.read("deny")
      const tags = events.map((e) => e.event._tag)
      assert.include(tags, "ToolCallFailed")
      assert.include(tags, "SubmissionFailed")
      assert.notInclude(tags, "ToolCallSucceeded")
    }).pipe(Effect.scoped),
    20_000
  )

  it.live("interrupting a submission parked on an Ask clears the question, runs nothing and records no grant", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])
      const policy = yield* Permission.remembered(Permission.askAll)
      const f = yield* durable(agentWith(ran, { permission: policy }), [
        call("c1", "ls"),
        call("c2", "ls"),
        TestLanguageModel.text("done")
      ])
      const session = yield* Effect.scoped(f.client.createSession({ sessionId: "park" }))
      const first = yield* Effect.forkChild(session.prompt("go"))
      const pending = yield* until(session.pending, (p) => p.length > 0)
      yield* session.interrupt()
      const result = yield* Fiber.join(first)
      assert.strictEqual(result.status, "interrupted")
      assert.deepStrictEqual(yield* session.pending, [])
      assert.deepStrictEqual(yield* Ref.get(ran), [])
      // The stale answer is refused: nothing is waiting for it.
      assert.isFalse(yield* session.respond({ id: pending[0]!.id, granted: true, value: { remember: true } }))
      // And the next identical call asks again -- no grant leaked out of the
      // interrupted question.
      const second = yield* Effect.forkChild(session.prompt("again"))
      const again = yield* until(session.pending, (p) => p.length > 0)
      assert.strictEqual(decodeDetail(again[0]!.detail).toolCallId, "c2")
      yield* session.respond({ id: again[0]!.id, granted: true })
      assert.strictEqual((yield* Fiber.join(second)).text, "done")
      assert.deepStrictEqual(yield* Ref.get(ran), ["ls"])
    }).pipe(Effect.scoped),
    20_000
  )
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const http = (agent: Agent.AgentDefinition<any, any, any>, turns: ReadonlyArray<TestLanguageModel.Turn>) =>
  Effect.gen(function* () {
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const routes = AgentHttp.serverLayer({
      authorization: { authorize: () => Effect.void },
      principal: {
        resolve: ({ headers: h, operation }) =>
          h.authorization === undefined
            ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
            : Effect.succeed(h.authorization)
      },
      maxSessions: 8,
      maxRequestsPerSession: 64
    }).pipe(
      Layer.provide(AgentClient.layer(agent, { elicitation: Elicitation.memory })),
      Layer.provide(model)
    )
    const runtime = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
        )
      )
    )
    const address = HttpServer.formatAddress(
      (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(runtime))).address
    )
    const api = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl: address })
    return { api, recorder }
  })

const headers = { authorization: "Bearer test" } as const
const requestId = (value: string) => AgentProtocol.RequestId.make(value)

describe("Permission over HTTP", () => {
  it.live("the question and its remembered answer cross the wire intact", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])
      const policy = yield* Permission.remembered(
        Permission.rules([{ action: "shell", resource: "deploy", decision: Permission.ask("prod") }], {
          otherwise: Permission.allow
        })
      )
      const f = yield* http(agentWith(ran, { permission: policy }), [
        call("c1", "deploy"),
        call("c2", "deploy"),
        TestLanguageModel.text("deployed twice")
      ])
      const id = AgentProtocol.SessionId.make("wire")
      yield* f.api.sessions.createSession({ headers, payload: { requestId: requestId("create"), sessionId: id } })
      const running = yield* Effect.forkChild(
        f.api.sessions.prompt({
          params: { id },
          headers,
          payload: { requestId: requestId("prompt"), input: Prompt.make("deploy it") }
        })
      )
      const pending = yield* until(
        Effect.map(f.api.sessions.pending({ params: { id }, headers }), (r) => r.requests),
        (p) => p.length > 0
      )
      const detail = decodeDetail(pending[0]!.detail)
      assert.strictEqual(detail.action, "shell")
      assert.strictEqual(detail.resource, "deploy")
      assert.strictEqual(detail.reason, "prod")
      const answered = yield* f.api.sessions.respond({
        params: { id },
        headers,
        payload: {
          requestId: requestId("answer"),
          response: { id: pending[0]!.id, granted: true, value: { remember: true } }
        }
      })
      assert.isTrue(answered.matched)
      const result = yield* Fiber.join(running)
      assert.strictEqual(result.result.text, "deployed twice")
      // c2 was the same action and resource: remembered over the wire, not asked.
      assert.deepStrictEqual(yield* Ref.get(ran), ["deploy", "deploy"])
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    20_000
  )
})

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("Permission over the OpenAI surface", () => {
  it.live("a denial is a 422 whose code is the denial, never a transport failure", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])
      const { layer: model } = yield* FakeModel.script([call("c1", "rm -rf /"), TestLanguageModel.text("never")])
      const runtime = yield* Layer.build(
        HttpRouter.serve(
          OpenAiAgent.serverLayer({ model: "agent" }).pipe(
            Layer.provide(AgentClient.layer(agentWith(ran, { permission: Permission.denyAll }))),
            Layer.provide(model)
          ),
          { disableLogger: true, disableListenLog: true }
        ).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
          )
        )
      )
      const address = HttpServer.formatAddress(
        (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(runtime))).address
      )
      const response = yield* post(address, { model: "agent", messages: [{ role: "user", content: "wipe" }] })
      assert.strictEqual(response.status, 422)
      const body = yield* errorBody(response)
      assert.strictEqual(body.error.type, "server_error")
      assert.strictEqual(body.error.code, "ToolPermissionDeniedError")
      assert.include(body.error.message, "rm -rf /")
      assert.deepStrictEqual(yield* Ref.get(ran), [])
      // With ReturnToModel the same agent answers 200 and the model explains.
      void completion
    }).pipe(Effect.scoped)
  )
})
