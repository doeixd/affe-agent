import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { Crypto, Duration, Effect, Fiber, Layer, Ref, Schedule, Schema, Stream } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentProtocol } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { AgentHttp } from "../src/http/index.js"
import { BearerHost, bearerHost } from "./helpers.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

const Host = BearerHost("test/DurableHttpIntegration/host")

/**
 * The whole stack, end to end: a generated HTTP client talks to an HTTP
 * server whose `AgentClient` is the durable one over a SQLite-backed cluster
 * engine. Nothing in the HTTP layer knows durability exists.
 *
 * What this proves that the unit suites cannot: the session host adopts a
 * durable session it did not create; the approval raised inside the
 * workflow is visible and answerable over HTTP; SSE carries the delivery
 * log; and a second *process* -- new server, new engine, new client, same
 * database -- continues the same conversation over HTTP after the first
 * has died with a submission parked.
 */

const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(
        () =>
          new Uint8Array(
            NodeCrypto.createHash(algorithm.toLowerCase().replace("-", ""))
              .update(data)
              .digest()
          )
      )
  })
)

const engineFor = (file: string) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      SingleRunner.layer({
        runnerStorage: "sql",
        shardingConfig: {
          shardLockExpiration: Duration.seconds(1),
          shardLockRefreshInterval: Duration.millis(200)
        }
      }).pipe(
        Layer.provide(SqliteClient.layer({ filename: file })),
        Layer.provide(CryptoLayer)
      )
    )
  )

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "agent-http-durable-")),
      "agent.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Best effort: the database may still be held open.
      }
    })
)

const Wipe = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

const headers = { authorization: "Bearer test" } as const
const requestId = (value: string) => AgentProtocol.RequestId.make(value)
const sessionId = AgentProtocol.SessionId.make("customer-123")

/**
 * One process: an HTTP server over a durable client over its own engine,
 * all on the shared database. Built into the enclosing scope, so closing
 * that scope is the process dying.
 */
const process_ = (
  file: string,
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>
) =>
  Effect.gen(function* () {
    const sql = yield* Layer.build(SqliteClient.layer({ filename: file }))
    const stores = yield* Effect.all({
      store: DurableChannels.sqlStoreWithTable(),
      sessionStore: DurableSessionStore.sqlStoreWithTables(),
      delivery: DeliveryLog.sqlLogWithTable({ pollInterval: Duration.millis(30) })
    }).pipe(Effect.provide(sql))
    const { layer: model, recorder } = yield* FakeModel.script(turns)

    const clientRuntime = yield* Layer.build(
      DurableAgentClient.layer("HttpDurable", agent, {
        ...stores,
        pollInterval: Duration.millis(50)
      }).pipe(Layer.provideMerge(engineFor(file)), Layer.provideMerge(model))
    )
    const client = Layer.succeedContext(clientRuntime)

    const routes = AgentHttp.serverLayer({ host: Host }).pipe(
      Layer.provide(bearerHost(Host, { maxSessions: 8, maxRequestsPerSession: 64 })),
      Layer.provide(client)
    )

    const server = HttpRouter.serve(routes, {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provideMerge(
        // Preemptive shutdown is off: with a request in flight at close,
        // NodeHttpServer's timed close interrupts the fibre closing the scope
        // (an upstream quirk), which here would be the test itself.
        NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
      )
    )
    const runtime = yield* Layer.build(server)
    const address = HttpServer.formatAddress(
      (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(runtime))).address
    )
    const api = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl: address })
    return { ...stores, recorder, api }
  })

const until = <A, E>(
  observation: Effect.Effect<A, E>,
  predicate: (value: A) => boolean
): Effect.Effect<A, E> =>
  Effect.repeat(observation, {
    until: predicate,
    schedule: Schedule.spaced(Duration.millis(50))
  })

