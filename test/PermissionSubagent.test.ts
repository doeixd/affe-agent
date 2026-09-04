import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as Permission from "../src/Permission.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Approval, across a delegation.
 *
 * A parent decides what its own tools may do. A child is a second agent with
 * its own toolkit and its own policy, reached through a tool call the parent
 * *did* approve -- so the question is what governs the child's tools, and
 * whose answer counts.
 *
 * This is worth asking rather than assuming, because both plausible answers
 * are bad in different ways. If a child's dangerous tool is governed by the
 * parent's policy, then approving `research` silently approves whatever
 * `research` decides to do. If it is governed by nothing, then a policy is a
 * wall with a door next to it.
 */

const Wipe = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

describe("approval across a delegation", () => {
  it.live("a child's tool is governed by the child's policy, not the parent's", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const parentAsked = yield* Ref.make<ReadonlyArray<string>>([])

      // A plain tool, deliberately: this row measures whose *policy* governs
      // a child's tool, and a tool marked `needsApproval` can no longer be
      // delegated at all (the rows below). The policy question is the same
      // either way.
      const PlainWipe = Tool.make("wipe", { parameters: Schema.Struct({}), success: Schema.String })
      const wipe = Agent.tool(PlainWipe, () => Effect.as(Ref.update(wiped, (n) => n + 1), "wiped"))

      // The child denies everything. If the parent's policy governed the
      // child's tools, the parent's `allowAll` would override this.
      const child = Agent.make({
        instructions: "child",
        tools: [wipe],
        permission: Permission.denyAll,
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
        { text: "the child gave up" }
      ])

      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer,
        onError: "return"
      })

      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        // The parent allows everything *it* is asked about, and records what
        // it was asked, so "the parent was never consulted" is measurable.
        permission: Permission.make((request) =>
          Effect.as(
            Ref.update(parentAsked, (all) => [...all, request.tool.name]),
            Permission.allow
          )
        ),
        loop: AgentLoop.bounded(4)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      const result = yield* Agent.run(parent, "go").pipe(
        Effect.scoped,
        Effect.provide(parentModel)
      )

      assert.strictEqual(result.text, "the parent answered")
      // The child's own policy governed its own tool.
      assert.strictEqual(yield* Ref.get(wiped), 0, "the child's denied tool ran anyway")
      // And the parent was asked about the delegation, not about what the
      // child then wanted to do -- which is the part worth knowing.
      assert.deepStrictEqual(
        yield* Ref.get(parentAsked),
        ["research"],
        "the parent's policy was consulted about a tool it does not own"
      )
    }),
    30_000
  )

  /**
   * The finding, and what was decided about it.
   *
   * A tool marked `needsApproval` asks for an approval, and a session answers
   * that from its elicitation seam. `Subagent.tool` opens the child with
   * `Agent.run`, which has no elicitor to give it -- the parent's is not
   * passed down and nothing else supplies one -- so the request is refused
   * and the tool never runs. The child's *policy* is not what decides it:
   * `allowAll` makes no difference, which is exactly what separates this
   * from an ordinary denial. A tool marked as needing approval was not so
   * much protected as disabled, and the only report was a string the parent
   * model read.
   *
   * Item 53 recorded that. `plan-seams.md` B decided the first half: not
   * *who* should answer -- asking the parent's user to approve a tool they
   * cannot see is a real question -- but *when* the fault is reported. It is
   * now refused at construction, the way `Agent.make` refuses two toolkits,
   * so a wiring fault is found before the agent starts rather than three
   * delegations in.
   *
   * The control from the original finding is kept: same child, same policy,
   * one tool marked `needsApproval` and one not. The plain child delegates
   * and its tool runs; the approving child cannot be made into a tool at all.
   */
  it.live("a child holding an approval-requiring tool is refused at construction", () =>
    Effect.gen(function* () {
      const plainRan = yield* Ref.make(0)

      const approvingChild = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.succeed("did it"))],
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(3)
      })
      const approvingModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])

      // Refused by throwing, at the call, before any run exists.
      assert.throws(
        () =>
          Subagent.tool("research", approvingChild, {
            description: "Delegate research.",
            provide: approvingModel.layer
          }),
        /"wipe"/,
        "a child with an unanswerable approval was accepted: its tool would be refused on every call, and nobody told anyone"
      )

      // The control: the same thing, without the annotation, delegates.
      const Plain = Tool.make("plain", { parameters: Schema.Struct({}), success: Schema.String })
      const plainChild = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Plain, () => Effect.as(Ref.update(plainRan, (n) => n + 1), "did it"))],
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(3)
      })
      const plainModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "plain", params: {} }] },
        { text: "the child finished" }
      ])
      const plainResearch = Subagent.tool("research", plainChild, {
        description: "Delegate research.",
        provide: plainModel.layer
      })
      const withPlain = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])
      yield* Agent.run(
        Agent.make({
          instructions: "Delegate.",
          tools: [plainResearch],
          permission: Permission.allowAll,
          loop: AgentLoop.bounded(4)
        }),
        "go"
      ).pipe(Effect.scoped, Effect.provide(withPlain.layer))

      assert.strictEqual(
        yield* Ref.get(plainRan),
        1,
        "the control did not run, so the refusal above is measuring something other than approval"
      )
    }),
    30_000
  )

  it.live("`toolScoped` refuses the same child, before its layer is built", () =>
    Effect.gen(function* () {
      const builds = yield* Ref.make(0)
      const approvingChild = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.succeed("did it"))],
        loop: AgentLoop.bounded(3)
      })
      const model = yield* FakeModel.layer([{ text: "unused" }])
      const counted = Layer.effectDiscard(Ref.update(builds, (n) => n + 1)).pipe(
        Layer.provideMerge(model.layer)
      )

      const exit = yield* Effect.exit(
        Effect.scoped(
          Subagent.toolScoped("research", approvingChild, {
            description: "Delegate research.",
            provide: counted
          })
        )
      )

      assert.isTrue(exit._tag === "Failure", "an unanswerable approval was accepted by toolScoped")
      assert.include(
        exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "",
        "\"wipe\""
      )
      // A wiring fault should not cost a connection pool to discover.
      assert.strictEqual(yield* Ref.get(builds), 0, "the child's layer was built before the refusal")
    })
  )

  it.live("a `needsApproval` given as a function counts, because nobody could answer it either", () =>
    Effect.gen(function* () {
      // Asks only sometimes. Deciding at construction that it never will
      // would need the parameters, so it is treated as a tool that may ask.
      const Sometimes = Tool.make("sometimes", {
        parameters: Schema.Struct({ force: Schema.Boolean }),
        success: Schema.String
      }).setNeedsApproval((params) => params.force)
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Sometimes, () => Effect.succeed("did it"))],
        loop: AgentLoop.bounded(3)
      })
      const model = yield* FakeModel.layer([{ text: "unused" }])
      assert.throws(
        () => Subagent.tool("research", child, { description: "Delegate.", provide: model.layer }),
        /"sometimes"/
      )
    })
  )

  it.live("a child whose toolkit is resolved per turn cannot be inspected, and keeps the runtime refusal", () =>
    Effect.gen(function* () {
      /**
       * The one shape the construction-time check cannot reach: a toolkit
       * resolved per turn from runtime state, which declares nothing until it
       * has run. (`Agent.toolkit` and `tools: [...]` both declare, so this
       * has to be a bare Effect.) Pinned so the gap is a row rather than a surprise.
       * The tool is still dead -- this is the original item 53 behaviour --
       * and the test says so, in the direction that will fail if someone
       * closes the gap, so they come here and delete it.
       */
      const ran = yield* Ref.make(0)
      const child = Agent.make({
        instructions: "child",
        toolkit: Effect.suspend(() =>
          Agent.toolkit([Wipe], {
            wipe: () => Effect.as(Ref.update(ran, (n) => n + 1), "did it")
          })
        ),
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])
      // Accepted: there is nothing to read.
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })
      const parentModel = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])
      const result = yield* Agent.run(
        Agent.make({ instructions: "Delegate.", tools: [research], loop: AgentLoop.bounded(4) }),
        "go"
      ).pipe(Effect.scoped, Effect.provide(parentModel.layer))

      assert.strictEqual(result.text, "the parent answered")
      assert.strictEqual(
        yield* Ref.get(ran),
        0,
        "the tool ran: someone is answering approvals for a delegated child now, and the construction-time refusal should go"
      )
    }),
    30_000
  )
})
