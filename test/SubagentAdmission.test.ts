import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Subagent } from "../src/subagent/index.js"
import { AgentProbe } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 111: a delegation is admitted before its child opens -- by depth,
 * counted across every subagent tool, and by this tool's concurrency.
 */

const delegate = (id: string, to: string) => ({ toolCalls: [{ id, name: to, params: { prompt: "go deeper" } }] })

describe("subagent admission (item 111)", () => {
  it.effect("delegation stops at the depth limit, with an error the delegating model reads", () =>
    Effect.gen(function* () {
      // parent -> one (depth 1) -> two (depth 2) -> three would be depth 3.
      const threeModel = yield* FakeModel.layer([{ text: "never asked" }])
      const three = Subagent.tool("three", Agent.make({}), {
        description: "Level three.",
        provide: threeModel.layer,
        maxDepth: 2
      })
      const twoModel = yield* FakeModel.layer([delegate("t", "three"), { text: "two answered without three" }])
      const two = Subagent.tool("two", Agent.make({ tools: [three], loop: AgentLoop.bounded(3) }), {
        description: "Level two.",
        provide: twoModel.layer,
        maxDepth: 2
      })
      const oneModel = yield* FakeModel.layer([delegate("o", "two"), { text: "one done" }])
      const one = Subagent.tool("one", Agent.make({ tools: [two], loop: AgentLoop.bounded(3) }), {
        description: "Level one.",
        provide: oneModel.layer,
        maxDepth: 2
      })
      const { layer: parentModel } = yield* FakeModel.layer([delegate("p", "one"), { text: "parent done" }])
      const result = yield* Effect.scoped(
        Effect.flatMap(
          AgentSession.make(Agent.make({ tools: [one], loop: AgentLoop.bounded(3) })),
          (session) => AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(parentModel))

      assert.strictEqual(result.text, "parent done")
      // Level three never opened: its model was never called.
      assert.strictEqual((yield* threeModel.recorder.prompts).length, 0)
      // Level two's model read the refusal on its second turn, and answered.
      const twoPrompts = yield* twoModel.recorder.prompts
      assert.strictEqual(twoPrompts.length, 2)
      const seen = JSON.stringify(twoPrompts[1])
      assert.include(seen, "would run 3 delegations deep, and the limit is 2")
    }))

  it.effect("the default limit is eight: a ninth-level delegation is refused", () =>
    Effect.gen(function* () {
      // Built from the bottom: level 9's tool is on level 8's agent. No
      // `maxDepth` anywhere -- this is the default at work.
      const deepest = yield* FakeModel.layer([{ text: "never asked" }])
      let tool = Subagent.tool("level9", Agent.make({}), { description: "Level 9.", provide: deepest.layer })
      const models: Array<FakeModel.Recorder> = []
      for (let level = 8; level >= 1; level--) {
        const model = yield* FakeModel.layer([delegate(`l${level}`, `level${level + 1}`), { text: `level ${level} done` }])
        models.unshift(model.recorder)
        tool = Subagent.tool(`level${level}`, Agent.make({ tools: [tool], loop: AgentLoop.bounded(3) }), {
          description: `Level ${level}.`,
          provide: model.layer
        })
      }
      const { layer: parentModel } = yield* FakeModel.layer([delegate("p", "level1"), { text: "parent done" }])
      const result = yield* Effect.scoped(
        Effect.flatMap(
          AgentSession.make(Agent.make({ tools: [tool], loop: AgentLoop.bounded(3) })),
          (session) => AgentSession.prompt(session, "go")
        )
      ).pipe(Effect.provide(parentModel))
      assert.strictEqual(result.text, "parent done")
      assert.strictEqual((yield* deepest.recorder.prompts).length, 0)
      assert.include(
        JSON.stringify((yield* models[7]!.prompts)[1]),
        `would run ${Subagent.defaultMaxDepth + 1} delegations deep`
      )
    }))

  it.effect("concurrency waits for a slot rather than refusing: a parallel batch completes, two at a time", () =>
    Effect.gen(function* () {
      let open = 0
      let peak = 0
      const gate = yield* Deferred.make<void>()
      const during = Effect.gen(function* () {
        open++
        peak = Math.max(peak, open)
        yield* Deferred.await(gate)
        open--
      })
      const childModel = yield* FakeModel.layer(Array.from({ length: 5 }, () => ({ text: "found", during })))
      const research = Subagent.tool("research", Agent.make({}), {
        description: "Research.",
        provide: childModel.layer,
        maxConcurrent: 2
      })
      const { layer: parentModel } = yield* FakeModel.layer([
        { toolCalls: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, name: "research", params: { prompt: `q${i}` } })) },
        { text: "all in" }
      ])
      const { result, events } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({ tools: [research], loop: AgentLoop.bounded(3) }))
          const probe = yield* AgentProbe.make(session)
          const fiber = yield* Effect.forkChild(AgentSession.prompt(session, "go"))
          // Let every call that can start, start: two, and the rest wait.
          for (let i = 0; i < 20; i++) yield* Effect.yieldNow
          assert.strictEqual(open, 2)
          yield* Deferred.succeed(gate, void 0)
          const result = yield* Fiber.join(fiber)
          return { result, events: yield* probe.events }
        })
      ).pipe(Effect.provide(parentModel))
      assert.strictEqual(result.text, "all in")
      assert.strictEqual(peak, 2)
      const succeeded = events.filter((e) => AgentEvent.is("ToolCallSucceeded")(e))
      assert.strictEqual(succeeded.length, 5)
    }))

  it.effect("limits that are not positive integers are refused at construction", () =>
    Effect.gen(function* () {
      const { layer } = yield* FakeModel.layer([])
      const base = { description: "x", provide: layer }
      assert.throws(() => Subagent.tool("a", Agent.make({}), { ...base, maxDepth: 0 }), RangeError)
      assert.throws(() => Subagent.tool("a", Agent.make({}), { ...base, maxConcurrent: 1.5 }), RangeError)
    }))
})
