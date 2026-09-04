import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { CurrentPrincipal } from "../src/Principal.js"
import { Subagent } from "../src/subagent/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Does the caller's identity reach a delegated agent's tools?
 *
 * `plan-seams.md` asserts that it does, and until now that assertion came from
 * reading the mechanism rather than running anything: `CurrentPrincipal` is a
 * `Context.Reference` on the fibre, a child runs on the calling fibre, so the
 * child inherits it. That is a sound argument and arguments have been wrong
 * twice today.
 *
 * It matters more than the other rows in its column, because the *other*
 * cross-cutting concerns do not cross a delegation -- a budget does not, an
 * approval does not -- and a reader who learns that pattern would reasonably
 * assume identity behaves the same way. It does not, and a tool that decides
 * what a *user* may see needs to know which of the two rules it is under.
 */

const WhoAmI = Tool.make("who_am_i", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

describe("a principal across a delegation", () => {
  it.live("a child's tool reads the principal the parent was acting for", () =>
    Effect.gen(function* () {
      const seenByChild = yield* Ref.make<Option.Option<string>>(Option.none())

      const child = Agent.make({
        instructions: "child",
        tools: [
          Agent.tool(WhoAmI, () =>
            Effect.flatMap(CurrentPrincipal, (principal) =>
              Effect.as(Ref.set(seenByChild, principal), "reported")))
        ],
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "w1", name: "who_am_i", params: {} }] },
        { text: "the child answered" }
      ])

      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })

      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: AgentLoop.bounded(4)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      yield* Agent.run(parent, "go").pipe(
        Effect.scoped,
        Effect.provide(parentModel),
        // The identity the parent is acting for, set the way a host sets it.
        Effect.provideService(CurrentPrincipal, Option.some("user:carol"))
      )

      assert.deepStrictEqual(
        yield* Ref.get(seenByChild),
        Option.some("user:carol"),
        "the child ran without the caller's identity: a tool deciding what a user may see would have decided for nobody"
      )
    }),
    30_000
  )

  it.live("a child with no principal above it reads None, rather than someone else's", () =>
    Effect.gen(function* () {
      const seenByChild = yield* Ref.make<Option.Option<string>>(Option.some("stale"))

      const child = Agent.make({
        instructions: "child",
        tools: [
          Agent.tool(WhoAmI, () =>
            Effect.flatMap(CurrentPrincipal, (principal) =>
              Effect.as(Ref.set(seenByChild, principal), "reported")))
        ],
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "w1", name: "who_am_i", params: {} }] },
        { text: "the child answered" }
      ])

      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })
      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: AgentLoop.bounded(4)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      // No principal provided anywhere: the default, and the child must read
      // it rather than whatever the last run happened to leave behind.
      yield* Agent.run(parent, "go").pipe(Effect.scoped, Effect.provide(parentModel))

      assert.deepStrictEqual(yield* Ref.get(seenByChild), Option.none())
    }),
    30_000
  )
})
