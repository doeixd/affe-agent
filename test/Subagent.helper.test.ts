import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import { Subagent } from "../src/subagent/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `Subagent.tool` (issue #4 item 4). The bare pattern -- a tool that opens a
 * child session -- is already proven in `Subagent.test.ts`; here the claim is
 * that the helper collapses it to one call while keeping the two properties
 * that make it worth having: the child runs under its own model, and
 * interrupting the parent interrupts the child. Both are asserted against
 * scripted models, deterministically.
 */

const delegates = (question: string): TestLanguageModel.Turn => ({
  toolCalls: [{ id: "d1", name: "research", params: { prompt: question } }]
})

describe("Subagent.tool", () => {
  it.effect("delegates a prompt to a child running under its own model; the two conversations stay apart", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([TestLanguageModel.text("child findings")])
      const parent = yield* TestLanguageModel.script([
        delegates("what is effect"),
        TestLanguageModel.text("parent decision")
      ])

      const Researcher = Agent.make({ instructions: "You research." })
      const research = Subagent.tool("research", Researcher, {
        description: "Research a question and return findings.",
        provide: child.layer
      })
      const Lead = Agent.make({ instructions: "You delegate.", tools: [research] })

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Lead), (s) => s.prompt("decide on effect"))
      ).pipe(Effect.provide(parent.layer))

      assert.strictEqual(result.text, "parent decision")

      // The child saw exactly one conversation -- its own system prompt and the
      // delegated question -- never the parent's history.
      const childPrompts = yield* child.recorder.prompts
      assert.strictEqual(childPrompts.length, 1)
      assert.deepStrictEqual(TestLanguageModel.roles(childPrompts[0]!), ["system", "user"])
      assert.deepStrictEqual(TestLanguageModel.userTexts(childPrompts[0]!), ["what is effect"])
      // The parent ran two turns (delegate, then decide) and never saw the child's.
      assert.strictEqual((yield* parent.recorder.prompts).length, 2)
    })
  )

  it.effect("the child's answer is the tool result the parent model reads", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([TestLanguageModel.text("the answer is 42")])
      const parent = yield* TestLanguageModel.script([
        delegates("the question"),
        TestLanguageModel.text("done")
      ])
      const Sub = Agent.make({ instructions: "child" })
      const Lead = Agent.make({
        tools: [Subagent.tool("research", Sub, { description: "research", provide: child.layer })]
      })

      const history = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Lead)
          yield* session.prompt("go")
          return yield* session.history
        })
      ).pipe(Effect.provide(parent.layer))

      const toolResults = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      assert.strictEqual(toolResults.length, 1)
      const first = toolResults[0]
      assert.isTrue(first !== undefined && first.type === "tool-result" && !first.isFailure)
      assert.include(JSON.stringify(first), "the answer is 42")
    })
  )

  it.effect("interrupting the parent interrupts the child, through the tool's scope alone", () =>
    Effect.gen(function* () {
      const childStarted = yield* Deferred.make<void>()
      const child = yield* TestLanguageModel.script([{ hang: true, started: childStarted }])
      const parent = yield* TestLanguageModel.script([delegates("q")])

      const Sub = Agent.make({ instructions: "child" })
      const Lead = Agent.make({
        tools: [Subagent.tool("research", Sub, { description: "research", provide: child.layer })]
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Lead)
          const fiber = yield* Effect.forkChild(AgentSession.prompt(session, "go"))
          yield* Deferred.await(childStarted)
          yield* AgentSession.interrupt(session)
          const outcome = yield* Fiber.join(fiber)
          assert.strictEqual(outcome.status, "interrupted")
          assert.strictEqual(yield* AgentSession.status(session), "idle")
        })
      ).pipe(Effect.provide(parent.layer))
    })
  )

  // A child whose model calls a tool the child's own policy denies: the child
  // run fails with a *typed* ToolPermissionDeniedError (a real recoverable
  // failure, not a defect), which is exactly what the subagent surfaces.
  const failingChild = () => {
    const Boom = Tool.make("boom", { parameters: Schema.Struct({}), success: Schema.String })
    return Agent.make({
      instructions: "child",
      tools: [Agent.tool(Boom, () => Effect.succeed("ok"))],
      permission: Permission.rules([{ tool: "boom", decision: Permission.deny("denied in child") }], {
        otherwise: Permission.allow
      })
    })
  }
  const callsBoom: TestLanguageModel.Turn = { toolCalls: [{ id: "b1", name: "boom", params: {} }] }

  it.effect("a typed child failure returns to the parent model as a string by default", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([callsBoom])
      const parent = yield* TestLanguageModel.script([
        delegates("q"),
        TestLanguageModel.text("i will try another way")
      ])
      const Lead = Agent.make({
        tools: [Subagent.tool("research", failingChild(), { description: "research", provide: child.layer })]
      })

      const { history, result } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Lead)
          const result = yield* session.prompt("go")
          return { result, history: yield* session.history }
        })
      ).pipe(Effect.provide(parent.layer))

      // The parent run did not fail; the model got a chance to route around it.
      assert.strictEqual(result.text, "i will try another way")
      const toolResults = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      const failure = toolResults[0]
      assert.isTrue(failure !== undefined && failure.type === "tool-result" && failure.isFailure)
      // The child's denial reason rode out on the string the parent saw.
      assert.include(JSON.stringify(failure), "denied in child")
    })
  )

  it.effect("onError 'die' fails the parent run instead", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([callsBoom])
      const parent = yield* TestLanguageModel.script([delegates("q"), TestLanguageModel.text("unreached")])
      const Lead = Agent.make({
        tools: [Subagent.tool("research", failingChild(), { description: "research", provide: child.layer, onError: "die" })]
      })

      const exit = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Lead), (s) => Effect.exit(s.prompt("go")))
      ).pipe(Effect.provide(parent.layer))

      assert.isTrue(exit._tag === "Failure")
    })
  )

  it.effect("composes as an ordinary bound tool beside hand-written tools, and a policy can gate it", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([TestLanguageModel.text("child ran")])
      const parent = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "n1", name: "note", params: { text: "hi" } }] },
        delegates("q"),
        TestLanguageModel.text("all done")
      ])
      const notes = yield* Ref.make<Array<string>>([])
      const Note = Tool.make("note", {
        parameters: Schema.Struct({ text: Schema.String }),
        success: Schema.String
      })
      const Sub = Agent.make({ instructions: "child" })
      const Lead = Agent.make({
        tools: [
          Agent.tool(Note, ({ text }) => Ref.update(notes, (all) => [...all, text]).pipe(Effect.as("noted"))),
          Subagent.tool("research", Sub, { description: "research", provide: child.layer })
        ],
        // The subagent projects to the default tool/name, so a policy names it
        // like any tool: allow the note, deny research.
        permission: Permission.rules(
          [
            { tool: "note", decision: Permission.allow },
            { tool: "research", decision: Permission.deny("no delegation allowed") }
          ],
          { otherwise: Permission.allow }
        ),
        toolDenialPolicy: { _tag: "ReturnToModel" }
      })

      const { result, ran } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Lead)
          const result = yield* session.prompt("go")
          return { result, ran: yield* child.recorder.calls }
        })
      ).pipe(Effect.provide(parent.layer))

      assert.strictEqual(result.text, "all done")
      // The note tool ran; the denied subagent never opened a child session.
      assert.deepStrictEqual(yield* Ref.get(notes), ["hi"])
      assert.strictEqual(ran, 0)
    })
  )
})
