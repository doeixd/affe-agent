import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Subagent } from "../src/subagent/index.js"
import { AgentProbe } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * `plan-streaming.md` P3: a child's events on the parent's stream, opt-in.
 *
 * A subagent runs on a bus of its own, so a parent's consumers saw
 * `ToolCallStarted`, silence, then the result. `Inherit.events: "parent"`
 * gives the child a sink that re-emits every envelope of its bus onto the
 * parent's, wrapped in one `DelegatedEvent` naming the tool and the call, with
 * the child's envelope inside untouched. The rows hold what the plan promised:
 * the wrapper carries the parent's correlation and a parent sequence; the
 * child's terminal events are the child's and end nothing of the parent's;
 * nested delegation wraps once per forwarding edge; the default forwards
 * nothing; and the envelope crosses the wire, an unknown inner tag included.
 */
const delegated = (events: ReadonlyArray<AgentEvent.AgentEventEnvelope>) =>
  events.filter(AgentEvent.is("DelegatedEvent"))

const run = (inherit: Subagent.Inherit | undefined) =>
  Effect.gen(function* () {
    const child = Agent.make({ instructions: "child", loop: AgentLoop.bounded(2) })
    const childModel = yield* FakeModel.layer([{ text: "the child found it" }])
    const research = Subagent.tool("research", child, {
      description: "Delegate research.",
      provide: childModel.layer,
      inherit
    })
    const parent = Agent.make({ instructions: "Delegate.", tools: [research], loop: AgentLoop.bounded(3) })
    const { layer: parentModel } = yield* FakeModel.script([
      { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
      { text: "the parent answered" }
    ])
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* AgentSession.make(parent)
        const probe = yield* AgentProbe.make(session)
        const result = yield* session.prompt("go")
        return { events: yield* probe.events, text: result.text, sessionId: session.id }
      })
    ).pipe(Effect.provide(parentModel))
  })

