import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Whether a tool gets to clean up when the run above it goes away.
 *
 * `test/Sandbox.test.ts` proves the sandbox itself is well behaved: interrupt
 * the `exec` and the child process dies rather than running on unowned. That
 * is a fact about the sandbox, and it is worth nothing if the interruption
 * never reaches it.
 *
 * A tool holding a process, a workspace, a lock or a connection releases it in
 * a finalizer. Under durability that path now goes somewhere it did not
 * before: 48a converts an interrupted non-retry-safe handler into a
 * *journalled value* rather than re-raising, precisely so the handler is not
 * reissued. If catching the interruption also swallowed it, every durable tool
 * would leak whatever it was holding -- and nothing would say so, because the
 * submission still settles and the text still reads correctly.
 *
 * So the interrupt is delivered to a handler that records its own cleanup,
 * which is what a sandbox's process kill is an instance of.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const Hold = Tool.make("hold", { parameters: Schema.Struct({}), success: Schema.String })

/** A tool that acquires something, blocks, and records whether it let go. */
const holding = (options: {
  readonly entered: Deferred.Deferred<void>
  readonly released: Ref.Ref<number>
  readonly held: Deferred.Deferred<void>
}) =>
  Agent.tool(Hold, () =>
    Effect.acquireUseRelease(
      Deferred.succeed(options.entered, undefined),
      () => Effect.as(Deferred.await(options.held), "let go"),
      () => Ref.update(options.released, (n) => n + 1)
    ))

describe("a tool's cleanup when the run goes away", () => {
  it.live("an interrupted in-process run releases what its tool was holding", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const released = yield* Ref.make(0)

      const agent = Agent.make({
        instructions: "Hold it.",
        tools: [holding({ entered, released, held })],
        loop: AgentLoop.bounded(3)
      })
      const { layer: model } = yield* FakeModel.script([
        { toolCalls: [{ id: "h1", name: "hold", params: {} }] },
        { text: "done" }
      ])

      yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const running = yield* Effect.forkChild(Effect.exit(session.prompt("go")))
            yield* Deferred.await(entered)
            yield* session.interrupt()
            yield* Fiber.join(running)
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))

      assert.strictEqual(
        yield* Ref.get(released),
        1,
        "the tool never got to release what it was holding: a sandbox process, a workspace or a lock would have leaked"
      )
    }),
    20_000
  )

  it.live("and so does an interrupted durable run, which 48a could have broken", () =>
    Effect.gen(function* () {
      /**
       * The one worth writing.
       *
       * 48a made an interrupted non-retry-safe handler journal `Unresolved`
       * as a *success* of the activity, so that upstream's schedule does not
       * reissue it. That happens in a `catchCause` on the handler's outcome --
       * *after* the handler has unwound -- so the finalizer should already
       * have run. "Should" is the word this test exists to remove: if the
       * catch had been placed anywhere earlier, every durable tool would
       * quietly leak whatever it held, and the submission would still settle
       * and still read correctly.
       */
      const entered = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const released = yield* Ref.make(0)

      const agent = Agent.make({
        instructions: "Hold it.",
        tools: [holding({ entered, released, held })],
        loop: AgentLoop.bounded(3)
      })
      const { layer: model } = yield* FakeModel.script([
        { toolCalls: [{ id: "h1", name: "hold", params: {} }] },
        { text: "done" }
      ])

      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const runtime = DurableAgentClient.layer("ToolCleanup", agent, {
        store,
        sessionStore,
        delivery
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

      yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "tool-cleanup" })
            const running = yield* Effect.forkChild(Effect.exit(session.prompt("go")))
            yield* Deferred.await(entered)
            yield* session.interrupt()
            yield* Fiber.join(running)
          })
        )
      }).pipe(Effect.provide(runtime))

      assert.strictEqual(
        yield* Ref.get(released),
        1,
        "a durable tool did not release what it was holding when the run was interrupted"
      )
    }),
    30_000
  )
})

