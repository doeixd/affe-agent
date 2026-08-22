import { assert, describe, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as Elicitation from "../src/Elicitation.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { tags, withSession } from "./helpers.js"

/**
 * The sugar's claims under pressure: that it introduces no execution branch
 * of its own, so everything the primitives do -- approval, failure modes,
 * preliminary results, per-turn toolkits, interruption, scope -- happens
 * the same way through it.
 */

const Echo = Tool.make("echo", {
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.String
})

const Dangerous = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

const Soft = Tool.make("soft", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Schema.Literal("nope"),
  failureMode: "return"
})

const Long = Tool.make("long", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

class Counter extends Context.Service<Counter, { readonly hits: Ref.Ref<number> }>()(
  "test/Counter"
) {}

const Counted = Tool.make("counted", {
  parameters: Schema.Struct({}),
  success: Schema.Number,
  dependencies: [Counter]
})

describe("bound tools carry every tool semantic through unchanged", () => {
  it.effect("a bound tool that needs approval pauses exactly like a bulk-bound one", () =>
    Effect.gen(function* () {
      const bound = Agent.make().pipe(
        Agent.withTool(Dangerous, () => Effect.succeed("wiped")),
        Agent.withLoop(AgentLoop.bounded(2))
      )
      const turns = [
        TestLanguageModel.toolCall("wipe", {}, { id: "w1" }),
        TestLanguageModel.text("done")
      ]
      // No elicitor is supplied, so the default refuses, and a refused
      // approval fails the run with the typed error -- exactly as it would
      // for a bulk-bound tool. Neither a hang nor a defect.
      const ran = yield* withSession(turns, bound, ({ session }) =>
        Effect.flip(AgentSession.prompt(session, "go"))
      )
      assert.include(tags(ran.events), "ElicitationRequested")
      assert.strictEqual(ran.value._tag, "ToolApprovalRequiredError")
      assert.include(tags(ran.events), "ToolCallFailed")
      assert.include(tags(ran.events), "SubmissionFailed")
    })
  )

  it.effect("an approval granted through the session runs the bound handler once", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0)
      const agent = Agent.make({
        tools: [Agent.tool(Dangerous, () => Ref.update(runs, (n) => n + 1).pipe(Effect.as("wiped")))],
        loop: AgentLoop.bounded(2)
      })
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("wipe", {}, { id: "w1" }),
        TestLanguageModel.text("done")
      ])
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent, { elicitation: Elicitation.memory })
          const running = yield* Effect.forkChild(AgentSession.prompt(session, "go"))
          const waiting = yield* Effect.repeat(AgentSession.pending(session), {
            until: (p) => p.length > 0
          })
          assert.isTrue(yield* AgentSession.respond(session, { id: waiting[0]!.id, granted: true }))
          return yield* Fiber.join(running)
        })
      ).pipe(Effect.provide(layer))
      assert.strictEqual(result.text, "done")
      assert.strictEqual(yield* Ref.get(runs), 1)
    })
  )

  it.effect("failureMode: return hands the declared failure back to the model", () =>
    Effect.gen(function* () {
      const agent = Agent.make().pipe(
        Agent.withTool(Soft, () => Effect.fail("nope" as const)),
        // FailRun would end the run on a thrown failure; a *returned* one is
        // a result, and the run must continue regardless of policy.
        Agent.withToolFailurePolicy(ToolExecution.FailRun),
        Agent.withLoop(AgentLoop.bounded(3))
      )
      const turns = [
        TestLanguageModel.toolCall("soft", {}, { id: "s1" }),
        TestLanguageModel.text("continued")
      ]
      const ran = yield* withSession(turns, agent, ({ session }) =>
        AgentSession.prompt(session, "go")
      )
      assert.strictEqual(ran.value.status, "completed")
      assert.strictEqual(ran.value.text, "continued")
      assert.notInclude(tags(ran.events), "RunFailed")
    })
  )

  it.effect("a bound handler's preliminary results are reported as progress", () =>
    Effect.gen(function* () {
      const agent = Agent.make().pipe(
        Agent.withTool(Long, (_, context) =>
          context.preliminary("half").pipe(Effect.as("whole"))
        ),
        Agent.withLoop(AgentLoop.bounded(2))
      )
      const turns = [
        TestLanguageModel.toolCall("long", {}, { id: "l1" }),
        TestLanguageModel.text("ok")
      ]
      const ran = yield* withSession(turns, agent, ({ session }) =>
        AgentSession.prompt(session, "go")
      )
      const progress = ran.events.filter((e) => e.event._tag === "ToolCallProgress")
      assert.strictEqual(progress.length, 1)
      const succeeded = ran.events.find((e) => e.event._tag === "ToolCallSucceeded")
      assert.isDefined(succeeded)
      if (succeeded?.event._tag === "ToolCallSucceeded") {
        assert.strictEqual(succeeded.event.result, "whole")
      }
    })
  )

  it.effect("a tool's declared dependency is resolved from the environment at call time", () =>
    Effect.gen(function* () {
      const hits = yield* Ref.make(0)
      const agent = Agent.make().pipe(
        Agent.withTool(Counted, () =>
          Effect.flatMap(Counter, (counter) => Ref.updateAndGet(counter.hits, (n) => n + 1))
        ),
        Agent.withLoop(AgentLoop.bounded(2))
      )
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("counted", {}, { id: "c1" }),
        TestLanguageModel.text("ok")
      ])
      yield* Agent.run(agent, "go").pipe(
        Effect.provide(Layer.merge(layer, Layer.succeed(Counter, { hits })))
      )
      assert.strictEqual(yield* Ref.get(hits), 1)
    })
  )

  it.effect("a handler defect is reported as a defect, never swallowed", () =>
    Effect.gen(function* () {
      const agent = Agent.make().pipe(
        Agent.withTool(Echo, () => Effect.die(new Error("boom"))),
        Agent.withLoop(AgentLoop.bounded(2))
      )
      const turns = [
        TestLanguageModel.toolCall("echo", { value: "x" }, { id: "e1" }),
        TestLanguageModel.text("unreachable")
      ]
      const ran = yield* withSession(turns, agent, ({ session }) =>
        Effect.exit(AgentSession.prompt(session, "go"))
      )
      assert.isTrue(ran.value._tag === "Failure")
      const failed = ran.events.find((e) => e.event._tag === "ToolCallFailed")
      assert.isDefined(failed)
      if (failed?.event._tag === "ToolCallFailed") {
        assert.isTrue(failed.event.failure.isDefect)
      }
    })
  )
})