describe("durable client behind the HTTP transport, on SQLite", () => {
  it.live(
    "an approval raised in one process is answered over HTTP from another, and the conversation continues",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const wiped = yield* Ref.make(0)
        const agent = Agent.make({
          instructions: "Ask before wiping.",
          toolkit: Agent.toolkit([Wipe], {
            wipe: () => Ref.update(wiped, (n) => n + 1).pipe(Effect.as("wiped"))
          }),
          loop: AgentLoop.bounded(4)
        })

        // ---- Process A: create, prompt, reach the approval, die -----------
        const firstEvents = yield* Effect.gen(function* () {
          const a = yield* process_(file, agent, [
            { toolCalls: [{ id: "w1", name: "wipe", params: {} }] }
          ])
          const created = yield* a.api.sessions.createSession({
            headers,
            payload: { requestId: requestId("create"), sessionId }
          })
          assert.strictEqual(created.session.status, "idle")

          // Live SSE from the delivery log, subscribed before the prompt.
          const events = yield* a.api.sessions.events({
            params: { id: sessionId },
            headers
          })
          const seen = yield* Ref.make<Array<string>>([])
          const observer = yield* Effect.forkChild(
            Stream.runForEach(events, (envelope) =>
              Ref.update(seen, (all) => [...all, envelope.event._tag])
            )
          )

          // The prompt request itself will die with this process; the
          // durable submission will not.
          // The request dies with this process (its handler is interrupted at
          // shutdown and the client sees a 503); the durable submission
          // does not.
          yield* Effect.forkDetach(
            Effect.ignore(
              a.api.sessions.prompt({
                params: { id: sessionId },
                headers,
                payload: { requestId: requestId("prompt-1"), input: Prompt.make("wipe it") }
              })
            )
          )

          const pending = yield* until(
            Effect.map(
              a.api.sessions.pending({ params: { id: sessionId }, headers }),
              (response) => response.requests
            ),
            (requests) => requests.length > 0
          )
          assert.strictEqual(pending[0]!.kind, "tool-approval")
          assert.strictEqual(
            (yield* a.api.sessions.status({ params: { id: sessionId }, headers })).status,
            "running"
          )
          // Let the suspension reach the journal before the process dies.
          yield* Effect.sleep(Duration.millis(500))
          yield* Fiber.interrupt(observer)
          return yield* Ref.get(seen)
        }).pipe(Effect.scoped)

        // SSE carried the delivery log live, from a subscription opened
        // before the prompt: the lifecycle up to the question, and no end.
        assert.deepStrictEqual(firstEvents.slice(0, 3), [
          "SubmissionStarted",
          "RunStarted",
          "TurnStarted"
        ])
        assert.include(firstEvents, "ElicitationRequested")
        assert.notInclude(firstEvents, "SubmissionCompleted")

        yield* Effect.sleep(Duration.seconds(2))

        // ---- Process B: a new server, engine and client; same database ----
        yield* Effect.gen(function* () {
          const b = yield* process_(file, agent, [
            { text: "wiped, as asked" },
            { text: "and the other one" }
          ])
          // Never created here: the host adopts it from the durable client.
          const found = yield* b.api.sessions.getSession({
            params: { id: sessionId },
            headers
          })
          assert.strictEqual(found.status, "running")
          const pending = yield* b.api.sessions.pending({
            params: { id: sessionId },
            headers
          })
          assert.strictEqual(pending.requests.length, 1)

          const answered = yield* b.api.sessions.respond({
            params: { id: sessionId },
            headers,
            payload: {
              requestId: requestId("respond-1"),
              response: { id: pending.requests[0]!.id, granted: true }
            }
          })
          assert.isTrue(answered.matched)

          assert.strictEqual(
            yield* until(
              Effect.map(
                b.api.sessions.status({ params: { id: sessionId }, headers }),
                (response) => response.status
              ),
              (status) => status === "idle"
            ),
            "idle"
          )
          assert.strictEqual(yield* Ref.get(wiped), 1)
          const history = yield* b.api.sessions.history({
            params: { id: sessionId },
            headers
          })
          assert.deepStrictEqual(
            history.history.content.map((message) => message.role),
            ["system", "user", "assistant", "tool", "assistant"]
          )

          // The same logical session continues over HTTP from process B.
          const next = yield* b.api.sessions.prompt({
            params: { id: sessionId },
            headers,
            payload: { requestId: requestId("prompt-2"), input: Prompt.make("now the other") }
          })
          assert.strictEqual(next.result.text, "and the other one")
          assert.strictEqual(next.result.status, "completed")
          assert.deepStrictEqual(
            TestLanguageModel.userTexts(
              (yield* b.api.sessions.history({ params: { id: sessionId }, headers })).history
            ),
            ["wipe it", "now the other"]
          )
          // Only turn 2 and the second prompt ran here; turn 1 was replayed.
          assert.strictEqual(yield* b.recorder.calls, 2)

          // Delivery survived the process boundary: one offset space, no
          // duplicate or spurious terminal events.
          const log = yield* b.delivery.read(sessionId)
          assert.deepStrictEqual(log.map((e) => e.sequence), log.map((_, i) => i + 1))
          const tags = log.map((e) => e.event._tag)
          assert.strictEqual(tags.filter((t) => t === "SubmissionCompleted").length, 2)
          assert.strictEqual(tags.filter((t) => t === "ToolCallSucceeded").length, 1)
          assert.notInclude(tags, "SubmissionInterrupted")
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    40_000
  )

  it.live(
    "a node tailing events over SSE sees a submission another node runs, live",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const id = AgentProtocol.SessionId.make("cross-node")
        const agent = Agent.make({ loop: AgentLoop.bounded(2) })

        yield* Effect.gen(function* () {
          // Two nodes: separate runtimes and separate SQL delivery logs over
          // one database, as two processes behind a load balancer.
          const a = yield* process_(file, agent, [TestLanguageModel.text("done")])
          const b = yield* process_(file, agent, [])
          yield* a.api.sessions.createSession({
            headers,
            payload: { requestId: requestId("create"), sessionId: id }
          })

          // Node B tails the session over SSE *before* node A prompts, and
          // its delivery log has never seen the session. Its live stream is
          // the SQL log's cross-process tail, not a same-process PubSub.
          const events = yield* b.api.sessions.events({ params: { id }, headers })
          const observed = yield* Effect.forkChild(
            Stream.runCollect(
              events.pipe(Stream.takeUntil((e) => e.event._tag === "SubmissionCompleted"))
            )
          )
          yield* Effect.sleep(Duration.millis(150))

          const result = yield* a.api.sessions.prompt({
            params: { id },
            headers,
            payload: { requestId: requestId("prompt"), input: Prompt.make("go") }
          })
          assert.strictEqual(result.result.text, "done")

          const seen = yield* Fiber.join(observed)
          const tags = seen.map((e) => e.event._tag)
          assert.strictEqual(tags[0], "SubmissionStarted")
          assert.strictEqual(tags[tags.length - 1], "SubmissionCompleted")
          assert.isTrue(seen.every((e) => e.sessionId === id))
          // Contiguous offsets, from a node that ran none of the work.
          assert.deepStrictEqual(seen.map((e) => e.sequence), seen.map((_, i) => i + 1))
        }).pipe(Effect.scoped)
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    40_000
  )
})
