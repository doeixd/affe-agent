import { assert, describe, it } from "@effect/vitest"
import {
  Cron,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema
} from "effect"
import { Prompt } from "effect/unstable/ai"
import {
  ClusterWorkflowEngine,
  Entity,
  ShardingConfig,
  TestRunner
} from "effect/unstable/cluster"
import type { Sharding } from "effect/unstable/cluster"
import type { WorkflowEngine } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as ScheduledAgent from "../src/cluster/ScheduledAgent.js"
import type { AgentIdleError } from "../src/Errors.js"
import type { AgentTransportError } from "../src/client/AgentClient.js"
import * as EntityClient from "../src/cluster/EntityClient.js"
import {
  AgentEntity,
  layer as entityLayer
} from "../src/cluster/AgentEntity.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"

/**
 * WORKFLOW_CLUSTER_PLAN Phase 6 — the session as a cluster entity.
 *
 * What is asserted here is the routing contract: the entity exposes the four
 * session operations, and out-of-band input is keyed by the entity id, which is
 * the session id. That is the part of Phase 6 that belongs to this project.
 *
 */
/** Decodes what a store holds back into plain text, for assertions. */
const textsIn = (store: DurableChannels.Store, key: string) =>
  Effect.map(store.takeAll(key), (encoded) =>
    encoded.flatMap((json) =>
      FakeModel.userTexts(
        Schema.decodeUnknownSync(Prompt.Prompt)(JSON.parse(json))
      )
    )
  )

describe("agent entity", () => {
  it("exposes the session operations as entity RPCs", () => {
    // The surface a remote client sees, and the reason no core change was
    // needed: these map one-to-one onto AgentSession's module functions.
    assert.deepStrictEqual(
      // Reaching into Effect's RpcGroup internals deliberately: there is no
      // public way to enumerate an entity's operations, and the surface a
      // remote client sees is worth pinning.
      Array.from(AgentEntity.protocol.requests.keys()).sort(),
      ["followUp", "interrupt", "respond", "steer", "submit"]
    )
    assert.strictEqual(AgentEntity.type, "AgentSession")
  })

  it.effect("out-of-band input is keyed by session id", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Keyed", Agent.make({}), { store })
      void durable

      // What the entity handlers do with `address.entityId`: a steer for one
      // session is invisible to another, which is what makes the entity the
      // right home for routing.
      // Keying is what this test is about, so write through the channel
      // directly rather than the admission-checked convenience functions.
      yield* DurableChannels.offer(store, "session-a", "steering", "for a")
      yield* DurableChannels.offer(store, "session-b", "followUps", "for b")

      // The store holds encoded prompts, so compare their text rather than
      // their wire form.
      assert.deepStrictEqual(
        yield* textsIn(store, "session-a:steering"),
        ["for a"]
      )
      assert.deepStrictEqual(
        yield* textsIn(store, "session-b:followUps"),
        ["for b"]
      )
      assert.deepStrictEqual(yield* textsIn(store, "session-b:steering"), [])
    })
  )

  it.live("submits and steers through a sharded entity client", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Sharded", Agent.make({}), { store })

      const runtime = durable.layer.pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer),
        Layer.provideMerge(modelLayer)
      )
      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(runtime)
      )

      // A client reaches the session by id; sharding routes it to the owner.
      const makeClient = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = yield* makeClient("session-alpha")

      const executionId = yield* client.submit({ input: Prompt.make("hello") })
      assert.isString(executionId)

      yield* client.steer({ input: Prompt.make("stay on topic") })
      yield* client.followUp({ input: Prompt.make("and then this") })

      // Routed input landed under this session's keys.
      assert.deepStrictEqual(
        yield* textsIn(store, "session-alpha:followUps"),
        ["and then this"]
      )

      // And the submission the entity started actually runs to completion.
      const result = yield* Effect.retry(
        Effect.flatMap(durable.definition.poll(executionId), (polled) =>
          Option.isSome(polled) && polled.value._tag === "Complete"
            ? Effect.succeed(polled.value)
            : Effect.fail("pending" as const)
        ),
        { times: 400, schedule: Schedule.spaced(Duration.millis(10)) }
      ).pipe(Effect.provide(runtime))

      assert.strictEqual(result._tag, "Complete")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )

  it.effect("derives a session's execution id without dispatching", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Derived", Agent.make({}), { store })

      // The idempotency key is the session, so the prompt cannot affect the id.
      // This is what lets the entity interrupt a submission it never started,
      // and what makes `interrupt` safe to expose with no payload at all.
      const fromSession = yield* DurableAgent.executionIdFor(durable, "s-1")
      const fromPrompt = yield* durable.definition.executionId({
        sessionId: "s-1",
        prompt: Prompt.make("something entirely different")
      })
      assert.strictEqual(fromSession, fromPrompt)

      // ...and it is still per-session, not one id for everything.
      const other = yield* DurableAgent.executionIdFor(durable, "s-2")
      assert.notStrictEqual(fromSession, other)
    })
  )

  it.live("steering an idle session fails as a typed error, not a defect", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Idle", Agent.make({}), { store })

      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(
          durable.layer.pipe(
            Layer.provideMerge(ClusterWorkflowEngine.layer),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      const makeClient = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = yield* makeClient("never-submitted")

      // Nothing was ever submitted for this session, so there is no admission
      // marker. A remote caller must be able to tell that apart from a runner
      // falling over — which is exactly what the declared error buys.
      // `flip` succeeds with the error, so it is typed here without a cast --
      // which is the whole point of declaring it on the RPC.
      const error = yield* Effect.flip(
        client.steer({ input: Prompt.make("too late") })
      )
      assert.strictEqual(error._tag, "AgentIdleError")
      assert.strictEqual(error.operation, "steer")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )
})

