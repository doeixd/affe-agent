import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
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

      const wipe = Agent.tool(Wipe, () => Effect.as(Ref.update(wiped, (n) => n + 1), "wiped"))

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

  it.live("a child's tool that needs approval cannot be approved by anyone", () =>
    Effect.gen(function* () {
      /**
       * The finding, isolated by running the same shape twice.
       *
       * A tool marked `needsApproval` asks for an approval, and a session
       * answers that from its elicitation seam. `Subagent.tool` opens the
       * child with `Agent.run`, which has no elicitor to give it -- the
       * parent's is not passed down and nothing else supplies one -- so the
       * request is refused and the tool never runs. The child's *policy* is
       * not what decides it: `allowAll` makes no difference, which is exactly
       * what separates this from an ordinary denial.
       *
       * The control is the proof. Same child, same policy, same script, one
       * tool marked `needsApproval` and one not: the plain tool runs and the
       * approving one is dead. So a delegated agent may hold any tool it
       * likes as long as nobody has to approve it, and a tool marked as
       * needing approval is not so much protected as disabled.
       *
       * Written down rather than fixed, as item 53: passing the parent's
       * elicitor to the child is one answer and *asking the parent's user to
       * approve a tool they cannot see* is a real question about it.
       */
      const approvingRan = yield* Ref.make(0)
      const plainRan = yield* Ref.make(0)

      // The tool that needs approval.
      const approvingChild = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.as(Ref.update(approvingRan, (n) => n + 1), "did it"))],
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(3)
      })
      const approvingModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])
      const approvingResearch = Subagent.tool("research", approvingChild, {
        description: "Delegate research.",
        provide: approvingModel.layer,
        onError: "return"
      })

      // The same thing, without the annotation.
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
        provide: plainModel.layer,
        onError: "return"
      })

      const parentScript = [
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ] as const

      const withApproving = yield* FakeModel.script([...parentScript])
      yield* Agent.run(
        Agent.make({
          instructions: "Delegate.",
          tools: [approvingResearch],
          permission: Permission.allowAll,
          loop: AgentLoop.bounded(4)
        }),
        "go"
      ).pipe(Effect.scoped, Effect.provide(withApproving.layer))

      const withPlain = yield* FakeModel.script([...parentScript])
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
        "the control did not run either, so this test is measuring something other than approval"
      )
      assert.strictEqual(
        yield* Ref.get(approvingRan),
        0,
        "a child's approval-requiring tool now runs: somebody is answering for it, and who should be written down"
      )
    }),
    30_000
  )
})
