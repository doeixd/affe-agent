import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Memory } from "../src/memory/index.js"
import * as Permission from "../src/Permission.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Long-term memory. The service contract is exercised directly (the in-memory
 * built-in recalls by keyword, scoped), recall's non-fatal contract is pinned
 * against a deliberately broken backend, and the whole loop runs in a session:
 * a remembered fact from one session is recalled into the next. A custom
 * `Memory` provided as a plain layer proves the service is the seam.
 */

describe("Memory service (in-memory built-in)", () => {
  it.effect("recall matches by keyword within a scope, best first, and stays scoped", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory
        yield* memory.remember("alice", { content: "Alice prefers dark mode." })
        yield* memory.remember("alice", { content: "Alice's timezone is CET." })
        yield* memory.remember("bob", { content: "Bob prefers light mode." })
        return {
          darkForAlice: yield* memory.recall("alice", "what mode does the user like"),
          crossScope: yield* memory.recall("bob", "timezone")
        }
      }).pipe(Effect.provide(Memory.layer()))

      assert.deepStrictEqual(result.darkForAlice.entries, [{ content: "Alice prefers dark mode." }])
      // Bob's scope never sees Alice's timezone note.
      assert.deepStrictEqual(result.crossScope.entries, [])
    })
  )

  it.effect("an empty or too-short query recalls nothing rather than everything", () =>
    Effect.gen(function* () {
      const empty = yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory
        yield* memory.remember("s", { content: "a fact" })
        return yield* memory.recall("s", "  a  ")
      }).pipe(Effect.provide(Memory.layer()))
      assert.deepStrictEqual(empty.entries, [])
    })
  )

  it.effect("more query words matched ranks an entry higher", () =>
    Effect.gen(function* () {
      const ranked = yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory
        yield* memory.remember("s", { content: "Alice enjoys mountains" })
        yield* memory.remember("s", { content: "Alice loves hiking and mountain trips" })
        return yield* memory.recall("s", "mountain hiking trips")
      }).pipe(Effect.provide(Memory.layer()))
      // The three-hit entry outranks the one-hit entry -- the sort is load-bearing.
      assert.deepStrictEqual(ranked.entries, [
        { content: "Alice loves hiking and mountain trips" },
        { content: "Alice enjoys mountains" }
      ])
    })
  )
})

describe("Memory.recall transform", () => {
  // A backend that always fails, to prove recall is non-fatal.
  const broken = Layer.succeed(Memory.Memory, {
    recall: () => Effect.fail(new Memory.MemoryError({ reason: "backend down" })),
    remember: () => Effect.void
  })

  it.effect("a broken backend degrades the run rather than failing it", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("answered anyway")])
      const agent = Agent.make({
        instructions: "Help.",
        loop: AgentLoop.bounded(2),
        contextTransform: Memory.recall("alice")
      })
      const result = yield* Effect.flatMap(AgentSession.make(agent), (s) => s.prompt("hello there")).pipe(
        Effect.provide(Layer.merge(broken, layer)),
        Effect.scoped
      )
      // The run completed; the recall failure did not surface.
      assert.strictEqual(result.text, "answered anyway")
    })
  )
})

describe("Memory.rememberTool", () => {
  it.effect("projects to a memory action on the content, so a policy can gate writes", () => {
    const projection = Permission.projectionOf(Memory.rememberTool("alice").tool)
    assert.strictEqual(projection.action, "memory")
    assert.strictEqual(projection.resource({ content: "a fact" }), "a fact")
    return Effect.void
  })

  it.effect("a store failure reaches the model as a failed tool result, not a defect", () =>
    Effect.gen(function* () {
      const broken = Layer.succeed(Memory.Memory, {
        recall: () => Effect.succeed({ entries: [] }),
        remember: () => Effect.fail(new Memory.MemoryError({ reason: "disk full" }))
      })
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "r1", name: "remember", params: { content: "a fact" } }] },
        TestLanguageModel.text("could not save")
      ])
      const agent = Agent.make({
        instructions: "save",
        tools: [Memory.rememberTool("alice")],
        loop: AgentLoop.bounded(4)
      })
      const { history, result } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("go")
        return { result, history: yield* session.history }
      }).pipe(Effect.provide(Layer.merge(broken, layer)), Effect.scoped)

      // The run finished; the write surfaced as a failure the model could read.
      assert.strictEqual(result.text, "could not save")
      const toolResults = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      const failure = toolResults[0]
      assert.isTrue(failure !== undefined && failure.type === "tool-result" && failure.isFailure)
      assert.include(JSON.stringify(failure), "disk full")
    })
  )
})

