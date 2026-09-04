import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as InternalToolkit from "../src/internal/toolkit.js"

/**
 * A toolkit built from a static list says what it holds before it runs.
 *
 * This exists for one reader today -- `Subagent`'s construction-time check
 * for a child's approval-requiring tools -- and it is pinned separately
 * because the check is only as good as the declaration: a path that lowers a
 * static list to a bare Effect makes that check silently skip the child, and
 * nothing else in the suite would notice.
 */

const A = Tool.make("a", { parameters: Schema.Struct({}), success: Schema.String })
const B = Tool.make("b", { parameters: Schema.Struct({}), success: Schema.String })

describe("a statically built toolkit declares its tools", () => {
  it("`Agent.toolkit` declares, and the declaration is typed", () => {
    const built = Agent.toolkit([A], { a: () => Effect.succeed("a") })
    // Typed, not merely present: the record is `ToolsByName`, so a wrong name
    // is a compile error here rather than an `undefined` at the reader.
    assert.strictEqual(built.tools.a.name, "a")
    assert.deepStrictEqual(
      Option.map(InternalToolkit.declaredTools(built), Object.keys),
      Option.some(["a"])
    )
  })

  it("`Agent.make({ tools })` and `withTools` declare, and the union follows the merge", () => {
    const agent = Agent.make({ tools: [Agent.tool(A, () => Effect.succeed("a"))] }).pipe(
      Agent.withTools(Agent.tool(B, () => Effect.succeed("b")))
    )
    assert.deepStrictEqual(
      Option.map(InternalToolkit.declaredTools(agent.toolkit), (tools) => Object.keys(tools).sort()),
      Option.some(["a", "b"])
    )
  })

  it("a toolkit resolved per turn declares nothing, and adding to it does not invent a declaration", () => {
    const perTurn = Agent.make({
      toolkit: Effect.suspend(() => Agent.toolkit([A], { a: () => Effect.succeed("a") }))
    })
    assert.isTrue(Option.isNone(InternalToolkit.declaredTools(perTurn.toolkit)))
    // `withTools` onto an undeclared toolkit stays undeclared: claiming
    // `["b"]` here would be a declaration that omits `a`, which is worse
    // than none for a reader deciding whether it has seen every tool.
    const added = perTurn.pipe(Agent.withTools(Agent.tool(B, () => Effect.succeed("b"))))
    assert.isTrue(Option.isNone(InternalToolkit.declaredTools(added.toolkit)))
  })

  it("the declaration is what the Effect resolves to", () =>
    Effect.gen(function* () {
      const agent = Agent.make({ tools: [Agent.tool(A, () => Effect.succeed("a"))] }).pipe(
        Agent.withTools(Agent.tool(B, () => Effect.succeed("b")))
      )
      const declared = InternalToolkit.declaredTools(agent.toolkit)
      const resolved = yield* InternalToolkit.resolveToolkitInput(agent.toolkit)
      assert.deepStrictEqual(
        Option.map(declared, (tools) => Object.keys(tools).sort()),
        Option.some(Object.keys(resolved.tools).sort())
      )
    }).pipe(Effect.runPromise))
})