describe("a child's events on the parent's stream", () => {
  it.effect("`events: \"parent\"`: every envelope of the child's bus, wrapped, inside the delegating call", () =>
    Effect.gen(function* () {
      const { events, sessionId, text } = yield* run({ events: "parent" })
      assert.strictEqual(text, "the parent answered")

      const wrapped = delegated(events)
      assert.isAbove(wrapped.length, 0)
      // The wrapper is the parent's: its session, its submission, a sequence
      // in the parent's order, the delegating tool and call.
      const parentSubmission = Option.getOrThrow(events[0]!.submissionId)
      for (const envelope of wrapped) {
        assert.strictEqual(envelope.sessionId, sessionId)
        assert.deepStrictEqual(envelope.submissionId, Option.some(parentSubmission))
        assert.strictEqual(envelope.event.tool, "research")
        assert.strictEqual(envelope.event.toolCallId, "r1")
      }
      // The inside is the child's, untouched: one other session, its own
      // sequence from 1, its own boundaries.
      const inner = wrapped.map((e) => e.event.envelope)
      const childSessions = new Set(inner.map((e) => e.sessionId))
      assert.strictEqual(childSessions.size, 1)
      assert.notStrictEqual([...childSessions][0], sessionId)
      assert.deepStrictEqual(inner.map((e) => e.sequence), inner.map((_, i) => i + 1))
      const innerTags = inner.map((e) => e.event._tag)
      // From the child's very first envelope: the sink is synchronous, so
      // even the session-level opening is seen.
      assert.strictEqual(innerTags[0], "SessionStarted")
      assert.strictEqual(innerTags[1], "SubmissionStarted")
      assert.include(innerTags, "MessageCompleted")
      assert.include(innerTags, "SubmissionCompleted")
      assert.strictEqual(innerTags[innerTags.length - 1], "SessionClosed")

      // Between the call's start and its result, and the child's terminal
      // events ended nothing of the parent's.
      const tags = events.map((e) => e.event._tag)
      const first = tags.indexOf("DelegatedEvent")
      const last = tags.lastIndexOf("DelegatedEvent")
      assert.isAbove(first, tags.indexOf("ToolCallStarted"))
      assert.isBelow(last, tags.indexOf("ToolCallSucceeded"))
      assert.strictEqual(tags[tags.length - 1], "SubmissionCompleted")
      assert.strictEqual(tags.filter((t) => t === "SubmissionCompleted").length, 1)
      // Parent sequences stay strictly increasing across the wrapped ones.
      const sequences = events.map((e) => e.sequence)
      assert.deepStrictEqual(sequences, [...sequences].sort((a, b) => a - b))
      assert.strictEqual(new Set(sequences).size, sequences.length)
    })
  )

  it.effect("the default forwards nothing", () =>
    Effect.gen(function* () {
      const { events } = yield* run(undefined)
      assert.deepStrictEqual(delegated(events), [])
      const explicit = yield* run({ events: "none" })
      assert.deepStrictEqual(delegated(explicit.events), [])
    })
  )

  it.effect("nested delegation wraps once per forwarding edge", () =>
    Effect.gen(function* () {
      const grandchild = Agent.make({ instructions: "grandchild", loop: AgentLoop.bounded(2) })
      const grandchildModel = yield* FakeModel.layer([{ text: "deep answer" }])
      const deep = Subagent.tool("deep", grandchild, {
        description: "Go deeper.",
        provide: grandchildModel.layer,
        inherit: { events: "parent" }
      })
      const child = Agent.make({ instructions: "child", tools: [deep], loop: AgentLoop.bounded(3) })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "d1", name: "deep", params: { prompt: "deeper" } }] },
        { text: "child answer" }
      ])
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer,
        inherit: { events: "parent" }
      })
      const parent = Agent.make({ instructions: "Delegate.", tools: [research], loop: AgentLoop.bounded(3) })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])
      const events = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(parent)
          const probe = yield* AgentProbe.make(session)
          yield* session.prompt("go")
          return yield* probe.events
        })
      ).pipe(Effect.provide(parentModel))

      const twice = delegated(events).flatMap((outer) => {
        const inner = outer.event.envelope.event
        return inner._tag === "DelegatedEvent" ? [{ outer: outer.event, inner }] : []
      })
      assert.isAbove(twice.length, 0)
      for (const { inner, outer } of twice) {
        assert.strictEqual(outer.tool, "research")
        assert.strictEqual(outer.toolCallId, "r1")
        assert.strictEqual(inner.tool, "deep")
        assert.strictEqual(inner.toolCallId, "d1")
      }
      const deepest = twice.map(({ inner }) => inner.envelope.event._tag)
      assert.include(deepest, "MessageCompleted")
      assert.include(deepest, "SubmissionCompleted")
      // Three sessions, one per level.
      const sessions = new Set([
        ...events.map((e) => e.sessionId),
        ...delegated(events).map((e) => e.event.envelope.sessionId),
        ...twice.map(({ inner }) => inner.envelope.sessionId)
      ])
      assert.strictEqual(sessions.size, 3)
    })
  )

  it.effect("a child made outside any tool execution forwards nowhere", () =>
    Effect.gen(function* () {
      // `ParentEvents` is `None` outside a handler, so a child that asks to
      // forward has nothing to forward to and runs as it would have.
      const child = Agent.make({ instructions: "child" })
      const { layer } = yield* FakeModel.script([{ text: "alone" }])
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(child)
          return yield* session.prompt("go")
        })
      ).pipe(Effect.provide(layer))
      assert.strictEqual(result.text, "alone")
    })
  )

  it("the wire projection reaches the wrapped envelope", () => {
    // `toWire` replaces a decoded tool result with its JSON; a child's result
    // crosses the same wire and is projected the same way.
    const decoded = new Date(0)
    const envelope: AgentEvent.AgentEventEnvelope = {
      sessionId: AgentEvent.SessionId.make("parent"),
      submissionId: Option.none(),
      runId: Option.none(),
      turn: Option.none(),
      sequence: 1,
      event: {
        _tag: "DelegatedEvent",
        tool: "research",
        toolCallId: "r1",
        envelope: {
          sessionId: AgentEvent.SessionId.make("child"),
          submissionId: Option.none(),
          runId: Option.none(),
          turn: Option.none(),
          sequence: 1,
          event: { _tag: "ToolCallSucceeded", id: "t1", name: "when", result: decoded, encodedResult: "1970-01-01T00:00:00.000Z" }
        }
      }
    }
    const wire = AgentEvent.toWire(envelope)
    assert.strictEqual(wire.event._tag, "DelegatedEvent")
    if (wire.event._tag === "DelegatedEvent" && wire.event.envelope.event._tag === "ToolCallSucceeded") {
      assert.strictEqual(wire.event.envelope.event.result, "1970-01-01T00:00:00.000Z")
    } else {
      assert.fail("the inner event was not the tool result")
    }
  })

  it.effect("crosses the wire, an unknown inner tag included", () =>
    Effect.gen(function* () {
      const childEnvelope: AgentEvent.AgentEventEnvelope = {
        sessionId: AgentEvent.SessionId.make("child"),
        submissionId: Option.some(AgentEvent.SubmissionId.make("child:submission-1")),
        runId: Option.none(),
        turn: Option.some(1),
        sequence: 3,
        event: { _tag: "MessageDelta", kind: "text", delta: "hi" }
      }
      const envelope: AgentEvent.AgentEventEnvelope = {
        sessionId: AgentEvent.SessionId.make("parent"),
        submissionId: Option.some(AgentEvent.SubmissionId.make("parent:submission-1")),
        runId: Option.none(),
        turn: Option.some(1),
        sequence: 9,
        event: { _tag: "DelegatedEvent", tool: "research", toolCallId: "r1", envelope: childEnvelope }
      }
      const encoded = yield* Schema.encodeEffect(AgentEvent.AgentEventEnvelope)(envelope)
      const decoded = yield* Schema.decodeEffect(AgentEvent.AgentEventEnvelope)(encoded)
      assert.deepStrictEqual(decoded, envelope)

      // A newer child's event a parent's build does not know arrives inside
      // as `UnknownEvent`, exactly as it would at the top level.
      const newer: unknown = {
        ...encoded,
        event: {
          _tag: "DelegatedEvent",
          tool: "research",
          toolCallId: "r1",
          envelope: { ...childEnvelope, event: { _tag: "SomethingNewer", a: 1 } }
        }
      }
      const tolerant = yield* Schema.decodeUnknownEffect(AgentEvent.AgentEventEnvelope)(newer)
      assert.strictEqual(tolerant.event._tag, "DelegatedEvent")
      if (tolerant.event._tag === "DelegatedEvent") {
        assert.deepStrictEqual(tolerant.event.envelope.event, {
          _tag: "UnknownEvent",
          originalTag: "SomethingNewer",
          payload: { _tag: "SomethingNewer", a: 1 }
        })
      }
    })
  )
})
