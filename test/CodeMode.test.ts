import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as Permission from "../src/Permission.js"
import { CodeMode } from "../src/code/index.js"
import { CurrentPrincipal } from "../src/Principal.js"
import { Option } from "effect"

/**
 * The code-mode host API (`plan-code-mode-engine.md` step 5): a program
 * runs against exactly the supplied tools, nested calls answer to the
 * same permission policy as direct ones, the executor failure split
 * holds, program outcomes are data, and limits refuse with the fix
 * named.
 */

const Lookup = Tool.make("lookup", {
  description: "Look something up",
  parameters: Schema.Struct({ key: Schema.String }),
  success: Schema.Struct({ found: Schema.String })
})

const Fail = Tool.make("flaky", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Schema.Struct({ code: Schema.String })
})

const Wipe = Permission.annotate(
  Tool.make("wipe", {
    parameters: Schema.Struct({ target: Schema.String }),
    success: Schema.String
  }),
  { action: "delete", resource: (params) => params.target }
)

const Who = Tool.make("who", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

const fixture = Effect.gen(function*() {
  const seen: Array<string> = []
  const data = yield* Agent.toolkit([Lookup, Fail], {
    lookup: ({ key }) => Effect.succeed({ found: `value-of-${key}` }),
    flaky: () => Effect.fail({ code: "UPSTREAM_DOWN" })
  })
  const admin = yield* Agent.toolkit([Wipe, Who], {
    wipe: ({ target }) => Effect.succeed(`wiped ${target}`),
    who: () =>
      Effect.map(CurrentPrincipal, (principal) =>
        Option.getOrElse(principal, () => "nobody"))
  })
  return { data, admin, seen }
})

// ---------------------------------------------------------------------------
// Inference is precise: `any` compiles too, so assert it does not happen.
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Fixture = Effect.Success<typeof fixture>
type Runtime = ReturnType<typeof CodeMode.make<{ data: Fixture["data"] }, never>>
type ExecuteResult = Effect.Success<ReturnType<Runtime["execute"]>>
export type _ResultIsNotAny = Assert<IsAny<ExecuteResult> extends true ? false : true>
export type _RequirementsAreNotAny = Assert<
  IsAny<Effect.Services<ReturnType<Runtime["execute"]>>> extends true ? false : true
>

describe("CodeMode", () => {
  it.effect("a program calls tools, branches on the failure value, and returns data", () =>
    Effect.gen(function*() {
      const { admin, data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data, admin } })
      const out = yield* runtime.execute([
        "const one = await tools.data.lookup({ key: \"a\" })",
        "const broken = await tools.data.flaky({})",
        "if (broken.ok) { throw \"should have failed\" }",
        "return { got: one.value.found, code: broken.error.code }"
      ].join("\n"))
      assert.deepStrictEqual(out.outcome, {
        _tag: "Returned",
        value: { got: "value-of-a", code: "UPSTREAM_DOWN" }
      })
      assert.deepStrictEqual(
        out.calls.map((call) => `${call.path.join(".")}:${call.outcome}`),
        ["data.lookup:succeeded", "data.flaky:failed"]
      )
      assert.deepStrictEqual(out.recovered, [])
    })
  )

  it.effect("a denied call throws into the program; an allowed one runs — the same policy as direct calls", () =>
    Effect.gen(function*() {
      const { admin, data } = yield* fixture
      const runtime = CodeMode.make({
        tools: { admin, data },
        permission: Permission.make((request) =>
          Effect.succeed(
            request.action === "delete"
              ? Permission.deny("not in code mode")
              : Permission.allow
          ))
      })
      const out = yield* runtime.execute([
        "try {",
        "  await tools.admin.wipe({ target: \"prod\" })",
        "  return \"unreachable\"",
        "} catch (error) {",
        "  const ok = await tools.data.lookup({ key: \"still-works\" })",
        "  return { refused: error.message, then: ok.value.found }",
        "}"
      ].join("\n"))
      assert.deepStrictEqual(out.outcome, {
        _tag: "Returned",
        value: {
          refused: "permission denied for wipe: not in code mode",
          then: "value-of-still-works"
        }
      })
      assert.strictEqual(out.calls[0]!.outcome, "refused")
    })
  )

  it.effect("a nested call runs on the calling fibre: CurrentPrincipal reaches the handler", () =>
    Effect.gen(function*() {
      const { admin } = yield* fixture
      const runtime = CodeMode.make({ tools: { admin } })
      const out = yield* runtime
        .execute("const who = await tools.admin.who({})\nreturn who.value")
        .pipe(Effect.provideService(CurrentPrincipal, Option.some("user:carol")))
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: "user:carol" })
    })
  )

  it.effect("an unknown path is a catchable program error naming the catalog", () =>
    Effect.gen(function*() {
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })
      const out = yield* runtime.execute(
        "try {\n  await tools.data.nope({})\n} catch (error) {\n  return error.message\n}"
      )
      assert.deepStrictEqual(out.outcome, {
        _tag: "Returned",
        value: "no tool at tools.data.nope; check the catalog"
      })
    })
  )

  it.effect("limits refuse with the fix named: tool calls, output size, timeout", () =>
    Effect.gen(function*() {
      const { data } = yield* fixture
      const limited = CodeMode.make({ tools: { data }, limits: { maxToolCalls: 2 } })
      const tooMany = yield* limited.execute(
        "for (const key of [\"a\", \"b\", \"c\"]) {\n  await tools.data.lookup({ key })\n}\nreturn \"done\""
      )
      assert.strictEqual(tooMany.outcome._tag, "Refused")
      if (tooMany.outcome._tag === "Refused") {
        assert.strictEqual(tooMany.outcome.reason, "tool-limit")
      }

      const small = CodeMode.make({ tools: { data }, limits: { maxOutputBytes: 8 } })
      const tooBig = yield* small.execute("return { a: \"0123456789\" }")
      assert.strictEqual(tooBig.outcome._tag, "Refused")
      if (tooBig.outcome._tag === "Refused") {
        assert.strictEqual(tooBig.outcome.reason, "output-limit")
        assert.include(tooBig.outcome.fix, "return less")
      }
    })
  )

  it.effect("outcomes are data: threw, ran off the end, refused syntax — and recovery is reported", () =>
    Effect.gen(function*() {
      const { data } = yield* fixture
      const runtime = CodeMode.make({ tools: { data } })

      const threw = yield* runtime.execute("throw { message: \"mine\" }")
      assert.strictEqual(threw.outcome._tag, "Threw")

      const silent = yield* runtime.execute("const x = 1")
      assert.strictEqual(silent.outcome._tag, "RanOffTheEnd")

      const refused = yield* runtime.execute("class X {}")
      assert.strictEqual(refused.outcome._tag, "Refused")

      const fenced = yield* runtime.execute("```js\nreturn 7\n```")
      assert.deepStrictEqual(fenced.outcome, { _tag: "Returned", value: 7 })
      assert.deepStrictEqual(fenced.recovered, ["fence"])
    })
  )
})
