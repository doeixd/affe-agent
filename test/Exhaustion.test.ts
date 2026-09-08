import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Budget from "../src/budget/Budget.js"
import * as FakeModel from "./FakeModel.js"
import recorded from "./fixtures/run-completed.json" with { type: "json" }

/**
 * Ran out, or finished?
 *
 * `plan-run-stream-start.md` §7 asks for that distinction to be a value rather
 * than a sentence. `stopReason` stays what it was -- open-ended prose, named by
 * whichever policy decided -- and `exhaustion` is the classification beside it,
 * so a caller branches on a union instead of matching strings that a custom
 * policy is free to invent.
 *
 * §7.2 is the property most of these are about: a model going idle, an output
 * tool reporting, and a custom policy choosing to stop are all *stops*, and
 * none of them is exhaustion. Only a built-in ceiling running out is.
 */

const Lookup = Tool.make("lookup", {
  description: "look something up",
  parameters: Schema.Struct({}),
  success: Schema.String
})

/** Keeps asking for tools, so a bound is what ends the run rather than the model. */
const insistent: ReadonlyArray<FakeModel.Turn> = [
  { toolCalls: [{ id: "a", name: "lookup", params: {} }] },
  { toolCalls: [{ id: "b", name: "lookup", params: {} }] },
  { toolCalls: [{ id: "c", name: "lookup", params: {} }] },
  { toolCalls: [{ id: "d", name: "lookup", params: {} }] }
]

const withTool = <E, R>(loop: AgentLoop.AgentLoop<E, R, any>) =>
  Agent.make({
    tools: [Agent.tool(Lookup, () => Effect.succeed("found"))],
    loop
  })

const run = <Tools extends Record<string, Tool.Any>, E, R, Value>(
  turns: ReadonlyArray<FakeModel.Turn>,
  agent: Agent.AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Prompt.RawInput>
) =>
  Effect.gen(function*() {
    const { layer } = yield* FakeModel.layer(turns)
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        return yield* AgentSession.prompt<Tools, E, Value, Prompt.RawInput>(session, "go")
      }).pipe(Effect.provide(layer))
    )
  })

