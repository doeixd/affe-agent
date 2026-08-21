import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Duration, Effect, Exit, Layer, Option, Ref, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { DurableDeferred } from "effect/unstable/workflow"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

/**
 * WORKFLOW_CLUSTER_PLAN Phases 1–3.
 *
 * The claim under test is the plan's central one: the *same* agent definition
 * runs durably, and a resumed submission replays completed model and tool calls
 * instead of repeating them.
 */

const Gate = DurableDeferred.make("DurableTestGate", { success: Schema.String })
const Gate2 = DurableDeferred.make("DurableTestGate2", { success: Schema.String })
const Gate3 = DurableDeferred.make("DurableTestGate3", { success: Schema.String })
const Gate4 = DurableDeferred.make("DurableTestGate4", { success: Schema.String })

const Refund = Tool.make("refund", {
  parameters: Schema.Struct({ amount: Schema.String }),
  success: Schema.String
})
const RefundToolkit = Toolkit.make(Refund)

describe("durable submissions", () => {
  it.live("a submission runs durably with no change to the agent", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore

      // The very same value an embedded session would take.
      const Researcher = Agent.make({ instructions: "Be brief." })

      const durable = DurableAgent.workflow("Researcher", Researcher, { store })

      const text = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s1", "hello")
        const result = yield* DurableAgent.result(durable, executionId)
        return result
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      assert.isTrue(Exit.isSuccess(text))
    })
  )

  it.live("a resumed submission does not repeat a completed tool call", () =>
    Effect.gen(function* () {
      // The scenario the plan names: a refund must not go out twice.
      const refunds = yield* Ref.make<Array<string>>([])
      const modelCalls = yield* Ref.make(0)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()

      const refundToolkit = yield* RefundToolkit.pipe(
        Effect.provide(
          RefundToolkit.toLayer({
            refund: ({ amount }) =>
              Ref.update(refunds, (all) => [...all, amount]).pipe(
                Effect.as(`refunded ${amount}`)
              )
          })
        )
      )

      // Turn 1 calls the tool; the agent then suspends on a durable gate;
      // turn 2 finishes after resumption.
      const script: Array<FakeModel.Turn> = [
        { toolCalls: [{ id: "r1", name: "refund", params: { amount: "500" } }] },
        { text: "settled" }
      ]

      const { layer: baseModel } = yield* FakeModel.layer(script)
      const countingModel = Layer.effect(
        LanguageModel.LanguageModel,
        Effect.gen(function* () {
          const inner = yield* LanguageModel.LanguageModel
          return {
            ...inner,
            generateText: ((options: any) =>
              Ref.update(modelCalls, (n) => n + 1).pipe(
                Effect.andThen(inner.generateText(options))
              )) as LanguageModel.Service["generateText"]
          }
        })
      ).pipe(Layer.provide(baseModel))

      const store = yield* DurableChannels.memoryStore

      // A context transform is a convenient place to suspend mid-submission:
      // it runs inside the workflow, before turn 2's model call.
      const suspendOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
            const shouldSuspend = yield* Ref.getAndSet(suspendOnce, false)
            if (shouldSuspend) {
              const token = yield* DurableDeferred.token(Gate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(Gate)
            }
          return context.canonicalPrompt
        })
      )

      const Support = Agent.make({
        toolkit: refundToolkit,
        contextTransform: gating
      })

      const durable = DurableAgent.workflow("Support", Support, {
        store,
        toolkit: refundToolkit
      })

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s2", "refund")

        // Wait for the suspension, then wake it as an external actor would.
        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(Gate, { token, value: "go" })

        yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(countingModel)
          )
        )
      )

      // The decisive assertions: the refund happened once, and turn 1's model
      // call was replayed rather than re-issued.
      assert.deepStrictEqual(yield* Ref.get(refunds), ["500"])
      assert.strictEqual(
        yield* Ref.get(modelCalls),
        2,
        "each model call should execute once across the resumption"
      )
    })
  )

  it.live("steering survives a suspension and is applied exactly once", () =>
    Effect.gen(function* () {
      // Phase 3: the drain must be replay-stable. If it were not, the resumed
      // turn would derive a prompt without the steer — or apply it twice.
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const store = yield* DurableChannels.memoryStore

      const { layer: modelLayer, recorder } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])

      const suspendOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
            const shouldSuspend = yield* Ref.getAndSet(suspendOnce, false)
            if (shouldSuspend) {
              const token = yield* DurableDeferred.token(Gate2)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(Gate2)
            }
          return context.canonicalPrompt
        })
      )

      const Looping = Agent.make({
        contextTransform: gating,
        loop: AgentLoop.make((state) =>
          Effect.succeed(
            state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
          )
        )
      })

      const durable = DurableAgent.workflow("Steered", Looping, { store })

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s3", "go")

        const token = yield* Deferred.await(gateReady)
        // Queued while the submission is suspended — the realistic case.
        yield* DurableAgent.steer(store, "s3", "stay on topic")
        yield* DurableDeferred.succeed(Gate2, { token, value: "go" })

        yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      const prompts = yield* recorder.prompts
      const steered = prompts.filter((prompt) =>
        FakeModel.userTexts(prompt).includes("stay on topic")
      )
      // Applied, and applied once: it appears from the turn that drained it
      // onward, and is never drained a second time.
      assert.isAtLeast(steered.length, 1)
      const last = prompts[prompts.length - 1]!
      assert.strictEqual(
        FakeModel.userTexts(last).filter((t) => t === "stay on topic").length,
        1
      )
    })
  )


  it.live("a suspended submission is not reported as complete", () =>
    Effect.gen(function* () {
      // The regression this guards is subtle and was live for a while.
      // `Workflow.suspend` signals by setting a flag on the WorkflowInstance
      // and interrupting the fiber -- and a session absorbs interruption by
      // design, because a run that is cut short still has to end tidily. So
      // control came back to the workflow body looking like an ordinary
      // finish, and the body committed `Success("")`.
      //
      // A submission that is merely waiting would have been terminalised, and
      // nothing downstream could tell the difference: `poll` said Complete,
      // the admission marker was cleared, and resuming it was impossible.
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const store = yield* DurableChannels.memoryStore

      const { layer: modelLayer } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])

      const suspendOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(suspendOnce, false)) {
            const token = yield* DurableDeferred.token(Gate4)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(Gate4)
          }
          return context.canonicalPrompt
        })
      )

      const durable = DurableAgent.workflow(
        "Suspended",
        Agent.make({
          contextTransform: gating,
          loop: AgentLoop.make((state) =>
            Effect.succeed(
              state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
            )
          )
        }),
        { store }
      )

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s5", "go")
        const token = yield* Deferred.await(gateReady)

        // Let the suspension settle so we are observing a parked execution
        // rather than racing the fiber on its way there.
        yield* Effect.sleep(Duration.millis(300))

        const parked = yield* durable.definition.poll(executionId)
        assert.isFalse(
          Option.isSome(parked) && parked.value._tag === "Complete",
          "a suspended submission must not be reported as complete"
        )

        // And it is still open for business: steering a parked submission is
        // the realistic case, so the admission marker must survive suspension.
        yield* DurableAgent.steer(store, "s5", "while parked")

        // Resuming still works, which is what "not terminal" has to mean.
        yield* DurableDeferred.succeed(Gate4, { token, value: "go" })
        const exit = yield* DurableAgent.result(durable, executionId)
        assert.isTrue(Exit.isSuccess(exit))
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )
    })
  )


  it.live("a failed submission crosses as a typed error, not a defect", () =>
    Effect.gen(function* () {
      // Before this, the workflow declared no error schema and the body ended
      // in `orDie`, so every failure -- however carefully typed inside the
      // agent -- reached a caller in another process as an opaque defect.
      class RetrievalUnavailable extends Schema.TaggedError<RetrievalUnavailable>()(
        "RetrievalUnavailable",
        { detail: Schema.String }
      ) {}

      const store = yield* DurableChannels.memoryStore
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "never" }])

      const durable = DurableAgent.workflow(
        "Failing",
        Agent.make({
          contextTransform: ContextTransform.make(() =>
            Effect.fail(new RetrievalUnavailable({ detail: "index offline" }))
          )
        }),
        { store }
      )

      const exit = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s6", "go")
        return yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      // A *completed* workflow whose exit is a failure -- not a defect, and
      // not a crash of the polling caller.
      assert.isTrue(Exit.isFailure(exit))
      // `findErrorOption` returns none for a defect, so this assertion fails
      // outright if the failure ever regresses to being died on.
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined
      assert.isDefined(failure)
      // The originating tag survived the journal, which is the whole point:
      // a caller in another process can branch on *which* thing went wrong.
      assert.strictEqual(failure!.tag, "RetrievalUnavailable")
      assert.isFalse(failure!.isDefect)
      assert.include(failure!.detail, "index offline")
    })
  )


  it.live("a provider failure survives the journal with its detail intact", () =>
    Effect.gen(function* () {
      // The model call is an activity, and an activity with no declared error
      // schema cannot encode a failure -- the engine records an unencodable
      // SchemaError in its place, destroying the provider error on the way
      // out. DurableModel carries the outcome as a *value* to avoid that; this
      // asserts the detail actually arrives at a caller.
      const store = yield* DurableChannels.memoryStore
      const { layer: modelLayer } = yield* FakeModel.layer([
        { fail: "provider returned 503" }
      ])

      const durable = DurableAgent.workflow("Provider", Agent.make({}), { store })

      const exit = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s7", "go")
        return yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      assert.isTrue(Exit.isFailure(exit))
      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined
      assert.isDefined(failure)
      // Not a bare "something died": the provider's own message is still here.
      assert.include(failure!.detail, "provider returned 503")
    })
  )


  it.live("a follow-up accepted at quiescence is not silently dropped", () =>
    Effect.gen(function* () {
      // Core promises that an accepted follow-up is processed. `AgentSubmission`
      // drains, closes `acceptingFollowUps` atomically, then drains **once
      // more** so nothing accepted before the close is stranded.
      //
      // The durable path does not consult that gate -- it cannot, because
      // `followUp` is called from outside the process. It consults a marker in
      // the store instead, and that marker is cleared only when the workflow
      // exits, well after the submission's closing drain. Anything accepted in
      // between is written to a queue nobody will read again.
      //
      // For a single-turn submission with no follow-ups, core drains the
      // follow-up channel exactly twice: once at the top of the loop, once
      // after closing the gate. Offering immediately after the second drain
      // lands in the window exactly.
      const inner = yield* DurableChannels.memoryStore
      const drains = yield* Ref.make(0)
      const accepted = yield* Ref.make(false)

      const followUpsKey = "late-1:followUps"
      const store: DurableChannels.Store = {
        offer: inner.offer,
        size: inner.size,
        takeAll: (key) =>
          key !== followUpsKey
            ? inner.takeAll(key)
            : inner.takeAll(key).pipe(
                Effect.tap(() =>
                  Effect.flatMap(
                    Ref.updateAndGet(drains, (n) => n + 1),
                    (n) =>
                      n === 2
                        ? DurableAgent.followUp(
                            store,
                            "late-1",
                            "one more"
                          ).pipe(
                            Effect.andThen(Ref.set(accepted, true)),
                            // If the durable gate matched core's, this is where
                            // it would refuse -- which is a fine outcome too.
                            Effect.catchTag("AgentIdleError", () => Effect.void)
                          )
                        : Effect.void
                  )
                )
              )
      }

      // A third turn: processing the late follow-up is another run.
      const { layer: modelLayer, recorder } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" },
        { text: "third" }
      ])
      const durable = DurableAgent.workflow("Late", Agent.make({}), { store })

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(
          durable,
          store,
          "late-1",
          "go"
        )
        return yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      // Either answer is defensible on its own: refusing the follow-up is
      // honest, and accepting it obliges the run to process it. Accepting it
      // and dropping it is the one outcome that is not.
      if (yield* Ref.get(accepted)) {
        const prompts = yield* recorder.prompts
        assert.isTrue(
          prompts.some((prompt) =>
            FakeModel.userTexts(prompt).includes("one more")
          ),
          "followUp reported success but the input was never processed"
        )
      }

      // And nothing accepted may be left sitting in the queue.
      assert.deepStrictEqual(yield* inner.takeAll(followUpsKey), [])
    })
  )

  it.live("an interrupted submission reaches a terminal state and stays there", () =>
    Effect.gen(function* () {
      // Phase 4: interruption under durability must be terminal — an
      // interrupted submission must never later complete.
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const store = yield* DurableChannels.memoryStore
      const { layer: modelLayer } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])

      const suspendOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
            if (yield* Ref.getAndSet(suspendOnce, false)) {
              const token = yield* DurableDeferred.token(Gate3)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(Gate3)
            }
          return context.canonicalPrompt
        })
      )

      const Suspending = Agent.make({ contextTransform: gating })
      const durable = DurableAgent.workflow("Interrupted", Suspending, { store })

      const outcome = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s4", "go")
        yield* Deferred.await(gateReady)

        yield* durable.definition.interrupt(executionId)

        // Waking the gate after interruption must not revive the submission.
        yield* DurableDeferred.succeed(Gate3, {
          token: yield* Deferred.await(gateReady),
          value: "too late"
        }).pipe(Effect.ignore)

        return yield* durable.definition.poll(executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      // Interrupted is terminal: it is not Complete, and completing the gate
      // afterwards does not make it so.
      assert.isFalse(
        Option.isSome(outcome) &&
          outcome.value._tag === "Complete" &&
          Exit.isSuccess(outcome.value.exit),
        "an interrupted submission must not complete successfully"
      )
    })
  )
})
