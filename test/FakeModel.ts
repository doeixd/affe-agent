import { IdGenerator, LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"

/**
 * What a scripted turn should produce.
 */
export interface Turn {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly params: unknown
  }>
  /**
   * Runs while the model call is in flight, letting a test drive concurrent
   * interaction (steering, interrupt) at a precisely known moment.
   */
  readonly during?: Effect.Effect<void, never, never>
  /**
   * Completed once the model call has actually been entered.
   *
   * Waiting on session state is not enough: a run becomes active slightly
   * before it reaches the model, so tests that interrupt "during generation"
   * must synchronise on this instead to stay deterministic.
   */
  readonly started?: Deferred.Deferred<void>
  /** Fails the model call, to exercise run failure. */
  readonly fail?: string
  /** Never completes, so the run can be interrupted mid-generation. */
  readonly hang?: boolean
}

export interface Recorder {
  /** The exact model-facing prompt seen by each call, in order. */
  readonly prompts: Effect.Effect<ReadonlyArray<Prompt.Prompt>>
  readonly calls: Effect.Effect<number>
}

const finishPart = (): Response.PartEncoded => ({
  type: "finish",
  reason: "stop",
  // v4 groups token counts by direction rather than a flat record.
  usage: {
    inputTokens: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 }
  }
})

const partsFor = (turn: Turn): Array<Response.PartEncoded> => {
  const parts: Array<Response.PartEncoded> = []
  if (turn.text !== undefined) {
    parts.push({ type: "text", text: turn.text })
  }
  for (const call of turn.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      id: call.id,
      name: call.name,
      params: call.params
    })
  }
  parts.push(finishPart())
  return parts
}

/**
 * A LanguageModel that replays a fixed script.
 *
 * Determinism is the point: loop continuation, event ordering and steering
 * placement become assertions rather than observations of a real provider.
 */
export const make = (turns: ReadonlyArray<Turn>) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<Array<Prompt.Prompt>>([])
    const index = yield* Ref.make(0)

    const next = (options: { readonly prompt: Prompt.Prompt }) =>
      Effect.gen(function* () {
        yield* Ref.update(seen, (all) => [...all, options.prompt])
        const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
        const turn = turns[i]
        if (turn === undefined) {
          return [finishPart()]
        }
        if (turn.started !== undefined) {
          yield* Deferred.succeed(turn.started, void 0)
        }
        if (turn.during !== undefined) {
          yield* turn.during
        }
        if (turn.hang === true) {
          return yield* Effect.never
        }
        if (turn.fail !== undefined) {
          return yield* Effect.die(new Error(turn.fail))
        }
        return partsFor(turn)
      })

    const service = yield* LanguageModel.make({
      generateText: (options) => next(options),
      // The harness does not stream in v0.1. A stub that pretended to would
      // be silently wrong the moment streaming lands; this fails loudly.
      streamText: () =>
        Stream.fromEffect(
          Effect.die(new Error("FakeModel does not implement streamText"))
        )
    })

    const recorder: Recorder = {
      prompts: Ref.get(seen),
      calls: Ref.get(index)
    }

    return { service, recorder }
  })

/**
 * Layer form, plus the recorder for asserting on derived context.
 */
export const layer = (turns: ReadonlyArray<Turn>) =>
  Effect.gen(function* () {
    const { recorder, service } = yield* make(turns)
    const layer = Layer.succeed(LanguageModel.LanguageModel, service).pipe(
      Layer.provideMerge(
        Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)
      )
    )
    return { layer, recorder }
  })

/** Text of every user message in a prompt, for concise assertions. */
export const userTexts = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        )
      : []
  )

/** Role sequence of a prompt. */
export const roles = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.map((message) => message.role)
