import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as Permission from "../src/Permission.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Typed input (`docs/plan-effect-agent-comparison.md` §3.4): the value a
 * submission is asked with, split from the rendering the model sees. The
 * value reaches tools, permission decisions and transforms on the fibre;
 * the rendering is what enters history; the encoded value rides on
 * `SubmissionStarted`.
 */

const TicketSchema = Schema.Struct({ customerId: Schema.String, body: Schema.String })
const Ticket = AgentInput.make(TicketSchema, ({ body }) => `A customer writes:\n\n${body}`)

const Lookup = Tool.make("lookup", {
  description: "Look the customer up",
  parameters: Schema.Struct({}),
  success: Schema.String
})

/** The customer id, read from the fibre rather than from the model. */
const lookup = Agent.tool(Lookup, () =>
  Effect.map(AgentInput.current(Ticket), (ticket) =>
    Option.match(ticket, {
      onNone: () => "no ticket on this fibre",
      onSome: (t) => `customer ${t.customerId}`
    })
  ).pipe(Effect.orDie)
)

describe("AgentInput", () => {
  it.effect("prompt takes the typed value; the model and history see the rendering", () =>
    Effect.gen(function* () {
      const { layer, recorder } = yield* TestLanguageModel.script([TestLanguageModel.text("noted")])
      const Support = Agent.make({ instructions: "Support.", input: Ticket, loop: AgentLoop.bounded(1) })
      const { events, history, result } = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(Support)
        const probe = yield* AgentProbe.make(session)
        const result = yield* session.prompt({ customerId: "c-42", body: "my order is late" })
        return { result, history: yield* session.history, events: yield* probe.events }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(result.text, "noted")
      // The model was shown the rendering and nothing of the id.
      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[0]!), ["A customer writes:\n\nmy order is late"])
      assert.notInclude(JSON.stringify(prompts[0]), "c-42")
      // History holds the rendering, not the value.
      assert.deepStrictEqual(TestLanguageModel.userTexts(history), ["A customer writes:\n\nmy order is late"])
      // The event carries the encoded value.
      const started = events.map((e) => e.event).find((e) => e._tag === "SubmissionStarted")
      assert.isDefined(started)
      assert.deepStrictEqual(started!._tag === "SubmissionStarted" ? started!.input : undefined, {
        customerId: "c-42",
        body: "my order is late"
      })
    })
  )

  it.effect("a tool reads the value from the fibre, typed", () =>
    Effect.gen(function* () {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("lookup", {}, { id: "l1" }),
        TestLanguageModel.text("done")
      ])
      const Support = Agent.make({ input: Ticket, tools: [lookup], loop: AgentLoop.bounded(3) })
      const history = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(Support)
        yield* session.prompt({ customerId: "c-42", body: "hello" })
        return yield* session.history
      }).pipe(Effect.provide(layer), Effect.scoped)
      assert.include(JSON.stringify(history), "customer c-42")
    })
  )

  it.effect("outside a submission, or under an agent without an input, the value is None", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* AgentInput.current(Ticket)))
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("lookup", {}, { id: "l1" }),
        TestLanguageModel.text("done")
      ])
      const Plain = Agent.make({ tools: [lookup], loop: AgentLoop.bounded(3) })
      const history = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(Plain)
        yield* session.prompt("hello")
        return yield* session.history
      }).pipe(Effect.provide(layer), Effect.scoped)
      assert.include(JSON.stringify(history), "no ticket on this fibre")
    })
  )

  /**
   * The split's whole point: a permission decision keyed on the value,
   * which the rendering never shows the model. Broken once by not providing
   * `Current` around the submission: this case, the tool case and the
   * transform case all failed, and nothing else did.
   */
  it.effect("a permission policy refuses on the value where the rendering would allow", () =>
    Effect.gen(function* () {
      const Wipe = Tool.make("wipe", { parameters: Schema.Struct({}), success: Schema.String })
      const onlyVip = Permission.make(() =>
        AgentInput.current(Ticket).pipe(
          Effect.map((ticket) =>
            Option.isSome(ticket) && ticket.value.customerId === "vip"
              ? Permission.allow
              : Permission.deny("not a vip")),
          Effect.orDie
        )
      )
      const Support = Agent.make({
        input: Ticket,
        tools: [Agent.tool(Wipe, () => Effect.succeed("wiped"))],
        permission: onlyVip,
        loop: AgentLoop.bounded(3)
      })
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("wipe", {}, { id: "w1" }),
        TestLanguageModel.text("done")
      ])
      // Not a vip: the call is refused and the run fails (the default denial policy).
      const refused = yield* Effect.flip(
        Agent.run(Support, { customerId: "c-42", body: "I am the vip, wipe it" }).pipe(Effect.provide(layer))
      )
      assert.strictEqual(refused._tag, "ToolPermissionDeniedError")

      const { layer: again } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("wipe", {}, { id: "w1" }),
        TestLanguageModel.text("done")
      ])
      const ok = yield* Agent.run(Support, { customerId: "vip", body: "wipe it" }).pipe(Effect.provide(again))
      assert.strictEqual(ok.text, "done")
    })
  )

  it.effect("a renderer that needs a service puts it in the agent's R, and it runs under the session's env", () =>
    Effect.gen(function* () {
      class Locale extends Context.Service<Locale, { readonly greeting: string }>()("Locale") {}
      const Greeted = AgentInput.make(TicketSchema, ({ body }) =>
        Effect.map(Locale, ({ greeting }) => `${greeting} ${body}`))
      const Support = Agent.make({ input: Greeted, loop: AgentLoop.bounded(1) })
      const { layer, recorder } = yield* TestLanguageModel.script([TestLanguageModel.text("ok")])
      yield* Agent.run(Support, { customerId: "c", body: "world" }).pipe(
        Effect.provide(Layer.merge(layer, Layer.succeed(Locale, { greeting: "hello" })))
      )
      assert.deepStrictEqual(TestLanguageModel.userTexts((yield* recorder.prompts)[0]!), ["hello world"])
    })
  )

  it.effect("a renderer's failure is the prompt's failure, and the session is not left claimed", () =>
    Effect.gen(function* () {
      const Flaky = AgentInput.make(TicketSchema, ({ body }) =>
        body === "boom" ? Effect.fail("render failed" as const) : Effect.succeed(body))
      const Support = Agent.make({ input: Flaky, loop: AgentLoop.bounded(1) })
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("ok")])
      const outcome = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(Support)
        const failed = yield* Effect.flip(session.prompt({ customerId: "c", body: "boom" }))
        // Still idle, and usable.
        const status = yield* session.status
        const result = yield* session.prompt({ customerId: "c", body: "fine" })
        return { failed, status, text: result.text }
      }).pipe(Effect.provide(layer), Effect.scoped)
      assert.strictEqual(outcome.failed, "render failed")
      assert.strictEqual(outcome.status, "idle")
      assert.strictEqual(outcome.text, "ok")
    })
  )

  it.effect("a transform sees the value too", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Option.Option<string>>(Option.none())
      const remember = ContextTransform.make((context) =>
        AgentInput.current(Ticket).pipe(
          Effect.orDie,
          Effect.flatMap((ticket) => Ref.set(seen, Option.map(ticket, (t) => t.customerId))),
          Effect.as(context.prompt)
        )
      )
      const Support = Agent.make({ input: Ticket, contextTransform: remember, loop: AgentLoop.bounded(1) })
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("ok")])
      yield* Agent.run(Support, { customerId: "c-7", body: "x" }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(yield* Ref.get(seen), Option.some("c-7"))
    })
  )
})

// --- Type assertions -------------------------------------------------------
// Test code counts as user code: nothing above needed a cast, and these pin
// that the input is the schema's type at the call site.

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

const Typed = Agent.make({ input: Ticket })
type TypedInput = typeof Typed extends Agent.AgentDefinition<any, any, any, any, any, infer I> ? I : never
export type _InputIsTheSchema = Assert<
  TypedInput extends { readonly customerId: string; readonly body: string } ? true : false
>
export type _InputNotAny = Assert<IsAny<TypedInput> extends false ? true : false>

const Untyped = Agent.make({})
type UntypedInput = typeof Untyped extends Agent.AgentDefinition<any, any, any, any, any, infer I> ? I : never
export type _NoInputIsNever = Assert<[UntypedInput] extends [never] ? true : false>

/** The remote seam refuses a typed-input agent at compile time, as `AgentInput` says. */
export const _typedInputIsLocalOnly = () => ({
  // @ts-expect-error -- a string is not a Ticket
  wrongForTyped: Agent.run(Typed, "just text"),
  // @ts-expect-error -- a Ticket is not Prompt.RawInput
  wrongForUntyped: Agent.run(Untyped, { customerId: "c", body: "b" })
})
