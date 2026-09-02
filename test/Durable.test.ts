import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Deferred, Duration, Effect, Exit, Layer, Option, Ref, Schedule, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { Activity, DurableDeferred } from "effect/unstable/workflow"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as Ids from "../src/internal/ids.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import { Compaction } from "../src/compaction/index.js"
import { ExecutionPlan } from "effect"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableElicitation from "../src/durable/DurableElicitation.js"
import * as FakeModel from "./FakeModel.js"
import { countingModel } from "./helpers.js"

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
const Gate5 = DurableDeferred.make("DurableTestGate5", { success: Schema.String })
const StreamGate = DurableDeferred.make("StreamGate", { success: Schema.String })
const Gate6 = DurableDeferred.make("DurableTestGate6", { success: Schema.String })

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

  /**
   * Typed input through the embedded API (issue #81): `submit` admits the
   * value with the agent's schema, the payload journals it, and the
   * workflow renders -- an Effect-valued renderer as an activity.
   */
  it.live("a typed input is admitted by submit, journalled, and rendered in the workflow", () =>
    Effect.gen(function* () {
      const renders = yield* Ref.make(0)
      const Ticket = AgentInput.make(
        Schema.Struct({ customerId: Schema.String, body: Schema.String }),
        ({ body }) => Ref.update(renders, (n) => n + 1).pipe(Effect.as(`A customer writes:\n\n${body}`))
      )
      const { layer: modelLayer, recorder } = yield* FakeModel.layer([{ text: "handled" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("TypedSupport", Agent.make({ input: Ticket }), { store })
      const layer = durable.layer.pipe(Layer.provideMerge(Engine), Layer.provideMerge(modelLayer))

      const { refused, result } = yield* Effect.gen(function* () {
        const refused = yield* Effect.flip(DurableAgent.submit(durable, store, "typed-bad", AgentInput.typed({ customerId: 1 })))
        const executionId = yield* DurableAgent.submit(
          durable,
          store,
          "typed-1",
          AgentInput.typed({ customerId: "c-42", body: "my order is late" })
        )
        return { refused, result: yield* DurableAgent.result(durable, executionId) }
      }).pipe(Effect.provide(layer))

      assert.strictEqual(refused._tag, "AgentInvalidRequestError")
      assert.isTrue(Exit.isSuccess(result))
      assert.strictEqual(yield* Ref.get(renders), 1)
      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(FakeModel.userTexts(prompts[0]!), ["A customer writes:\n\nmy order is late"])
      assert.notInclude(JSON.stringify(prompts[0]), "c-42")
      // Nothing was opened for the refused value.
      assert.strictEqual(yield* store.size(DurableChannels.openKey("typed-bad")), 0)
    })
  )

  it.live("a second submit on a completed session reopens nothing", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow("Once", Agent.make({}), { store })

      yield* Effect.gen(function* () {
        const first = yield* DurableAgent.submit(durable, store, "once", "hello")
        yield* DurableAgent.result(durable, first)

        // The key is the session: the engine hands back the finished
        // execution. What must not happen is admission reopening for it --
        // steering accepted into channels nothing will ever drain.
        const second = yield* DurableAgent.submit(durable, store, "once", "again")
        assert.strictEqual(second, first)
        assert.strictEqual(
          yield* store.size(DurableChannels.openKey("once")),
          0
        )
        const refused = yield* Effect.flip(
          DurableAgent.steer(store, "once", "late")
        )
        assert.strictEqual(refused._tag, "AgentIdleError")
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

  it.live("a subagent run by a tool does not shift the parent's model journal on replay", () =>
    Effect.gen(function* () {
      // One scripted model shared by parent and child, as a child inheriting
      // the environment's model would. Turn 1: the parent delegates; the tool
      // runs a child session whose model call happens *inside* the tool
      // activity. Then the parent suspends, resumes, and makes turn 2's call.
      // On replay the tool activity returns its journal without running the
      // child, so the child must never have consumed a `model-N` name of the
      // parent's -- or turn 2 is handed the child's recorded answer. It does
      // not: a handler's context is fixed when its toolkit layer is built,
      // before the durable wrapper exists, so the child calls the provider
      // directly and its call is covered by the tool activity's journal.
      const modelCalls = yield* Ref.make(0)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const SubGate = DurableDeferred.make("SubagentGate", { success: Schema.String })
      const Delegate = Tool.make("delegate", {
        parameters: Schema.Struct({ question: Schema.String }),
        success: Schema.String
      })
      const DelegateToolkit = Toolkit.make(Delegate)
      // The handler picks the model up from the context it is *called* in
      // -- the session's, where the durable wrapper is in place -- which is
      // what makes the child's call a nested durable one.
      const delegating = DelegateToolkit.pipe(
        Effect.provide(
          DelegateToolkit.toLayer({
            delegate: ({ question }) =>
              Effect.gen(function* () {
                const ambient = yield* Effect.context<never>()
                const model = Context.getOption(ambient, LanguageModel.LanguageModel)
                if (Option.isNone(model)) {
                  return yield* Effect.die(new Error("no ambient model"))
                }
                return yield* Effect.scoped(
                  Effect.gen(function* () {
                    const child = yield* AgentSession.make(Agent.make({}))
                    return (yield* AgentSession.prompt(child, question)).text
                  })
                ).pipe(
                  Effect.provideService(LanguageModel.LanguageModel, model.value),
                  Effect.orDie
                )
              })
          })
        )
      )
      const { layer: baseModel } = yield* FakeModel.layer([
        { toolCalls: [{ id: "d1", name: "delegate", params: { question: "q" } }] },
        { text: "child answer" },
        { text: "parent answer" }
      ])
      const model = countingModel(baseModel, modelCalls)

      const suspendOnce = yield* Ref.make(true)
      const turns = yield* Ref.make(0)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          // Only the parent's turns count; the child has no transform.
          const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
          if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
            const token = yield* DurableDeferred.token(SubGate)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(SubGate)
          }
          return context.canonicalPrompt
        })
      )
      const store = yield* DurableChannels.memoryStore
      const durable = DurableAgent.workflow(
        "Delegating",
        Agent.make({ toolkit: delegating, contextTransform: gating }),
        { store }
      )

      const exit = yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "sub-1", "ask")
        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(SubGate, { token, value: "go" })
        return yield* DurableAgent.result(durable, id)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )
      assert.isTrue(Exit.isSuccess(exit), JSON.stringify(exit))
      if (Exit.isSuccess(exit)) {
        assert.strictEqual(exit.value, "parent answer")
      }
      // Parent turn 1, child, parent turn 2 -- and nothing re-issued.
      assert.strictEqual(yield* Ref.get(modelCalls), 3)
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
        offerIfOpen: inner.offerIfOpen,
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

        // The recorded intent, not `durable.definition.interrupt`. The
        // engine's own interrupt is mark-and-resume: it forks a replay that
        // knows nothing about why it was restarted, and the replay -- whose
        // `suspendOnce` gate no longer parks it -- ran to completion. That
        // was issue #77's D4 violation.
        yield* DurableAgent.interrupt(store, "s4")

        // Waking the gate after interruption must not revive the submission:
        // the resumed replay finds the intent before it can run.
        yield* DurableDeferred.succeed(Gate3, {
          token: yield* Deferred.await(gateReady),
          value: "too late"
        }).pipe(Effect.ignore)

        // The original assertion polled *here*, at the instant the engine had
        // forked a fibre and recorded no exit, so `poll` returned `None` every
        // single time and the conjunction below could not be false. Waiting
        // for the execution to settle is what makes this test able to fail.
        return yield* Effect.retry(
          Effect.flatMap(durable.definition.poll(executionId), (polled) =>
            Option.isSome(polled) && polled.value._tag === "Complete"
              ? Effect.succeed(polled.value)
              : Effect.fail("pending" as const)
          ),
          { times: 400, schedule: Schedule.spaced(Duration.millis(25)) }
        )
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      // Interrupted is terminal, and it is terminal as an *interruption*:
      // never a success, and carrying the reason rather than an anonymous
      // death. Completing the gate afterwards does not change either.
      assert.isFalse(
        Exit.isSuccess(outcome.exit),
        "an interrupted submission must not complete successfully"
      )
      const failure = Exit.isFailure(outcome.exit)
        ? Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause))
        : undefined
      assert.strictEqual(failure?.tag, "SubmissionInterrupted")
    })
  )

  it.live("a replay resuming a journal whose interrupt intent is recorded stops before it runs", () =>
    Effect.gen(function* () {
      // The cross-process shape of the same guarantee, and the half the
      // poller cannot cover. The intent is recorded while nothing is
      // running -- the submission is parked on a durable await, so its body
      // fibre, and with it the poller, is gone. What observes the intent is
      // the *replay*, at the top of the body, before the model is reached.
      //
      // The parking happens in the `ContextTransform`, ahead of the first
      // model call, so the original run never reaches the provider. A replay
      // that ran to completion would -- and the recorded prompt count is what
      // distinguishes "stopped before running" from "ran and was relabelled",
      // which the outcome tag alone cannot.
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const store = yield* DurableChannels.memoryStore
      const { layer: modelLayer, recorder } = yield* FakeModel.layer([
        { text: "first" }
      ])

      // Parks before the first model call and never again, so the replay is
      // free to run straight through -- the condition under which the
      // violation reproduced.
      const parkOnce = yield* Ref.make(true)
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(parkOnce, false)) {
            yield* Deferred.succeed(gateReady, yield* DurableDeferred.token(Gate5))
            yield* DurableDeferred.await(Gate5)
          }
          return context.canonicalPrompt
        })
      )

      const Parking = Agent.make({ contextTransform: gating })
      // The poller is put out of reach on purpose. It would also catch this
      // intent -- but only by winning a race against a replay that no longer
      // parks, which is the race the violation won. What must hold is that
      // the replay observes the intent *before it runs*, so the one check
      // that can still fire here is the one at the top of the body.
      const durable = DurableAgent.workflow("Replayed", Parking, {
        store,
        interruptPollInterval: Duration.minutes(10)
      })

      const outcome = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "s4b", "go")
        const token = yield* Deferred.await(gateReady)

        // Recorded while the execution is suspended: nothing is polling.
        yield* DurableAgent.interrupt(store, "s4b")

        // Waking it is what starts the replay.
        yield* DurableDeferred.succeed(Gate5, { token, value: "resume" }).pipe(
          Effect.ignore
        )

        return yield* Effect.retry(
          Effect.flatMap(durable.definition.poll(executionId), (polled) =>
            Option.isSome(polled) && polled.value._tag === "Complete"
              ? Effect.succeed(polled.value)
              : Effect.fail("pending" as const)
          ),
          { times: 400, schedule: Schedule.spaced(Duration.millis(25)) }
        )
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(modelLayer)
          )
        )
      )

      assert.isFalse(Exit.isSuccess(outcome.exit))
      const failure = Exit.isFailure(outcome.exit)
        ? Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause))
        : undefined
      assert.strictEqual(failure?.tag, "SubmissionInterrupted")
      // The replay stopped before the model: the provider was never reached,
      // by either the original run or the replay.
      assert.strictEqual((yield* recorder.prompts).length, 0)
    })
  )
})

