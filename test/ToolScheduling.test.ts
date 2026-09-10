import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import * as ToolScheduling from "../src/ToolScheduling.js"
import { withSession } from "./helpers.js"

/**
 * Item 105: host scheduling tightens the agent's concurrency and never widens
 * it. Every test instruments how many calls were in flight at once, per tool
 * and overall, and asserts on the maximum seen.
 */

const BookRoom = Tool.make("book_room", { parameters: Schema.Struct({ room: Schema.String }), success: Schema.String })
const Read = Tool.make("read", { parameters: Schema.Struct({ path: Schema.String }), success: Schema.String })

/** In-flight counters, and the maximum each reached. */
const meter = Effect.gen(function*() {
  const state = yield* Ref.make({ rooms: 0, all: 0, maxRooms: 0, maxAll: 0 })
  const enter = (room: boolean) =>
    Ref.update(state, (s) => {
      const rooms = s.rooms + (room ? 1 : 0)
      const all = s.all + 1
      return { rooms, all, maxRooms: Math.max(s.maxRooms, rooms), maxAll: Math.max(s.maxAll, all) }
    })
  const leave = (room: boolean) =>
    Ref.update(state, (s) => ({ ...s, rooms: s.rooms - (room ? 1 : 0), all: s.all - 1 }))
  // Long enough that calls started together are certainly in flight together.
  const busy = (room: boolean) =>
    Effect.acquireUseRelease(enter(room), () => Effect.sleep("40 millis"), () => leave(room))
  return { busy, read: Ref.get(state) }
})

const agentWith = (busy: (room: boolean) => Effect.Effect<void>) =>
  Agent.make({
    tools: [
      Agent.tool(BookRoom, ({ room }) => Effect.as(busy(true), `booked ${room}`)),
      Agent.tool(Read, ({ path }) => Effect.as(busy(false), `read ${path}`))
    ],
    toolExecution: ToolExecution.Parallel
  })

/** Two bookings and a read in one response, which `Parallel` starts together. */
const batch = [
  {
    toolCalls: [
      { id: "b1", name: "book_room", params: { room: "a" } },
      { id: "b2", name: "book_room", params: { room: "b" } },
      { id: "r1", name: "read", params: { path: "x" } }
    ]
  },
  { text: "done" }
]

const rooms = ToolScheduling.serialize("rooms", (call) => call.name === "book_room" ? "rooms" : undefined)

describe("ToolScheduling (item 105)", () => {
  it.live("unconstrained by default: Parallel overlaps everything", () =>
    Effect.gen(function*() {
      // The control: without it, "never overlapped" below could be an
      // accident of the fake model rather than the scheduling.
      const { busy, read } = yield* meter
      yield* withSession(batch, agentWith(busy), ({ session }) => AgentSession.prompt(session, "go"))
      const seen = yield* read
      assert.strictEqual(seen.maxRooms, 2)
      assert.strictEqual(seen.maxAll, 3)
    }))

  it.live("serialize holds keyed calls apart and leaves the rest concurrent", () =>
    Effect.gen(function*() {
      const { busy, read } = yield* meter
      const { events } = yield* withSession(batch, agentWith(busy), ({ session }) => AgentSession.prompt(session, "go"))
        .pipe(Effect.provide(ToolScheduling.layer(rooms)))
      const seen = yield* read
      assert.strictEqual(seen.maxRooms, 1, "two bookings overlapped")
      assert.strictEqual(seen.maxAll, 2, "the read should still overlap a booking")
      // Tightening changes when calls run, not what the turn records: every
      // call still succeeds, in the order the model asked.
      const succeeded = events.flatMap((e) => AgentEvent.is("ToolCallSucceeded")(e) ? [e.event.id] : [])
      assert.deepStrictEqual([...succeeded].sort(), ["b1", "b2", "r1"])
    }))

  it.live("one serialize value holds calls apart across sessions, which a strategy cannot", () =>
    Effect.gen(function*() {
      // `ToolExecution.perTool` is scoped to one response; host scheduling is
      // as wide as the value provided.
      const { busy, read } = yield* meter
      const one = [{ toolCalls: [{ id: "b1", name: "book_room", params: { room: "a" } }] }, { text: "done" }]
      yield* Effect.all(
        [
          withSession(one, agentWith(busy), ({ session }) => AgentSession.prompt(session, "go")),
          withSession(one, agentWith(busy), ({ session }) => AgentSession.prompt(session, "go"))
        ],
        { concurrency: "unbounded" }
      ).pipe(Effect.provide(ToolScheduling.layer(rooms)))
      assert.strictEqual((yield* read).maxRooms, 1)
    }))

  it.live("maxConcurrent bounds every call, and cannot widen a Sequential agent", () =>
    Effect.gen(function*() {
      const wide = yield* meter
      yield* withSession(batch, agentWith(wide.busy), ({ session }) => AgentSession.prompt(session, "go"))
        .pipe(Effect.provide(ToolScheduling.layer(ToolScheduling.maxConcurrent(2))))
      assert.strictEqual((yield* wide.read).maxAll, 2)

      // Tighten, never widen: a host allowing ten does not make a
      // Sequential agent run two at once.
      const narrow = yield* meter
      yield* withSession(
        batch,
        agentWith(narrow.busy).pipe(Agent.withToolExecution(ToolExecution.Sequential)),
        ({ session }) => AgentSession.prompt(session, "go")
      ).pipe(Effect.provide(ToolScheduling.layer(ToolScheduling.maxConcurrent(10))))
      assert.strictEqual((yield* narrow.read).maxAll, 1)
    }))

  it.live("all applies every constraint", () =>
    Effect.gen(function*() {
      const { busy, read } = yield* meter
      yield* withSession(batch, agentWith(busy), ({ session }) => AgentSession.prompt(session, "go"))
        .pipe(Effect.provide(ToolScheduling.layer(ToolScheduling.all(rooms, ToolScheduling.maxConcurrent(1)))))
      const seen = yield* read
      assert.strictEqual(seen.maxAll, 1)
      assert.deepStrictEqual(
        ToolScheduling.all(rooms, ToolScheduling.maxConcurrent(1)).description,
        { _tag: "All", schedulings: [{ _tag: "Serialize", name: "rooms" }, { _tag: "MaxConcurrent", max: 1 }] }
      )
    }))

  it("maxConcurrent refuses a limit that would wait forever", () => {
    assert.throws(() => ToolScheduling.maxConcurrent(0), RangeError)
    assert.throws(() => ToolScheduling.maxConcurrent(1.5), RangeError)
  })
})
