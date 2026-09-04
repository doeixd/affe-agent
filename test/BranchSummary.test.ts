import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Ref } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as BranchSummary from "../src/tree/BranchSummary.js"
import * as SessionTree from "../src/tree/SessionTree.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Branch carryover (`docs/plan-branching-and-compaction.md` §16–19), and the
 * one tree capability it needed: a generic seed on `branch` (§18).
 *
 * The acceptance rows from §32 that live here: only abandoned work after the
 * common ancestor is summarised; the target's history stays intact; the
 * carryover persists into descendants of the new branch; the abandoned
 * branch is unchanged.
 */

const agent = Agent.make({
  instructions: "You answer briefly.",
  loop: AgentLoop.bounded(2)
})

const script = (...replies: ReadonlyArray<string>) =>
  TestLanguageModel.script(replies.map((reply) => TestLanguageModel.text(reply)))

const textOf = (prompt: { readonly content: ReadonlyArray<unknown> }): string =>
  JSON.stringify(prompt.content)

describe("BranchSummary", () => {
  it.effect("the seed decorates the new branch's starting history, not the node", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("first answer", "seeded answer")
      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("start here")
        const node = yield* tree.commit(trunk)

        const seeded = yield* tree.branch(node, {
          seed: (history) =>
            Prompt.fromMessages([
              ...history.content,
              Prompt.systemMessage({ content: "decorated by the seed" })
            ])
        })
        return {
          branchHistory: yield* seeded.history,
          nodeHistory: yield* tree.historyOf(node)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.include(textOf(out.branchHistory), "decorated by the seed")
      assert.include(textOf(out.branchHistory), "start here")
      // The node itself was not rewritten: the seed decorates the copy.
      assert.notInclude(textOf(out.nodeHistory), "decorated by the seed")
    })
  )

  it.effect("only work after the common ancestor is summarised, and both branches survive intact", () =>
    Effect.gen(function*() {
      const { layer } = yield* script(
        "trunk answer",
        "left answer",
        "right answer"
      )
      const seen = yield* Ref.make(Option.none<Prompt.Prompt>())
      const instructionsSeen = yield* Ref.make(Option.none<string>())

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("shared beginning")
        const ancestor = yield* tree.commit(trunk)

        const left = yield* tree.branch(ancestor)
        yield* left.prompt("abandoned direction")
        const leftNode = yield* tree.commit(left)

        const right = yield* tree.branch(ancestor)
        yield* right.prompt("kept direction")
        const rightNode = yield* tree.commit(right)

        const carried = yield* BranchSummary.branch(tree, {
          from: leftNode,
          to: rightNode,
          instructions: "keep the file names",
          summarise: ({ instructions, messages }) =>
            Effect.gen(function*() {
              yield* Ref.set(seen, Option.some(messages))
              yield* Ref.set(instructionsSeen, instructions)
              return {
                text: "what the abandoned branch learned",
                usage: Option.some({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
              }
            })
        })

        return {
          carried,
          carriedHistory: yield* carried.session.history,
          rightHistory: yield* tree.historyOf(rightNode),
          leftHistory: yield* tree.historyOf(leftNode),
          summarised: yield* Ref.get(seen),
          instructions: yield* Ref.get(instructionsSeen),
          ancestor
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The summariser saw the abandoned stretch and nothing shared: the
      // slice starts where the common ancestor's history ends.
      const summarised = textOf(Option.getOrThrow(out.summarised))
      assert.include(summarised, "abandoned direction")
      assert.notInclude(summarised, "shared beginning")
      assert.notInclude(summarised, "kept direction")
      assert.deepStrictEqual(out.instructions, Option.some("keep the file names"))

      // The new branch: the target's history verbatim, then the carryover.
      assert.include(textOf(out.carriedHistory), "shared beginning")
      assert.include(textOf(out.carriedHistory), "kept direction")
      assert.include(
        textOf(out.carriedHistory),
        "Context carried from another branch:\\n\\nwhat the abandoned branch learned"
      )
      assert.notInclude(textOf(out.carriedHistory), "abandoned direction")

      // Provenance and cost, on the value rather than a message protocol.
      assert.strictEqual(out.carried.summary, "what the abandoned branch learned")
      assert.deepStrictEqual(
        out.carried.usage,
        Option.some({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })
      )
      assert.strictEqual(
        Option.getOrThrow(out.carried.commonAncestor),
        out.ancestor.id
      )

      // Neither existing branch was touched.
      assert.notInclude(textOf(out.rightHistory), "Context carried")
      assert.notInclude(textOf(out.leftHistory), "Context carried")
      assert.notInclude(textOf(out.rightHistory), "abandoned direction")
    })
  )

  it.effect("the carryover becomes canonical: a later commit records it and descendants keep it", () =>
    Effect.gen(function*() {
      const { layer } = yield* script(
        "trunk answer",
        "left answer",
        "right answer",
        "carried-on answer",
        "grandchild answer"
      )
      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("shared beginning")
        const ancestor = yield* tree.commit(trunk)

        const left = yield* tree.branch(ancestor)
        yield* left.prompt("abandoned direction")
        const leftNode = yield* tree.commit(left)

        const right = yield* tree.branch(ancestor)
        yield* right.prompt("kept direction")
        const rightNode = yield* tree.commit(right)

        const carried = yield* BranchSummary.branch(tree, {
          from: leftNode,
          to: rightNode,
          summarise: () => Effect.succeed("what the abandoned branch learned")
        })
        yield* carried.session.prompt("carry on")
        const committed = yield* tree.commit(carried.session)

        // A descendant of the committed node inherits the carryover.
        const grandchild = yield* tree.branch(committed)
        yield* grandchild.prompt("descendant turn")

        return {
          committed,
          committedHistory: yield* tree.historyOf(committed),
          grandchildHistory: yield* grandchild.history,
          rightNode
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Canonical on the new branch: the commit recorded it, parented on the
      // target node.
      assert.include(textOf(out.committedHistory), "Context carried from another branch")
      assert.include(textOf(out.committedHistory), "carry on")
      assert.strictEqual(
        Option.getOrThrow(out.committed.parent),
        out.rightNode.id
      )
      // And it survives into descendants.
      assert.include(textOf(out.grandchildHistory), "Context carried from another branch")
      assert.include(textOf(out.grandchildHistory), "descendant turn")
    })
  )

  it.effect("nothing to carry is a refusal, not an empty summary", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk answer", "child answer")
      const error = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("shared beginning")
        const ancestor = yield* tree.commit(trunk)

        const child = yield* tree.branch(ancestor)
        yield* child.prompt("kept direction")
        const childNode = yield* tree.commit(child)

        // `from` is an ancestor of `to`: everything it holds is already in
        // the target's history, so a summary would carry nothing.
        return yield* Effect.flip(BranchSummary.branch(tree, {
          from: ancestor,
          to: childNode,
          summarise: () => Effect.succeed("must never be asked")
        }))
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(error._tag, "affe-agent/tree/NothingToCarry")
    })
  )
})