describe("streaming under durability", () => {
  it.live("a streamed submission commits what a batched one does", () =>
    Effect.gen(function* () {
      // Adding streaming to core made `stream: true` under `/durable`
      // reachable for the first time, and it died: DurableModel had no
      // streamText. It now produces its stream from the response the batch
      // path journals -- one activity per model call, whichever way the caller
      // asked -- so the two paths cannot disagree about the transcript.
      const script = [
        { text: "streamed answer", chunks: ["streamed", " answer"] }
      ]

      const runWith = (stream: boolean) =>
        Effect.gen(function* () {
          const store = yield* DurableChannels.memoryStore
          const { layer: model } = yield* FakeModel.layer(script)
          const durable = DurableAgent.workflow(
            `Streamed-${stream}`,
            Agent.make({}),
            { store, stream }
          )

          return yield* Effect.gen(function* () {
            const id = yield* DurableAgent.submit(
              durable,
              store,
              `s-${stream}`,
              "go"
            )
            return yield* DurableAgent.result(durable, id)
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(Engine),
                Layer.provideMerge(model)
              )
            )
          )
        })

      const streamed = yield* runWith(true)
      const batched = yield* runWith(false)

      assert.isTrue(
        Exit.isSuccess(streamed),
        `streamed submission failed: ${JSON.stringify(streamed)}`
      )
      assert.isTrue(Exit.isSuccess(batched))
      if (Exit.isSuccess(streamed) && Exit.isSuccess(batched)) {
        assert.strictEqual(streamed.value, "streamed answer")
        assert.strictEqual(streamed.value, batched.value)
      }
    })
  )

  it.live("a streamed submission still replays rather than re-issuing", () =>
    Effect.gen(function* () {
      // The property that matters more than the deltas: journalling is
      // unchanged by streaming. A resumed run returns the persisted response
      // instead of calling the model again.
      const calls = yield* Ref.make(0)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const suspendOnce = yield* Ref.make(true)

      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(suspendOnce, false)) {
            const token = yield* DurableDeferred.token(StreamGate)
            yield* Deferred.succeed(gateReady, token)
            yield* DurableDeferred.await(StreamGate)
          }
          return context.canonicalPrompt
        })
      )

      const store = yield* DurableChannels.memoryStore
      const { layer: base } = yield* FakeModel.layer([
        { text: "first", chunks: ["fir", "st"] },
        { text: "second" }
      ])
      const model = countingModel(base, calls)

      const durable = DurableAgent.workflow(
        "StreamedResume",
        Agent.make({
          contextTransform: gating,
          loop: AgentLoop.make((state) =>
            Effect.succeed(
              state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
            )
          )
        }),
        { store, stream: true }
      )

      yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "s-resume", "go")
        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(StreamGate, { token, value: "go" })
        yield* DurableAgent.result(durable, id)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      // Two turns, two model calls -- the suspension replayed turn 1's
      // journalled response rather than streaming it again.
      assert.strictEqual(yield* Ref.get(calls), 2)
    })
  )
})

