import { Cause, Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import * as AgentEvent from "../AgentEvent.js"
import * as Accumulator from "../internal/streamAccumulator.js"
import { AiError, LanguageModel, Response, Toolkit } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"
import type * as AgentOutput from "../AgentOutput.js"
import { describedTools } from "../internal/describedTools.js"

/**
 * Makes every model call of a submission a durable `Activity`.
 *
 * A model call is the archetypal thing you must not repeat on replay: it is
 * billed, nondeterministic, and may have provider-side effects. Wrapping it in
 * an activity means a resumed execution returns the persisted response instead
 * of asking the model again.
 *
 * This is a Layer that replaces `LanguageModel`, so the harness above it is
 * untouched — it is the substitution point PLAN §30.1 identified.
 */

/**
 * Wrap an existing `LanguageModel` so its responses are persisted.
 *
 * The response is stored as its content parts, which `Response.Part` can encode
 * for a given toolkit. `GenerateTextResponse` is then reconstructed from those
 * parts on replay, so callers cannot tell the difference.
 */
/** What a model activity persists: an outcome, never a failure. */
type ModelOutcome =
  | { readonly _tag: "Succeeded"; readonly parts: ReadonlyArray<any> }
  | { readonly _tag: "Failed"; readonly failure: AgentEvent.Failure }

/** A provider failure, as it survives the durable boundary. */
export class DurableModelFailure extends Schema.TaggedError<DurableModelFailure>()(
  "DurableModelFailure",
  { failure: AgentEvent.Failure }
) {
  override get message() {
    return `Model call failed: ${this.failure.message}`
  }
}

/**
 * A completed response, re-expressed as the stream parts that would have
 * produced it.
 *
 * Text and reasoning arrive as one chunk each: the original chunking is a
 * property of the provider's connection, not of the turn, and is exactly the
 * thing the journal must not depend on. Everything else passes through as it
 * is.
 */
const streamPartsFor = (
  parts: ReadonlyArray<Response.PartEncoded>
): Array<Response.StreamPartEncoded> => {
  const out: Array<Response.StreamPartEncoded> = []
  let chunk = 0
  for (const part of parts) {
    if (part.type === "text" || part.type === "reasoning") {
      const id = `durable-${part.type}-${chunk++}`
      out.push({ type: `${part.type}-start`, id })
      out.push({ type: `${part.type}-delta`, id, delta: part.text })
      out.push({ type: `${part.type}-end`, id })
    } else {
      out.push(part)
    }
  }
  return out
}

export const wrap = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  options?: {
    readonly prefix?: string | undefined
    /**
     * The agent's declared output, when it has one.
     *
     * Its tool is injected per turn by `AgentTurn` and never enters the
     * agent's tool record, so the journal's part schema has to be told about
     * it separately -- see `internal/describedTools.ts` for why that set has a
     * name. Without it, encoding a response that calls the output tool fails
     * and the submission dies with a `SchemaError` naming a union the reader
     * has no way to connect to a missing output tool.
     *
     * Only the schemas are affected. Handlers are untouched, which is right:
     * the injected tool's handler closes over one session's staged value and
     * is not an activity to replay.
     */
    readonly output?: Option.Option<AgentOutput.AgentOutput<any, any>> | undefined
  }
): Effect.Effect<
  Layer.Layer<LanguageModel.LanguageModel>,
  never,
  LanguageModel.LanguageModel | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const underlying = yield* LanguageModel.LanguageModel

    // `Activity.make` needs the workflow context, but the service methods below
    // are called by the harness, which knows nothing about workflows. Capturing
    // the context here — inside the running workflow — is what reconciles them,
    // and it is why this layer must be built inside the workflow body.
    const workflowContext = yield* Effect.context<
      WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
    >()

    // Captured before the service closures below, whose own `options`
    // parameter would otherwise shadow this one.
    const prefix = options?.prefix ?? ""

    // Activity names must be stable across replays. A submission's model calls
    // are consumed in a fixed order, so their ordinal is exactly that.
    const callIndex = yield* Ref.make(0)

    // With `disableToolCallResolution`, model responses deliberately carry
    // tool parameters in their encoded form. `Response.Part(toolkit)` instead
    // describes a live part whose parameters are decoded and therefore tries
    // to *encode* them here. That is invisible for strings and wrong for a
    // transformation such as URLFromString: the journal sees the model's URL
    // string where the schema expects a URL object. Give only the journalling
    // codec encoded parameter schemas; result schemas remain unchanged.
    // Everything a response can mention: the agent's own tools, plus whatever
    // the harness injects per turn and the agent's record therefore omits.
    const described = describedTools(toolkit.tools, { output: options?.output ?? Option.none() })
    // Left over the agent's own toolkit on purpose: this one is used only for
    // its *type* parameters, which the cast below restates, and widening it to
    // `Tool.Any` erases `Tools` and takes the stream's element type with it.
    const livePartSchema = Response.Part(toolkit)
    const encodedToolkit = Toolkit.make(
      ...described.map((tool) => tool.setParameters(Schema.toEncoded(tool.parametersSchema)))
    )
    const encodedPartSchema = Response.Part(encodedToolkit) as Schema.Codec<
      Response.Part<Tools, true>,
      Response.PartEncoded,
      (typeof livePartSchema)["DecodingServices"],
      (typeof livePartSchema)["EncodingServices"]
    >
    const partsSchema = Schema.Array(encodedPartSchema)
    // A real schema, not `Schema.Unknown`: response parts are class instances
    // that `Unknown` cannot encode, which is how the original parts schema came
    // to exist. The outcome union has to preserve that.
    const outcomeSchema = Schema.Union([
      Schema.TaggedStruct("Succeeded", { parts: partsSchema }),
      Schema.TaggedStruct("Failed", { failure: AgentEvent.Failure })
    ])

    /**
     * One journalled model call. Named so `streamText` can reuse it directly:
     * going through `service.generateText` would mean re-entering Effect AI's
     * overloads, which erase the tool types the harness depends on.
     */
    const durableGenerate = (
      options: any,
      /** On a first run, every provider stream part as it arrives. Absent on the batch path. */
      tap?: (part: Response.StreamPart<Tools, true>) => void
    ) =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(callIndex, (n) => n + 1)
          // Like tool activities, this must not fail: an activity with no
          // declared error schema cannot encode a failure, and the engine
          // records an unencodable `SchemaError` instead of the provider error.
          // The outcome is carried as a value and re-raised here.
          const outcome = yield* Activity.make({
            // The prefix scopes the name to one submission when the caller
            // runs several executions against the same workflow definition —
            // without it, a second execution's `model-0` meets the first's.
            name: `${prefix}model-${index}`,
            success: outcomeSchema,
            execute: (
              tap === undefined
                ? (underlying.generateText(options) as unknown as Effect.Effect<
                    LanguageModel.GenerateTextResponse<Tools>,
                    unknown
                  >)
                : // The live path: the provider's stream, folded into the
                  // completed response the journal keeps, with each part
                  // handed to the harness as it arrives. This runs exactly
                  // once -- a replay never enters `execute` -- so deltas
                  // are delivered live on the first run and never twice.
                  Stream.runFoldEffect(
                    underlying.streamText(options) as Stream.Stream<
                      Response.StreamPart<Tools, true>,
                      unknown
                    >,
                    () => Accumulator.empty<Tools>(),
                    (state, part) => {
                      const next = Accumulator.step(state, part)
                      if (next._tag === "Failed") {
                        return Effect.fail(
                          new AiError.InternalProviderError({
                            description: Accumulator.describeStreamError(next.error)
                          })
                        )
                      }
                      tap(part)
                      return Effect.succeed(next.state)
                    }
                  ).pipe(
                    Effect.map(
                      (state) =>
                        new LanguageModel.GenerateTextResponse<Tools>([
                          ...Accumulator.finish(state)
                        ] as Array<Response.Part<Tools, any>>)
                    )
                  )
            ).pipe(
              Effect.map(
                (response): ModelOutcome => ({
                  _tag: "Succeeded",
                  parts: response.content as ReadonlyArray<any>
                })
              ),
              Effect.catchCause(
                (cause): Effect.Effect<ModelOutcome> =>
                  Cause.hasInterruptsOnly(cause)
                    ? (Effect.failCause(cause) as unknown as Effect.Effect<
                        ModelOutcome
                      >)
                    : Effect.succeed<ModelOutcome>({
                        _tag: "Failed",
                        failure: AgentEvent.failureFromCause(cause)
                      })
              )
            )
          }).pipe(Effect.provide(workflowContext))

          const result = outcome as ModelOutcome
          if (result._tag === "Failed") {
            return yield* new DurableModelFailure({ failure: result.failure })
          }

          return new LanguageModel.GenerateTextResponse(
            result.parts as Array<Response.Part<any, any>>
          )
        })

    const service: LanguageModel.Service = {
      ...underlying,
      generateText:
        durableGenerate as unknown as LanguageModel.Service["generateText"],
      // Streaming under durability, defined rather than refused.
      //
      // WORKFLOW_CLUSTER_PLAN separates three things that are easy to
      // conflate: the workflow journal is *computation* durability, canonical
      // history is *semantic* state, and reconnectable streaming output is the
      // delivery log. Journalling every token delta would put a delivery
      // concern in the computation journal, and make a replayed turn's
      // durability depend on how a provider happened to chunk its output.
      //
      // So the journal keeps what it already keeps: one entry per model
      // call, holding the completed response. On a *first* run the provider's
      // parts are handed to the harness live, from inside the activity, as
      // they arrive -- the harness emits `MessageDelta` for each exactly as
      // it does locally, and the delivery log records them as they happen.
      // On a *replay* the journal answers at once, and the completed response
      // is re-expressed as one chunk per text part: the original chunking was
      // a property of a connection that no longer exists.
      //
      // What is guaranteed either way is that a streamed durable submission
      // commits exactly the history a batched one does.
      streamText: ((options: any) =>
        Stream.callback<Response.StreamPart<Tools, true>, unknown>((queue) =>
          Effect.gen(function* () {
            let live = false
            // Runs in the callback's own fibre while the consumer reads.
            const exit = yield* Effect.exit(
              durableGenerate(options, (part) => {
                live = true
                Queue.offerUnsafe(queue, part)
              })
            )
            if (exit._tag === "Failure") {
              Queue.failCauseUnsafe(queue, exit.cause)
              return
            }
            if (!live) {
              // A replay, or a provider whose stream produced nothing: the
              // journalled response, as the parts that would have produced it.
              const encoded = yield* Schema.encodeEffect(partsSchema)(
                exit.value.content as ReadonlyArray<Response.Part<Tools, true>>
              ).pipe(Effect.orDie)
              Queue.offerAllUnsafe(
                queue,
                streamPartsFor(encoded) as unknown as ReadonlyArray<Response.StreamPart<Tools, true>>
              )
            }
            Queue.endUnsafe(queue)
          })
        )) as unknown as LanguageModel.Service["streamText"]
    }

    return Layer.succeed(LanguageModel.LanguageModel, service)
  })