describe("exhaustion is a classification, not a parsed reason", () => {
  it.effect("running out of turns says so", () =>
    Effect.gen(function*() {
      const result = yield* run(insistent, withTool(AgentLoop.maxTurns(2)))

      assert.deepStrictEqual(result.exhaustion, Option.some("turns"))
      // The prose survives beside it rather than being replaced by it.
      assert.deepStrictEqual(result.stopReason, Option.some("max turns"))
    }))

  it.effect("running out of tool calls says so", () =>
    Effect.gen(function*() {
      const result = yield* run(
        insistent,
        withTool(AgentLoop.and(AgentLoop.maxToolCalls(2), AgentLoop.maxTurns(9)))
      )

      assert.deepStrictEqual(result.exhaustion, Option.some("tool-calls"))
    }))

  it.effect("running out of tokens says so", () =>
    Effect.gen(function*() {
      const { layer } = yield* FakeModel.layer([
        { toolCalls: [{ id: "a", name: "lookup", params: {} }], usage: { input: 100, output: 100 } },
        { toolCalls: [{ id: "b", name: "lookup", params: {} }], usage: { input: 100, output: 100 } },
        { text: "done" }
      ])
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(withTool(Budget.within(150, AgentLoop.untilIdle())))
          return yield* AgentSession.prompt(session, "go")
        }).pipe(Effect.provide(Layer.merge(layer, Budget.layer)))
      )

      assert.deepStrictEqual(result.exhaustion, Option.some("tokens"))
    }))

  /**
   * §7.2, and the reason the field exists at all: three different ways of
   * finishing normally, none of which ran out of anything.
   */
  it.effect("an idle model finished, and did not run out", () =>
    Effect.gen(function*() {
      const result = yield* run([{ text: "done" }], withTool(AgentLoop.untilIdle()))

      assert.strictEqual(result.status, "completed")
      assert.isTrue(Option.isNone(result.exhaustion), "an idle model is not exhaustion")
    }))

  it.effect("a custom policy's stop is not exhaustion, however it is worded", () =>
    Effect.gen(function*() {
      // Deliberately worded like a ceiling. A classification derived by reading
      // the string would call this exhaustion; the value does not.
      const supervisor = AgentLoop.make(() => Effect.succeed(AgentLoop.stop("max turns")))
      const result = yield* run(insistent, withTool(supervisor))

      assert.deepStrictEqual(result.stopReason, Option.some("max turns"))
      assert.isTrue(
        Option.isNone(result.exhaustion),
        "exhaustion must come from the decision, not from what the reason happens to say"
      )
    }))

  /**
   * A run that ran out of turns and then took a polite final turn still ran out
   * of turns. Losing the classification through `withFinalTurn` would mean the
   * answer to "why did this end" changed because the agent was configured to
   * end more gracefully.
   */
  it.effect("a final turn keeps the classification of the bound that caused it", () =>
    Effect.gen(function*() {
      const result = yield* run(
        // Two tool-calling turns, then the final turn -- which is offered no
        // tools, so the script must not ask for one there.
        [insistent[0]!, insistent[1]!, { text: "wrapping up" }],
        withTool(AgentLoop.withFinalTurn(AgentLoop.maxTurns(2)))
      )

      assert.deepStrictEqual(result.exhaustion, Option.some("turns"))
      assert.strictEqual(result.text, "wrapping up")
    }))

  it.effect("the decision that wins a conjunction brings its own classification", () =>
    Effect.gen(function*() {
      // Turns bites first; the tool-call ceiling never fires.
      const result = yield* run(
        insistent,
        withTool(AgentLoop.and(AgentLoop.maxTurns(1), AgentLoop.maxToolCalls(99)))
      )

      assert.deepStrictEqual(result.exhaustion, Option.some("turns"))
    }))

  it.effect("the event carries it too, so a remote observer need not parse either", () =>
    Effect.gen(function*() {
      const { layer } = yield* FakeModel.layer(insistent)
      const events = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(withTool(AgentLoop.maxTurns(2)))
          const collecting = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.takeUntil(
                AgentSession.events(session),
                (envelope) => envelope.event._tag === "RunCompleted"
              )
            )
          )
          yield* AgentSession.prompt(session, "go")
          return yield* Fiber.join(collecting)
        }).pipe(Effect.provide(layer))
      )

      const completed = events.find((envelope) => envelope.event._tag === "RunCompleted")
      assert.isDefined(completed)
      if (completed?.event._tag !== "RunCompleted") return
      assert.strictEqual(completed.event.exhaustion, "turns")
      assert.strictEqual(completed.event.stopReason, "max turns")
    }))
})

describe("the recorded RunCompleted wire", () => {
  /**
   * The compatibility claim the trailer makes, measured rather than asserted.
   *
   * `withoutExhaustion` is the shape every `RunCompleted` had before the field
   * existed -- recorded from a run whose custom policy stopped without
   * exhausting anything, which produces those bytes exactly. A journal written
   * by an older host holds that, and it has to keep decoding.
   */
  it("an older journal entry still decodes, and reports no exhaustion", () => {
    const decoded = Schema.decodeUnknownSync(AgentEvent.RunCompleted)(
      recorded.withoutExhaustion.event
    )
    assert.strictEqual(decoded.stopReason, "supervisor said so")
    assert.isUndefined(decoded.exhaustion)
  })

  it("a run that ran out records which ceiling it was", () => {
    const decoded = Schema.decodeUnknownSync(AgentEvent.RunCompleted)(
      recorded.withExhaustion.event
    )
    assert.strictEqual(decoded.exhaustion, "turns")
    // Beside the prose, not instead of it.
    assert.strictEqual(decoded.stopReason, "max turns")
  })

  it("the field is the only thing that changed", () => {
    const { exhaustion, ...rest } = recorded.withExhaustion.event
    assert.deepStrictEqual(
      Object.keys(rest).sort(),
      Object.keys(recorded.withoutExhaustion.event).sort(),
      "a RunCompleted gained more than the one field the trailer declared"
    )
  })
})
