import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentProbe } from "../src/testing/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A framework submission: a run opened by framework messages, with no
 * application input. It exists so a harness can *tell* a session something —
 * a background worker's report, a completion — without being *asked*
 * something, which is what makes it reach a typed-input agent at all.
 */

const Ticket = AgentInput.make(
  Schema.Struct({ customerId: Schema.String }),
  ({ customerId }) => `ticket ${customerId}`
)

const Seen = Tool.make("seen", { parameters: Schema.Struct({}), success: Schema.String })

/** Reports what `AgentInput.Current` holds during the call: the ticket, or none. */
const Support = Agent.make({
  instructions: "Answer.",
  input: Ticket,
  tools: [
    Agent.tool(Seen, () =>
      Effect.map(AgentInput.current(Ticket), (current) =>
        Option.match(current, { onNone: () => "no input", onSome: (ticket) => ticket.customerId })
      ).pipe(Effect.orDie))
  ]
})

describe("a framework submission", () => {
  it.effect("reaches a typed-input agent with no input, and commits its messages", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "t1", name: "seen", params: {} }] },
        TestLanguageModel.text("done")
      ])
      const { result, seen, history } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Support)
          const probe = yield* AgentProbe.make(session)
          const receipt = yield* AgentSession.framework(
            session,
            Prompt.fromMessages([Prompt.systemMessage({ content: "a background report" })])
          )
          const result = yield* AgentSession.awaitSubmission(session, receipt.submissionId)
          const events = yield* probe.events
          return {
            result,
            seen: events.flatMap((e) =>
              AgentEvent.is("ToolCallSucceeded")(e) && e.event.name === "seen" ? [e.event.result] : []
            ),
            history: yield* AgentSession.history(session)
          }
        })
      ).pipe(Effect.provide(layer))

      assert.strictEqual(result.status, "completed")
      // The whole point: the agent declared an input, and the framework
      // submission supplied none -- a tool reading it sees `None`, not a
      // decode failure. Before this, `submit` would have refused the prompt.
      assert.deepStrictEqual(seen, ["no input"])
      // The messages are committed with system provenance -- the shape a
      // report takes, not the person's input. The instructions are the other
      // system message a session always has.
      const system = history.content
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : ""))
      assert.include(system, "a background report")
      assert.deepStrictEqual(
        history.content.filter((message) => message.role === "user"),
        [],
        "a framework submission must commit nothing as the person's input"
      )
    }))

  it.effect("carries no input on `SubmissionStarted`, unlike a typed submission", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("done")])
      const { started, typedStarted } = yield* Effect.scoped(
        Effect.gen(function* () {
          const frameworkSession = yield* AgentSession.make(Support)
          const frameworkProbe = yield* AgentProbe.make(frameworkSession)
          const fReceipt = yield* AgentSession.framework(frameworkSession, "a report")
          yield* AgentSession.awaitSubmission(frameworkSession, fReceipt.submissionId)
          const started = (yield* frameworkProbe.events).flatMap((e) =>
            AgentEvent.is("SubmissionStarted")(e) ? [e.event] : []
          )

          const typedSession = yield* AgentSession.make(Support)
          const typedProbe = yield* AgentProbe.make(typedSession)
          yield* AgentSession.prompt(typedSession, { customerId: "c-1" })
          const typedStarted = (yield* typedProbe.events).flatMap((e) =>
            AgentEvent.is("SubmissionStarted")(e) ? [e.event] : []
          )
          return { started, typedStarted }
        })
      ).pipe(Effect.provide(layer))

      // A framework submission records no input; a typed one records the value.
      assert.deepStrictEqual(started.map((event) => event.input), [undefined])
      assert.deepStrictEqual(typedStarted.map((event) => event.input), [{ customerId: "c-1" }])
    }))
})
