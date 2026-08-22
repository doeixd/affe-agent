import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { createServer } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { AgentHttp } from "../src/http/index.js"
import { BearerHost, bearerHost } from "./helpers.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

const Host = BearerHost("test/DurableHttpConcurrency/host")

/**
 * Two HTTP servers over one durable runtime stand in for two web nodes in
 * front of one cluster: separate hosts and registries, shared stores and
 * engine. The questions are about concurrency -- many sessions at once,
 * each with its own observer; a session steered and followed up from a node
 * that did not start it; two nodes racing to prompt one session.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))
const headers = { authorization: "Bearer test" } as const
const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sid = (value: string) => AgentProtocol.SessionId.make(value)

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const server = (client: Layer.Layer<AgentClient.AgentClient>) =>
  HttpRouter.serve(
    AgentHttp.serverLayer({ host: Host }).pipe(
      Layer.provide(bearerHost(Host, { maxSessions: 32, maxRequestsPerSession: 64 })),
      Layer.provide(client)
    ),
    { disableLogger: true, disableListenLog: true }
  ).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
    )
  )

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
      DurableAgentClient.layer("HttpNodes", agent, stores).pipe(
        Layer.provideMerge(Engine),
        Layer.provideMerge(model)
      )
    )
    const shared: Layer.Layer<AgentClient.AgentClient> = Layer.succeedContext(runtime)
    const api = (name: string) =>
      Effect.gen(function* () {
        const http = yield* Layer.build(server(shared))
        const address = HttpServer.formatAddress(
          (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(http))).address
        )
        const client = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl: address })
        return { name, client }
      })
    const a = yield* api("node-a")
    const b = yield* api("node-b")
    return { ...stores, recorder, a: a.client, b: b.client }
  })

describe("durable client behind two HTTP nodes", () => {
  it.live("many sessions prompt at once, each observer sees only its own session, all complete", () =>
    Effect.gen(function* () {
      const count = 6
      const f = yield* fixture(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        Array.from({ length: count }, () => TestLanguageModel.text("done"))
      )
      const outcomes = yield* Effect.forEach(
        Array.from({ length: count }, (_, i) => sid(`many-${i}`)),
        (id) =>
          Effect.gen(function* () {
            // Alternate which node creates and which observes.
            const creator = Number(id.slice(-1)) % 2 === 0 ? f.a : f.b
            const observerNode = creator === f.a ? f.b : f.a
            yield* creator.sessions.createSession({
              headers,
              payload: { requestId: requestId(`create-${id}`), sessionId: id }
            })
            const events = yield* observerNode.sessions.events({ params: { id }, headers })
            const seen = yield* Ref.make<Array<{ session: string; tag: string }>>([])
            const observer = yield* Effect.forkChild(
              Stream.runForEach(
                events.pipe(Stream.takeUntil((e) => e.event._tag === "SubmissionCompleted")),
                (e) =>
                  Ref.update(seen, (all) => [...all, { session: e.sessionId, tag: e.event._tag }])
              )
            )
            const result = yield* creator.sessions.prompt({
              params: { id },
              headers,
              payload: { requestId: requestId(`prompt-${id}`), input: Prompt.make(`hello ${id}`) }
            })
            yield* Fiber.join(observer)
            return { id, result, seen: yield* Ref.get(seen) }
          }),
        { concurrency: "unbounded" }
      )
      for (const { id, result, seen } of outcomes) {
        assert.strictEqual(result.result.text, "done")
        assert.strictEqual(result.result.status, "completed")
        assert.isTrue(seen.length > 0, `${id} saw no events`)
        assert.isTrue(seen.every((e) => e.session === id), `${id} saw another session's events`)
        assert.strictEqual(seen[seen.length - 1]?.tag, "SubmissionCompleted")
        assert.strictEqual(seen[0]?.tag, "SubmissionStarted")
      }
      assert.strictEqual(yield* f.recorder.calls, count)
      // Every session settled idle with its own transcript.
      for (const { id } of outcomes) {
        const history = yield* f.b.sessions.history({ params: { id }, headers })
        assert.deepStrictEqual(TestLanguageModel.userTexts(history.history), [`hello ${id}`])
      }
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )

  it.live("steering and a follow-up from the other node reach the running submission", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const f = yield* fixture(
        Agent.make({
          toolkit: Agent.toolkit([Search], {
            search: ({ query }) => Effect.succeed(`hits for ${query}`)
          }),
          loop: AgentLoop.bounded(6)
        }),
        [
          {
            toolCalls: [{ id: "s1", name: "search", params: { query: "a" } }],
            started: entered,
            during: Deferred.await(release)
          },
          TestLanguageModel.text("steered"),
          TestLanguageModel.text("followed")
        ]
      )
      const id = sid("cross")
      yield* f.a.sessions.createSession({
        headers,
        payload: { requestId: requestId("create"), sessionId: id }
      })
      // Node B observes before anything starts, from the delivery log.
      const observed = yield* Ref.make<Array<string>>([])
      const events = yield* f.b.sessions.events({ params: { id }, headers })
      const observer = yield* Effect.forkChild(
        Stream.runForEach(
          events.pipe(Stream.takeUntil((e) => e.event._tag === "SubmissionCompleted")),
          (e) => Ref.update(observed, (all) => [...all, e.event._tag])
        )
      )
      const running = yield* Effect.forkChild(
        f.a.sessions.prompt({
          params: { id },
          headers,
          payload: { requestId: requestId("prompt"), input: Prompt.make("go") }
        })
      )
      yield* Deferred.await(entered)
      // Node B never created this session; it adopts it and steers it.
      assert.strictEqual(
        (yield* f.b.sessions.status({ params: { id }, headers })).status,
        "running"
      )
      yield* f.b.sessions.steer({
        params: { id },
        headers,
        payload: { requestId: requestId("steer"), input: Prompt.make("go left") }
      })
      yield* f.b.sessions.followUp({
        params: { id },
        headers,
        payload: { requestId: requestId("follow"), input: Prompt.make("then this") }
      })
      yield* Deferred.succeed(release, void 0)
      const result = yield* Fiber.join(running)
      assert.strictEqual(result.result.runs, 2)
      assert.strictEqual(result.result.text, "followed")
      yield* Fiber.join(observer)
      const tags = yield* Ref.get(observed)
      // The durable client hands steering and follow-ups straight to the
      // durable channels; acceptance is the successful return of `steer` /
      // `followUp`, not a `*Queued` event (the in-workflow session never
      // sees `AgentSession.steer`). The applications are observed, in order,
      // and the steering lands before the follow-up's run starts.
      assert.notInclude(tags, "SteeringQueued")
      assert.notInclude(tags, "FollowUpQueued")
      assert.include(tags, "SteeringApplied")
      assert.include(tags, "FollowUpApplied")
      assert.isTrue(tags.indexOf("SteeringApplied") < tags.indexOf("FollowUpApplied"))
      assert.strictEqual(tags.filter((t) => t === "RunStarted").length, 2)
      const history = yield* f.a.sessions.history({ params: { id }, headers })
      assert.deepStrictEqual(TestLanguageModel.userTexts(history.history), ["go", "go left", "then this"])
      // Steering and follow-up after quiescence are refused as idle, from
      // either node.
      const idle = yield* Effect.flip(
        f.b.sessions.steer({
          params: { id },
          headers,
          payload: { requestId: requestId("late-steer"), input: Prompt.make("late") }
        })
      )
      assert.strictEqual(idle._tag, "AgentIdleError")
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )

  it.live("two nodes racing to prompt one session: one accepted, one busy, never both", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const f = yield* fixture(Agent.make({ loop: AgentLoop.bounded(2) }), [
        { text: "won", during: Deferred.await(release) },
        TestLanguageModel.text("next")
      ])
      const id = sid("contested")
      yield* f.a.sessions.createSession({
        headers,
        payload: { requestId: requestId("create"), sessionId: id }
      })
      const attempt = (node: typeof f.a, tag: string) =>
        Effect.result(
          node.sessions.prompt({
            params: { id },
            headers,
            payload: { requestId: requestId(`prompt-${tag}`), input: Prompt.make(tag) }
          })
        )
      const racing = yield* Effect.forkChild(
        Effect.all([attempt(f.a, "from-a"), attempt(f.b, "from-b")], { concurrency: "unbounded" })
      )
      yield* Effect.repeat(
        Effect.map(f.a.sessions.status({ params: { id }, headers }), (s) => s.status),
        { until: (status) => status === "running" }
      )
      yield* Deferred.succeed(release, void 0)
      const outcomes = yield* Fiber.join(racing)
      const won = outcomes.filter((o) => o._tag === "Success")
      const lost = outcomes.flatMap((o) => (o._tag === "Failure" ? [o.failure._tag] : []))
      assert.strictEqual(won.length, 1)
      assert.deepStrictEqual(lost, ["AgentBusyError"])
      const history = yield* f.b.sessions.history({ params: { id }, headers })
      assert.strictEqual(TestLanguageModel.userTexts(history.history).length, 1)
      // And the loser can go next.
      const next = yield* f.b.sessions.prompt({
        params: { id },
        headers,
        payload: { requestId: requestId("prompt-after"), input: Prompt.make("after") }
      })
      assert.strictEqual(next.result.text, "next")
      const record = yield* f.sessionStore.get(id)
      assert.strictEqual(record._tag === "Some" ? record.value.submissionCount : 0, 2)
      assert.isTrue(Option.isNone(record._tag === "Some" ? record.value.claim : Option.none()))
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    30_000
  )
})