describe("what a delegation does with the child's services", () => {
  /**
   * A sandbox, a workspace, a browser, a database pool: whatever
   * `Subagent.Options.provide` builds, something has to take it down.
   *
   * `tool` and `toolScoped` differ here on purpose and the difference is the
   * documented reason `toolScoped` exists -- "the child's services live as
   * long as the scope, not as long as a call". That is a claim about
   * lifetimes, which is a claim about *release*, and release is the half
   * nobody tests because nothing goes wrong loudly when it does not happen.
   * A workspace that is never released is a directory that stays; a pool that
   * is never released is a connection that stays.
   */
  const countingLayer = (built: Ref.Ref<number>, released: Ref.Ref<number>) =>
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.acquireRelease(
        Effect.flatMap(Ref.update(built, (n) => n + 1), () => LanguageModel.LanguageModel),
        () => Ref.update(released, (n) => n + 1)
      )
    )

  /**
   * Written out at each call site rather than shared.
   *
   * A helper taking the delegation tool needs to name its type, and naming it
   * means writing `any` through an invariant parameter, which erases the
   * agent's requirements and lands as `unknown` in the test's own context.
   * Two copies of four lines cost less than a signature that lies.
   */
  const parentScript = [
    { toolCalls: [{ id: "r1", name: "research", params: { prompt: "one" } }] },
    { toolCalls: [{ id: "r2", name: "research", params: { prompt: "two" } }] },
    { text: "done" }
  ] as const

  it.live("`tool` builds and releases the child's services once per delegation", () =>
    Effect.gen(function* () {
      const built = yield* Ref.make(0)
      const released = yield* Ref.make(0)
      const childModel = yield* FakeModel.layer([{ text: "child" }, { text: "child" }])
      const child = Agent.make({ instructions: "child", loop: AgentLoop.bounded(2) })

      const research = Subagent.tool("research", child, {
        description: "Delegate.",
        provide: countingLayer(built, released).pipe(Layer.provide(childModel.layer))
      })

      const { layer: parentModel } = yield* FakeModel.script([...parentScript])
      const result = yield* Agent.run(
        Agent.make({ instructions: "Delegate twice.", tools: [research], loop: AgentLoop.bounded(5) }),
        "go"
      ).pipe(Effect.scoped, Effect.provide(parentModel))
      assert.strictEqual(result.text, "done")

      // Two delegations, two builds -- and, the half that matters, two
      // releases. A build without a matching release is the leak.
      assert.strictEqual(yield* Ref.get(built), 2, "the child's services were not built per call")
      assert.strictEqual(
        yield* Ref.get(released),
        2,
        "the child's services were built per call and never released: whatever they held is still held"
      )
    }),
    30_000
  )

  it.live("`toolScoped` builds once and holds it for the scope, then lets go", () =>
    Effect.gen(function* () {
      const built = yield* Ref.make(0)
      const released = yield* Ref.make(0)
      const childModel = yield* FakeModel.layer([{ text: "child" }, { text: "child" }])
      const child = Agent.make({ instructions: "child", loop: AgentLoop.bounded(2) })

      const insideScope = yield* Effect.scoped(
        Effect.gen(function* () {
          const research = yield* Subagent.toolScoped("research", child, {
            description: "Delegate.",
            provide: countingLayer(built, released).pipe(Layer.provide(childModel.layer))
          })
          const { layer: parentModel } = yield* FakeModel.script([...parentScript])
          yield* Agent.run(
            Agent.make({ instructions: "Delegate twice.", tools: [research], loop: AgentLoop.bounded(5) }),
            "go"
          ).pipe(Effect.scoped, Effect.provide(parentModel))
          // One build for two delegations, and still held.
          return { built: yield* Ref.get(built), released: yield* Ref.get(released) }
        })
      )

      assert.strictEqual(insideScope.built, 1, "the shared build happened more than once")
      assert.strictEqual(insideScope.released, 0, "the shared services were released mid-scope")
      // And the scope closing is what lets go, which is the whole reason this
      // is a separate function rather than a flag.
      assert.strictEqual(
        yield* Ref.get(released),
        1,
        "the scope closed and the child's services were never released"
      )
    }),
    30_000
  )
})
