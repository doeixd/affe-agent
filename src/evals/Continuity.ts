import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { IdGenerator, LanguageModel, Prompt } from "effect/unstable/ai"
import type { Response } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as AgentLoop from "../AgentLoop.js"
import * as AgentSession from "../AgentSession.js"
import * as ContextTransform from "../ContextTransform.js"
import { Compaction } from "../compaction/index.js"

/**
 * Can an agent stay coherent over a long lifetime?
 *
 * The pieces are each tested alone -- a fold, a rollover, a restore, a search
 * over folded history. What users care about is the property they add up to:
 * after many turns, repeated compaction and a few restarts, can the agent
 * still recall what it was told first, prefer what it was told last, and
 * point at where it heard it? This runs a scenario through all of it and
 * scores the answers **programmatically** -- against the scenario's own
 * ground truth and the session's canonical history, never an LLM judge.
 *
 * Each question is scored three ways:
 *
 * - `correct` -- the answer contains the expected text and none of the stale
 *   text (a superseded value is a wrong answer, not a partial one);
 * - `inView` -- whether the fact was still in the prompt the model was sent.
 *   Checked for the source statement. A question answerable by reading the
 *   prompt tests nothing, so the scenario only counts when this is false: the
 *   statement had really been folded away;
 * - `provenance` -- the canonical message a `search_context` hit pointed at,
 *   when that message is the one that stated the fact.
 *
 * The model comes from the environment. `referenceModel` is a deterministic
 * one that follows the strategy a good agent should -- search for the quoted
 * phrase, answer from the latest user statement -- so the whole pipeline runs
 * in the ordinary suite with no key; a real model runs the same scenario for
 * the live tier.
 *
 * "Restart" is a process ending *between* submissions: the session is
 * snapshotted, its scope closed, and a new one restored from the snapshot.
 * Death *inside* a submission is `DurableEquivalence`'s subject.
 */

/** One thing that happens in a scenario. */
export type Step =
  /** The user says something. Facts, corrections and filler are all this. */
  | { readonly _tag: "Say"; readonly text: string }
  /** The process ends between submissions and a new one restores the session. */
  | { readonly _tag: "Restart" }
  /**
   * The user asks. `phrase` is quoted in the question, which is what a
   * searching agent looks for. `expect` must appear in the answer, `stale`
   * must not, and `source` is the text of the statement that should be found.
   */
  | {
    readonly _tag: "Ask"
    readonly id: string
    readonly phrase: string
    readonly question: string
    readonly expect: string
    readonly stale?: ReadonlyArray<string> | undefined
    readonly source: string
  }

export interface Scenario {
  readonly name: string
  readonly steps: ReadonlyArray<Step>
}

export const say = (text: string): Step => ({ _tag: "Say", text })
export const restart: Step = { _tag: "Restart" }
export const ask = (options: Omit<Extract<Step, { readonly _tag: "Ask" }>, "_tag">): Step => ({
  _tag: "Ask",
  ...options
})

export interface AskReport {
  readonly id: string
  readonly answer: string
  readonly correct: boolean
  readonly inView: boolean
  /** The canonical index a search hit pointed at, when it holds the source statement. */
  readonly provenance: Option.Option<number>
}

export interface Report {
  readonly scenario: string
  /** Compactions that completed over the whole run. */
  readonly folds: number
  readonly restarts: number
  readonly asks: ReadonlyArray<AskReport>
  /** Every question correct, out of view, and traced to its source. */
  readonly passed: boolean
}

export interface Options {
  /**
   * Fold once more than this many foldable messages have accumulated. Default
   * 4: small, so a scenario of a few dozen turns folds a dozen times or more.
   */
  readonly foldAfter?: number | undefined
  /** Messages kept verbatim after a fold. Default 2. */
  readonly retain?: number | undefined
}

/**
 * The summary every fold writes. Deliberately empty of content: a fact must be
 * recovered from canonical history by search, not read out of a summary, or
 * the scenario would be testing the summariser instead.
 */
export const foldedSummary = "(earlier conversation folded; search it with search_context)"

const instructions =
  "You are a project assistant in a long conversation. Earlier parts of it are folded away. " +
  "When asked a question, call search_context with the phrase in quotes, then answer from the most recent " +
  "statement the user made about it -- a later correction replaces an earlier value."

