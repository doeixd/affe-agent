import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option, Ref, Schema, Stream } from "effect"
import { AiError, LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentRun from "../src/AgentRun.js"
import * as AgentSession from "../src/AgentSession.js"
import * as AgentSubmission from "../src/AgentSubmission.js"
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

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T

class BudgetFailure extends Schema.TaggedError<BudgetFailure>()(
  "BudgetFailure",
  {}
) {
  override get message() {
    return "budget failed"
  }
}

class EstimateFailure extends Schema.TaggedError<EstimateFailure>()(
  "EstimateFailure",
  {}
) {
  override get message() {
    return "estimate failed"
  }
}

class SummaryFailure extends Schema.TaggedError<SummaryFailure>()(
  "SummaryFailure",
  {}
) {
  override get message() {
    return "summary failed"
  }
}

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

  it.effect("never opens the retained tail on a tool result", () =>
    Effect.gen(function* () {
      // Every submission is four messages: user, assistant (tool call), tool,
      // assistant. With `retain: 1`, the second turn of a submission sees a
      // raw boundary on the tool result — a projection a provider rejects —
      // so the tail must open on the assistant message that issued the call
      // instead.
      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(1, { retain: 1 }),
        summarise: ({ messages }) =>
          Effect.succeed(`covered ${messages.content.length} messages`)
      })
      const Search = Tool.make("search", {
        parameters: Schema.Struct({ query: Schema.String }),
        success: Schema.String
      })
      const { layer, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("search", { query: "a" }, { id: "c1" }),
        TestLanguageModel.text("one"),
        TestLanguageModel.toolCall("search", { query: "b" }, { id: "c2" }),
        TestLanguageModel.text("two"),
        TestLanguageModel.toolCall("search", { query: "c" }, { id: "c3" }),
        TestLanguageModel.text("three")
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              toolkit: Agent.toolkit([Search], {
                search: ({ query }) => Effect.succeed(`hits for ${query}`)
              }),
              contextTransform: compaction,
              loop: AgentLoop.bounded(2)
            })
          )
          for (const input of ["a", "b", "c"]) {
            yield* session.prompt(input)
          }
        })
      ).pipe(Effect.provide(layer))

      const prompts = yield* recorder.prompts
      for (const prompt of prompts) {
        const roles = prompt.content.map((m) => m.role)
        // After any summary, every tool message still follows the assistant
        // message that asked for it.
        const tail = roles.filter((role) => role !== "system")
        assert.notStrictEqual(tail[0], "tool", roles.join(","))
        roles.forEach((role, i) => {
          if (role === "tool") assert.strictEqual(roles[i - 1], "assistant", roles.join(","))
        })
      }
      // And compaction did happen.
      assert.isTrue(prompts.some((prompt) => summaryOf(prompt).length === 1))
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
          yield* session.prompt("m5")
        })
      ).pipe(Effect.provide(layer))

      // Measured both ways rather than reasoned about. With the checkpoint
      // honoured the folded ranges are [3, 4]: the first session folds three
      // messages, the restored one folds only the four accumulated since.
      // With it rejected the restored session folds from the beginning
      // again. An `isBelow(range, transcriptLength)` bound was written first
      // and passed either way.
      assert.deepStrictEqual(
        yield* Ref.get(ranges),
        [3, 4],
        "the restored session redid work the checkpoint had already done"
      )
    })
  )

  it.effect("persists checkpoints across transform recreation", () =>
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore.use(Effect.succeed).pipe(
        Effect.provide(KeyValueStore.layerMemory)
      )
      const ranges = yield* Ref.make<Array<number>>([])
      const usage = {
        inputTokens: 13,
        outputTokens: 3,
        totalTokens: 16
      }
      const makeAgent = Effect.map(
        Compaction.make({
          policy: Compaction.whenLongerThan(2, { retain: 2 }),
          summarise: ({ messages }) =>
            Ref.update(
              ranges,
              (all) => [...all, messages.content.length]
            ).pipe(
              Effect.as({
                text: "persistent summary",
                usage: Option.some(usage)
              })
            ),
          checkpointStore: kv
        }),
        (contextTransform) =>
          Agent.make({
            contextTransform,
            loop: AgentLoop.bounded(1)
          })
      )
      const { layer } = yield* TestLanguageModel.script(
        Array.from({ length: 6 }, (_, index) =>
          TestLanguageModel.text(`r${index}`)
        )
      )

      const firstAgent = yield* makeAgent
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(firstAgent, {
            sessionId: "persistent"
          })
          for (let index = 0; index < 4; index++) {
            yield* session.prompt(`m${index}`)
          }
          return yield* AgentSession.snapshot(session)
        })
      ).pipe(Effect.provide(layer))

      // A new transform has a fresh Ref; only the supplied store can carry the
      // checkpoint across this boundary.
      const secondAgent = yield* makeAgent
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.restore(secondAgent, snapshot)
          yield* session.prompt("m4")
          yield* session.prompt("m5")
        })
      ).pipe(Effect.provide(layer))

      assert.deepStrictEqual(yield* Ref.get(ranges), [3, 4])
      const stored = yield* KeyValueStore.toSchemaStore(
        KeyValueStore.prefix(kv, "affe-agent:compaction:"),
        Compaction.Checkpoint
      ).get("persistent")
      assert.isTrue(Option.isSome(stored))
      if (Option.isSome(stored) && Compaction.isSummary(stored.value)) {
        assert.deepStrictEqual(stored.value.usage, Option.some(usage))
      } else assert.fail("expected a persisted summary checkpoint")

      const compaction = yield* Compaction.make({
        policy: Compaction.whenLongerThan(2),
        summarise: () => Effect.succeed("summary"),
        checkpointStore: kv
      })
      const prompt = Prompt.make("hello")
      const transformed = compaction.transform({
        sessionId: AgentSession.Id.make("typed-persistence"),
        submissionId: AgentSubmission.Id.make("typed-persistence"),
        runId: AgentRun.Id.make("typed-persistence"),
        turnIndex: 1,
        canonicalPrompt: prompt,
        prompt
      })
      type _Error = Assert<
        Equal<
          Effect.Error<typeof transformed>,
          KeyValueStore.KeyValueStoreError | Schema.SchemaError | Compaction.CompactionCannotHelpError
        >
      >
    })
  )

  it.effect("compacts against token pressure and keeps a token-sized tail", () =>
    Effect.gen(function* () {
      const summarised = yield* Ref.make<ReadonlyArray<number>>([])
      const estimator: Compaction.EstimateTokens = (prompt) =>
        Effect.succeed(prompt.content.length * 2)
      const compaction = yield* Compaction.make({
        policy: Compaction.tokens({
          budget: {
            contextWindow: 10,
            reserveTokens: 2,
            keepRecentTokens: 3
          },
          estimate: estimator
        }),
        summarise: ({ messages }) =>
          Ref.update(
            summarised,
            (all) => [...all, messages.content.length]
          ).pipe(Effect.as("TOKEN SUMMARY"))
      })
      const { layer, recorder } = yield* TestLanguageModel.script(
        Array.from({ length: 7 }, (_, index) =>
          TestLanguageModel.text(`answer ${index}`)
        )
      )

      const history = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              contextTransform: compaction,
              loop: AgentLoop.bounded(1)
            })
          )
          for (let index = 0; index < 7; index++) {
            yield* session.prompt(`message ${index}`)
          }
          return yield* session.history
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(history.content.length, 14)
      const ranges = yield* Ref.get(summarised)
      assert.isAtLeast(ranges.length, 1)
      assert.isTrue(ranges.every((length) => length > 0))
      assert.isBelow(ranges.length, 7)
      const prompts = yield* recorder.prompts
      assert.isTrue(
        prompts.some((prompt) =>
          summaryOf(prompt).some((summary) => summary.includes("TOKEN SUMMARY"))
        )
      )
    })
  )

  it.effect("ships a portable approximate estimator for text and bytes", () =>
    Effect.gen(function* () {
      const empty = yield* Compaction.estimate.approximate(Prompt.empty)
      const short = yield* Compaction.estimate.approximate(Prompt.make("hello"))
      const binary = yield* Compaction.estimate.approximate(Prompt.make([{
        role: "user",
        content: [{
          type: "file",
          mediaType: "application/octet-stream",
          data: new Uint8Array(120)
        }]
      }]))
      assert.strictEqual(empty, 0)
      assert.isAbove(short, 0)
      assert.isAbove(binary, short)
    })
  )

  it.effect("preserves policy and summarizer failures in the transform type", () =>
    Effect.gen(function* () {
      const budgetFailure = new BudgetFailure()
      const estimateFailure = new EstimateFailure()
      const summaryFailure = new SummaryFailure()
      const compaction = yield* Compaction.make({
        policy: Compaction.tokens({
          budget: () => Effect.fail(budgetFailure),
          estimate: () => Effect.fail(estimateFailure)
        }),
        summarise: () => Effect.fail(summaryFailure)
      })
      const prompt = Prompt.make("hello")
      const outcome = compaction.transform({
        sessionId: AgentSession.Id.make("typed-session"),
        submissionId: AgentSubmission.Id.make("typed-submission"),
        runId: AgentRun.Id.make("typed-run"),
        turnIndex: 1,
        canonicalPrompt: prompt,
        prompt
      })
      type _Error = Assert<
        Equal<
          Effect.Error<typeof outcome>,
          BudgetFailure | EstimateFailure | SummaryFailure | Compaction.CompactionCannotHelpError
        >
      >
      const exit = yield* Effect.exit(outcome)
      assert.strictEqual(exit._tag, "Failure")
    })
  )

  it.effect("defines checkpoints as round-trippable Schema values", () =>
    Effect.gen(function* () {
      const checkpoint: Compaction.Checkpoint = {
        coveredThrough: 12,
        summary: "summary",
        prefix: "abc123",
        tokensBefore: Option.some(900),
        tokensAfter: Option.some(240),
        usage: Option.none()
      }
      const encoded = yield* Schema.encodeEffect(Compaction.Checkpoint)(checkpoint)
      const decoded = yield* Schema.decodeEffect(Compaction.Checkpoint)(encoded)
      type _Checkpoint = Assert<Equal<typeof decoded, Compaction.Checkpoint>>
      assert.deepStrictEqual(decoded, checkpoint)
    })
  )

  it("serializes a bounded, file-safe summarizer transcript", () => {
    const prompt = Prompt.fromMessages([
      Prompt.systemMessage({ content: "Follow the policy." }),
      Prompt.userMessage({
        content: [
          Prompt.textPart({ text: "inspect this" }),
          Prompt.filePart({
            mediaType: "application/octet-stream",
            fileName: "blob.bin",
            data: new Uint8Array([10, 20, 30])
          })
        ]
      }),
      Prompt.assistantMessage({
        content: [
          Prompt.reasoningPart({ text: "considering" }),
          Prompt.toolCallPart({
            id: "call-1",
            name: "lookup",
            params: { query: "effect" },
            providerExecuted: false
          }),
          Prompt.toolApprovalRequestPart({
            approvalId: "approval-1",
            toolCallId: "call-1"
          })
        ]
      }),
      Prompt.toolMessage({
        content: [
          Prompt.toolResultPart({
            id: "call-1",
            name: "lookup",
            isFailure: false,
            result: "abcdefghij",
            providerExecuted: false
          }),
          Prompt.toolApprovalResponsePart({
            approvalId: "approval-1",
            approved: false,
            reason: "not now"
          })
        ]
      })
    ])

    assert.strictEqual(
      Compaction.serialize(prompt, { maxToolResultChars: 5 }),
      `[System]\nFollow the policy.\n\n[User]\ninspect this\n\n[File: blob.bin; application/octet-stream; 3 bytes]\n\n[Assistant]\n[Reasoning]\nconsidering\n\n[Tool call: lookup; id=call-1]\n{\n  "query": "effect"\n}\n\n[Tool approval requested: approval-1; call=call-1]\n\n[Tool]\n[Tool result: lookup; id=call-1; success]\n"abcd\n… [7 characters omitted]\n\n[Tool approval denied: approval-1]\nnot now`
    )
    assert.throws(
      () => Compaction.serialize(prompt, { maxToolResultChars: -1 }),
      "non-negative safe integer"
    )
  })

  /**
   * What a transform *before* compaction costs, and who is told about it.
   *
   * `substitute` already establishes that an earlier transform's injection --
   * retrieved memory, a dynamic instruction -- stays in the projection. It is
   * therefore counted in `tokensBefore`, and it is not in canonical history, so
   * no cut can fold it away. When the injection alone is over budget the walk
   * retains every canonical message, finds no boundary, and compaction has to
   * say so.
   *
   * What it must not say is that the retained tail exceeded `keepRecentTokens`,
   * which is precisely what this branch has just established is false -- the
   * walk stopped here because the tail fit. That message sent an operator to
   * lower `keepRecentTokens`, which cannot change the outcome, and it is why
   * the failure now carries a `kind`.
   */
  it.effect("blames the injection, not the tail, when no cut exists", () =>
    Effect.gen(function* () {
      const summarised = yield* Ref.make(0)
      const compaction = yield* Compaction.make({
        policy: Compaction.tokens({
          budget: {
            contextWindow: 100,
            reserveTokens: 10,
            keepRecentTokens: 40
          },
          estimate: Compaction.estimate.approximate
        }),
        summarise: () =>
          Ref.update(summarised, (n) => n + 1).pipe(Effect.as("summary"))
      })
      const canonical = Prompt.make("a short question")
      const injected = Prompt.fromMessages([
        Prompt.systemMessage({ content: "M".repeat(4_000) }),
        ...canonical.content
      ])

      const failure = yield* Effect.flip(
        compaction.transform({
          sessionId: AgentSession.Id.make("injected"),
          submissionId: AgentSubmission.Id.make("injected"),
          runId: AgentRun.Id.make("injected"),
          turnIndex: 1,
          canonicalPrompt: canonical,
          prompt: injected
        })
      )

      assert.strictEqual(failure._tag, "CompactionCannotHelpError")
      if (failure._tag === "CompactionCannotHelpError") {
        assert.strictEqual(failure.kind, "nothing-to-fold")
        assert.notInclude(failure.message, "retained tail alone exceeds")
      }
      // And nothing was summarised, so no model call was paid for a cut that
      // could not exist.
      assert.strictEqual(yield* Ref.get(summarised), 0)
    })
  )

  /**
   * A `ResolveBudget` is an ordinary Effect: it may read configuration or ask a
   * provider. It was resolved twice on a compacting turn -- once to choose the
   * cut and again to check the summary against the budget -- so a caller paid
   * for both, and the two answers need not agree: the check could be made
   * against a window the cut was never chosen for.
   */
  it.effect("resolves a dynamic budget once per turn", () =>
    Effect.gen(function* () {
      const resolved = yield* Ref.make(0)
      const compaction = yield* Compaction.make({
        policy: Compaction.tokens({
          budget: () =>
            Ref.update(resolved, (n) => n + 1).pipe(
              Effect.as({
                contextWindow: 10,
                reserveTokens: 2,
                keepRecentTokens: 3
              })
            ),
          estimate: (prompt) => Effect.succeed(prompt.content.length * 2)
        }),
        summarise: () => Effect.succeed("summary")
      })
      const canonical = Prompt.fromMessages(
        Array.from({ length: 7 }, (_, index) =>
          Prompt.userMessage({
            content: [Prompt.textPart({ text: `message ${index}` })]
          }))
      )

      const projected = yield* compaction.transform({
        sessionId: AgentSession.Id.make("dynamic-budget"),
        submissionId: AgentSubmission.Id.make("dynamic-budget"),
        runId: AgentRun.Id.make("dynamic-budget"),
        turnIndex: 1,
        canonicalPrompt: canonical,
        prompt: canonical
      })

      // The turn really did compact, or "resolved once" would be vacuous.
      assert.isBelow(projected.content.length, canonical.content.length)
      assert.strictEqual(summaryOf(projected).length, 1)
      assert.isTrue(summaryOf(projected)[0]?.endsWith("summary"))
      assert.strictEqual(yield* Ref.get(resolved), 1)
    })
  )

  it("rejects token budgets that cannot leave room for a summary", () => {
    assert.throws(
      () => Compaction.tokens({
        budget: {
          contextWindow: 100,
          reserveTokens: 20,
          keepRecentTokens: 80
        },
        estimate: Compaction.estimate.approximate
      }),
      "must leave room"
    )
  })
})

