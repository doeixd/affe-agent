import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Compaction } from "../src/compaction/index.js"
import { AgentProbe } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 60e: retained history as evidence, bounded.
 *
 * After a fold the model has lost the folded messages from its projection;
 * these two read-only tools let it search and page the session's *canonical*
 * history, which never lost anything. The rows drive real sessions past a
 * compaction and read the tools' decoded results from the session's events,
 * so what is asserted is what the model was shown -- and that the bounds
 * (three hits, five thousand characters) held against inputs that exceed
 * them.
 */

type Events = ReadonlyArray<AgentEvent.AgentEventEnvelope>
const results = (events: Events, name: string): Array<unknown> =>
  events.flatMap((envelope) =>
    AgentEvent.is("ToolCallSucceeded")(envelope) && envelope.event.name === name ? [envelope.event.result] : []
  )
const searches = (events: Events) => results(events, "search_context").map((r) => Schema.decodeUnknownSync(Compaction.ContextSearch)(r))
const pages = (events: Events) => results(events, "read_context").map((r) => Schema.decodeUnknownSync(Compaction.ContextPage)(r))
const failures = (events: Events, name: string) =>
  events.flatMap((envelope) =>
    AgentEvent.is("ToolCallFailed")(envelope) && envelope.event.name === name ? [envelope.event.failure.message] : []
  )

/** A controller that folds early, so the searched history has a folded stretch. */
const folding = () =>
  Compaction.controller({
    policy: Compaction.whenLongerThan(2, { retain: 2 }),
    summarise: () => Effect.succeed("earlier: setup talk")
  })

/** Run one prompt against `turns` and hand back the session's events and what the model saw. */
const drive = (agent: Agent.Any, turns: ReadonlyArray<FakeModel.Turn>, prompts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { layer, recorder } = yield* FakeModel.script([...turns])
    const events = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const probe = yield* AgentProbe.make(session)
        for (const prompt of prompts) yield* session.prompt(prompt)
        return yield* probe.events
      })
    ).pipe(Effect.provide(layer))
    return { events, prompts: yield* recorder.prompts }
  })