describe("elicitation under durability", () => {
  it.live("a submission suspends for approval and resumes when answered", () =>
    Effect.gen(function* () {
      // The claim the seam exists for. Locally an elicitation parks a fibre in
      // memory, which is the wrong lifetime for an answer that arrives in
      // minutes or days. Under durability it suspends the *workflow*, so the
      // run stops consuming anything and resumes in whatever process is
      // running when the answer comes.
      const ran = yield* Ref.make(0)
      const Dangerous = Tool.make("wipe", {
        parameters: Schema.Struct({}),
        success: Schema.String
      }).setNeedsApproval(true)

      const toolkit = yield* Agent.toolkit([Dangerous], {
        wipe: () => Ref.update(ran, (n) => n + 1).pipe(Effect.as("wiped"))
      })

      const store = yield* DurableChannels.memoryStore
      const { layer: model } = yield* FakeModel.layer([
        { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
        { text: "done" }
      ])

      const durable = DurableAgent.workflow(
        "Approval",
        Agent.make({ toolkit, loop: AgentLoop.bounded(4) }),
        { store }
      )

      yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(
          durable,
          store,
          "approve-1",
          "go"
        )

        // Let it reach the tool and suspend. Nothing is running now: there is
        // no fibre parked, which is the difference from the local elicitor.
        yield* Effect.sleep(Duration.millis(300))
        assert.strictEqual(yield* Ref.get(ran), 0)

        // Answered from outside with nothing but the session id -- the same
        // derivation the cluster entity's `respond` performs, and the reason
        // it needs no extra state. The token comes from the execution rather
        // than from memory, because the process that asked may be gone.
        const derived = yield* DurableAgent.executionIdFor(durable, "approve-1")
        assert.strictEqual(derived, executionId)

        yield* DurableElicitation.respond({
          workflow: durable.definition,
          executionId: derived,
          // One execution per session here, so its one submission is `submission-1`.
          response: { id: Ids.elicitationId("submission-1", 1), granted: true }
        })

        const exit = yield* DurableAgent.result(durable, executionId, {
          interval: Duration.millis(20)
        })
        assert.isTrue(
          Exit.isSuccess(exit),
          `the approved submission did not finish: ${JSON.stringify(exit)}`
        )
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      // Approved, so it actually ran -- once.
      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )
})

describe("compaction under durability", () => {
  it.live("a summarisation can be journalled like any other activity", () =>
    Effect.gen(function* () {
      // Compaction knows nothing about workflows, and does not need to. Its
      // `summarise` is an ordinary Effect, so a durable deployment wraps its
      // own in an `Activity` and the summary is journalled with everything
      // else. Without that, a process loss re-summarises -- which for a real
      // summariser means paying for a model call again.
      //
      // What makes it possible is that the workflow context reaches a
      // `ContextTransform` at all: the transform's requirements flow through
      // the agent to `AgentSession.make`, which the workflow body satisfies.
      // That is the property this pins.
      const summarised = yield* Ref.make(0)

      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: () =>
          Activity.make({
            name: "summarise",
            success: Schema.String,
            execute: Ref.updateAndGet(summarised, (n) => n + 1).pipe(
              Effect.map((n) => `summary ${n}`)
            )
          })
      })

      const store = yield* DurableChannels.memoryStore
      const { layer: model, recorder } = yield* FakeModel.layer(
        Array.from({ length: 8 }, (_, i) => ({ text: `t${i}` }))
      )

      const durable = DurableAgent.workflow(
        "Compacted",
        Agent.make({
          contextTransform: compaction,
          loop: AgentLoop.make((state) =>
            Effect.succeed(
              state.turnIndex < 6 ? AgentLoop.Continue : AgentLoop.Stop
            )
          )
        }),
        { store }
      )

      yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "compact-1", "go")
        const exit = yield* DurableAgent.result(durable, id, {
          interval: Duration.millis(20)
        })
        assert.isTrue(
          Exit.isSuccess(exit),
          `the compacted submission failed: ${JSON.stringify(exit)}`
        )
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      // It ran, and the model saw the compacted projection rather than the
      // whole transcript.
      assert.isAtLeast(yield* Ref.get(summarised), 1)
      const prompts = yield* recorder.prompts
      const last = prompts[prompts.length - 1]!
      assert.isTrue(
        last.content.some((message) => message.role === "system"),
        "the compacted projection never reached the model"
      )
    })
  )

  it.live("a replay returns the journalled summary instead of paying for it again", () =>
    Effect.gen(function* () {
      // Phase 14 of `plan-branching-and-compaction.md`, the decisive half.
      // The test above shows an Activity-wrapped summariser *runs*; this one
      // shows the journal doing its job. The summariser completes its
      // Activity and then the submission suspends -- before the checkpoint is
      // saved, which is the worst case: the resumed replay finds no
      // checkpoint, asks the summariser again, and the answer must come from
      // the journal rather than from executing the summary again. `executes`
      // counts only real executions, inside the Activity body.
      //
      // The Activity's name is derived from what is being summarised
      // (`summarise-<messages>`), because replay-stability is the entire
      // contract: a name that varied per ask would journal nothing usefully,
      // which the break-once for this test confirms (a random suffix makes
      // `executes` reach 2).
      const executes = yield* Ref.make(0)
      const suspendOnce = yield* Ref.make(true)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const kv = yield* KeyValueStore.KeyValueStore.use(Effect.succeed).pipe(
        Effect.provide(KeyValueStore.layerMemory)
      )

      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        checkpointStore: kv,
        summarise: ({ messages }) =>
          Activity.make({
            name: `summarise-${messages.content.length}`,
            success: Schema.String,
            execute: Ref.updateAndGet(executes, (n) => n + 1).pipe(
              Effect.map((n) => `summary ${n}`)
            )
          }).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                const shouldSuspend = yield* Ref.getAndSet(suspendOnce, false)
                if (shouldSuspend) {
                  const token = yield* DurableDeferred.token(Gate6)
                  yield* Deferred.succeed(gateReady, token)
                  yield* DurableDeferred.await(Gate6)
                }
              })
            )
          )
      })

      const store = yield* DurableChannels.memoryStore
      const { layer: model } = yield* FakeModel.layer(
        Array.from({ length: 8 }, (_, i) => ({ text: `t${i}` }))
      )

      const durable = DurableAgent.workflow(
        "CompactedReplay",
        Agent.make({
          contextTransform: compaction,
          loop: AgentLoop.make((state) =>
            Effect.succeed(
              state.turnIndex < 5 ? AgentLoop.Continue : AgentLoop.Stop
            )
          )
        }),
        { store }
      )

      yield* Effect.gen(function* () {
        const id = yield* DurableAgent.submit(durable, store, "compact-2", "go")
        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(Gate6, { token, value: "resume" })
        const exit = yield* DurableAgent.result(durable, id, {
          interval: Duration.millis(20)
        })
        assert.isTrue(
          Exit.isSuccess(exit),
          `the resumed compacted submission failed: ${JSON.stringify(exit)}`
        )
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      // The replay asked the summariser again -- there was no checkpoint to
      // reuse, the suspension came first -- and the journal answered.
      const stored = yield* KeyValueStore.toSchemaStore(
        KeyValueStore.prefix(kv, "effect-agent:compaction:"),
        Compaction.Checkpoint
      ).get("compact-2")
      assert.isTrue(Option.isSome(stored), "the checkpoint was never persisted")
      assert.strictEqual(
        Option.getOrThrow(stored).summary,
        "summary 1",
        "the persisted summary should be the journalled first execution"
      )
      assert.strictEqual(
        yield* Ref.get(executes),
        1,
        "the summary was executed again on replay instead of replayed from the journal"
      )
    })
  )

  /**
   * R37 -- a plan and durability cannot both own the model call.
   *
   * `DurableModel` wraps the ambient `LanguageModel` so a completed call is
   * journalled and a replay returns the recorded response rather than calling
   * the provider again. An `ExecutionPlan` step *provides its own*
   * `LanguageModel`, and `AgentTurn` applies the plan directly around the
   * model call -- so the plan's layer shadows the wrapper, the provider is
   * reached outside the journal, and a replay repeats a call that has already
   * been made and billed.
   *
   * There is no way to wrap the steps of a plan built elsewhere, so the
   * choice is between silently losing the durability guarantee and refusing
   * loudly. Only one of those is something an operator can act on.
   */
  it.live("a durable agent carrying an execution plan is refused", () =>
    Effect.gen(function* () {
      const { layer: modelLayer } = yield* FakeModel.layer([{ text: "done" }])
      const store = yield* DurableChannels.memoryStore
      const { layer: stepLayer } = yield* FakeModel.layer([{ text: "from the plan" }])

      const Planned = Agent.make({ instructions: "Be brief." }).pipe(
        Agent.withExecutionPlan(ExecutionPlan.make({ provide: stepLayer }))
      )
      const durable = DurableAgent.workflow("Planned", Planned, { store })

      const outcome = yield* Effect.exit(
        Effect.gen(function* () {
          const executionId = yield* DurableAgent.submit(durable, store, "planned-1", "hello")
          return yield* DurableAgent.result(durable, executionId)
        }).pipe(
          Effect.provide(
            durable.layer.pipe(
              Layer.provideMerge(Engine),
              Layer.provideMerge(modelLayer)
            )
          )
        )
      )

      // However the workflow surfaces it, the run does not quietly succeed
      // with the journal bypassed.
      const reported = Exit.isFailure(outcome)
        ? String(outcome.cause)
        : String(outcome.value)
      assert.include(reported, "ExecutionPlan")
    })
  )
})