describe("merging into a per-turn toolkit", () => {
  it.effect("the existing toolkit is still resolved every turn, and the bound tool joins each time", () =>
    Effect.gen(function* () {
      const resolutions = yield* Ref.make(0)
      const dynamic = Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(resolutions, (k) => k + 1)
        // The available echo changes per resolution: proof the merge did not
        // freeze the first resolution.
        return yield* Agent.toolkit([Echo], {
          echo: ({ value }) => Effect.succeed(`${value}#${n}`)
        })
      })
      const agent = Agent.make({ toolkit: dynamic, loop: AgentLoop.bounded(4) }).pipe(
        Agent.withTool(Long, () => Effect.succeed("long"))
      )
      const turns = [
        TestLanguageModel.toolCall("echo", { value: "a" }, { id: "e1" }),
        TestLanguageModel.toolCall("echo", { value: "b" }, { id: "e2" }),
        TestLanguageModel.toolCall("long", {}, { id: "l1" }),
        TestLanguageModel.text("done")
      ]
      const ran = yield* withSession(turns, agent, ({ session }) =>
        AgentSession.prompt(session, "go")
      )
      assert.strictEqual(ran.value.turns, 4)
      // One resolution per turn, not one ever.
      assert.strictEqual(yield* Ref.get(resolutions), 4)
      const results = ran.events.flatMap((e) =>
        e.event._tag === "ToolCallSucceeded" ? [e.event.result] : []
      )
      assert.deepStrictEqual(results, ["a#1", "b#2", "long"])
    })
  )

  it.effect("a failing toolkit resolution fails the submission, with the bound tool never consulted", () =>
    Effect.gen(function* () {
      const failing: Effect.Effect<never, "no-capability"> = Effect.fail("no-capability" as const)
      const agent = Agent.make({ toolkit: failing, loop: AgentLoop.bounded(2) }).pipe(
        Agent.withTool(Long, () => Effect.succeed("long"))
      )
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("never")])
      const failure = yield* Effect.flip(Agent.run(agent, "go").pipe(Effect.provide(layer)))
      assert.strictEqual(failure, "no-capability")
    })
  )

  it.effect("withToolkit after withTools replaces, it does not merge", () =>
    Effect.gen(function* () {
      const agent = Agent.make().pipe(
        Agent.withTool(Long, () => Effect.succeed("long")),
        Agent.withToolkit(Agent.toolkit([Echo], { echo: ({ value }) => Effect.succeed(value) })),
        Agent.withLoop(AgentLoop.bounded(2))
      )
      type Tools = typeof agent extends Agent.AgentDefinition<infer T, any, any> ? T : never
      type _OnlyEcho = [keyof Tools] extends ["echo"] ? true : never
      const _check: _OnlyEcho = true
      void _check
      // Resolved, the toolkit knows only echo.
      const resolved = yield* Effect.isEffect(agent.toolkit)
        ? agent.toolkit
        : Effect.succeed(agent.toolkit)
      assert.deepStrictEqual(Object.keys(resolved.tools), ["echo"])
      // And a model that still asks for `long` is producing invalid output
      // for this toolkit, which the harness reports as the provider error it
      // is rather than as a tool the agent has.
      const turns = [TestLanguageModel.toolCall("long", {}, { id: "l1" })]
      const ran = yield* withSession(turns, agent, ({ session }) =>
        Effect.flip(AgentSession.prompt(session, "go"))
      )
      assert.strictEqual(ran.value._tag, "AiError")
    })
  )
})

