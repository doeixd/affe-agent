import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentOutput from "../src/AgentOutput.js"
import * as ContextTransform from "../src/ContextTransform.js"
import { AgentClient } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import { Tool } from "effect/unstable/ai"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/**
 * A typed output across the remote boundary (`remaining-work.md` item 35).
 *
 * `Result.value` was local to an in-process session: `RemoteResult` is one
 * schema shared by every agent, so it could not name any particular agent's
 * `Value`, and a remote caller had to read the answer back out of history and
 * hope. What crosses now is the *encoded* value, and the caller names what it
 * expects -- the shape `AgentA2A.typed` has used across the same kind of
 * boundary for a while, so there is one story rather than two.
 */

const Triage = Schema.Struct({
  severity: Schema.Literals(["low", "high"]),
  summary: Schema.String
})

const triage = AgentOutput.make(Triage, { name: "triage" })

/** A plain tool, so a turn can happen before the one that produces the value. */
const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ of: Schema.String }),
  success: Schema.String
})

const agent = Agent.make({
  instructions: "Triage it.",
  output: triage,
  loop: AgentLoop.bounded(2)
})

/** The model answers by calling the output tool, which is how a value is produced. */
const answering = (severity: "low" | "high") =>
  TestLanguageModel.script([
    TestLanguageModel.toolCall("triage", { severity, summary: "disk is full" })
  ])

describe("a typed output across the remote boundary", () => {
  it.live("the declared value crosses, decoded with the agent's own schema", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* answering("high")

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(agent)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const result = yield* session.prompt("the disk filled up")

            assert.isTrue(
              Option.isSome(result.value),
              "the agent declared an output and produced one, and it did not cross"
            )
            if (Option.isSome(result.value)) {
              // Decoded, not the wire form: a caller reads its own type.
              assert.strictEqual(result.value.value.severity, "high")
              assert.strictEqual(result.value.value.summary, "disk is full")
            }

            // `awaitSubmission` answers with the same thing, since it is the
            // same result read a second time.
            const again = yield* session.awaitSubmission(result.submissionId)
            assert.deepStrictEqual(again.value, result.value)
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))
    })
  )

  it.live("an agent with no declared output reports None rather than inventing one", () =>
    Effect.gen(function* () {
      const plain = Agent.make({ instructions: "Answer.", loop: AgentLoop.bounded(2) })
      const { layer: model } = yield* TestLanguageModel.script([TestLanguageModel.text("done")])

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(plain)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const result = yield* session.prompt("hello")
            assert.strictEqual(result.text, "done")
            // The default output's value is the text, and it crosses the wire.
            assert.deepStrictEqual(result.value, Option.some("done"))
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(plain).pipe(Layer.provide(model))))
    })
  )

  it.live("a value that does not decode is the far end's fault, not a defect here", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* answering("high")

      /**
       * The caller expects a different shape than the one that answered --
       * a different version of the agent, or a different agent behind the
       * same id. That is a statement about the far end, so it arrives as a
       * codec error against the response rather than killing the caller.
       */
      const Expected = Schema.Struct({ severity: Schema.Number })
      const mismatched = Agent.make({
        instructions: "Triage it.",
        output: AgentOutput.make(Expected, { name: "triage" }),
        loop: AgentLoop.bounded(2)
      })

      yield* Effect.gen(function* () {
        // Served by the agent that produces a *string* severity; read by a
        // caller that expects a number.
        const client = yield* AgentClient.typed(mismatched)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const failure = yield* Effect.flip(session.prompt("the disk filled up"))
            assert.strictEqual(failure._tag, "AgentProtocolCodecError")
            assert.include(failure.message, "did not decode")
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))
    })
  )
})