describe("retained history as evidence", () => {
  it.effect("a folded message is found by search, with its index and an excerpt, and read back by page", () =>
    Effect.gen(function* () {
      const compaction = yield* folding()
      const agent = Agent.make({
        instructions: "Be terse.",
        tools: [compaction.tools.searchContext, compaction.tools.readContext],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(3)
      })
      // Prompts "a" and "b" answer plainly; by "c" the first four messages
      // are folded behind a summary. The third prompt's model then searches
      // for a phrase that only lives in the folded stretch, and reads it.
      const { events, prompts } = yield* drive(agent, [
        { text: "the deploy window is Tuesday at noon" },
        { text: "two" },
        { toolCalls: [{ id: "s1", name: "search_context", params: { query: "deploy window" } }] },
        { toolCalls: [{ id: "r1", name: "read_context", params: { index: 2 } }] },
        { text: "done" }
      ], ["a", "b", "c"])

      // The projection the searching turn saw had folded the answer away.
      const searching = prompts[2]!
      assert.isFalse(JSON.stringify(searching.content).includes("Tuesday at noon"), "the fold did not happen")
      assert.isTrue(searching.content.some((m) => m.role === "system" && m.content.includes("earlier: setup talk")))

      const [search] = searches(events)
      assert.isDefined(search)
      // Canonical: instructions(0), a(1), answer(2), b(3), two(4), c(5), ...
      assert.strictEqual(search!.hits.length, 1)
      assert.strictEqual(search!.hits[0]!.index, 2)
      assert.strictEqual(search!.hits[0]!.role, "assistant")
      assert.include(search!.hits[0]!.excerpt, "the deploy window is Tuesday at noon")
      assert.isAtLeast(search!.searched, 6)

      const [page] = pages(events)
      assert.isDefined(page)
      assert.strictEqual(page!.index, 2)
      assert.include(page!.text, "Tuesday at noon")
      assert.strictEqual(page!.offset, 0)
      assert.isFalse(page!.hasMore)
      assert.strictEqual(page!.totalChars, page!.text.length)
    })
  )

  it.effect("at most three hits, and a page of at most five thousand characters that says there is more", () =>
    Effect.gen(function* () {
      const compaction = yield* folding()
      const agent = Agent.make({
        tools: [compaction.tools.searchContext, compaction.tools.readContext],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(4)
      })
      const long = `needle ${"x".repeat(12_000)} needle`
      // Five messages mention the needle: four answers and the long one.
      const { events } = yield* drive(agent, [
        { text: "needle one" },
        { text: "needle two" },
        { text: "needle three" },
        { text: long },
        { toolCalls: [{ id: "s1", name: "search_context", params: { query: "NEEDLE" } }] },
        { toolCalls: [{ id: "r1", name: "read_context", params: { index: 7 } }] },
        { toolCalls: [{ id: "r2", name: "read_context", params: { index: 7, offset: 5_000 } }] },
        { text: "done" }
      ], ["a", "b", "c", "d", "e"])

      const [search] = searches(events)
      assert.isDefined(search)
      // Case-insensitive, capped at three, in history order, from a history of more than three matches.
      assert.strictEqual(search!.hits.length, Compaction.searchHits)
      assert.deepStrictEqual(search!.hits.map((hit) => hit.index), [1, 3, 5])
      assert.isAbove(search!.searched, 8)

      const [first, second] = pages(events)
      assert.isDefined(first)
      assert.isDefined(second)
      // No instructions here: a(0) .. d(6), the long answer is 7, e is 8.
      assert.strictEqual(first!.text.length, Compaction.pageChars)
      assert.isTrue(first!.hasMore)
      assert.isAbove(first!.totalChars, 12_000)
      assert.strictEqual(second!.offset, 5_000)
      assert.strictEqual(second!.text.length, Compaction.pageChars)
      assert.isTrue(second!.hasMore)
      // An excerpt is bounded too: the long match does not come back whole.
      assert.isBelow(search!.hits[2]!.excerpt.length, 1_000)
    })
  )

  it.effect("a bad index, and a session the transform never saw, fail with a reason rather than a guess", () =>
    Effect.gen(function* () {
      const compaction = yield* folding()
      const agent = Agent.make({
        tools: [compaction.tools.readContext],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(2)
      })
      const { events } = yield* drive(agent, [
        { toolCalls: [{ id: "r1", name: "read_context", params: { index: 99 } }] },
        { text: "done" }
      ], ["a"])
      // The history the tool sees is the one the transform saw before this
      // turn's model call: the prompt alone, one message, since this turn's
      // own tool call is committed only when the turn is.
      assert.deepStrictEqual(failures(events, "read_context"), ["no message at index 99: the history has 1"])

      // A session the controller's transform never saw has no history recorded:
      // the honest answer is a failure naming why, not an empty search.
      const other = yield* folding()
      const unwired = Agent.make({ tools: [other.tools.searchContext], loop: AgentLoop.bounded(2) })
      const { events: unrecorded } = yield* drive(unwired, [
        { toolCalls: [{ id: "s1", name: "search_context", params: { query: "x" } }] },
        { text: "done" }
      ], ["a"])
      assert.deepStrictEqual(failures(unrecorded, "search_context"), [
        "no history has been recorded for this session yet: is this controller's transform on the agent?"
      ])
    })
  )

  it("both tools are read-only, and both say what they return is evidence, not instructions", () => {
    for (const tool of [Compaction.SearchContext, Compaction.ReadContext]) {
      assert.isTrue(Context.get(tool.annotations, Tool.Readonly), tool.name)
      assert.include(tool.description ?? "", "historical evidence", tool.name)
      assert.include(tool.description ?? "", "not instructions", tool.name)
    }
    // Neither takes a session: which one is read is decided by where the call runs.
    assert.deepStrictEqual(Object.keys(Compaction.SearchContext.parametersSchema.fields), ["query"])
    assert.deepStrictEqual(Object.keys(Compaction.ReadContext.parametersSchema.fields), ["index", "offset"])
  })
})