describe("compaction controller (phases 8-10)", () => {
  /** A short user/assistant conversation as canonical history. */
  const conversation = (turns: number): Prompt.Prompt =>
    Prompt.fromMessages(
      Array.from({ length: turns }, (_, i) => [
        Prompt.userMessage({ content: [Prompt.textPart({ text: `question ${i + 1}` })] }),
        Prompt.assistantMessage({ content: [Prompt.textPart({ text: `answer ${i + 1}` })] })
      ]).flat()
    )

  it.effect("model() asks the ambient model with the continuation template and returns its usage", () =>
    Effect.gen(function* () {
      const { layer, recorder } = yield* TestLanguageModel.script([
        { text: "## Goal\nFinish the migration.", usage: { input: 120, output: 30 } }
      ])
      const summarise = Compaction.model()
      // The summariser's requirement is the model, and nothing else: that is
      // what lets it be satisfied by a model other than the agent's.
      type _R = Assert<Equal<
        typeof summarise,
        Compaction.Summarise<AiError.AiError, LanguageModel.LanguageModel>
      >>

      const result = yield* summarise({
        messages: conversation(2),
        previous: Option.some("Earlier: the schema was chosen."),
        instructions: Option.some("Keep the migration plan.")
      }).pipe(Effect.provide(layer))

      assert.deepStrictEqual(result, {
        text: "## Goal\nFinish the migration.",
        usage: Option.some({ inputTokens: 120, outputTokens: 30, totalTokens: 150 })
      })

      // What the model was actually asked: the structured headings in the
      // system message; the previous summary, the instructions and the
      // serialised transcript in the user message.
      const asked = (yield* recorder.prompts)[0]!
      const system = asked.content.find((m) => m.role === "system")
      assert.isDefined(system)
      if (system?.role === "system") {
        for (const heading of ["## Goal", "## Constraints and preferences", "## Progress", "## Decisions", "## Next steps", "## Critical context", "## Files"]) {
          assert.include(system.content, heading)
        }
      }
      const user = TestLanguageModel.userTexts(asked).join("\n")
      assert.include(user, "Earlier: the schema was chosen.")
      assert.include(user, "Keep the migration plan.")
      assert.include(user, "[User]\nquestion 1")
      assert.include(user, "[Assistant]\nanswer 2")
    })
  )

  it.effect("compact() folds on request, regardless of the threshold, and the next turn projects it", () =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<Array<{ messages: number; previous: Option.Option<string>; instructions: Option.Option<string> }>>([])
      const compaction = yield* Compaction.controller({
        // A threshold the conversation never reaches: only a manual compact
        // can fold anything.
        policy: Compaction.whenLongerThan(1_000, { retain: 2 }),
        summarise: ({ messages, previous, instructions }) =>
          Ref.update(asked, (all) => [...all, { messages: messages.content.length, previous, instructions }]).pipe(
            Effect.as(`summary of ${messages.content.length}`)
          )
      })
      // The memory-backed controller cannot fail to load or forget.
      type _Store = Assert<Equal<
        ReturnType<typeof compaction.checkpoint>,
        Effect.Effect<Option.Option<Compaction.Checkpoint>, never>
      >>

      const { layer, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two"),
        TestLanguageModel.text("three"),
        TestLanguageModel.text("after")
      ])

      const out = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ contextTransform: compaction.transform, loop: AgentLoop.bounded(1) })
          )
          for (const input of ["a", "b", "c"]) yield* session.prompt(input)
          assert.isTrue(Option.isNone(yield* compaction.checkpoint(session.id)))

          const checkpoint = yield* compaction.compact({
            sessionId: session.id,
            history: yield* session.history,
            instructions: "Keep the plan."
          })
          const stored = yield* compaction.checkpoint(session.id)

          yield* session.prompt("d")
          return { checkpoint, stored, historyLength: (yield* session.history).content.length }
        })
      ).pipe(Effect.provide(layer))

      // Six messages, two retained: four folded, with the instructions.
      assert.deepStrictEqual(yield* Ref.get(asked), [
        { messages: 4, previous: Option.none(), instructions: Option.some("Keep the plan.") }
      ])
      assert.strictEqual(out.checkpoint.coveredThrough, 4)
      assert.strictEqual(out.checkpoint.summary, "summary of 4")
      assert.deepStrictEqual(out.stored, Option.some(out.checkpoint))
      // Canonical history is untouched by the fold.
      assert.strictEqual(out.historyLength, 8)

      // The turn after the manual compaction saw the summary plus the tail,
      // not the transcript, and did not summarise again.
      const prompts = yield* recorder.prompts
      const last = prompts[prompts.length - 1]!
      assert.deepStrictEqual(summaryOf(last), ["Summary of the earlier conversation:\n\nsummary of 4"])
      assert.strictEqual(last.content.length, 1 + 2 + 1)
      assert.strictEqual((yield* Ref.get(asked)).length, 1)
    })
  )

  it.effect("compact() with nothing to fold fails typed, leaves the checkpoint, and says so on the stream", () =>
    Effect.gen(function* () {
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(1, { retain: 2 }),
        summarise: () => Effect.succeed("unreachable")
      })
      const seen = yield* Ref.make<Array<Compaction.CompactionEvent>>([])
      yield* Effect.forkScoped(
        Stream.runForEach(compaction.events, (event) => Ref.update(seen, (all) => [...all, event]))
      )
      yield* Effect.yieldNow

      const exit = yield* Effect.exit(
        compaction.compact({ sessionId: "s", history: conversation(1) })
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        assert.instanceOf(error, Compaction.CompactionCannotHelpError)
        if (error instanceof Compaction.CompactionCannotHelpError) {
          assert.strictEqual(error.kind, "nothing-to-fold")
        }
      }
      assert.isTrue(Option.isNone(yield* compaction.checkpoint("s")))
      const events = yield* Ref.get(seen)
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0]?._tag, "CompactionFailed")
      if (events[0]?._tag === "CompactionFailed") {
        assert.strictEqual(events[0].trigger, "manual")
        assert.include(events[0].reason, "nothing to fold")
      }
    }).pipe(Effect.scoped)
  )

  it.effect("events report started and completed, with usage, for automatic and manual compactions", () =>
    Effect.gen(function* () {
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: ({ messages }) =>
          Effect.succeed<Compaction.SummaryResult>({
            text: `folded ${messages.content.length}`,
            usage: Option.some({ inputTokens: 40, outputTokens: 8, totalTokens: 48 })
          })
      })
      const seen = yield* Ref.make<Array<Compaction.CompactionEvent>>([])
      yield* Effect.forkScoped(
        Stream.runForEach(compaction.events, (event) => Ref.update(seen, (all) => [...all, event]))
      )
      yield* Effect.yieldNow

      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two"),
        TestLanguageModel.text("three")
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ contextTransform: compaction.transform, loop: AgentLoop.bounded(1) })
          )
          // Turn three runs the transform over five canonical messages (the
          // reply is not committed yet): two retained, three foldable > 2.
          for (const input of ["a", "b", "c"]) yield* session.prompt(input)
          // Then a manual one over the committed six: the checkpoint covers
          // three, the tail is two, so exactly one message is left to fold.
          yield* compaction.compact({ sessionId: session.id, history: yield* session.history })
        })
      ).pipe(Effect.provide(layer))
      yield* Effect.yieldNow

      const events = yield* Ref.get(seen)
      assert.deepStrictEqual(events.map((e) => [e._tag, e.trigger]), [
        ["CompactionStarted", "automatic"],
        ["CompactionCompleted", "automatic"],
        ["CompactionStarted", "manual"],
        ["CompactionCompleted", "manual"]
      ])
      const completed = events[1]
      if (completed?._tag === "CompactionCompleted" && Compaction.isSummary(completed.checkpoint)) {
        assert.strictEqual(completed.checkpoint.coveredThrough, 3)
        assert.strictEqual(completed.checkpoint.summary, "folded 3")
        assert.deepStrictEqual(
          completed.checkpoint.usage,
          Option.some({ inputTokens: 40, outputTokens: 8, totalTokens: 48 })
        )
      }
      const started = events[0]
      if (started?._tag === "CompactionStarted") assert.strictEqual(started.messages, 3)
      const manual = events[3]
      if (manual?._tag === "CompactionCompleted" && Compaction.isSummary(manual.checkpoint)) {
        assert.strictEqual(manual.checkpoint.coveredThrough, 4)
        assert.strictEqual(manual.checkpoint.summary, "folded 1")
      }
      // The event vocabulary is a Schema: it round-trips through JSON, by
      // the same codec the key-value checkpoint store uses.
      const json = Schema.fromJsonString(Schema.toCodecJson(Schema.Array(Compaction.CompactionEvent)))
      const encoded = yield* Schema.encodeEffect(json)(events)
      assert.strictEqual(typeof encoded, "string")
      assert.deepStrictEqual(yield* Schema.decodeEffect(json)(encoded), events)
    }).pipe(Effect.scoped)
  )

  it.effect("compaction giving up under a token policy is reported as failed, once, and not on interruption", () =>
    Effect.gen(function* () {
      const compaction = yield* Compaction.controller({
        policy: Compaction.tokens({
          // Per-message cost is 1; the window is tight enough that a summary
          // of ten characters cannot fit under the line.
          budget: { contextWindow: 6, reserveTokens: 1, keepRecentTokens: 2 },
          estimate: (prompt) => Effect.succeed(prompt.content.length === 1 ? 1 : prompt.content.length * 3)
        }),
        summarise: () => Effect.succeed("a summary far too large for the budget")
      })
      const seen = yield* Ref.make<Array<Compaction.CompactionEvent>>([])
      yield* Effect.forkScoped(
        Stream.runForEach(compaction.events, (event) => Ref.update(seen, (all) => [...all, event]))
      )
      yield* Effect.yieldNow

      // Turn one projects one message (cost 1, under the line of 5). Turn two
      // projects three (cost 9): the walk keeps two, folds one, and the
      // summary plus the tail is three messages again -- still 9.
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two")
      ])
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ contextTransform: compaction.transform, loop: AgentLoop.bounded(1) })
          )
          yield* session.prompt("a")
          return yield* Effect.exit(session.prompt("b"))
        })
      ).pipe(Effect.provide(layer))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        assert.instanceOf(error, Compaction.CompactionCannotHelpError)
        if (error instanceof Compaction.CompactionCannotHelpError) {
          assert.strictEqual(error.kind, "summary-too-large")
        }
      }
      yield* Effect.yieldNow
      // Started, then exactly one Failed naming the reason -- not one from the
      // summariser wrapper and another from the transform.
      assert.deepStrictEqual((yield* Ref.get(seen)).map((e) => e._tag), ["CompactionStarted", "CompactionFailed"])
      const failed = (yield* Ref.get(seen))[1]
      if (failed?._tag === "CompactionFailed") {
        assert.strictEqual(failed.trigger, "automatic")
        assert.include(failed.reason, "summary still over budget")
      }

      // An interrupted summary is not a failed compaction.
      const parked = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(1, { retain: 1 }),
        summarise: () => Effect.never
      })
      const parkedSeen = yield* Ref.make<Array<Compaction.CompactionEvent>>([])
      yield* Effect.forkScoped(
        Stream.runForEach(parked.events, (event) => Ref.update(parkedSeen, (all) => [...all, event]))
      )
      yield* Effect.yieldNow
      const fiber = yield* Effect.forkChild(parked.compact({ sessionId: "p", history: conversation(3) }))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      // Generous, because the claim is that nothing arrives: a single yield
      // would pass even if a late event were on its way.
      for (let i = 0; i < 50; i++) yield* Effect.yieldNow
      assert.deepStrictEqual((yield* Ref.get(parkedSeen)).map((e) => e._tag), ["CompactionStarted"])
    }).pipe(Effect.scoped)
  )

  it.effect("clear() forgets the checkpoint, so the next turn summarises again", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        summarise: ({ messages }) =>
          Ref.update(calls, (n) => n + 1).pipe(Effect.as(`folded ${messages.content.length}`))
      })
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two"),
        TestLanguageModel.text("three"),
        TestLanguageModel.text("four")
      ])
      const out = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ contextTransform: compaction.transform, loop: AgentLoop.bounded(1) })
          )
          for (const input of ["a", "b", "c"]) yield* session.prompt(input)
          const before = yield* Ref.get(calls)
          const had = Option.isSome(yield* compaction.checkpoint(session.id))
          yield* compaction.clear(session.id)
          const cleared = Option.isNone(yield* compaction.checkpoint(session.id))
          yield* session.prompt("d")
          return { before, had, cleared, after: yield* Ref.get(calls) }
        })
      ).pipe(Effect.provide(layer))
      assert.strictEqual(out.before, 1)
      assert.isTrue(out.had)
      assert.isTrue(out.cleared)
      // Without `clear`, turn four would have folded nothing new (two fresh
      // messages, threshold two) and reused the checkpoint. With it, the
      // whole foldable stretch is summarised from scratch.
      assert.strictEqual(out.after, 2)
    })
  )

  it.effect("the summarising model can differ from the agent's", () =>
    Effect.gen(function* () {
      const agentModel = yield* TestLanguageModel.script([
        TestLanguageModel.text("one"),
        TestLanguageModel.text("two"),
        TestLanguageModel.text("three")
      ])
      const cheap = yield* TestLanguageModel.script([
        { text: "CHEAP SUMMARY", usage: { input: 10, output: 2 } }
      ])
      const summarise = Compaction.model()
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(2, { retain: 2 }),
        // The summariser's model requirement is discharged here, by the
        // cheap model, so the transform asks nothing of the session's.
        summarise: (input) => summarise(input).pipe(Effect.provide(cheap.layer))
      })
      const { layer, recorder } = agentModel
      const checkpoint = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({ contextTransform: compaction.transform, loop: AgentLoop.bounded(1) })
          )
          for (const input of ["a", "b", "c"]) yield* session.prompt(input)
          return yield* compaction.checkpoint(session.id)
        })
      ).pipe(Effect.provide(layer))

      assert.isTrue(Option.isSome(checkpoint))
      if (Option.isSome(checkpoint) && Compaction.isSummary(checkpoint.value)) {
        assert.strictEqual(checkpoint.value.summary, "CHEAP SUMMARY")
        assert.deepStrictEqual(checkpoint.value.usage, Option.some({ inputTokens: 10, outputTokens: 2, totalTokens: 12 }))
      }
      // The agent's model answered three prompts and was never asked to
      // summarise; the cheap one was asked exactly once.
      assert.strictEqual((yield* recorder.prompts).length, 3)
      assert.strictEqual((yield* cheap.recorder.prompts).length, 1)
    })
  )
})
