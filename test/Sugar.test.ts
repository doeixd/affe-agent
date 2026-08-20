import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import { withSession } from "./helpers.js"

describe("Agent.toolkit", () => {
  it.effect("builds and binds in one step, with inferred handlers", () =>
    Effect.gen(function* () {
      const Add = Tool.make("add", {
        parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
        success: Schema.Number
      })
      const Shout = Tool.make("shout", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String
      })

      // No annotations: `a`, `b` and `text` come from the schemas, and the
      // return types are checked against `success`.
      const toolkit = yield* Agent.toolkit([Add, Shout], {
        add: ({ a, b }) => Effect.succeed(a + b),
        shout: ({ text }) => Effect.succeed(text.toUpperCase())
      })

      const { events } = yield* withSession(
        [
          {
            toolCalls: [
              { id: "t1", name: "add", params: { a: 2, b: 3 } },
              { id: "t2", name: "shout", params: { text: "hi" } }
            ]
          },
          { text: "done" }
        ],
        Agent.make({ toolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const results = events
        .filter(AgentEvent.is("ToolCallSucceeded"))
        .map((e) => e.event.result)
        .sort()
      assert.deepStrictEqual(results, [5, "HI"])
    })
  )
})

describe("AgentLoop.bounded", () => {
  it.effect("runs until idle but never past the bound", () =>
    Effect.gen(function* () {
      const Ping = Tool.make("ping", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const toolkit = yield* Agent.toolkit([Ping], {
        ping: () => Effect.succeed("pong")
      })

      const toolTurn = { toolCalls: [{ id: "p", name: "ping", params: {} }] }
      const { events } = yield* withSession(
        [toolTurn, toolTurn, toolTurn, toolTurn],
        Agent.make({ toolkit, loop: AgentLoop.bounded(2) }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      assert.strictEqual(
        events.filter(AgentEvent.is("RunCompleted"))[0]!.event.turns,
        2
      )
    })
  )

  it.effect("still stops early when the model goes idle", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ text: "done" }],
        Agent.make({ loop: AgentLoop.bounded(20) }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      assert.strictEqual(
        events.filter(AgentEvent.is("RunCompleted"))[0]!.event.turns,
        1
      )
    })
  )
})

describe("ContextTransform system messages", () => {
  it.effect("injects a per-turn instruction without touching history", () =>
    Effect.gen(function* () {
      const clock = yield* Ref.make(0)

      // The canonical dynamic-instruction case: recomputed every turn.
      const withTurnInfo = ContextTransform.appendSystem((context) =>
        Effect.map(
          Ref.updateAndGet(clock, (n) => n + 1),
          (tick) => `turn ${context.turnIndex}, tick ${tick}`
        )
      )

      const { recorder, session } = yield* withSession(
        [{ text: "one" }, { text: "two" }],
        Agent.make({
          contextTransform: withTurnInfo,
          loop: AgentLoop.make((state) =>
            Effect.succeed(
              state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
            )
          )
        }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const prompts = yield* recorder.prompts
      const systemOf = (prompt: Prompt.Prompt) =>
        prompt.content
          .filter((m): m is Prompt.SystemMessage => m.role === "system")
          .map((m) => m.content)

      assert.deepStrictEqual(systemOf(prompts[0]!), ["turn 1, tick 1"])
      assert.deepStrictEqual(systemOf(prompts[1]!), ["turn 2, tick 2"])

      // And none of it reached canonical history.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(systemOf(history), [])
    })
  )

  it.effect("composes with other transforms in order", () =>
    Effect.gen(function* () {
      const first = ContextTransform.appendSystem(() => Effect.succeed("first"))
      const second = ContextTransform.appendSystem(() =>
        Effect.succeed("second")
      )

      const { recorder } = yield* withSession(
        [{ text: "ok" }],
        Agent.make({ contextTransform: ContextTransform.compose(first, second) }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const prompt = (yield* recorder.prompts)[0]!
      assert.deepStrictEqual(
        prompt.content
          .filter((m): m is Prompt.SystemMessage => m.role === "system")
          .map((m) => m.content),
        ["first", "second"]
      )
    })
  )
})

describe("AgentEvent.match", () => {
  it.effect("dispatches by tag with typed payloads", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<string>>([])

      const handle = AgentEvent.match({
        // `event` is narrowed, so `.name` and `.turns` are available without
        // casting or re-checking the tag.
        ToolCallStarted: (event) =>
          Ref.update(seen, (all) => [...all, "started:" + event.name]),
        RunCompleted: (event, envelope) =>
          Ref.update(seen, (all) => [
            ...all,
            "run:" + event.turns + "@" + envelope.sequence
          ]),
        orElse: () => Effect.void
      })

      const Ping = Tool.make("ping", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const toolkit = yield* Agent.toolkit([Ping], {
        ping: () => Effect.succeed("pong")
      })

      yield* withSession(
        [
          { toolCalls: [{ id: "p", name: "ping", params: {} }] },
          { text: "done" }
        ],
        Agent.make({ toolkit }),
        ({ events, session }) =>
          Effect.gen(function* () {
            yield* AgentSession.prompt(session, "go")
            yield* Stream.runForEach(Stream.fromIterable(yield* events), handle)
          })
      )

      const observed = yield* Ref.get(seen)
      assert.include(observed, "started:ping")
      assert.isTrue(observed.some((entry) => entry.startsWith("run:2@")))
    })
  )
})