describe("Memory.writer", () => {
  it.effect("saves nothing when the extractor returns None", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<string>>([])
      const custom = Layer.succeed(Memory.Memory, {
        recall: () => Effect.succeed({ entries: [] }),
        remember: (_scope, entry) => Ref.update(saved, (all) => [...all, entry.content])
      })
      const writerLoop = Memory.writer<Record<string, never>>("alice", () => Option.none())
      const agent = Agent.make({
        instructions: "work",
        loop: AgentLoop.and(writerLoop, AgentLoop.bounded(2))
      })
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("done")])
      yield* Effect.flatMap(AgentSession.make(agent), (s) => s.prompt("go")).pipe(
        Effect.provide(Layer.merge(custom, layer)),
        Effect.scoped
      )
      assert.deepStrictEqual(yield* Ref.get(saved), [])
    })
  )
})

describe("Memory across sessions", () => {
  it.effect("a fact remembered in one session is recalled into the next", () =>
    Effect.gen(function* () {
      const writer = Agent.make({
        instructions: "Save what you learn.",
        tools: [Memory.rememberTool("alice")],
        loop: AgentLoop.bounded(4)
      })
      const reader = Agent.make({
        instructions: "Answer using what you know.",
        loop: AgentLoop.bounded(2),
        contextTransform: Memory.recall("alice", { query: () => "which mode does the user prefer" })
      })

      // Both sessions run inside one scope that provides the memory once, the
      // way a real (shared) backend would be provided -- the in-memory built-in
      // makes a fresh store per build, so sharing means one provide over both.
      const prompts = yield* Effect.gen(function* () {
        // Session one: the model saves a fact.
        const write = yield* TestLanguageModel.script([
          { toolCalls: [{ id: "r1", name: "remember", params: { content: "Alice prefers dark mode." } }] },
          TestLanguageModel.text("noted")
        ])
        yield* Effect.flatMap(AgentSession.make(writer), (s) => s.prompt("go")).pipe(
          Effect.provide(write.layer),
          Effect.scoped
        )
        // Session two: a different agent that recalls, no tools.
        const read = yield* TestLanguageModel.script([TestLanguageModel.text("dark mode")])
        yield* Effect.flatMap(AgentSession.make(reader), (s) => s.prompt("which mode?")).pipe(
          Effect.provide(read.layer),
          Effect.scoped
        )
        return yield* read.recorder.prompts
      }).pipe(Effect.provide(Memory.layer()), Effect.scoped)

      // The second session's prompt carried the fact the first session saved.
      assert.include(JSON.stringify(prompts[0]), "Alice prefers dark mode.")
    })
  )

  it.effect("a custom Memory implementation provided as a layer works the same", () =>
    Effect.gen(function* () {
      // Bring-your-own: nothing here is the built-in. The service is the seam.
      const saved = yield* Ref.make<ReadonlyArray<string>>([])
      const custom = Layer.effect(
        Memory.Memory,
        Effect.succeed<Memory.MemoryShape>({
          remember: (_scope, entry) => Ref.update(saved, (all) => [...all, entry.content]),
          recall: (_scope, _query) =>
            Ref.get(saved).pipe(Effect.map((all) => ({ entries: all.map((content) => ({ content })) })))
        })
      )

      const writerLoop = Memory.writer<Record<string, never>>("alice", () =>
        Option.some({ content: "learned during the turn" }))
      const agent = Agent.make({
        instructions: "work",
        // The writer runs first so it fires on every turn, including the last.
        loop: AgentLoop.and(writerLoop, AgentLoop.bounded(2))
      })
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("done")])
      yield* Effect.flatMap(AgentSession.make(agent), (s) => s.prompt("go")).pipe(
        Effect.provide(Layer.merge(custom, layer)),
        Effect.scoped
      )

      // The writer recorded through the custom backend.
      assert.deepStrictEqual(yield* Ref.get(saved), ["learned during the turn"])
    })
  )
})
