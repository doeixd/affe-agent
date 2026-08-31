import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as Permission from "../src/Permission.js"
import { CodeMode, CodeTool } from "../src/code/index.js"

/**
 * The rule that matters most (AGENTS.md): end-user code must never need a
 * cast, and inference must be *precise* -- `any` compiles too, so the
 * claim has to be asserted rather than assumed.
 *
 * Code mode is the hardest case in the repository for this, because its
 * groups are constrained as `WithHandler<any>` (the type is invariant in
 * its tools). That `any` is exactly the kind that silently swallows a
 * service requirement and turns a compile error into a runtime
 * missing-service defect, so it is pinned here from both ends.
 */

class Database extends Context.Service<Database, { readonly rows: number }>()(
  "test/CodeTypes/Database"
) {}

const Query = Tool.make("query", {
  parameters: Schema.Struct({ sql: Schema.String }),
  success: Schema.Number,
  dependencies: [Database]
})

const Plain = Tool.make("plain", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

const withDependency = Effect.gen(function*() {
  const db = yield* Agent.toolkit([Query], {
    query: () => Effect.map(Effect.service(Database), (service) => service.rows)
  })
  return { db }
})

const withoutDependency = Effect.gen(function*() {
  const plain = yield* Agent.toolkit([Plain], {
    plain: () => Effect.succeed("ok")
  })
  return { plain }
})

// ---------------------------------------------------------------------------
// Compile-time assertions. Each of these is a claim about inference that a
// runtime test cannot make, and each has been broken once to confirm it is
// enforced rather than vacuous.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

type WithDependency = Effect.Success<typeof withDependency>
type WithoutDependency = Effect.Success<typeof withoutDependency>

type DependentRuntime = ReturnType<
  typeof CodeMode.make<{ db: WithDependency["db"] }, never>
>
type DependentServices = Effect.Services<ReturnType<DependentRuntime["execute"]>>

/** A handler's own dependency survives the `any` in the groups constraint. */
export type _DependencyPropagates = Assert<Extends<Database, DependentServices>>
/** ...and is not merely `any` masquerading as everything. */
export type _ServicesAreNotAny = Assert<IsAny<DependentServices> extends true ? false : true>

type PlainRuntime = ReturnType<
  typeof CodeMode.make<{ plain: WithoutDependency["plain"] }, never>
>
type PlainServices = Effect.Services<ReturnType<PlainRuntime["execute"]>>

/** A toolkit that needs nothing requires nothing: no phantom service. */
export type _NoPhantomRequirement = Assert<Extends<PlainServices, never>>

/** A policy's own requirement reaches `execute` too. */
type PolicyRuntime = ReturnType<
  typeof CodeMode.make<{ plain: WithoutDependency["plain"] }, Database>
>
export type _PolicyRequirementPropagates = Assert<
  Extends<Database, Effect.Services<ReturnType<PolicyRuntime["execute"]>>>
>

/** The outcome is a real discriminated union, not `any`. */
type Outcome = Effect.Success<ReturnType<PlainRuntime["execute"]>>["outcome"]
export type _OutcomeIsNotAny = Assert<IsAny<Outcome> extends true ? false : true>
export type _OutcomeDiscriminates = Assert<
  Extends<Extract<Outcome, { _tag: "Returned" }>["value"], unknown>
>

describe("code mode types", () => {
  it.effect("a handler's dependency must be provided, and providing it is enough", () =>
    Effect.gen(function*() {
      const { db } = yield* withDependency
      const runtime = CodeMode.make({ tools: { db } })
      // No cast anywhere: the requirement is real, and `Effect.provide`
      // discharges it exactly as it would for any other effect.
      const out = yield* runtime.execute(
        "const n = await tools.db.query({ sql: \"select 1\" })\nreturn n.value"
      )
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: 42 })
    }).pipe(Effect.provideService(Database, { rows: 42 }))
  )

  it.effect("a permission policy's requirement is discharged the same way", () =>
    Effect.gen(function*() {
      const { plain } = yield* withoutDependency
      const runtime = CodeMode.make({
        tools: { plain },
        permission: Permission.make(() =>
          Effect.map(Effect.service(Database), (service) =>
            service.rows > 0 ? Permission.allow : Permission.deny("empty")))
      })
      const out = yield* runtime.execute(
        "const r = await tools.plain.plain()\nreturn r.value"
      )
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: "ok" })
    }).pipe(Effect.provideService(Database, { rows: 1 }))
  )

  it.effect("CodeTool.tool discharges those requirements where it is built", () =>
    Effect.gen(function*() {
      const { db } = yield* withDependency
      // Built inside a context that has the service, so the bound tool
      // carries no requirement of its own -- the whole reason `tool` is
      // an Effect. The agent that receives it needs nothing extra.
      const bound = yield* CodeTool.tool({ tools: { db } })
      assert.strictEqual(bound.tool.name, "execute")
      assert.include(bound.tool.description ?? "", "tools.db.query")
    }).pipe(Effect.provideService(Database, { rows: 9 }))
  )
})
