import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Option, Ref, Schema } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import type { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentProbe } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

const Quality = Schema.Struct({
  hasCallToAction: Schema.Boolean,
  clarity: Schema.Number
})

const Output = AgentOutput.make(Quality)

/** Everything an exit's cause says, defect included, as one string. */
const causeText = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "(the effect succeeded)"

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
  agent: Agent.AgentDefinition<Tools, never, never, LanguageModel.LanguageModel, Value>
) =>
  Effect.gen(function*() {
    const { layer, recorder } = yield* FakeModel.layer(turns)
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        // Explicit: a generic `Value` is not inferred through `Effect.fn`'s
        // wrapper and would fall to the default, `string`.
        const result = yield* AgentSession.prompt<Tools, never, Value, Prompt.RawInput>(session, "go")
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

  it.effect("an agent that declares no output reports its text as the value", () =>
    Effect.gen(function*() {
      // Every agent has a `Value`; the default is the final text, so a
      // caller generic over agents reads one from every result
      // (`plan-input-default.md` step 5). It was `None` before.
      const { result } = yield* run([FakeModel.text("done")], Agent.make({}))

      assert.strictEqual(result.status, "completed")
      assert.deepStrictEqual(result.value, Option.some("done"))
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

  it.effect("two reports in one turn are both refused, and the model answers again", () =>
    Effect.gen(function*() {
      // It used to be a race, with whichever handler finished last kept. The
      // output tool is `Alone` now (item 91), so neither answer is recorded:
      // the harness does not pick between two answers on the model's behalf.
      const { calls, result } = yield* run(
        [
          {
            toolCalls: [
              { id: "a", name: Output.toolName, params: { hasCallToAction: false, clarity: 1 } },
              { id: "b", name: Output.toolName, params: { hasCallToAction: false, clarity: 2 } }
            ]
          },
          FakeModel.toolCall(Output.toolName, report)
        ],
        Agent.make({ output: Output, toolExecution: ToolExecution.Sequential })
      )

      assert.strictEqual(calls, 2)
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

  // "A value from a turn that never commits is not reported" lived here: the
  // answer ran, a sibling in the same turn hung, the run was interrupted, and
  // the staged value had to roll back with the turn. Item 91 made that
  // scenario unconstructible -- the answer is `Alone`, so a batch with a
  // sibling runs neither -- and nothing else runs between a lone answer's
  // handler and the commit. The staging (`pendingOutput`, set by the handler
  // and read only at commit) stays, because a durable replay or a future
  // post-execution step would reopen the window; the rejection is pinned by
  // "an action beside the answer runs nothing" below.

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

      // Named, not merely "some failure": `Exit.isFailure` alone passes on a
      // failure from any cause at all, including the ones this test exists to
      // distinguish itself from.
      assert.match(causeText(exit), /duplicate tool name "submit_output"/)
    }))

  it.effect("the report is committed to history like any other tool call", () =>
    Effect.gen(function*() {
      const { session } = yield* run(
        [FakeModel.toolCall(Output.toolName, report)],
        Agent.make({ output: Output })
      )
      const history = yield* AgentSession.history(session)

      // The *output* call specifically, not merely some tool call: a test that
      // only checked for a `tool` role would pass for any agent with any tool.
      const parts = history.content.flatMap((message) =>
        Array.isArray(message.content) ? message.content : []
      )
      const names = parts.flatMap((part: { readonly type: string; readonly name?: string }) =>
        part.name === undefined ? [] : [part.name]
      )
      assert.include(names, Output.toolName)
      assert.include(FakeModel.roles(history), "assistant")
    }))

  it.effect("a streamed run reports the value the same way", () =>
    Effect.gen(function*() {
      // The streaming path is a different function (`streamResponse`), and it
      // reassembles the response itself. The claim that streaming "needs to
      // know nothing about" outputs is only worth making if it is checked.
      const { layer } = yield* FakeModel.layer([
        FakeModel.toolCall(Output.toolName, report)
      ])
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(Agent.make({ output: Output }))
          return yield* AgentSession.prompt(session, "go", { stream: true })
        }).pipe(Effect.provide(layer))
      )

      assert.deepStrictEqual(
        result.value,
        Option.some({ hasCallToAction: true, clarity: 8 })
      )
    }))

  it.effect("a denied report ends the run, like any other denied call", () =>
    Effect.gen(function*() {
      // Worth pinning because it is surprising: the output tool goes through
      // permission like everything else, and the default `toolDenialPolicy`
      // is `FailRun` -- so a policy that denies it destroys the answer rather
      // than returning it to the model. That is the agent's policy doing
      // exactly what it says, and a caller should not discover it in
      // production.
      const exit = yield* Effect.exit(
        run(
          [FakeModel.toolCall(Output.toolName, report)],
          Agent.make({
            output: Output,
            permission: Permission.rules([
              { tool: Output.toolName, decision: Permission.deny("not allowed") }
            ], { otherwise: Permission.allow })
          })
        )
      )

      assert.match(causeText(exit), /ToolPermissionDenied|not allowed/)
    }))

  it.effect("a tool added after construction cannot shadow the output", () =>
    Effect.gen(function*() {
      // The `toolkit` config path is covered above; this is the other
      // authoring path, which merges through a different code route.
      const Clash = Tool.make("submit_output", {
        parameters: Schema.Struct({ value: Schema.String }),
        success: Schema.String
      })

      const exit = yield* Effect.exit(
        run(
          [FakeModel.text("hi")],
          Agent.make({ output: Output }).pipe(
            Agent.withTool(Clash, () => Effect.succeed("x"))
          )
        )
      )

      assert.match(causeText(exit), /duplicate tool name "submit_output"/)
    }))

  it.effect("a value from an earlier run outlives a later run that gives none", () =>
    Effect.gen(function*() {
      // Documented behaviour rather than an accident, and the same rule
      // `text` follows: the result reports what landed. A caller cannot tell
      // "this answers the follow-up" from "this answered the prompt" -- see
      // docs/plan-structured-output.md.
      const queued = yield* Deferred.make<void>()

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const { layer } = yield* FakeModel.layer([
            {
              ...FakeModel.toolCall(Output.toolName, report),
              during: Deferred.await(queued)
            },
            FakeModel.text("nothing further to report")
          ])

          return yield* Effect.gen(function*() {
            const session = yield* AgentSession.make(Agent.make({ output: Output }))
            const receipt = yield* AgentSession.submit(session, "go")
            yield* AgentSession.followUp(session, "and again")
            yield* Deferred.succeed(queued, undefined)
            return yield* AgentSession.awaitSubmission(session, receipt.submissionId)
          }).pipe(Effect.provide(layer))
        })
      )

      assert.strictEqual(result.runs, 2)
      assert.strictEqual(result.text, "nothing further to report")
      assert.deepStrictEqual(
        result.value,
        Option.some({ hasCallToAction: true, clarity: 8 })
      )
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

/**
 * Item 91: the answer must be the only application call of its turn, and a
 * batch that breaks that runs *nothing* -- not the answer, not its siblings.
 */
describe("AgentOutput, alone in its turn", () => {
  const CreateInvoice = Tool.make("create_invoice", {
    parameters: Schema.Struct({ amount: Schema.Number }),
    success: Schema.String
  })

  /** An agent whose one action counts its runs, and whose policy counts its consultations. */
  const setup = Effect.gen(function*() {
    const created = yield* Ref.make(0)
    const consulted = yield* Ref.make<ReadonlyArray<string>>([])
    const agent = Agent.make({
      output: Output,
      tools: [
        Agent.tool(CreateInvoice, ({ amount }) =>
          Effect.as(Ref.update(created, (n) => n + 1), `invoice for ${amount}`))
      ],
      permission: Permission.make((request) =>
        Effect.as(Ref.update(consulted, (names) => [...names, request.tool.name]), Permission.allow)
      )
    })
    return { agent, created, consulted }
  })

  const actionAndAnswer: FakeModel.Turn = {
    toolCalls: [
      { id: "i1", name: "create_invoice", params: { amount: 5 } },
      { id: "o1", name: Output.toolName, params: report }
    ]
  }

  const failuresOf = (events: ReadonlyArray<AgentEvent.AgentEventEnvelope>) =>
    events.flatMap((envelope) =>
      AgentEvent.is("ToolCallFailed")(envelope)
        ? [{ id: envelope.event.id, tag: envelope.event.failure.tag, returned: envelope.event.returnedToModel }]
        : []
    )

  const runProbed = <Tools extends Record<string, Tool.Any>, Value>(
    turns: ReadonlyArray<FakeModel.Turn>,
    agent: Agent.AgentDefinition<Tools, never, never, LanguageModel.LanguageModel, Value>
  ) =>
    Effect.gen(function*() {
      const { layer, recorder } = yield* FakeModel.layer(turns)
      return yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          const probe = yield* AgentProbe.make(session)
          const result = yield* AgentSession.prompt<Tools, never, Value, Prompt.RawInput>(session, "go")
          return { result, calls: yield* recorder.calls, events: yield* probe.events }
        }).pipe(Effect.provide(layer))
      )
    })

  it.effect("an action beside the answer runs nothing, and the model corrects itself", () =>
    Effect.gen(function*() {
      const { agent, created, consulted } = yield* setup
      const { calls, events, result } = yield* runProbed(
        [actionAndAnswer, FakeModel.toolCall(Output.toolName, report)],
        agent
      )

      // Nothing from the rejected batch ran -- the side effect is the point.
      assert.strictEqual(yield* Ref.get(created), 0)
      // Both calls were refused, each told why, and both went back to the model.
      assert.deepStrictEqual(failuresOf(events), [
        { id: "i1", tag: "ToolBatchRejectedError", returned: true },
        { id: "o1", tag: "ToolNotAloneError", returned: true }
      ])
      // The rejected answer was not recorded: it took the second turn's.
      assert.strictEqual(calls, 2)
      assert.strictEqual(result.turns, 2)
      assert.deepStrictEqual(result.value, Option.some(report))
      // Permission was asked only about the lone answer, never the rejected batch.
      assert.deepStrictEqual(yield* Ref.get(consulted), [Output.toolName])
    }))

  it.effect("the refusals name the rule, so the model can act on them", () =>
    Effect.gen(function*() {
      const { agent } = yield* setup
      const { events } = yield* runProbed(
        [actionAndAnswer, FakeModel.toolCall(Output.toolName, report)],
        agent
      )
      const messages = events.flatMap((envelope) =>
        AgentEvent.is("ToolCallFailed")(envelope) ? [envelope.event.failure.message] : []
      )
      assert.include(messages[0]!, `${Output.toolName} must be the only call in its turn`)
      assert.include(messages[1]!, "1 other call arrived with it, so none of them was run")
    }))

  it.effect("a call the provider already executed is not company", () =>
    Effect.gen(function*() {
      // #419's distinction: a provider-hosted call has settled and cannot be
      // undone, so it is not part of the batch. Counting `toolCalls.length`
      // would reject this answer; counting executable calls does not.
      const { agent, created } = yield* setup
      const { calls, events, result } = yield* runProbed(
        [{
          toolCalls: [
            { id: "p1", name: "create_invoice", params: { amount: 5 }, providerExecuted: true },
            { id: "o1", name: Output.toolName, params: report }
          ]
        }],
        agent
      )

      assert.strictEqual(calls, 1)
      assert.deepStrictEqual(failuresOf(events), [])
      assert.deepStrictEqual(result.value, Option.some(report))
      assert.strictEqual(yield* Ref.get(created), 0)
    }))

  it.effect("a model that keeps breaking the rule exhausts the loop rather than spinning", () =>
    Effect.gen(function*() {
      // The rejected calls are still calls: `maxToolCalls` counts them, so
      // four rejected calls end the run at the ceiling with no answer and no
      // side effect.
      const { agent, created } = yield* setup
      const { calls, result } = yield* runProbed(
        [actionAndAnswer, actionAndAnswer, actionAndAnswer],
        agent.pipe(Agent.withLoop(AgentLoop.maxToolCalls(4)))
      )

      assert.strictEqual(calls, 2)
      assert.strictEqual(result.turns, 2)
      assert.isTrue(Option.isNone(result.value))
      assert.strictEqual(yield* Ref.get(created), 0)
    }))

  it.effect("a lone answer refused and returned to the model does not end the run", () =>
    Effect.gen(function*() {
      // The stop rule used to fire on the call's *presence*, so a denial the
      // model was shown ended the run with no answer at all -- the model was
      // told to try again and never asked. It stops on a committed value now.
      const deniedOnce = yield* Ref.make(true)
      const { calls, result } = yield* run(
        [FakeModel.toolCall(Output.toolName, report), FakeModel.toolCall(Output.toolName, report)],
        Agent.make({
          output: Output,
          toolDenialPolicy: ToolExecution.ReturnToModel,
          permission: Permission.make(() =>
            Effect.map(Ref.getAndSet(deniedOnce, false), (deny) => deny ? Permission.deny("not yet") : Permission.allow)
          )
        })
      )

      assert.strictEqual(calls, 2)
      assert.deepStrictEqual(result.value, Option.some(report))
    }))

  it.effect("an answer alone still runs, and ordinary batches are untouched", () =>
    Effect.gen(function*() {
      const { agent, created } = yield* setup
      const { calls, events, result } = yield* runProbed(
        [
          {
            toolCalls: [
              { id: "i1", name: "create_invoice", params: { amount: 1 } },
              { id: "i2", name: "create_invoice", params: { amount: 2 } }
            ]
          },
          FakeModel.toolCall(Output.toolName, report)
        ],
        agent
      )

      assert.strictEqual(yield* Ref.get(created), 2)
      assert.deepStrictEqual(failuresOf(events), [])
      assert.strictEqual(calls, 2)
      assert.deepStrictEqual(result.value, Option.some(report))
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
 * An agent with no output has `Option<string>`: its value is its text, so
 * every agent has one and a caller generic over agents reads it uniformly
 * (`plan-input-default.md` step 5). It was `Option<never>`.
 */
const plainAgent = Agent.make({})
type PlainValue = Agent.ValueOf<typeof plainAgent>
export type _NoOutputIsString = Assert<
  Equal<AgentSession.Result<{}, PlainValue>["value"], Option.Option<string>>
>

/**
 * And a *direct* call on a concrete typed session infers its `Value`: the
 * explicit type arguments in `run` above are for a `Value` that is itself a
 * type parameter, which `Effect.fn`'s wrapper does not carry. If this ever
 * fails, the signature has regressed, not the call site.
 */
const probeAgent = Agent.make({ output: Output })
type DirectValue = Effect.Success<
  ReturnType<typeof AgentSession.prompt<{}, never, Agent.ValueOf<typeof probeAgent>, Prompt.RawInput>>
>["value"]
export type _DirectCallKeepsValue = Assert<
  Equal<DirectValue, Option.Option<{ readonly hasCallToAction: boolean; readonly clarity: number }>>
>

/** Piping an agent through a combinator does not lose the contract. */
const pipedAgent = Agent.make({ output: Output }).pipe(
  Agent.withInstructions("evaluate"),
  Agent.withLoop(AgentLoop.bounded(4))
)
type PipedValue = typeof pipedAgent extends
  Agent.AgentDefinition<any, any, any, any, infer V> ? V : never
export type _PipeKeepsValue = Assert<Equal<PipedValue, QualityValue>>