describe("agent client", () => {
  it.live("takes RawInput, and normalises it before it reaches the wire", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Wrapped", Agent.make({}), { store })

      const runtime = durable.layer.pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer),
        Layer.provideMerge(modelLayer)
      )
      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(runtime)
      )

      const makeRaw = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = EntityClient.wrap(yield* makeRaw("session-wrapped"))

      // A bare string is what a caller reaches for. On the generated client
      // this compiles and then fails at encode time, because `Prompt.Prompt`'s
      // type-level input is looser than what it will actually encode.
      const executionId = yield* client.submit("hello")
      assert.isString(executionId)

      // Structured input goes through the same door, unchanged.
      yield* client.steer([{ role: "user", content: [{ type: "text", text: "stay on topic" }] }])
      yield* client.followUp("and then this")

      assert.deepStrictEqual(
        yield* textsIn(store, "session-wrapped:steering"),
        ["stay on topic"]
      )
      assert.deepStrictEqual(
        yield* textsIn(store, "session-wrapped:followUps"),
        ["and then this"]
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )

  it.live("keeps the one error a caller can act on, and drops the rest", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("WrappedIdle", Agent.make({}), {
        store
      })

      const handlers = entityLayer(durable, store).pipe(
        Layer.provideMerge(
          durable.layer.pipe(
            Layer.provideMerge(ClusterWorkflowEngine.layer),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      const makeRaw = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = EntityClient.wrap(yield* makeRaw("never-submitted"))

      /**
       * R170 -- `steer` fails with the domain answer *or* a transport failure.
       *
       * The transport half used to be `Effect.die` after a bounded retry, on
       * the reasoning that a caller has no recovery for a broken transport.
       * A shard outage, mailbox pressure, a persistence failure and a runner
       * going away are all things an application answers by retrying later,
       * routing elsewhere, or returning a 503 -- and none of those is
       * available to a caller handed a defect.
       *
       * The annotations are the assertion. Narrowing either back to
       * `AgentIdleError` alone, or `submit` back to `never`, stops this
       * compiling.
       */
      const error: AgentIdleError | AgentTransportError = yield* Effect.flip(
        client.steer("too late")
      )
      assert.strictEqual(error._tag, "AgentIdleError")
      if (error._tag === "AgentIdleError") {
        assert.strictEqual(error.operation, "steer")
      }

      const submitting: Effect.Effect<string, AgentTransportError> = client.submit("go")
      void submitting
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )
})

describe("scheduled agent", () => {
  /** True only when `T` is `any`, which is the failure being guarded against. */
  type IsAny<T> = 0 extends 1 & T ? true : false
  type RequirementsOf<L> = L extends Layer.Layer<infer _A, infer _E, infer R>
    ? R
    : never

  it.effect("tracks its requirements instead of erasing them", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Cronned", Agent.make({}), { store })

      const scheduled = ScheduledAgent.layer({
        name: "nightly",
        cron: Cron.make({
          seconds: [0],
          minutes: [0],
          hours: [3],
          days: [],
          months: [],
          weekdays: []
        }),
        agent: durable,
        store,
        input: "summarise the day"
      })

      type R = RequirementsOf<typeof scheduled>

      // The signature used to be written as `WorkflowEngine | any`, which is
      // just `any`: the layer claimed to need nothing in particular and every
      // caller silently lost requirement checking. These two lines are the
      // test -- they stop compiling if that regresses.
      const notAny: IsAny<R> = false
      assert.isFalse(notAny)

      const needsSharding: Sharding.Sharding extends R ? true : false = true
      assert.isTrue(needsSharding)

      const needsEngine: WorkflowEngine.WorkflowEngine extends R ? true : false =
        true
      assert.isTrue(needsEngine)
    })
  )

  it.effect("a reused session id would suppress every later firing", () =>
    Effect.gen(function* () {
      // Why `sessionId` defaults to one derived from the firing time. A
      // submission's idempotency key is its session, so a scheduled agent that
      // reuses one session runs once and then does nothing forever, while
      // looking perfectly healthy.
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Repeat", Agent.make({}), { store })

      const first = yield* DurableAgent.executionIdFor(durable, "fixed")
      const second = yield* DurableAgent.executionIdFor(durable, "fixed")
      assert.strictEqual(first, second, "the same session is the same execution")

      const varying = yield* DurableAgent.executionIdFor(durable, "fixed-2")
      assert.notStrictEqual(varying, first)
    })
  )
})

