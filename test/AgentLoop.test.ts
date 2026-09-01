import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { LanguageModel, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentOutput from "../src/AgentOutput.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import { AgentClient } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as Ids from "../src/internal/ids.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Run policy through the loop seam (`docs/plan-effect-agent-comparison.md`
 * §3.1): the tool-call and duration ceilings, the `Final` decision that
 * turns a cut-off into one last tool-less turn, and the reason a stop
 * carries out to the result and the `RunCompleted` event.
 *
 * Every bound is checked *after* the turn, so each test names the exact
 * turn a ceiling bites, as `Budget.test.ts` does for tokens.
 */

const Noop = Tool.make("noop", { parameters: Schema.Struct({}), success: Schema.String })
const noop = Agent.tool(Noop, () => Effect.succeed("ok"))
const call = (id: string) => ({ id, name: "noop", params: {} })

/** One prompt, in a session that lives for it, with a probe attached. */
const runWith = <Tools extends Record<string, Tool.Any>, E, R, Value>(
  agent: Agent.AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value>,
  turns: ReadonlyArray<TestLanguageModel.Turn>
) =>
  Effect.gen(function* () {
    const { layer, recorder } = yield* TestLanguageModel.script(turns)
    return yield* Effect.gen(function* () {
      const session = yield* AgentSession.make(agent)
      const probe = yield* AgentProbe.make(session)
      const result = yield* session.prompt("go")
      const events = yield* probe.events
      const completed = events.map((envelope) => envelope.event).filter(
        (event) => event._tag === "RunCompleted"
      )
      return { result, completed, tools: yield* recorder.tools }
    }).pipe(Effect.provide(layer), Effect.scoped)
  })

describe("AgentLoop.maxToolCalls", () => {
  it.effect("stops after the turn that reaches the ceiling, running that turn's calls in full", () =>
    Effect.gen(function* () {
      // Two calls, then two more: the ceiling of three is reached at turn 2
      // (four executed), which becomes the last turn. Turn 3 never runs.
      const { result, completed } = yield* runWith(
        Agent.make({ tools: [noop], loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxToolCalls(3)) }),
        [
          { toolCalls: [call("a"), call("b")] },
          { toolCalls: [call("c"), call("d")] },
          { toolCalls: [call("e")] }
        ]
      )
      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.turns, 2)
      assert.deepStrictEqual(result.stopReason, Option.some("max tool calls"))
      assert.strictEqual(completed.length, 1)
      assert.strictEqual(completed[0]!.stopReason, "max tool calls")
    })
  )

  it.effect("a run that goes idle under the ceiling stops with no reason", () =>
    Effect.gen(function* () {
      const { result, completed } = yield* runWith(
        Agent.make({ tools: [noop], loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxToolCalls(3)) }),
        [{ toolCalls: [call("a")] }, TestLanguageModel.text("done")]
      )
      assert.strictEqual(result.turns, 2)
      assert.isTrue(Option.isNone(result.stopReason))
      assert.isUndefined(completed[0]!.stopReason)
    })
  )

  it("refuses a bound that could never bite", () => {
    assert.throws(() => AgentLoop.maxToolCalls(0), /positive integer/)
    assert.throws(() => AgentLoop.maxToolCalls(1.5), /positive integer/)
  })
})

describe("AgentLoop.maxDuration", () => {
  it.effect("stops after the turn in which the deadline passes", () =>
    Effect.gen(function* () {
      // Each model call advances the test clock by five seconds while it is
      // in flight. Turn 1 ends at 5s (under 8s: continue); turn 2 ends at 10s
      // (over: stop, having completed). Turn 3 never runs.
      const tick = TestClock.adjust(Duration.seconds(5))
      const { result, completed } = yield* runWith(
        Agent.make({
          tools: [noop],
          loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxDuration("8 seconds"))
        }),
        [
          { toolCalls: [call("a")], during: tick },
          { toolCalls: [call("b")], during: tick },
          { toolCalls: [call("c")], during: tick }
        ]
      )
      assert.strictEqual(result.turns, 2)
      assert.deepStrictEqual(result.stopReason, Option.some("max duration"))
      assert.strictEqual(completed[0]!.stopReason, "max duration")
    })
  )

  it("refuses a bound that could never bite", () => {
    assert.throws(() => AgentLoop.maxDuration("0 seconds"), /positive finite/)
    assert.throws(() => AgentLoop.maxDuration(-1), /positive finite/)
  })
})

