import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { IdGenerator, LanguageModel, Response } from "effect/unstable/ai"
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"

/**
 * SPIKE — durable execution via Effect Workflow.
 *
 * The question this answers is not "can we call Workflow from the harness"
 * but the one WORKFLOW.md and PLAN §30 actually pose:
 *
 *   Can the *same* agent definition be reinterpreted durably, without the
 *   harness knowing that durability exists?
 *
 * If it needs core changes, the durable package needs an interception
 * interface (`AgentExecution`). If it does not, the harness's existing
 * dependency-injection boundaries already are the interception points.
 */

const finishPart = (): Response.PartEncoded => ({
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 }
  }
})

/**
 * A LanguageModel whose provider call is a durable Activity.
 *
 * This is the whole integration. `LanguageModel.make` takes a provider
 * function returning `Array<Response.PartEncoded>` — already an encodable
 * value — so the activity boundary lands exactly where persistence needs it,
 * and the harness above is untouched.
 */
const durableModel = (
  script: ReadonlyArray<ReadonlyArray<Response.PartEncoded>>,
  calls: Ref.Ref<number>
) =>
  Effect.gen(function* () {
    const turn = yield* Ref.make(0)
    // `Activity.make` needs the workflow context, but `LanguageModel.make`
    // pins its provider's requirements to `IdGenerator`. Capturing the context
    // here — inside the running workflow — and providing it to the activity is
    // what reconciles the two signatures.
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()

    const service = yield* LanguageModel.make({
      generateText: () =>
        Effect.gen(function* () {
          // The activity name must be stable across replays; the turn index
          // within a submission is exactly that.
          const index = yield* Ref.getAndUpdate(turn, (n) => n + 1)
          return yield* Activity.make({
            name: `model-turn-${index}`,
            success: Schema.Unknown,
            execute: Effect.gen(function* () {
              yield* Ref.update(calls, (n) => n + 1)
              return script[index] ?? [finishPart()]
            })
          }).pipe(Effect.provide(workflowContext))
        }).pipe(
          Effect.map((parts) => parts as Array<Response.PartEncoded>),
          Effect.orDie
        ),
      streamText: () =>
        Stream.fromEffect(Effect.die(new Error("streaming is out of scope")))
    })

    return Layer.succeed(LanguageModel.LanguageModel, service).pipe(
      Layer.provideMerge(
        Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)
      )
    )
  })

describe("spike: durable execution", () => {
  it.effect("a submission runs inside a Workflow with no core changes", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)

      // The agent definition is ordinary, and unaware that Workflow exists.
      const Researcher = Agent.make({ instructions: "Be brief." })

      const AgentWorkflow = Workflow.make("AgentSubmission", {
        payload: { input: Schema.String },
        idempotencyKey: (payload) => payload.input,
        success: Schema.String
      })

      const layer = AgentWorkflow.toLayer((payload) =>
        Effect.gen(function* () {
          // Built here, inside the running workflow, because that is where the
          // workflow context exists.
          const modelLayer = yield* durableModel(
            [[{ type: "text", text: "answer" }, finishPart()]],
            calls
          )

          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* AgentSession.make(Researcher)
              const result = yield* AgentSession.prompt(session, payload.input)
              return result.text
            })
          ).pipe(Effect.provide(modelLayer), Effect.orDie)
        })
      )

      const text = yield* AgentWorkflow.execute({ input: "hello" }).pipe(
        Effect.provide(layer.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)))
      )

      assert.strictEqual(text, "answer")
      assert.strictEqual(yield* Ref.get(calls), 1)
    })
  )

  it.effect("parallel tool calls as concurrent Activities", () =>
    Effect.gen(function* () {
      // PLAN §17 executes a turn's tool calls with `Effect.all` at unbounded
      // concurrency. Effect-TS issue #6014 reports concurrent `Activity.make`
      // deadlocking during replay, so whether concurrent activities are safe
      // decides whether durable tool execution can keep that default.
      const ran = yield* Ref.make<Array<string>>([])

      const ParallelWorkflow = Workflow.make("ParallelActivities", {
        payload: { count: Schema.Number },
        idempotencyKey: (payload) => `parallel-${payload.count}`,
        success: Schema.Number
      })

      const layer = ParallelWorkflow.toLayer((payload) =>
        Effect.gen(function* () {
          const names = Array.from(
            { length: payload.count },
            (_, i) => `tool-${i}`
          )
          const results = yield* Effect.all(
            names.map((name) =>
              Activity.make({
                name,
                success: Schema.String,
                execute: Ref.update(ran, (all) => [...all, name]).pipe(
                  Effect.as(name)
                )
              })
            ),
            { concurrency: "unbounded" }
          )
          return results.length
        })
      )

      const count = yield* ParallelWorkflow.execute({ count: 4 }).pipe(
        Effect.provide(
          layer.pipe(Layer.provideMerge(WorkflowEngine.layerMemory))
        ),
        Effect.timeoutOption("5 seconds")
      )

      assert.deepStrictEqual(
        Option.getOrNull(count),
        4,
        "concurrent Activity.make did not complete — see effect#6014"
      )
      assert.deepStrictEqual((yield* Ref.get(ran)).sort(), [
        "tool-0",
        "tool-1",
        "tool-2",
        "tool-3"
      ])
    })
  )
})
