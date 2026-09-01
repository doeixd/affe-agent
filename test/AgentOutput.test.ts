import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Option, Ref, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import * as FakeModel from "./FakeModel.js"

const Quality = Schema.Struct({
  hasCallToAction: Schema.Boolean,
  clarity: Schema.Number
})

const Output = AgentOutput.make(Quality)

/** The params the model sends for a well-formed report. */
const report = { hasCallToAction: true, clarity: 8 }

/**
 * Run an agent against a scripted model and hand back the result.
 *
 * Deliberately not `helpers.withSession`: that helper's `Harness` types the
 * session as `AgentSession<Tools>`, whose value slot is `never`, and widening
 * it to accommodate outputs would weaken every other suite's typing to buy one
 * suite's convenience.
 */
const run = <Tools extends Record<string, Tool.Any>, Value>(
  turns: ReadonlyArray<FakeModel.Turn>,
  agent: Agent.AgentDefinition<Tools, never, never, never, Value>
) =>
  Effect.gen(function*() {
    const { layer, recorder } = yield* FakeModel.layer(turns)
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        const result = yield* AgentSession.prompt(session, "go")
        return { result, calls: yield* recorder.calls, session }
      }).pipe(Effect.provide(layer))
    )
  })

describe("AgentOutput", () => {
  it.effect("reports the value the model sent, decoded", () =>
    Effect.gen(function*() {
      const { result } = yield* run(
        [FakeModel.toolCall(Output.toolName, report)],
        Agent.make({ output: Output })
      )

      assert.strictEqual(result.status, "completed")
      assert.deepStrictEqual(
        result.value,
        Option.some({ hasCallToAction: true, clarity: 8 })
      )
    }))

  it.effect("ends the run on the reporting turn, spending no further call", () =>
    Effect.gen(function*() {
      // The second turn exists precisely so that consuming it would be
      // visible. `untilIdle` would continue here -- the turn made a tool
      // call -- so this is the whole reason the stop rule exists.
      const { calls, result } = yield* run(
        [FakeModel.toolCall(Output.toolName, report), FakeModel.text("chatter")],
        Agent.make({ output: Output })
      )

      assert.strictEqual(calls, 1)
      assert.strictEqual(result.turns, 1)
      assert.strictEqual(result.text, "")
    }))

  it.effect("an agent that declares no output reports no value", () =>
    Effect.gen(function*() {
      const { result } = yield* run([FakeModel.text("done")], Agent.make({}))

      assert.strictEqual(result.status, "completed")
      assert.isTrue(Option.isNone(result.value))
    }))

  it.effect("a model that never calls the tool completes without a value", () =>
    Effect.gen(function*() {
      // Completed, not failed: the harness cannot make a model answer, and
      // inventing a failure here would report a model's choice as a defect.
      const { result } = yield* run(
        [FakeModel.text("I would rather not.")],
        Agent.make({ output: Output })
      )

      assert.strictEqual(result.status, "completed")
      assert.isTrue(Option.isNone(result.value))
      assert.strictEqual(result.text, "I would rather not.")
    }))

  // No test scripts a *malformed* report, and the omission is deliberate. The
  // scripted model validates a call's parameters against the toolkit's own
  // schema before emitting it, exactly as a real provider validates against
  // the tool schema it was given -- so a report that does not fit the shape
  // cannot be produced here at all. That is the point of the output being a
  // tool: the shape is enforced at the provider boundary rather than checked
  // after the fact, and there is no post-hoc decode step of this library's own
  // to regression-test.

  it.effect("the last report wins when the model sends two", () =>
    Effect.gen(function*() {
      const { result } = yield* run(
        [
          {
            toolCalls: [
              { id: "a", name: Output.toolName, params: { hasCallToAction: false, clarity: 1 } },
              { id: "b", name: Output.toolName, params: report }
            ]
          }
        ],
        Agent.make({ output: Output, toolExecution: ToolExecution.Sequential })
      )

      assert.deepStrictEqual(
        result.value,
        Option.some({ hasCallToAction: true, clarity: 8 })
      )
    }))

  it.effect("a value that landed survives an interrupt in a later run", () =>
    Effect.gen(function*() {
      // Run one reports the value and stops. A follow-up queued while that
      // turn was in flight starts run two, which hangs -- so the interrupt is
      // guaranteed to arrive after the answer already exists.
      const started = yield* Deferred.make<void>()
      const reached = yield* Deferred.make<void>()
      const queued = yield* Deferred.make<void>()

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const { layer } = yield* FakeModel.layer([
            { ...FakeModel.toolCall(Output.toolName, report), during: Deferred.await(queued) },
            { hang: true, started: reached }
          ])

          return yield* Effect.gen(function*() {
            const session = yield* AgentSession.make(Agent.make({ output: Output }))
            const receipt = yield* AgentSession.submit(session, "go")
            yield* Deferred.succeed(started, undefined)
            // Accepted while run one is still executing, which is what makes
            // the submission continue into a second run.
            yield* AgentSession.followUp(session, "and again")
            yield* Deferred.succeed(queued, undefined)
            yield* Deferred.await(reached)
            yield* AgentSession.interrupt(session)
            return yield* AgentSession.awaitSubmission(session, receipt.submissionId)
          }).pipe(Effect.provide(layer))
        })
      )

      assert.strictEqual(result.status, "interrupted")
      assert.strictEqual(result.runs, 2)
      // Committed with its turn, so it is work that landed rather than work
      // in flight -- the same rule `turns` and `text` already follow.
      assert.deepStrictEqual(
        result.value,
        Option.some({ hasCallToAction: true, clarity: 8 })
      )
    }))

  it.effect("a value from a turn that never commits is not reported", () =>
    Effect.gen(function*() {
      // The output tool succeeds, then a second call in the same turn hangs
      // and the run is interrupted. The turn rolls back: nothing enters
      // history, so nothing may be reported as the answer either. Staging the
      // value until the commit is the whole reason this passes.
      const hanging = yield* Deferred.make<void>()
      const Slow = Tool.make("slow", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const { layer } = yield* FakeModel.layer([
            {
              toolCalls: [
                { id: "a", name: Output.toolName, params: report },
                { id: "b", name: "slow", params: {} }
              ]
            }
          ])

          return yield* Effect.gen(function*() {
            const session = yield* AgentSession.make(
              Agent.make({
                output: Output,
                // Sequential, so the output call is guaranteed to have run
                // before the hanging one parks the turn.
                toolExecution: ToolExecution.Sequential,
                tools: [
                  Agent.tool(Slow, () =>
                    Effect.andThen(
                      Deferred.succeed(hanging, undefined),
                      Effect.never
                    ))
                ]
              })
            )
            const receipt = yield* AgentSession.submit(session, "go")
            yield* Deferred.await(hanging)
            yield* AgentSession.interrupt(session)
            return yield* AgentSession.awaitSubmission(session, receipt.submissionId)
          }).pipe(Effect.provide(layer))
        })
      )

      assert.strictEqual(result.status, "interrupted")
      assert.strictEqual(result.turns, 0)
      assert.isTrue(Option.isNone(result.value))
    }))

  it.effect("replacing the loop keeps the contract's stop rule", () =>
    Effect.gen(function*() {
      // The regression this guards: the stop rule belongs to the output, not
      // to whichever loop object happened to be carrying it, so `withLoop`
      // must re-apply it rather than let it be overwritten.
      const { calls } = yield* run(
        [FakeModel.toolCall(Output.toolName, report), FakeModel.text("chatter")],
        Agent.make({ output: Output }).pipe(Agent.withLoop(AgentLoop.bounded(10)))
      )

      assert.strictEqual(calls, 1)
    }))

  it.effect("a custom name is what the model is asked to call", () =>
    Effect.gen(function*() {
      const Named = AgentOutput.make(Quality, {
        name: "record_evaluation",
        description: "Record your evaluation."
      })
      const { result } = yield* run(
        [FakeModel.toolCall("record_evaluation", report)],
        Agent.make({ output: Named })
      )

      assert.deepStrictEqual(
        result.value,
        Option.some({ hasCallToAction: true, clarity: 8 })
      )
    }))

  it.effect("a user tool of the same name is a defect, not a silent shadow", () =>
    Effect.gen(function*() {
      const Clash = Tool.make("submit_output", {
        parameters: Schema.Struct({ value: Schema.String }),
        success: Schema.String
      })
      const clashing = Toolkit.make(Clash)

      const exit = yield* Effect.exit(
        run(
          [FakeModel.text("hi")],
          Agent.make({
            output: Output,
            toolkit: clashing.pipe(
              Effect.provide(clashing.toLayer({ submit_output: () => Effect.succeed("x") }))
            )
          })
        )
      )

      assert.isTrue(Exit.isFailure(exit))
    }))

  it.effect("the report is committed to history like any other tool call", () =>
    Effect.gen(function*() {
      const { session } = yield* run(
        [FakeModel.toolCall(Output.toolName, report)],
        Agent.make({ output: Output })
      )
      const history = yield* AgentSession.history(session)
      const roles = FakeModel.roles(history)

      // Assistant message and tool result both present: the answer is part of
      // the transcript, which is what makes it auditable and replayable.
      assert.include(roles, "assistant")
      assert.include(roles, "tool")
    }))

  it.effect("tools and an output coexist", () =>
    Effect.gen(function*() {
      const Search = Tool.make("search", {
        parameters: Schema.Struct({ query: Schema.String }),
        success: Schema.String
      })
      const seen = yield* Ref.make<ReadonlyArray<string>>([])

      const { result } = yield* run(
        [
          FakeModel.toolCall("search", { query: "copy" }),
          FakeModel.toolCall(Output.toolName, report)
        ],
        Agent.make({
          tools: [
            Agent.tool(Search, ({ query }) =>
              Effect.as(Ref.update(seen, (q) => [...q, query]), "results"))
          ],
          output: Output
        })
      )

      assert.deepStrictEqual(yield* Ref.get(seen), ["copy"])
      assert.deepStrictEqual(
        result.value,
        Option.some({ hasCallToAction: true, clarity: 8 })
      )
    }))
})