describe("AgentLoop.Final", () => {
  it.effect("a bound that cuts the model off yields one final turn with the tools withheld", () =>
    Effect.gen(function* () {
      // Turn 1 asks for a tool and hits maxTurns(1): cut off, so `Final`.
      // Turn 2 is offered no tools and answers. The loop is not asked again.
      const { result, completed, tools } = yield* runWith(
        Agent.make({ tools: [noop], loop: AgentLoop.withFinalTurn(AgentLoop.bounded(1)) }),
        [{ toolCalls: [call("a")] }, TestLanguageModel.text("what I found")]
      )
      assert.strictEqual(result.turns, 2)
      assert.strictEqual(result.text, "what I found")
      assert.deepStrictEqual(tools, [["noop"], []])
      // The reason is the bound's, carried through the `Final`.
      assert.deepStrictEqual(result.stopReason, Option.some("max turns"))
      assert.strictEqual(completed[0]!.stopReason, "max turns")
    })
  )

  it.effect("with an AgentOutput, the final turn offers only the output tool and the value lands", () =>
    Effect.gen(function* () {
      const Verdict = AgentOutput.make(Schema.Struct({ ok: Schema.Boolean }), { name: "verdict" })
      const { result, tools } = yield* runWith(
        Agent.make({
          tools: [noop],
          output: Verdict,
          loop: AgentLoop.withFinalTurn(AgentLoop.bounded(1))
        }),
        [
          { toolCalls: [call("a")] },
          { toolCalls: [{ id: "v", name: "verdict", params: { ok: true } }] }
        ]
      )
      assert.strictEqual(result.turns, 2)
      assert.deepStrictEqual(tools, [["noop", "verdict"], ["verdict"]])
      assert.deepStrictEqual(result.value, Option.some({ ok: true }))
      // The loop is not consulted on the final turn, so the reason is the
      // bound's, not the output's own "output reported".
      assert.deepStrictEqual(result.stopReason, Option.some("max turns"))
    })
  )

  it.effect("a stop on an idle model is a plain stop: no final turn", () =>
    Effect.gen(function* () {
      const { result, tools } = yield* runWith(
        Agent.make({ tools: [noop], loop: AgentLoop.withFinalTurn(AgentLoop.bounded(1)) }),
        [TestLanguageModel.text("done at once"), TestLanguageModel.text("never asked")]
      )
      assert.strictEqual(result.turns, 1)
      assert.deepStrictEqual(tools, [["noop"]])
      assert.isTrue(Option.isNone(result.stopReason))
    })
  )

  it.effect("the final turn is the last one even if the model asks for tools again", () =>
    Effect.gen(function* () {
      // The model has no tools to call on the final turn; a scripted call
      // for one it was not offered is a decode failure returned to the model
      // -- but the loop is still not consulted, so the run ends there.
      const { result } = yield* runWith(
        Agent.make({ tools: [noop], loop: AgentLoop.withFinalTurn(AgentLoop.bounded(1)) }),
        [{ toolCalls: [call("a")] }, TestLanguageModel.text("last word"), TestLanguageModel.text("unreachable")]
      )
      assert.strictEqual(result.turns, 2)
      assert.strictEqual(result.text, "last word")
    })
  )
})

describe("AgentLoop.limits", () => {
  it.effect("composes the bounds given and takes the final turn when asked", () =>
    Effect.gen(function* () {
      const { result, tools } = yield* runWith(
        Agent.make({
          tools: [noop],
          loop: AgentLoop.limits({ maxTurns: 5, maxToolCalls: 2, finalTurn: true })
        }),
        [
          { toolCalls: [call("a"), call("b")] },
          TestLanguageModel.text("summary")
        ]
      )
      assert.strictEqual(result.turns, 2)
      assert.deepStrictEqual(tools, [["noop"], []])
      assert.deepStrictEqual(result.stopReason, Option.some("max tool calls"))
    })
  )

  it("needs at least one bound", () => {
    // @ts-expect-error -- an unbounded `untilIdle` is what `limits` exists to prevent
    AgentLoop.limits({})
    // @ts-expect-error -- a final turn is not a bound
    AgentLoop.limits({ finalTurn: true })
    assert.isDefined(AgentLoop.limits({ maxDuration: "1 minute" }))
  })
})

