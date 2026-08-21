import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Response, Tool } from "effect/unstable/ai"
import * as Accumulator from "../src/internal/streamAccumulator.js"

/**
 * Streaming and batch generation have to be interchangeable everywhere
 * downstream of the model call, which they only are if a stream folds back
 * into exactly the response a batch call would have returned. This is where
 * that happens, so it is tested directly rather than through a session.
 */
const Search = Tool.make("search", {
  parameters: Schema.Struct({ q: Schema.String }),
  success: Schema.String
})
type Tools = { readonly search: typeof Search }

const run = (parts: ReadonlyArray<Response.StreamPart<Tools, true>>) => {
  let state = Accumulator.empty<Tools>()
  const deltas: Array<Accumulator.Delta> = []
  for (const part of parts) {
    const step = Accumulator.step(state, part)
    if (step._tag === "Failed") return { failed: step.error, deltas }
    state = step.state
    if (step.delta !== undefined) deltas.push(step.delta)
  }
  return { parts: Accumulator.finish(state), deltas }
}

const textOf = (parts: ReadonlyArray<Response.Part<Tools, true>> | undefined) =>
  (parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))

describe("stream accumulator", () => {
  it("folds deltas into the text part a batch call would have returned", () => {
    const { deltas, parts } = run([
      Response.makePart("text-start", { id: "t1" }),
      Response.makePart("text-delta", { id: "t1", delta: "Hello" }),
      Response.makePart("text-delta", { id: "t1", delta: ", world" }),
      Response.makePart("text-end", { id: "t1" })
    ])

    assert.deepStrictEqual(textOf(parts), ["Hello, world"])
    // Every chunk is reported as it arrives, normalised to one shape.
    assert.deepStrictEqual(deltas, [
      { kind: "text", delta: "Hello" },
      { kind: "text", delta: ", world" }
    ])
  })

  it("keeps concurrent chunks apart", () => {
    // Providers may interleave several text or reasoning chunks, which is why
    // the open buffers are keyed by id rather than being a single string.
    const { parts } = run([
      Response.makePart("text-start", { id: "a" }),
      Response.makePart("reasoning-start", { id: "b" }),
      Response.makePart("text-delta", { id: "a", delta: "answer" }),
      Response.makePart("reasoning-delta", { id: "b", delta: "thinking" }),
      Response.makePart("text-end", { id: "a" }),
      Response.makePart("reasoning-end", { id: "b" })
    ])

    assert.deepStrictEqual(textOf(parts), ["answer"])
    assert.deepStrictEqual(
      (parts ?? []).flatMap((part) =>
        part.type === "reasoning" ? [part.text] : []
      ),
      ["thinking"]
    )
  })

  it("flushes a chunk the provider never closed", () => {
    // A stream that ends without `text-end` has still produced that text.
    // Dropping it would lose output the model actually generated.
    const { parts } = run([
      Response.makePart("text-start", { id: "t1" }),
      Response.makePart("text-delta", { id: "t1", delta: "unterminated" })
    ])
    assert.deepStrictEqual(textOf(parts), ["unterminated"])
  })

  it("accepts a delta with no matching start", () => {
    // Providers are not uniformly careful about the structural parts, and
    // dropping output because one was missing is the worse failure.
    const { parts } = run([
      Response.makePart("text-delta", { id: "t1", delta: "orphan" }),
      Response.makePart("text-end", { id: "t1" })
    ])
    assert.deepStrictEqual(textOf(parts), ["orphan"])
  })

  it("passes tool calls through and drops their incremental parameters", () => {
    // The harness executes the assembled call, never a partial one, so the
    // parameter increments are structural noise.
    const { parts } = run([
      Response.makePart("tool-params-start", {
        id: "c1",
        name: "search",
        providerExecuted: false
      }),
      Response.makePart("tool-params-delta", { id: "c1", delta: '{"q":' }),
      Response.makePart("tool-params-end", { id: "c1" }),
      Response.makePart("tool-call", {
        id: "c1",
        name: "search",
        params: { q: "effect" },
        providerExecuted: false
      })
    ])

    const calls = (parts ?? []).filter((part) => part.type === "tool-call")
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(
      (parts ?? []).filter((part) => part.type.startsWith("tool-params"))
        .length,
      0
    )
  })

  it("surfaces an error reported inside the stream", () => {
    // A provider may fail *in* the stream rather than by failing it. Folding
    // that into a response would commit a turn the provider just disowned.
    const outcome = run([
      Response.makePart("text-start", { id: "t1" }),
      Response.makePart("text-delta", { id: "t1", delta: "partial" }),
      Response.makePart("error", { error: new Error("upstream exploded") })
    ])
    assert.isDefined(outcome.failed)
    assert.instanceOf(outcome.failed, Error)
  })
})