/** Every text part of a message, joined. */
const textOf = (message: Prompt.Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

/** The question as the user says it: the phrase quoted, so a searching agent can find it. */
const questionText = (step: Extract<Step, { readonly _tag: "Ask" }>): string =>
  `Question: ${step.question} ("${step.phrase}")`

/**
 * Run a scenario and score it. Needs a `LanguageModel`.
 */
export const run = (scenario: Scenario, options?: Options) =>
  Effect.scoped(
    Effect.gen(function*() {
      const compaction = yield* Compaction.controller({
        policy: Compaction.whenLongerThan(options?.foldAfter ?? 4, { retain: options?.retain ?? 2 }),
        summarise: () => Effect.succeed(foldedSummary)
      })
      const folds = yield* Ref.make(0)
      yield* Effect.forkScoped(
        Stream.runForEach(compaction.events, (event) =>
          event._tag === "CompactionCompleted" ? Ref.update(folds, (n) => n + 1) : Effect.void)
      )
      yield* Effect.yieldNow

      // What the model was actually sent, per turn: `inView` reads it.
      const sent = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([])
      const recording = ContextTransform.make((context) =>
        Effect.tap(compaction.transform.transform(context), (prompt) => Ref.update(sent, (all) => [...all, prompt]))
      )
      const agent = Agent.make({
        instructions,
        tools: [compaction.tools.searchContext, compaction.tools.readContext],
        contextTransform: recording,
        loop: AgentLoop.bounded(4)
      })

      let snapshot: Option.Option<AgentSession.Snapshot> = Option.none()
      let restarts = 0
      const asks: Array<AskReport> = []

      // One segment per life of the process: a restart closes the session's
      // scope and the next segment restores it from the snapshot.
      const segments: Array<Array<Step>> = [[]]
      for (const step of scenario.steps) {
        if (step._tag === "Restart") segments.push([])
        else segments[segments.length - 1]!.push(step)
      }

      for (const [position, segment] of segments.entries()) {
        if (position > 0) restarts++
        snapshot = Option.some(
          yield* Effect.scoped(
            Effect.gen(function*() {
              const session = Option.isSome(snapshot)
                ? yield* AgentSession.restore(agent, snapshot.value)
                : yield* AgentSession.make(agent)
              for (const step of segment) {
                if (step._tag === "Say") {
                  yield* AgentSession.prompt(session, step.text)
                  continue
                }
                if (step._tag !== "Ask") continue
                const before = (yield* AgentSession.history(session)).content.length
                const sentBefore = (yield* Ref.get(sent)).length
                const result = yield* AgentSession.prompt(session, questionText(step))
                const history = (yield* AgentSession.history(session)).content
                const firstSent = (yield* Ref.get(sent))[sentBefore]
                asks.push({
                  id: step.id,
                  answer: result.text,
                  correct: result.text.toLowerCase().includes(step.expect.toLowerCase()) &&
                    !(step.stale ?? []).some((stale) => result.text.toLowerCase().includes(stale.toLowerCase())),
                  // The statement, not the answer word: an answer can be a
                  // substring of unrelated text ("ember" in "remember").
                  inView: firstSent !== undefined && JSON.stringify(firstSent.content).includes(step.source),
                  provenance: provenanceOf(history, before, step.source)
                })
              }
              return yield* AgentSession.snapshot(session)
            })
          )
        )
      }

      return {
        scenario: scenario.name,
        folds: yield* Ref.get(folds),
        restarts,
        asks,
        passed: asks.every((a) => a.correct && !a.inView && Option.isSome(a.provenance))
      } satisfies Report
    })
  )

/**
 * The latest `search_context` hit, made after `from`, that points at the
 * message stating `source`.
 */
const provenanceOf = (
  history: ReadonlyArray<Prompt.Message>,
  from: number,
  source: string
): Option.Option<number> => {
  const found: Array<number> = []
  for (const message of history.slice(from)) {
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.name !== "search_context") continue
      const search = Schema.decodeUnknownOption(Compaction.ContextSearch)(part.result)
      if (Option.isNone(search)) continue
      for (const hit of search.value.hits) {
        const stated = history[hit.index]
        if (stated !== undefined && stated.role === "user" && textOf(stated).includes(source)) found.push(hit.index)
      }
    }
  }
  return found.length === 0 ? Option.none() : Option.some(Math.max(...found))
}

// ---------------------------------------------------------------------------
// The reference model
// ---------------------------------------------------------------------------

const finish: Response.FinishPartEncoded = {
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 }
  }
}

/**
 * What the reference agent says next, from the conversation alone:
 *
 * - after a user question, search for its quoted phrase;
 * - after a search, answer from the hit with the highest index that is a user
 *   statement and not itself a question -- the latest thing the user said;
 * - otherwise acknowledge.
 *
 * It sees only the prompt it is sent, like any model, so it can only answer
 * what the harness lets it find.
 */