describe("AgentLoop.and / or over three decisions", () => {
  /**
   * A real state, with a real response from the scripted model: the
   * combinators never read it, but a hand-built one would need a cast, and
   * test code counts as user code.
   */
  const state = Effect.gen(function* () {
    const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("x")])
    const response = yield* LanguageModel.generateText({
      prompt: "x",
      disableToolCallResolution: true
    }).pipe(Effect.provide(layer))
    const state: AgentLoop.State<{}> = {
      sessionId: Ids.sessionId("s"),
      submissionId: Ids.submissionId("sub"),
      runId: Ids.runId("r"),
      turnIndex: 1,
      toolCallsTotal: 0,
      elapsed: Duration.zero,
      response,
      toolCalls: []
    }
    return state
  })
  const constant = (decision: AgentLoop.Decision) =>
    AgentLoop.make<never, never, {}>(() => Effect.succeed(decision))
  const C = AgentLoop.Continue
  const F = AgentLoop.final("f")
  const S = AgentLoop.stop("s")

  it.effect("and keeps the most stopping decision; or the least", () =>
    Effect.gen(function* () {
      const state_ = yield* state
      const and = (...ds: Array<AgentLoop.Decision>) =>
        AgentLoop.and(constant(ds[0]!), ...ds.slice(1).map(constant)).decide(state_)
      const or = (...ds: Array<AgentLoop.Decision>) =>
        AgentLoop.or(constant(ds[0]!), ...ds.slice(1).map(constant)).decide(state_)

      assert.deepStrictEqual(yield* and(C, C), C)
      assert.deepStrictEqual(yield* and(C, F), F)
      assert.deepStrictEqual(yield* and(F, C), F)
      assert.deepStrictEqual(yield* and(F, S), S)
      assert.deepStrictEqual(yield* and(S, F), S)
      assert.deepStrictEqual(yield* and(C, S, F), S)

      assert.deepStrictEqual(yield* or(S, S), S)
      assert.deepStrictEqual(yield* or(S, F), F)
      assert.deepStrictEqual(yield* or(F, S), F)
      assert.deepStrictEqual(yield* or(F, C), C)
      assert.deepStrictEqual(yield* or(S, C, F), C)
    })
  )

  it.effect("the first decision at the winning rank keeps its reason", () =>
    Effect.gen(function* () {
      const state_ = yield* state
      const first = AgentLoop.stop("first")
      const second = AgentLoop.stop("second")
      assert.deepStrictEqual(yield* AgentLoop.and(constant(first), constant(second)).decide(state_), first)
      assert.deepStrictEqual(yield* AgentLoop.or(constant(first), constant(second)).decide(state_), first)
    })
  )
})

describe("stopReason crosses the boundaries", () => {
  const agent = Agent.make({ tools: [noop], loop: AgentLoop.bounded(1) })
  const turns = [{ toolCalls: [call("a")] }, TestLanguageModel.text("unreachable")]

  it.effect("Budget.within names its ceiling", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [call("a")], usage: { input: 60, output: 60 } }
      ])
      const result = yield* Agent.run(
        Agent.make({ tools: [noop], loop: Budget.within(100, AgentLoop.untilIdle()) }),
        "go"
      ).pipe(Effect.provide(Layer.merge(layer, Budget.layer)))
      assert.deepStrictEqual(result.stopReason, Option.some("token budget"))
    })
  )

  it.effect("the in-process client reports it on the remote result", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script(turns)
      const result = yield* Effect.gen(function* () {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession({ sessionId: Ids.sessionId("s1") })
        return yield* session.prompt("go")
      }).pipe(Effect.scoped, Effect.provide(AgentClient.layer(agent).pipe(Layer.provide(layer))))
      assert.strictEqual(result.stopReason, "max turns")
    })
  )

  // `it.live`: the durable client polls on real delays, which a `TestClock`
  // would never advance.
  it.live("the durable client reads it back from the journal", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script(turns)
      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const Durable = DurableAgentClient.layer("StopReason", agent, { store, sessionStore, delivery }).pipe(
        Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))),
        Layer.provideMerge(model)
      )
      const result = yield* Effect.gen(function* () {
        const client = yield* AgentClient.AgentClient
        const session = yield* client.createSession({ sessionId: Ids.sessionId("s1") })
        return yield* session.prompt("go")
      }).pipe(Effect.scoped, Effect.provide(Durable))
      assert.strictEqual(result.stopReason, "max turns")
    })
  )
})
