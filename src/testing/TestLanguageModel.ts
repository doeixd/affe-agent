import { IdGenerator, LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { Deferred, Effect, Layer, Ref, Stream } from "effect"

/**
 * A `LanguageModel` that replays a fixed script.
 *
 * Determinism is the whole point. Loop continuation, event ordering, steering
 * placement and interruption boundaries become assertions rather than
 * observations of a real provider — and the awkward parts of driving a model
 * from a test (blocking a call, failing one, entering one at a known instant)
 * are declared in the script rather than raced.
 *
 * This is the same model the library's own suite runs against.
 */

/**
 * What a scripted turn should produce.
 */
export interface Turn {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly params: unknown
    /** Marks a call the provider already executed; see `AgentTurn`. */
    readonly providerExecuted?: boolean
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
  /**
   * How this turn's text arrives when the caller streams.
   *
   * Ignored by a batch call, which sees the same `text` either way — which is
   * the point: a script asserts that streaming changes *when* output is
   * observed, not what the turn produces. Defaults to the whole text in one
   * chunk.
   */
  readonly chunks?: ReadonlyArray<string>
  /**
   * Report a failure *inside* the stream rather than by failing it.
   *
   * A real provider can do this, and it is a distinct case: the stream is
   * well-formed and carries an error part. Streaming-only, since a batch call
   * has no equivalent.
   */
  readonly streamError?: string
}

export interface Recorder {
  /** The exact model-facing prompt seen by each call, in order. */
  readonly prompts: Effect.Effect<ReadonlyArray<Prompt.Prompt>>
  readonly calls: Effect.Effect<number>
}

// Typed as the finish part itself, not the wide union: it belongs to both
// the batch and stream part unions, and naming it lets both use it.
const finishPart = (): Response.FinishPartEncoded => ({
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
      params: call.params,
      ...(call.providerExecuted === undefined
        ? {}
        : { providerExecuted: call.providerExecuted })
    })
  }
  parts.push(finishPart())
  return parts
}

/**
 * The same turn, as a stream.
 *
 * Text is split into `chunks` if the script says so, and otherwise arrives
 * whole. Either way the accumulated result is the turn's `text`, so a script
 * can be run batched and streamed and the two compared.
 */
const streamPartsFor = (turn: Turn): Array<Response.StreamPartEncoded> => {
  const parts: Array<Response.StreamPartEncoded> = []
  if (turn.text !== undefined) {
    const id = "text-0"
    parts.push({ type: "text-start", id })
    for (const chunk of turn.chunks ?? [turn.text]) {
      parts.push({ type: "text-delta", id, delta: chunk })
    }
    parts.push({ type: "text-end", id })
  }
  for (const call of turn.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      id: call.id,
      name: call.name,
      params: call.params,
      ...(call.providerExecuted === undefined
        ? {}
        : { providerExecuted: call.providerExecuted })
    })
  }
  if (turn.streamError !== undefined) {
    parts.push({ type: "error", error: new Error(turn.streamError) })
    return parts
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

    /**
     * Advance the script and run this turn's hooks.
     *
     * Shared by both paths so a script means the same thing whichever is used:
     * the cursor moves once, `during` runs at the same point, and `hang` and
     * `fail` behave identically.
     */
    const nextTurn = (options: { readonly prompt: Prompt.Prompt }) =>
      Effect.gen(function* () {
        yield* Ref.update(seen, (all) => [...all, options.prompt])
        const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
        const turn = turns[i]
        if (turn === undefined) {
          return undefined
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
        return turn
      })

    const next = (options: { readonly prompt: Prompt.Prompt }) =>
      Effect.map(nextTurn(options), (turn) =>
        turn === undefined ? [finishPart()] : partsFor(turn)
      )

    const service = yield* LanguageModel.make({
      generateText: (options) => next(options),
      // The same script, delivered as a stream. A turn's `chunks` control how
      // the text is broken up; everything else -- tool calls, the hooks, the
      // finish part -- behaves exactly as it does for a batch call, so a test
      // can run one script both ways and compare.
      streamText: (options) =>
        Stream.unwrap(
          Effect.map(nextTurn(options), (turn) =>
            turn === undefined
              ? Stream.fromIterable<Response.StreamPartEncoded>([finishPart()])
              : Stream.fromIterable(streamPartsFor(turn))
          )
        )
    })

    const recorder: Recorder = {
      prompts: Ref.get(seen),
      calls: Ref.get(index)
    }

    return { service, recorder }
  })

/**
 * A scripted model as a `Layer`, plus the recorder for asserting on the
 * model-facing prompts the harness derived.
 *
 * ```ts
 * const { layer, recorder } = yield* TestLanguageModel.script([
 *   TestLanguageModel.toolCall("search", { query: "effect" }, { id: "s1" }),
 *   TestLanguageModel.text("found it")
 * ])
 * ```
 */
export const script = (turns: ReadonlyArray<Turn>) =>
  Effect.gen(function* () {
    const { recorder, service } = yield* make(turns)
    const layer = Layer.succeed(LanguageModel.LanguageModel, service).pipe(
      Layer.provideMerge(
        Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)
      )
    )
    return { layer, recorder }
  })

/** A turn that returns text and no tool calls. */
export const text = (value: string): Turn => ({ text: value })

/** A turn that asks for one tool call. */
export const toolCall = (
  name: string,
  params: unknown,
  options?: {
    readonly id?: string | undefined
    /** Marks a call the provider already executed; see `AgentTurn`. */
    readonly providerExecuted?: boolean | undefined
  }
): Turn => ({
  toolCalls: [
    {
      id: options?.id ?? `${name}-call`,
      name,
      params,
      ...(options?.providerExecuted === undefined
        ? {}
        : { providerExecuted: options.providerExecuted })
    }
  ]
})

/** A turn that asks for several tool calls at once, to exercise concurrency. */
export const toolCalls = (
  calls: ReadonlyArray<{
    readonly name: string
    readonly params: unknown
    readonly id?: string | undefined
  }>
): Turn => ({
  toolCalls: calls.map((call) => ({
    id: call.id ?? `${call.name}-call`,
    name: call.name,
    params: call.params
  }))
})

/**
 * Wrap a `LanguageModel` layer so each `generateText` is counted.
 *
 * Decorating a provider is an ordinary thing to do — the durable interpreter
 * does exactly this — but `generateText` is heavily overloaded, so the cast it
 * needs is absorbed here once. That is the point of shipping it: a test that
 * wants to count model calls should not have to write a cast to do it.
 */
export const counting = (
  base: Layer.Layer<LanguageModel.LanguageModel>,
  calls: Ref.Ref<number>
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const inner = yield* LanguageModel.LanguageModel
      // Both entry points count: a streamed call reaches the provider
      // through `streamText`, and a wrapper that counted only the batch
      // path would report a streamed turn as no call at all.
      return {
        ...inner,
        generateText: ((options: never) =>
          Ref.update(calls, (n) => n + 1).pipe(
            Effect.andThen(inner.generateText(options))
          )) as unknown as LanguageModel.Service["generateText"],
        streamText: ((options: never) =>
          Stream.unwrap(
            Ref.update(calls, (n) => n + 1).pipe(Effect.as(inner.streamText(options)))
          )) as unknown as LanguageModel.Service["streamText"]
      }
    })
  ).pipe(Layer.provide(base))

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