describe("approval across the cluster", () => {
  it("the entity can answer a paused run", () => {
    // The cluster is the deployment where a durable pause matters most -- a
    // submission suspended for approval outlives the node that asked -- and
    // the entity had no way to answer one. It could suspend a run and never
    // resume it.
    //
    // Only the surface is asserted here. Completing a `DurableDeferred`
    // routes through sharding, and `Entity.makeTestClient` supplies a stub
    // that cannot: the call fails inside Effect's own engine rather than in
    // this project. What the handler *does* -- derive the execution from the
    // session id and answer it -- is proved end to end against a real engine
    // in `Durable.test.ts`, which is the part that belongs to this project.
    assert.include(
      Array.from(AgentEntity.protocol.requests.keys()),
      "respond"
    )
  })

  /**
   * R172 -- an acknowledged submission is written down before it is
   * acknowledged.
   *
   * The entity hands back an execution id and dispatches on a detached fibre,
   * because dispatch routes back through the runner executing the handler and
   * awaiting it deadlocks. Nothing durable used to record the submission
   * before that reply, so process loss in the window lost it outright and left
   * the admission marker open with no execution behind it.
   *
   * The outbox row is what closes it. This test plants one directly -- which
   * is exactly the state a process that died after replying leaves behind --
   * and asserts the next submit carries it forward rather than ignoring it.
   */
  it.live("a submission recorded but never dispatched is carried forward", () =>
    Effect.gen(function* () {
      const { layer: modelLayer, recorder } = yield* FakeModel.layer([
        { text: "recovered" },
        { text: "and the new one" }
      ])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Recovered", Agent.make({}), { store })
      const runtime = durable.layer.pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer),
        Layer.provideMerge(modelLayer)
      )
      const handlers = entityLayer(durable, store).pipe(Layer.provideMerge(runtime))

      // What a process that replied and then died leaves behind.
      yield* DurableChannels.recordPendingDispatch(
        store,
        "session-lost",
        Prompt.make("the lost submission")
      )
      assert.strictEqual(
        yield* store.size(DurableChannels.dispatchKey("session-lost")),
        1
      )

      const makeClient = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = yield* makeClient("session-lost")
      yield* client.submit({ input: Prompt.make("a later submission") })

      /**
       * The assertion is what the *model* saw, not that the row is gone.
       *
       * The row disappears either way -- the new submission's own success
       * path drains the whole key -- so "no rows left" passes against a build
       * that ignores the leftover entirely. That is the shape of a test that
       * looks like coverage and is not, so what is checked is the thing only
       * the recovery can produce: the lost submission's prompt reaching a run.
       *
       * The entity derives one execution id per session, so the recovered
       * dispatch and the new one resolve to a single execution -- the earlier
       * accepted submission is the one that runs, which is the behaviour a
       * caller already told "this started" is owed.
       */
      yield* Effect.retry(
        Effect.flatMap(recorder.prompts, (seen) =>
          seen.some((prompt) => FakeModel.userTexts(prompt).includes("the lost submission"))
            ? Effect.void
            : Effect.fail("not yet dispatched" as const)),
        { times: 200, schedule: Schedule.spaced(Duration.millis(10)) }
      ).pipe(Effect.provide(runtime))
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )

  /**
   * R172's trigger -- recovery is no longer tied to submitting again.
   *
   * The outbox row above is only useful if something looks at it, and for a
   * while the only thing that did was the next `submit` to that session. A
   * caller whose submission was lost to process death and who then *steered*
   * -- or interrupted, or answered an elicitation -- was talking to a live
   * session with its work sitting in an outbox nobody read.
   *
   * Every entity handler carries it forward now. They share the exclusion
   * that made this safe in the first place: an entity's handlers for one
   * session are serialised by its mailbox, and the entity id is the session.
   *
   * `steer` itself is expected to fail here, and the test says so rather than
   * arranging for it to succeed: admission is opened by the recovered
   * submission on a detached fibre, so whether it is open yet is a race. The
   * claim under test is that the drain happened, not that the steer landed.
   */
  it.live("a lost submission is carried forward by a handler that is not submit", () =>
    Effect.gen(function* () {
      const { layer: modelLayer, recorder } = yield* FakeModel.layer([
        { text: "recovered" }
      ])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("RecoveredBySteer", Agent.make({}), { store })
      const runtime = durable.layer.pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer),
        Layer.provideMerge(modelLayer)
      )
      const handlers = entityLayer(durable, store).pipe(Layer.provideMerge(runtime))

      yield* DurableChannels.recordPendingDispatch(
        store,
        "session-steered",
        Prompt.make("the lost submission")
      )

      const makeClient = yield* Entity.makeTestClient(AgentEntity, handlers)
      const client = yield* makeClient("session-steered")
      // Nobody submits again. The only message this session ever receives is
      // a steer, which is the whole point.
      yield* Effect.exit(client.steer({ input: Prompt.make("some steering") }))

      yield* Effect.retry(
        Effect.flatMap(recorder.prompts, (seen) =>
          seen.some((prompt) => FakeModel.userTexts(prompt).includes("the lost submission"))
            ? Effect.void
            : Effect.fail("not yet dispatched" as const)),
        { times: 200, schedule: Schedule.spaced(Duration.millis(10)) }
      ).pipe(Effect.provide(runtime))
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestRunner.layer, ShardingConfig.layerDefaults)
      )
    )
  )
})