const respond = (prompt: Prompt.Prompt, callId: string): ReadonlyArray<Response.PartEncoded> => {
  const last = prompt.content[prompt.content.length - 1]
  if (last !== undefined && last.role === "tool") {
    for (const part of last.content) {
      if (part.type !== "tool-result" || part.name !== "search_context") continue
      const search = Schema.decodeUnknownOption(Compaction.ContextSearch)(part.result)
      const statements = Option.match(search, {
        onNone: () => [],
        onSome: (found) => found.hits.filter((hit) => hit.role === "user" && !hit.excerpt.includes("Question:"))
      })
      const latest = statements.reduce<Compaction.ContextHit | undefined>(
        (best, hit) => (best === undefined || hit.index > best.index ? hit : best),
        undefined
      )
      return [
        { type: "text", text: latest === undefined ? "I could not find that." : `From message ${latest.index}: ${latest.excerpt}` },
        finish
      ]
    }
  }
  if (last !== undefined && last.role === "user") {
    const phrase = /"([^"]+)"/.exec(textOf(last))
    if (textOf(last).startsWith("Question:") && phrase !== null) {
      return [{ type: "tool-call", id: callId, name: "search_context", params: { query: phrase[1] } }, finish]
    }
  }
  return [{ type: "text", text: "Noted." }, finish]
}

/** Stream form of the same parts: text as start/delta/end, everything else whole. */
const asStream = (parts: ReadonlyArray<Response.PartEncoded>): Array<Response.StreamPartEncoded> =>
  parts.flatMap((part): Array<Response.StreamPartEncoded> =>
    part.type === "text"
      ? [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: part.text }, { type: "text-end", id: "t" }]
      : part.type === "finish" || part.type === "tool-call"
      ? [part]
      : []
  )

/**
 * A deterministic model following the reference strategy, as a layer. For the
 * suite: it proves the pipeline -- folds, restarts, search, provenance -- can
 * carry a fact across a lifetime, so a live model's failure is the model's.
 */
export const referenceModel: Layer.Layer<LanguageModel.LanguageModel | IdGenerator.IdGenerator> = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function*() {
    const calls = yield* Ref.make(0)
    const next = (prompt: Prompt.Prompt) =>
      Effect.map(Ref.getAndUpdate(calls, (n) => n + 1), (n) => respond(prompt, `reference-${n}`))
    return yield* LanguageModel.make({
      generateText: (options) => Effect.map(next(options.prompt), (parts) => [...parts]),
      streamText: (options) => Stream.unwrap(Effect.map(next(options.prompt), (parts) => Stream.fromIterable(asStream(parts))))
    })
  })
).pipe(Layer.provideMerge(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)))

// ---------------------------------------------------------------------------
// The standard scenario
// ---------------------------------------------------------------------------

const filler = (from: number, count: number): ReadonlyArray<Step> =>
  Array.from({ length: count }, (_, i) => say(`Status note ${from + i}: routine progress, nothing new.`))

/**
 * An evolving project over three restarts: two facts, a correction that
 * supersedes one of them, an unfinished task, and enough routine talk between
 * them that each is folded away long before it is asked about.
 */
export const standard: Scenario = {
  name: "standard",
  steps: [
    say("The deploy window is Tuesday at noon."),
    say("The staging database is called ember."),
    ...filler(1, 8),
    restart,
    say("Open task: migrate the invoices table. Not started yet."),
    ...filler(9, 8),
    say("Correction: the deploy window is Thursday at 3pm, not Tuesday."),
    restart,
    ...filler(17, 8),
    restart,
    ...filler(25, 6),
    ask({
      id: "original-fact",
      phrase: "staging database",
      question: "What is the staging database called?",
      expect: "ember",
      source: "The staging database is called ember."
    }),
    ask({
      id: "latest-correction",
      phrase: "deploy window",
      question: "When is the deploy window?",
      expect: "Thursday at 3pm",
      stale: ["Tuesday at noon"],
      source: "Correction: the deploy window is Thursday at 3pm"
    }),
    ask({
      id: "unfinished-task",
      phrase: "Open task",
      question: "Which task is still open?",
      expect: "migrate the invoices table",
      source: "Open task: migrate the invoices table."
    })
  ]
}

/**
 * A value corrected twice, across restarts, with the older values still in
 * canonical history: the answer must be the latest, and both superseded ones
 * count as stale rather than as a pass. Separates a model that finds *a*
 * mention from one that finds the one that is still true.
 */
export const correctionChain: Scenario = {
  name: "correction-chain",
  steps: [
    say("The on-call owner this week is Priya."),
    ...filler(1, 8),
    restart,
    say("Update: the on-call owner is now Tomas, Priya is travelling."),
    ...filler(9, 8),
    restart,
    say("Update again: the on-call owner is Wen from today."),
    ...filler(17, 8),
    ask({
      id: "latest-of-three",
      phrase: "on-call owner",
      question: "Who is the on-call owner?",
      expect: "Wen",
      stale: ["Priya", "Tomas"],
      source: "Update again: the on-call owner is Wen from today."
    })
  ]
}