// --- Type assertions -------------------------------------------------------
//
// Compiling proves nothing on its own: `any` compiles. Each assertion below is
// an equality, and each was broken once to confirm the check is live.

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false

type QualityValue = { readonly hasCallToAction: boolean; readonly clarity: number }

/** What `Agent.make` inferred, read back off the definition it returned. */
const typedAgent = Agent.make({ output: Output })
type InferredValue = typeof typedAgent extends
  Agent.AgentDefinition<any, any, any, any, infer V> ? V : never

/** The value is the schema's decoded type -- not `unknown`, not `any`. */
export type _MakeInfersValue = Assert<Equal<InferredValue, QualityValue>>

/** And it survives the trip through the session to the result. */
export type _ResultValueIsTyped = Assert<
  Equal<
    AgentSession.Result<{}, InferredValue>["value"],
    Option.Option<QualityValue>
  >
>

/**
 * An agent with no output has `Option<never>`: the signature says the value
 * can never arrive, rather than a comment saying so.
 */
const plainAgent = Agent.make({})
type PlainValue = typeof plainAgent extends
  Agent.AgentDefinition<any, any, any, any, infer V> ? V : never
export type _NoOutputIsNever = Assert<
  Equal<AgentSession.Result<{}, PlainValue>["value"], Option.Option<never>>
>

/** Piping an agent through a combinator does not lose the contract. */
const pipedAgent = Agent.make({ output: Output }).pipe(
  Agent.withInstructions("evaluate"),
  Agent.withLoop(AgentLoop.bounded(4))
)
type PipedValue = typeof pipedAgent extends
  Agent.AgentDefinition<any, any, any, any, infer V> ? V : never
export type _PipeKeepsValue = Assert<Equal<PipedValue, QualityValue>>
