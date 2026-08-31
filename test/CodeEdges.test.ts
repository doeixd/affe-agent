import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import { CodeMode } from "../src/code/index.js"

/**
 * Edges a model actually writes into. Each case here was produced by
 * asking "what would a model plausibly type?" rather than by reading the
 * interpreter, so they test the surface as used rather than as built.
 */

const Count = Tool.make("count", {
  parameters: Schema.Struct({}),
  success: Schema.Number
})

const Echo = Tool.make("echo", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const run = (program: string) =>
  Effect.gen(function*() {
    const data = yield* Agent.toolkit([Count, Echo], {
      count: () => Effect.succeed(7),
      echo: ({ text }) => Effect.succeed(text)
    })
    const runtime = CodeMode.make({ tools: { data } })
    return yield* runtime.execute(program)
  })

describe("code mode edges", () => {
  it.effect("a parameterless tool may be called with no arguments at all", () =>
    Effect.gen(function*() {
      // The single most likely thing a model writes for a tool whose
      // schema has no properties. Requiring `({})` here would be a
      // pointless refusal it has to learn from a failure.
      const out = yield* run("const n = await tools.data.count()\nreturn n.value")
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: 7 })
    })
  )

  it.effect("an empty program, and a bare return, are distinguishable", () =>
    Effect.gen(function*() {
      assert.strictEqual((yield* run("")).outcome._tag, "RanOffTheEnd")
      assert.strictEqual((yield* run("// just a comment")).outcome._tag, "RanOffTheEnd")
      // `return;` is a deliberate empty answer, not "fell off the end".
      assert.deepStrictEqual((yield* run("return")).outcome, {
        _tag: "Returned",
        value: null
      })
    })
  )

  it.effect("a returned promise is awaited, not handed back unresolved", () =>
    Effect.gen(function*() {
      const out = yield* run("return tools.data.count()")
      assert.deepStrictEqual(out.outcome, {
        _tag: "Returned",
        value: { ok: true, value: 7 }
      })
    })
  )

  it.effect("a namespace is not callable, and a deeper path is not a tool", () =>
    Effect.gen(function*() {
      // A namespace called directly reads as a call at that path, and the
      // catalog is where the model finds out what is actually there.
      const namespace = yield* run(
        "try {\n  await tools.data()\n} catch (error) {\n  return error.message\n}"
      )
      assert.deepStrictEqual(namespace.outcome, {
        _tag: "Returned",
        value: "no tool at tools.data; check the catalog"
      })

      // Held in a variable and then called: the interpreter has never seen
      // the toolkit, so it names the form that works rather than guessing
      // whether the path is a tool or a namespace.
      const indirect = yield* run(
        "const held = tools.data.count\ntry {\n  await held()\n} catch (error) {\n  return error.message\n}"
      )
      assert.deepStrictEqual(indirect.outcome, {
        _tag: "Returned",
        value: "tools.data.count cannot be called through a variable; call it directly as tools.data.count(...)"
      })

      const deeper = yield* run(
        "try {\n  await tools.data.count.extra({})\n} catch (error) {\n  return error.message\n}"
      )
      assert.strictEqual(deeper.outcome._tag, "Returned")
      if (deeper.outcome._tag === "Returned") {
        assert.include(String(deeper.outcome.value), "no tool at tools.data.count.extra")
      }
    })
  )

  it.effect("invalid parameters come back as a value the program can branch on", () =>
    Effect.gen(function*() {
      // The model guessed the wrong shape. That is its mistake to
      // recover from, not a reason to fail the run.
      const out = yield* run(
        "const r = await tools.data.echo({ wrong: 1 })\nreturn r.ok"
      )
      assert.deepStrictEqual(out.outcome, { _tag: "Returned", value: false })
    })
  )

  it.effect("returning a function or a promise-bearing object is refused, naming the value", () =>
    Effect.gen(function*() {
      const fn = yield* run("return () => 1")
      assert.strictEqual(fn.outcome._tag, "Refused")
      if (fn.outcome._tag === "Refused") {
        // Described by what the model wrote, never by our class names: a
        // diagnostic that says "a ProgramFunction instance" is telling the
        // model about our implementation instead of about its program.
        assert.strictEqual(
          fn.outcome.fix,
          "the program returned a function; return plain data instead"
        )
      }

      const unawaited = yield* run("return { pending: tools.data.count() }")
      assert.strictEqual(unawaited.outcome._tag, "Refused")
      if (unawaited.outcome._tag === "Refused") {
        assert.include(unawaited.outcome.fix, "await")
      }
    })
  )

  it.effect("shadowing `tools` is the program's own business and cannot reach past its scope", () =>
    Effect.gen(function*() {
      const out = yield* run([
        "const shadow = (tools) => tools + 1",
        "const inner = shadow(1)",
        "const real = await tools.data.count()",
        "return { inner, real: real.value }"
      ].join("\n"))
      assert.deepStrictEqual(out.outcome, {
        _tag: "Returned",
        value: { inner: 2, real: 7 }
      })
    })
  )
})