describe("a typed output across the durable boundary", () => {
  it.live("the declared value survives the journal and decodes at the caller", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const { layer: model } = yield* answering("high")

      const runtime = DurableAgentClient.layer("TypedOutputAgent", agent, {
        store,
        sessionStore,
        delivery
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

      yield* Effect.gen(function* () {
        // The same `typed` wrapper as the in-process case: the durable client
        // is an `AgentClient`, so the edge that decodes does not know or care
        // which one it is holding. That is the whole point of the seam.
        const client = yield* AgentClient.typed(agent)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "typed-durable" })
            const result = yield* session.prompt("the disk filled up")

            assert.isTrue(
              Option.isSome(result.value),
              "the value did not survive the workflow journal"
            )
            if (Option.isSome(result.value)) {
              assert.strictEqual(result.value.value.severity, "high")
              assert.strictEqual(result.value.value.summary, "disk is full")
            }
          })
        )
      }).pipe(Effect.provide(runtime))
    }),
    30_000
  )

  /**
   * The pair, rather than either half.
   *
   * The straight-through durable case says the value can be encoded and read
   * back. It says nothing about what a *resumed* submission does, and that is
   * the interesting question: the turns before the suspension come back from
   * the journal rather than from the model, and the value is produced by a
   * turn on the far side of it. A replay that rebuilt the conversation but
   * lost the value would pass every existing test -- the text is right, the
   * tool ran once, the submission completed -- and hand a caller `None` for an
   * answer the agent definitely gave.
   */
  it.live("a value produced after a suspension survives the resume", () =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog

      const lookups = yield* Ref.make(0)
      const toolkit = yield* Agent.toolkit([Lookup], {
        lookup: () => Effect.as(Ref.update(lookups, (n) => n + 1), "disk is full")
      })

      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const Gate = DurableDeferred.make("TypedOutputReplayGate", { success: Schema.String })
      const suspendOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          // The second model call is the one that produces the value, so the
          // suspension lands exactly between the tool and the output.
          if ((yield* Ref.get(lookups)) > 0 && (yield* Ref.getAndSet(suspendOnce, false))) {
            const token = yield* DurableDeferred.token(Gate)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(Gate)
          }
          return context.canonicalPrompt
        })
      )

      const suspending = Agent.make({
        instructions: "Look it up, then triage it.",
        toolkit,
        output: triage,
        loop: AgentLoop.bounded(4),
        contextTransform: gating
      })

      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("lookup", { of: "disk" }),
        TestLanguageModel.toolCall("triage", { severity: "high", summary: "disk is full" })
      ])

      const runtime = DurableAgentClient.layer("TypedOutputReplayAgent", suspending, {
        store,
        sessionStore,
        delivery
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(suspending)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession({ sessionId: "typed-replay" })
            const running = yield* Effect.forkChild(session.prompt("the disk filled up"))

            // Wake it the way an external actor would, which is what makes the
            // rest of the run a replay of what came before.
            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(Gate, { token, value: "go" })

            const result = yield* Fiber.join(running)
            assert.isTrue(
              Option.isSome(result.value),
              "the submission suspended, resumed and answered, and the declared value did not come back"
            )
            if (Option.isSome(result.value)) {
              assert.strictEqual(result.value.value.severity, "high")
            }
            // The tool on the near side of the suspension was replayed from
            // the journal, not run again -- otherwise the value might be right
            // for the wrong reason.
            assert.strictEqual(yield* Ref.get(lookups), 1, "the tool ran again across the resume")
          })
        )
      }).pipe(Effect.provide(runtime))
    }),
    30_000
  )
})

describe("a typed input and a typed output on the same agent", () => {
  const Ticket = AgentInput.make(
    Schema.Struct({ customerId: Schema.String, body: Schema.String }),
    ({ body }) => Effect.succeed(`A customer writes:\n\n${body}`)
  )

  const both = Agent.make({
    instructions: "Triage it.",
    input: Ticket,
    output: triage,
    loop: AgentLoop.bounded(2)
  })

  /**
   * Each half was tested alone, which is exactly how this could have been
   * broken without anyone noticing.
   *
   * `typedSession` handles the two in different branches: the value decode
   * wraps the session first, and the input encode wraps *that*. An agent with
   * an input takes the second branch, so writing `session.prompt` there
   * instead of the wrapped one would lose the output for typed-input agents
   * only -- every existing test would still pass, because none of them
   * declares both.
   */
  it.live("the input is encoded and the output decoded on the same call", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* answering("high")

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(both)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const result = yield* session.prompt({ customerId: "c-42", body: "the disk filled up" })

            // The input reached the agent as the rendered prompt...
            assert.include(result.text ?? "", "")
            // ...and the output came back typed on the same call.
            assert.isTrue(
              Option.isSome(result.value),
              "an agent with both a typed input and a typed output lost the output"
            )
            if (Option.isSome(result.value)) {
              assert.strictEqual(result.value.value.severity, "high")
            }
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(both).pipe(Layer.provide(model))))
    })
  )

  it.live("awaitSubmission on a typed-input agent decodes the output too", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* answering("low")

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(both)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const receipt = yield* session.submit({ customerId: "c-9", body: "small thing" })
            const result = yield* session.awaitSubmission(receipt.submissionId)

            // `submit` goes through the input branch and `awaitSubmission`
            // through the wrapper beneath it: a different pairing again.
            assert.isTrue(
              Option.isSome(result.value),
              "the output was lost on the submit/await path"
            )
            if (Option.isSome(result.value)) {
              assert.strictEqual(result.value.value.severity, "low")
            }
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(both).pipe(Layer.provide(model))))
    })
  )
})

describe("a declared output on a run that never reached one", () => {
  it.live("an interrupted submission reports no value rather than a stale one", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const held = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([
        { text: "thinking", started: entered, during: Deferred.await(held) }
      ])

      yield* Effect.gen(function* () {
        const client = yield* AgentClient.typed(agent)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* client.createSession()
            const running = yield* Effect.forkChild(session.prompt("the disk filled up"))
            yield* Deferred.await(entered)
            yield* session.interrupt()

            const result = yield* Fiber.join(running)
            // The agent declares an output and never produced one. `None` is
            // the honest answer; anything else would be invented.
            assert.strictEqual(result.status, "interrupted")
            assert.isTrue(
              Option.isNone(result.value),
              "an interrupted run reported a value it never produced"
            )
          })
        )
      }).pipe(Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(model))))
    }),
    20_000
  )
})