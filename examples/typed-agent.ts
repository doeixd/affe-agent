import { Effect, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"

// --- Tools -----------------------------------------------------------------

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ hits: Schema.Array(Schema.String) }),
  failure: Schema.Literal("rate_limited")
})

// One step, one instance: `Agent.toolkit` makes the two-instance mistake
// unrepresentable. `query` and the result type still infer from the schemas.
const toolkitEffect = Agent.toolkit([Search], {
  search: ({ query }) => Effect.succeed({ hits: [query] })
})

// --- Agent -----------------------------------------------------------------

const stopOnEmptySearch = AgentLoop.make((state) =>
  Effect.succeed(
    // `toolCalls` should be typed, not `any`.
    state.toolCalls.some((call) => call.name === "search")
      ? AgentLoop.Continue
      : AgentLoop.Stop
  )
)

const Researcher = Agent.make({
  instructions: "Research carefully.",
  toolkit: toolkitEffect,
  contextTransform: ContextTransform.identity,
  loop: AgentLoop.and(stopOnEmptySearch, AgentLoop.maxTurns(10))
})

// --- Use -------------------------------------------------------------------

export const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Researcher)

    const result = yield* AgentSession.prompt(session, "Find Effect docs")

    // The final response should be typed by the toolkit. It is optional
    // because an interrupted submission never produced one.
    const usage = Option.map(result.response, (r) => r.usage)
    const finish = Option.map(result.response, (r) => r.finishReason)

    yield* AgentSession.steer(session, "prefer primary sources")

    return { usage, finish, text: result.text }
  })
).pipe(
  // The tool's declared failure must be catchable by name.
  Effect.catchTag("AgentBusyError", () => Effect.succeed(null))
)

// --- Type assertions -------------------------------------------------------
// Compile-time only. `any` would satisfy the code above silently, so these
// assert that inference is precise rather than merely accepted.

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

type LoopState = AgentLoop.State<{ readonly search: typeof Search }>
type ToolCall = LoopState["toolCalls"][number]

export type _ToolCallsNotAny = Assert<IsAny<ToolCall> extends false ? true : false>
export type _ToolCallNameIsLiteral = Assert<ToolCall["name"] extends "search" ? true : false>

type Result = typeof program extends Effect.Effect<infer A, any, any> ? A : never
export type _ResultNotAny = Assert<IsAny<Result> extends false ? true : false>

type PromptEffect = ReturnType<
  typeof AgentSession.prompt<{ readonly search: typeof Search }, never>
>
type PromptErr = PromptEffect extends Effect.Effect<any, infer E, any> ? E : never
export type _ToolFailureIsCatchable = Assert<
  "rate_limited" extends PromptErr ? true : false
>
export type _ErrorNotUnknown = Assert<unknown extends PromptErr ? false : true>

// The handler above destructures `query` with no annotation; if it were `any`
// the `_ToolCallNameIsLiteral` assertion would also have degraded.
