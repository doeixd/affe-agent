import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Ref } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Compaction } from "../src/compaction/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Compaction is the test of the architecture, not just of itself. It adds
 * nothing to the kernel — it is a `ContextTransform` — and the whole claim of
 * the canonical/derived split is that a feature like this can shrink what the
 * model sees without touching what the session recorded.
 */
const summaryOf = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "system" ? [message.content] : []
  )

describe("compaction", () => {
  it.effect("shrinks the projection and leaves history complete", () =>
    Effect.gen(function* () {
      const summarised = yield* Ref.make<Array<number>>([])

      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(4, { retain: 2 }),
        summarise: ({ messages }) =>
          Ref.update(summarised, (all) => [...all, messages.content.length]).pipe(
            Effect.as(`covered ${messages.content.length} messages`)
          )
      })

      const { layer, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two"),
        TestLanguageModel.text("three"),
        TestLanguageModel.text("four"),
        TestLanguageModel.text("five")
      ])

      const history = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              contextTransform: compaction,
              loop: AgentLoop.bounded(1)
            })
          )
          // Five submissions: history grows two messages each time (the user
          // prompt and the assistant reply).
          for (const input of ["a", "b", "c", "d", "e"]) {
            yield* session.prompt(input)
          }
          return yield* session.history
        })
      ).pipe(Effect.provide(layer))

      // Canonical history holds the whole conversation. This is the claim.
      assert.strictEqual(history.content.length, 10)
      assert.deepStrictEqual(summaryOf(history), [])

      // The model, by the last turn, saw a summary plus a short tail rather
      // than the full transcript.
      const prompts = yield* recorder.prompts
      const last = prompts[prompts.length - 1]!
      assert.strictEqual(summaryOf(last).length, 1)
      assert.include(summaryOf(last)[0]!, "covered")
      assert.isBelow(last.content.length, history.content.length)

      // And it summarised, rather than re-summarising every turn.
      assert.isAtLeast((yield* Ref.get(summarised)).length, 1)
    })
  )

  it.effect("reuses a checkpoint until enough new messages accumulate", () =>
    Effect.gen(function* () {
      // Without this, a conversation past the threshold would re-summarise on
      // every single turn -- the expensive thing compaction exists to avoid.
      const calls = yield* Ref.make(0)

      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(4, { retain: 2 }),
        summarise: () =>
          Ref.updateAndGet(calls, (n) => n + 1).pipe(
            Effect.map((n) => `summary ${n}`)
          )
      })

      const { layer } = yield* TestLanguageModel.script(
        Array.from({ length: 8 }, (_, i) => TestLanguageModel.text(`turn ${i}`))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              contextTransform: compaction,
              loop: AgentLoop.bounded(1)
            })
          )
          for (let i = 0; i < 8; i++) {
            yield* session.prompt(`message ${i}`)
          }
        })
      ).pipe(Effect.provide(layer))

      // Sixteen messages, a threshold of four beyond each checkpoint: a
      // handful of summaries, not one per turn.
      // Sixteen messages accumulate over eight submissions. Counting the
      // foldable stretch gives two summaries; counting the whole history each
      // time gives six. The bound has to discriminate between those, or it
      // passes whether or not the checkpoint is used -- an earlier version of
      // this assertion did exactly that.
      assert.strictEqual(yield* Ref.get(calls), 2)
    })
  )

  it.effect("extends the previous summary rather than starting over", () =>
    Effect.gen(function* () {
      // A second compaction covers only what is new, and is handed the earlier
      // summary so it can fold rather than forget.
      const seen = yield* Ref.make<Array<Option.Option<string>>>([])

      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: ({ previous }) =>
          Ref.updateAndGet(seen, (all) => [...all, previous]).pipe(
            Effect.map((all) => `summary ${all.length}`)
          )
      })

      const { layer } = yield* TestLanguageModel.script(
        Array.from({ length: 8 }, (_, i) => TestLanguageModel.text(`turn ${i}`))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              contextTransform: compaction,
              loop: AgentLoop.bounded(1)
            })
          )
          for (let i = 0; i < 8; i++) {
            yield* session.prompt(`message ${i}`)
          }
        })
      ).pipe(Effect.provide(layer))

      const previous = yield* Ref.get(seen)
      assert.isAtLeast(previous.length, 2)
      // The first has nothing to build on; later ones do.
      assert.isTrue(Option.isNone(previous[0]!))
      assert.isTrue(Option.isSome(previous[1]!))
    })
  )

  it.effect("never summarises an empty range at the default retain", () =>
    Effect.gen(function* () {
      // The bug this guards was reachable from the documented default.
      // `whenLongerThan(4)` keeps 6 messages, so the foldable stretch was
      // empty while total history was well past the threshold: compaction ran
      // nearly every turn, summarising nothing and overwriting each real
      // summary with a meaningless one.
      const ranges = yield* Ref.make<Array<number>>([])

      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(4),
        summarise: ({ messages }) =>
          Ref.update(ranges, (all) => [...all, messages.content.length]).pipe(
            Effect.as("summary")
          )
      })

      const { layer } = yield* TestLanguageModel.script(
        Array.from({ length: 8 }, (_, i) => TestLanguageModel.text(`turn ${i}`))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              contextTransform: compaction,
              loop: AgentLoop.bounded(1)
            })
          )
          for (let i = 0; i < 8; i++) {
            yield* session.prompt(`message ${i}`)
          }
        })
      ).pipe(Effect.provide(layer))

      const summarised = yield* Ref.get(ranges)
      // Whatever it summarised, it was never nothing.
      assert.isTrue(
        summarised.every((count) => count > 0),
        `summarised an empty range: ${JSON.stringify(summarised)}`
      )
      // And it did not fire on every turn.
      assert.isBelow(summarised.length, 4)
    })
  )
})