describe("run and the session lifetime", () => {
  it.effect("interrupting run releases everything: a fresh run on the same agent is not busy", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const agent = Agent.make().pipe(Agent.withLoop(AgentLoop.bounded(2)))
      const { layer } = yield* TestLanguageModel.script([
        { text: "hang", hang: true, started: entered },
        TestLanguageModel.text("second")
      ])
      const first = yield* Effect.forkChild(Agent.run(agent, "one").pipe(Effect.provide(layer)))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(first)
      // The agent is a value; each run is its own session. Nothing about the
      // interrupted run can leak into this one.
      const second = yield* Agent.run(agent, "two").pipe(Effect.provide(layer))
      assert.strictEqual(second.text, "second")
      assert.strictEqual(second.status, "completed")
    })
  )

  it.effect("run with stream: true commits the same history as without", () =>
    Effect.gen(function* () {
      const agent = Agent.make().pipe(Agent.withLoop(AgentLoop.bounded(1)))
      const script = [{ text: "streamed", chunks: ["stre", "amed"] }]
      const a = yield* TestLanguageModel.script(script)
      const b = yield* TestLanguageModel.script(script)
      const streamed = yield* Agent.run(agent, "go", { stream: true }).pipe(Effect.provide(a.layer))
      const batched = yield* Agent.run(agent, "go").pipe(Effect.provide(b.layer))
      assert.strictEqual(streamed.text, batched.text)
      assert.strictEqual(streamed.turns, batched.turns)
    })
  )
})

describe("context transform sugar", () => {
  it.effect("instructions run every turn and sit after the agent's own instructions", () =>
    Effect.gen(function* () {
      const evaluations = yield* Ref.make(0)
      const agent = Agent.make().pipe(
        Agent.withInstructions("static"),
        Agent.withContextTransform(
          ContextTransform.instructions(
            Ref.updateAndGet(evaluations, (n) => n + 1).pipe(Effect.map((n) => `dynamic ${n}`))
          )
        ),
        Agent.withTool(Echo, ({ value }) => Effect.succeed(value)),
        Agent.withLoop(AgentLoop.bounded(3))
      )
      const turns = [
        TestLanguageModel.toolCall("echo", { value: "x" }, { id: "e1" }),
        TestLanguageModel.text("done")
      ]
      const ran = yield* withSession(turns, agent, ({ session, recorder }) =>
        Effect.flatMap(AgentSession.prompt(session, "go"), () => recorder.prompts)
      )
      assert.strictEqual(yield* Ref.get(evaluations), 2)
      const systems = (prompt: (typeof ran.value)[number]) =>
        prompt.content.filter((m) => m.role === "system").map((m) => m.content)
      assert.deepStrictEqual(systems(ran.value[0]!), ["static", "dynamic 1"])
      assert.deepStrictEqual(systems(ran.value[1]!), ["static", "dynamic 2"])
      // Canonical history never sees the dynamic line.
      const history = yield* AgentSession.history(ran.session)
      assert.deepStrictEqual(
        history.content.filter((m) => m.role === "system").map((m) => m.content),
        ["static"]
      )
    })
  )

  it.effect("a failing instructions effect fails the turn with its own error", () =>
    Effect.gen(function* () {
      const agent = Agent.make().pipe(
        Agent.withContextTransform(ContextTransform.instructions(Effect.fail("no creds" as const)))
      )
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("never")])
      const failure = yield* Effect.flip(Agent.run(agent, "go").pipe(Effect.provide(layer)))
      assert.strictEqual(failure, "no creds")
    })
  )
})

describe("agent values", () => {
  it("a spread keeps pipe, and combinators never mutate their input", () => {
    const agent = Agent.make({ instructions: "x" })
    const copy = { ...agent }
    const piped = copy.pipe(Agent.withInstructions("y"))
    assert.deepStrictEqual(piped.instructions._tag, "Some")
    // And the original is untouched: combinators are pure.
    assert.strictEqual(agent.instructions._tag === "Some" ? agent.instructions.value : "", "x")
  })

  it.effect("make({ tools: [] }) resolves to the same empty toolkit as make()", () =>
    Effect.gen(function* () {
      const resolve = (agent: Agent.AgentDefinition<any, never, never>) =>
        Effect.isEffect(agent.toolkit) ? agent.toolkit : Effect.succeed(agent.toolkit)
      const empty = yield* resolve(Agent.make({ tools: [] }))
      const bare = yield* resolve(Agent.make())
      assert.deepStrictEqual(Object.keys(empty.tools), [])
      assert.deepStrictEqual(Object.keys(bare.tools), [])
    })
  )
})
