import { assert, describe, it } from "@effect/vitest"
import { Cause, Data, Deferred, Effect, Fiber, Layer, Ref, Schema } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
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

/** A construction-time wiring failure, tagged so it does not merge with other errors in the channel. */
class MissingApiKey extends Data.TaggedError("MissingApiKey")<{}> {
  override get message() {
    return "no api key"
  }
}

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

  /**
   * #67 -- the two halves of `onError: "return"`, pinned together because the
   * module doc used to read as covering both and only covers one.
   *
   * A typed child failure is an answer the parent can act on; a child defect is
   * a bug, and swallowing it into a string the model reasons about would leave
   * it unreported. `Cause.hasDies`, not merely "the exit failed": an exit that
   * failed for any other reason would pass the weaker assertion while the
   * defect had quietly been converted to something else.
   */
  it.effect("a child defect stays a defect and fails the parent, even under onError 'return'", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "b1", name: "explode", params: {} }] }
      ])
      const parent = yield* TestLanguageModel.script([
        delegates("q"),
        TestLanguageModel.text("never reached")
      ])
      const Explode = Tool.make("explode", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const Sub = Agent.make({
        instructions: "child",
        // Not a declared failure: a bug in the child's own tool.
        tools: [Agent.tool(Explode, () => Effect.die(new Error("a bug in the child")))]
      })
      const Lead = Agent.make({
        // The default, explicitly: this is the setting whose doc was wrong.
        tools: [
          Subagent.tool("research", Sub, {
            description: "research",
            provide: child.layer,
            onError: "return"
          })
        ]
      })

      const exit = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Lead), (s) => Effect.exit(s.prompt("go")))
      ).pipe(Effect.provide(parent.layer))

      assert.isTrue(exit._tag === "Failure")
      assert.isTrue(exit._tag === "Failure" && Cause.hasDies(exit.cause))
      // And the parent model was never given a second turn to route around it.
      assert.strictEqual((yield* parent.recorder.prompts).length, 1)
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

/**
 * #66 -- where `options.provide` is built.
 *
 * A counting layer is the only way to see the difference: both variants
 * produce the same answers, and the whole question is how many times the
 * child's world was constructed to produce them. Two delegations in one parent
 * run, so a per-call build and a shared one give different numbers.
 */
describe("Subagent.toolScoped", () => {
  const twoDelegations = () =>
    TestLanguageModel.script([
      delegates("first"),
      delegates("second"),
      TestLanguageModel.text("done")
    ])

  /** The child's layer, wrapped so that every build is counted. */
  const counting = <A, E>(inner: Layer.Layer<A, E>, builds: Ref.Ref<number>) =>
    Layer.effectDiscard(Ref.update(builds, (n) => n + 1)).pipe(Layer.provideMerge(inner))

  it.effect("builds the child's layer once and shares it across delegations", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([
        TestLanguageModel.text("first findings"),
        TestLanguageModel.text("second findings")
      ])
      const parent = yield* twoDelegations()
      const builds = yield* Ref.make(0)
      const Sub = Agent.make({ instructions: "child" })

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const research = yield* Subagent.toolScoped("research", Sub, {
            description: "research",
            provide: counting(child.layer, builds)
          })
          // Built before the agent exists, which is the point: the cost is
          // paid once, at wiring time.
          assert.strictEqual(yield* Ref.get(builds), 1)
          const Lead = Agent.make({ tools: [research] })
          const session = yield* AgentSession.make(Lead)
          return yield* session.prompt("go")
        })
      ).pipe(Effect.provide(parent.layer))

      assert.strictEqual(result.text, "done")
      // Two delegations actually happened...
      assert.strictEqual((yield* child.recorder.prompts).length, 2)
      // ...and the child's world was built for neither of them.
      assert.strictEqual(yield* Ref.get(builds), 1)
    })
  )

  it.effect("the plain `tool` builds per delegation, which is what the scoped variant is for", () =>
    Effect.gen(function* () {
      const child = yield* TestLanguageModel.script([
        TestLanguageModel.text("first findings"),
        TestLanguageModel.text("second findings")
      ])
      const parent = yield* twoDelegations()
      const builds = yield* Ref.make(0)
      const Sub = Agent.make({ instructions: "child" })
      const Lead = Agent.make({
        tools: [
          Subagent.tool("research", Sub, {
            description: "research",
            provide: counting(child.layer, builds)
          })
        ]
      })

      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(Lead), (s) => s.prompt("go"))
      ).pipe(Effect.provide(parent.layer))

      assert.strictEqual(result.text, "done")
      assert.strictEqual((yield* child.recorder.prompts).length, 2)
      // Documented, not accidental: `tool` stays pure, so `provide` is per call.
      assert.strictEqual(yield* Ref.get(builds), 2)
    })
  )

  it.effect("a layer that cannot build is reported at construction, not as a tool failure", () =>
    Effect.gen(function* () {
      const Sub = Agent.make({ instructions: "child" })

      // Building early moves `LE` off the tool's failure channel and onto the
      // construction. A missing key is wiring, and a run that never starts
      // beats one that discovers it three delegations in.
      const exit = yield* Effect.exit(
        Effect.scoped(
          Subagent.toolScoped("research", Sub, {
            description: "research",
            provide: Layer.effect(
              LanguageModel.LanguageModel,
              Effect.fail(new MissingApiKey())
            )
          })
        )
      )

      assert.isTrue(exit._tag === "Failure")
      assert.include(String(exit._tag === "Failure" ? Cause.squash(exit.cause) : ""), "no api key")
    })
  )
})
