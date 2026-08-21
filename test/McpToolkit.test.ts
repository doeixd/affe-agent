import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { McpToolkit } from "../src/mcp/index.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * The claim being tested is narrow and worth stating exactly: types come from
 * the local declaration, and the server is checked against it. Nothing here
 * infers anything from the server, because a server's tool list is a runtime
 * value and inference is not.
 *
 * What that buys is real, though — exact tool types through the agent, and the
 * declared schema acting as a decoding contract at the boundary.
 */
const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ hits: Schema.Array(Schema.String) })
})

/** A transforming schema, so encode and decode are observably not identity. */
const Schedule = Tool.make("schedule", {
  parameters: Schema.Struct({ at: Schema.DateFromString }),
  success: Schema.DateFromString
})

/** A connection standing in for a client Effect does not ship yet. */
const fakeConnection = (options: {
  readonly offers: ReadonlyArray<string>
  readonly respond?: (name: string, params: unknown) => unknown
  readonly calls?: Ref.Ref<Array<{ name: string; params: unknown }>>
}): McpToolkit.Connection => ({
  listTools: Effect.succeed(
    options.offers.map((name) => ({ name, inputSchema: {} }))
  ),
  callTool: (name, params) =>
    Effect.gen(function* () {
      if (options.calls !== undefined) {
        yield* Ref.update(options.calls, (all) => [...all, { name, params }])
      }
      return options.respond === undefined
        ? { hits: ["a", "b"] }
        : options.respond(name, params)
    })
})

describe("McpToolkit.bind", () => {
  it.effect("refuses to bind a tool the server does not offer", () =>
    Effect.gen(function* () {
      // At bind time, not on first call. A missing tool is a deployment
      // mismatch -- the wrong server, or one that has moved on -- and finding
      // out when the model first reaches for it means discovering it in
      // production, mid-conversation.
      const error = yield* Effect.flip(
        McpToolkit.bind(fakeConnection({ offers: ["fetch"] }), [Search])
      )

      assert.strictEqual(error._tag, "McpToolMissingError")
      if (error._tag === "McpToolMissingError") {
        assert.deepStrictEqual([...error.missing], ["search"])
        // Both sides reported, because "search is missing" is half an answer
        // when the real problem is that you are pointed at the wrong server.
        assert.deepStrictEqual([...error.offered], ["fetch"])
      }
    })
  )

  it.effect("gives the agent exact tool types", () =>
    Effect.gen(function* () {
      const toolkit = yield* McpToolkit.bind(
        fakeConnection({ offers: ["search"] }),
        [Search]
      )

      const seen = yield* Ref.make<Array<string>>([])

      const { events } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              toolkit,
              // Written inline so `state` is typed by this toolkit.
              loop: (state) =>
                Effect.gen(function* () {
                  for (const call of state.toolCalls) {
                    // The assertion is that this line compiles. `params` is
                    // typed from the declaration, not `unknown`, and tool
                    // parameters reach a loop *encoded* -- so `query` is a
                    // string here whichever way you look at it.
                    const query: string = call.params.query
                    yield* Ref.update(seen, (all) => [...all, query])
                  }
                  return state.toolCalls.length > 0
                    ? AgentLoop.Continue
                    : AgentLoop.Stop
                })
            })
          )
          const probe = yield* AgentProbe.make(session)
          yield* session.prompt("find things")
          return { events: yield* probe.events }
        })
      ).pipe(
        Effect.provide(
          (yield* TestLanguageModel.script([
            TestLanguageModel.toolCall("search", { query: "effect" }, {
              id: "s1"
            }),
            TestLanguageModel.text("done")
          ])).layer
        )
      )

      assert.deepStrictEqual(yield* Ref.get(seen), ["effect"])

      // And the result came back decoded, as the declared success type.
      const succeeded = events.filter(AgentEvent.is("ToolCallSucceeded"))
      assert.strictEqual(succeeded.length, 1)
      assert.deepStrictEqual(succeeded[0]!.event.result, {
        hits: ["a", "b"]
      })
    })
  )

  it.effect("encodes and decodes through the declared schemas", () =>
    Effect.gen(function* () {
      // A transforming schema is where a hopeful annotation and a real
      // contract come apart. The handler is given a `Date`; the wire must
      // carry the encoded string; the server's string must come back a `Date`.
      const calls = yield* Ref.make<Array<{ name: string; params: unknown }>>([])
      const toolkit = yield* McpToolkit.bind(
        fakeConnection({
          offers: ["schedule"],
          calls,
          respond: () => "2026-03-04T00:00:00.000Z"
        }),
        [Schedule]
      )

      const emitted = yield* Effect.flatMap(
        toolkit.handle("schedule", { at: "2026-01-01T00:00:00.000Z" }),
        Stream.runCollect
      )

      // Decoded on the way back: the declared success schema turned the
      // server's string into a Date.
      const result = emitted[emitted.length - 1]?.result
      // No cast: narrowing is the assertion.
      assert.isTrue(result instanceof Date, "the result was not decoded")
      if (result instanceof Date) {
        assert.strictEqual(result.toISOString(), "2026-03-04T00:00:00.000Z")
      }

      const sent = yield* Ref.get(calls)
      assert.strictEqual(sent.length, 1)
      // Encoded on the way out: a string, not a Date instance.
      assert.deepStrictEqual(sent[0]!.params, {
        at: "2026-01-01T00:00:00.000Z"
      })
    })
  )

  it.effect("a server answering the wrong shape fails at the boundary", () =>
    Effect.gen(function* () {
      // The other half of the contract. Without decoding, a server that
      // changed its result shape would hand `unknown` to the agent and the
      // damage would surface somewhere far away.
      const toolkit = yield* McpToolkit.bind(
        fakeConnection({
          offers: ["search"],
          respond: () => ({ wrong: true })
        }),
        [Search]
      )

      const error = yield* Effect.flip(
        Effect.flatMap(toolkit.handle("search", { query: "x" }), Stream.runCollect)
      )

      assert.include(String(error), "search")
      assert.include(String(error), "declared schema")
    })
  )
})
