import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Ref } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
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

  it.effect("keeps what an earlier transform contributed", () =>
    Effect.gen(function* () {
      // Compaction reasons about canonical history, because its checkpoints
      // are positions in the transcript. Rebuilding the prompt from canonical
      // history alone discarded whatever a transform composed before it had
      // added -- and silently: the conversation still looked right, and the
      // injected instruction simply stopped appearing once the conversation
      // grew long enough to compact. Dynamic instructions are the commonest
      // transform there is, so this mattered.
      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: () => Effect.succeed("SUMMARY")
      })
      const instructions = ContextTransform.appendSystem(() =>
        Effect.succeed("DYNAMIC")
      )

      const { layer, recorder } = yield* TestLanguageModel.script(
        Array.from({ length: 6 }, (_, i) => TestLanguageModel.text(`turn ${i}`))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              contextTransform: ContextTransform.compose(
                instructions,
                compaction
              ),
              loop: AgentLoop.bounded(1)
            })
          )
          for (let i = 0; i < 6; i++) {
            yield* session.prompt(`message ${i}`)
          }
        })
      ).pipe(Effect.provide(layer))

      const prompts = yield* recorder.prompts
      const last = prompts[prompts.length - 1]!
      const systems = summaryOf(last)

      // Both survive: the summary that replaced the conversation, and the
      // instruction the earlier transform appended after it.
      assert.strictEqual(systems.length, 2)
      assert.include(systems[0]!, "SUMMARY")
      assert.strictEqual(systems[1], "DYNAMIC")

      // Every turn kept the instruction, not just the uncompacted ones.
      assert.isTrue(
        prompts.every((prompt) => summaryOf(prompt).includes("DYNAMIC")),
        "compaction dropped an earlier transform's contribution"
      )
    })
  )

  it.effect("discards a checkpoint that cannot describe the history", () =>
    Effect.gen(function* () {
      // Session ids get reused: a snapshot is restored, a durable submission
      // replays, a server hands the same id to a new conversation after
      // evicting the old one. The transform outlives all of that.
      //
      // A stale checkpoint claiming to cover more messages than exist sliced
      // past the end of history, so the model received a summary of a
      // conversation that no longer existed and *none* of the actual messages.
      // Silently, and with the transcript itself perfectly intact.
      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: () => Effect.succeed("OLD")
      })
      const agent = Agent.make({
        contextTransform: compaction,
        loop: AgentLoop.bounded(1)
      })

      const run = (turns: number) =>
        Effect.gen(function* () {
          const { layer, recorder } = yield* TestLanguageModel.script(
            Array.from({ length: turns }, (_, i) =>
              TestLanguageModel.text(`r${i}`)
            )
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              // The same id, deliberately.
              const session = yield* AgentSession.make(agent, {
                sessionId: "reused"
              })
              for (let i = 0; i < turns; i++) {
                yield* session.prompt(`m${i}`)
              }
            })
          ).pipe(Effect.provide(layer))
          return yield* recorder.prompts
        })

      // Long enough to leave a checkpoint behind.
      yield* run(6)
      // A new, short conversation under the same id.
      const fresh = yield* run(2)

      const userTexts = (prompt: Prompt.Prompt) =>
        prompt.content.flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((part) =>
                part.type === "text" ? [part.text] : []
              )
            : []
        )

      assert.deepStrictEqual(userTexts(fresh[0]!), ["m0"])
      assert.deepStrictEqual(userTexts(fresh[1]!), ["m0", "m1"])
    })
  )

  it.effect("bounds its checkpoint cache across sessions", () =>
    Effect.gen(function* () {
      // An `Agent` is a value, usually built once and shared, so a transform
      // outlives every session that uses it: without a bound, each session that
      // ever compacted left a checkpoint behind forever.
      //
      // Evicting one is safe -- it caches work already done, and losing it
      // costs a re-summarisation. The bound is observed here by watching a
      // session that is still growing: with a cache of one, a second session
      // evicts its checkpoint and it has to summarise from scratch.
      const calls = yield* Ref.make(0)
      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: () =>
          Ref.updateAndGet(calls, (n) => n + 1).pipe(Effect.map(String)),
        maxSessions: 1
      })
      const agent = Agent.make({
        contextTransform: compaction,
        loop: AgentLoop.bounded(1)
      })

      const { layer } = yield* TestLanguageModel.script(
        Array.from({ length: 20 }, (_, i) => TestLanguageModel.text(`r${i}`))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const alpha = yield* AgentSession.make(agent, { sessionId: "alpha" })
          const beta = yield* AgentSession.make(agent, { sessionId: "beta" })

          // Interleaved, so each evicts the other's checkpoint every time.
          for (let i = 0; i < 5; i++) {
            yield* alpha.prompt(`a${i}`)
            yield* beta.prompt(`b${i}`)
          }
        })
      ).pipe(Effect.provide(layer))

      // Measured both ways rather than guessed: with the cache holding both
      // sessions each extends its own checkpoint and summarises four times
      // between them; with a cache of one they evict each other and have to
      // re-summarise, giving six. An `isAtLeast(4)` bound would have passed
      // either way and proved nothing.
      assert.strictEqual(yield* Ref.get(calls), 6)
    })
  )

  it.effect("refuses a checkpoint from a different conversation", () =>
    Effect.gen(function* () {
      // The case a length check cannot catch. An old conversation leaves a
      // checkpoint covering ten messages; a new conversation under the same id
      // grows past that, so the checkpoint *fits* -- and the new conversation
      // is handed a summary of one it never had. Confidently wrong is worse
      // than absent.
      const summaries = yield* Ref.make<Array<string>>([])
      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: ({ messages }) =>
          Effect.gen(function* () {
            const texts = messages.content.flatMap((message) =>
              message.role === "user"
                ? message.content.flatMap((part) =>
                    part.type === "text" ? [part.text] : []
                  )
                : []
            )
            const summary = texts.join("|")
            yield* Ref.update(summaries, (all) => [...all, summary])
            return summary
          })
      })
      const agent = Agent.make({
        contextTransform: compaction,
        loop: AgentLoop.bounded(1)
      })

      const run = (tag: string, turns: number) =>
        Effect.gen(function* () {
          const { layer, recorder } = yield* TestLanguageModel.script(
            Array.from({ length: turns }, (_, i) =>
              TestLanguageModel.text(`${tag}-r${i}`)
            )
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              // The same id both times, deliberately.
              const session = yield* AgentSession.make(agent, {
                sessionId: "reused"
              })
              for (let i = 0; i < turns; i++) {
                yield* session.prompt(`${tag}-m${i}`)
              }
            })
          ).pipe(Effect.provide(layer))
          return yield* recorder.prompts
        })

      // The lengths matter. A long first conversation leaves a checkpoint far
      // ahead of anything the second reaches before compacting on its own, so
      // the stale one is overwritten before it could ever fit. Three turns
      // leaves a checkpoint covering three messages -- exactly where the second
      // conversation is on *its* second turn, which is the window a length
      // check cannot see.
      yield* run("alpha", 3)
      const second = yield* run("beta", 3)

      const systems = second.flatMap((prompt) =>
        prompt.content.flatMap((message) =>
          message.role === "system" ? [message.content] : []
        )
      )
      // Not one summary in the new conversation mentions the old one.
      assert.isTrue(
        systems.every((text) => !text.includes("alpha")),
        `a summary of the old conversation leaked: ${JSON.stringify(systems)}`
      )
    })
  )

  it.effect("a restored session keeps the compaction work already done", () =>
    Effect.gen(function* () {
      // Snapshot and compaction have to agree about identity. A restored
      // session has the same id and the same transcript, so its checkpoint
      // still describes it and the summarising already paid for is not paid
      // for again -- while a checkpoint that no longer fits is rejected by the
      // same fingerprint doing both jobs.
      const ranges = yield* Ref.make<Array<number>>([])
      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: ({ messages }) =>
          Ref.update(ranges, (all) => [...all, messages.content.length]).pipe(
            Effect.as("summary")
          )
      })
      const agent = Agent.make({
        contextTransform: compaction,
        loop: AgentLoop.bounded(1)
      })

      const { layer } = yield* TestLanguageModel.script(
        Array.from({ length: 12 }, (_, i) => TestLanguageModel.text(`r${i}`))
      )

      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent, {
            sessionId: "snapshotted"
          })
          for (let i = 0; i < 4; i++) {
            yield* session.prompt(`m${i}`)
          }
          return yield* AgentSession.snapshot(session)
        })
      ).pipe(Effect.provide(layer))

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.restore(agent, snapshot)
          yield* session.prompt("m4")
        })
      ).pipe(Effect.provide(layer))

      // Measured both ways rather than reasoned about. With the checkpoint
      // honoured the folded ranges are [3, 4]: the first session folds three
      // messages, the restored one folds only the four accumulated since.
      // With it rejected they are [3, 5, 7] -- more compactions, each folding
      // from the beginning. An `isBelow(range, transcriptLength)` bound was
      // written first and passed either way, because 7 is also below 8.
      assert.deepStrictEqual(
        yield* Ref.get(ranges),
        [3, 4],
        "the restored session redid work the checkpoint had already done"
      )
    })
  )
})
