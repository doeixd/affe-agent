import { assert, describe, it } from "@effect/vitest"
import { recover } from "../src/code/internal/recover.js"

/**
 * Shape recovery (`plan-code-mode-engine.md` step 3): a model's wrapping
 * is unwrapped rather than refused, conservatively, and every applied
 * step is reported.
 */

describe("recover", () => {
  it("plain code comes back verbatim, with nothing applied", () => {
    const program = "const x = await tools.github.list_issues({ owner: \"a\", repo: \"b\" })\nreturn x"
    assert.deepStrictEqual(recover(program), { code: program, applied: [] })
  })

  it("a fenced block is extracted whatever its language tag claims", () => {
    const out = recover(
      "Here is the program:\n\n```typescript\nreturn 1\n```\n\nHope that helps!"
    )
    assert.strictEqual(out.code, "return 1")
    assert.deepStrictEqual(out.applied, ["fence"])
    // The tag is discarded even when it lies.
    assert.strictEqual(recover("```python\nreturn 2\n```").code, "return 2")
  })

  it("two fenced blocks are one program in two parts; the prose between was never code", () => {
    const out = recover(
      "First we fetch:\n```js\nconst a = await tools.net.ping()\n```\nthen we return:\n```js\nreturn a\n```"
    )
    assert.strictEqual(out.code, "const a = await tools.net.ping()\n\nreturn a")
    assert.deepStrictEqual(out.applied, ["fence"])
  })

  it("export default becomes return, inside a fence too", () => {
    assert.deepStrictEqual(recover("export default 41 + 1"), {
      code: "return 41 + 1",
      applied: ["export-default"]
    })
    const fenced = recover("```ts\nexport default { done: true }\n```")
    assert.strictEqual(fenced.code, "return { done: true }")
    assert.deepStrictEqual(fenced.applied, ["fence", "export-default"])
  })

  it("a bare arrow is invoked, sync or async, single parameter or list", () => {
    assert.deepStrictEqual(recover("() => 42"), {
      code: "return (() => 42)()",
      applied: ["bare-arrow"]
    })
    const asyncArrow = recover("async () => {\n  return await tools.net.ping()\n}")
    assert.strictEqual(
      asyncArrow.code,
      "return (async () => {\n  return await tools.net.ping()\n})()"
    )
    assert.deepStrictEqual(asyncArrow.applied, ["bare-arrow"])
    assert.strictEqual(recover("x => x + 1").code, "return (x => x + 1)()")
  })

  it("an arrow merely inside a program does not trigger the rewrite", () => {
    const program = "const double = (x) => x * 2\nreturn double(21)"
    assert.deepStrictEqual(recover(program), { code: program, applied: [] })
    // Nor does one on a later line after ordinary code.
    const mapped = "const out = items.map((item) => item.id)\nreturn out"
    assert.deepStrictEqual(recover(mapped), { code: mapped, applied: [] })
  })

  it("TypeScript syntax is deliberately not stripped here", () => {
    // A regex stripper would mangle this into a wrong-but-running
    // program; leaving it intact lets step 4's parser refuse it with an
    // UnsupportedSyntax that names the fix.
    const typed = "const n: number = 1\nreturn n"
    assert.deepStrictEqual(recover(typed), { code: typed, applied: [] })
  })
})
