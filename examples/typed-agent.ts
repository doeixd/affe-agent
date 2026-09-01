import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
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

    // `prompt` resolves at quiescence, by which point the session is idle — so
    // steering *after* it would fail with `AgentIdleError`. Steering is for
    // work that is still running, which means forking the submission and
    // joining it afterwards.
    const running = yield* Effect.forkChild(
      AgentSession.prompt(session, "Find Effect docs")
    )

    // Wait until the submission is actually active before steering it.
    yield* Stream.runDrain(
      Stream.take(
        Stream.filter(
          AgentSession.state(session).changes,
          (state) => state.status === "running"
        ),
        1
      )
    )
    yield* AgentSession.steer(session, "prefer primary sources").pipe(
      // It may already have finished; steering is best-effort by nature.
      Effect.ignore
    )

    const result = yield* Fiber.join(running)

    // The final response is typed by the toolkit. It is optional because an
    // interrupted submission never produced one.
    const usage = Option.map(result.response, (r) => r.usage)
    const finish = Option.map(result.response, (r) => r.finishReason)

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

type SubmitEffect = ReturnType<
  typeof AgentSession.submit<{ readonly search: typeof Search }, never>
>
type Receipt = SubmitEffect extends Effect.Effect<infer A, any, any> ? A : never
type SubmitErr = SubmitEffect extends Effect.Effect<any, infer E, any> ? E : never
// This assertion was deliberately inverted once while adding the public
// signature; isolated tsc rejected it, proving it is enforced.
export type _ReceiptNotAny = Assert<IsAny<Receipt> extends false ? true : false>
export type _ReceiptCarriesSubmissionId = Assert<
  Receipt extends { readonly submissionId: AgentSession.SubmissionReceipt["submissionId"] }
    ? true
    : false
>
export type _SubmitErrorNotUnknown = Assert<
  unknown extends SubmitErr ? false : true
>
export type _ToolFailureIsNotAdmissionFailure = Assert<
  "rate_limited" extends SubmitErr ? false : true
>

// The handler above destructures `query` with no annotation; if it were `any`
// the `_ToolCallNameIsLiteral` assertion would also have degraded.

// --- Typed input -----------------------------------------------------------
// The mirror of `AgentOutput`: the value a submission is asked with, and the
// rendering the model sees, kept apart. `customerId` never reaches the model;
// a tool reads it from the fibre.

const Ticket = AgentInput.make(
  Schema.Struct({ customerId: Schema.String, body: Schema.String }),
  ({ body }) => `A customer writes:\n\n${body}`
)

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

export const Support = Agent.make({
  instructions: "Answer the customer.",
  input: Ticket,
  tools: [
    Agent.tool(Lookup, () =>
      Effect.map(AgentInput.current(Ticket), (ticket) =>
        Option.match(ticket, {
          onNone: () => "no ticket",
          onSome: ({ customerId }) => `customer ${customerId}`
        })
      ).pipe(Effect.orDie))
  ],
  loop: AgentLoop.bounded(4)
})

// `prompt` takes the schema's type -- inferred, not annotated.
export const support = Agent.run(Support, { customerId: "c-42", body: "my order is late" })

type SupportInput = typeof Support extends Agent.AgentDefinition<any, any, any, any, any, infer I> ? I : never
export type _SupportInputIsTheTicket = Assert<
  SupportInput extends { readonly customerId: string; readonly body: string } ? true : false
>
export type _SupportInputNotAny = Assert<IsAny<SupportInput> extends false ? true : false>
// An agent without an input is still asked with `Prompt.RawInput`.
type ResearcherInput = typeof Researcher extends Agent.AgentDefinition<any, any, any, any, any, infer I> ? I : never
export type _ResearcherTakesRawInput = Assert<[ResearcherInput] extends [never] ? true : false>

