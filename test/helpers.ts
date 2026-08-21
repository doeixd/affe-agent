import { Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import type { AgentDefinition } from "../src/Agent.js"
import type { AgentEventEnvelope } from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Toolkits are built the way a user builds them: one `Toolkit.make`, bound to
 * its own handlers, with no casts and no annotated handler parameters.
 *
 * Calling `Toolkit.make(tool)` a second time to produce the handler layer makes
 * two unrelated toolkits, and the handlers attach to the one you are not
 * using — every call then resolves to nothing and succeeds silently. Naming the
 * toolkit once is what prevents it.
 */
export const Echo = Tool.make("echo", {
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.String
})

export const EchoToolkit = Toolkit.make(Echo)

/**
 * The tool record an `echoToolkit` session carries.
 *
 * Spelled out because `AgentSession` is invariant in `Tools`: a session built
 * from this toolkit is not assignable to `AgentSession<{}>`. That is honest —
 * a submission's `Result` holds a `GenerateTextResponse<Tools, true>`, which
 * Effect AI makes invariant — and naming the type is better than widening to
 * `any` to paper over it.
 */
export type EchoTools = { readonly echo: typeof Echo }

export const echoToolkit = EchoToolkit.pipe(
  Effect.provide(
    EchoToolkit.toLayer({ echo: ({ value }) => Effect.succeed(value) })
  )
)

export interface Harness<Tools extends Record<string, Tool.Any>> {
  readonly session: AgentSession.AgentSession<Tools>
  readonly recorder: FakeModel.Recorder
  readonly events: Effect.Effect<ReadonlyArray<AgentEventEnvelope>>
}

export interface Outcome<A, Tools extends Record<string, Tool.Any>> {
  readonly value: A
  readonly events: ReadonlyArray<AgentEventEnvelope>
  readonly session: AgentSession.AgentSession<Tools>
  readonly recorder: FakeModel.Recorder
}

/**
 * Run a scenario against a scripted model with every event collected.
 */
export const withSession = <A, E, Tools extends Record<string, Tool.Any>>(
  turns: ReadonlyArray<FakeModel.Turn>,
  agent: AgentDefinition<Tools, never>,
  use: (harness: Harness<Tools>) => Effect.Effect<A, E>
): Effect.Effect<Outcome<A, Tools>, E> =>
  Effect.gen(function* () {
    const { layer, recorder } = yield* FakeModel.layer(turns)

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)

        const collected = yield* Queue.unbounded<AgentEventEnvelope>()
        yield* Effect.forkScoped(
          Stream.runForEach(AgentSession.events(session), (event) =>
            Queue.offer(collected, event)
          )
        )
        // Let the subscriber attach before any run produces events.
        yield* Effect.yieldNow

        const drain = Queue.clear(collected)
        const value = yield* use({ session, recorder, events: drain })
        const events = yield* drain
        return { value, events, session, recorder }
      }).pipe(Effect.provide(layer))
    )
  })

export const tags = (events: ReadonlyArray<AgentEventEnvelope>) =>
  events.map((e) => e.event._tag)

/**
 * Re-exported from the published testing utilities.
 *
 * Counting model calls needs a cast, because `generateText` is heavily
 * overloaded. It lives in the library so that a user's test never has to write
 * one — and this alias keeps the suite pointed at the shipped implementation.
 */
export { counting as countingModel } from "../src/testing/TestLanguageModel.js"
