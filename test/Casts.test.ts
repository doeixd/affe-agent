import { assert, describe, it } from "@effect/vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

/**
 * The cast inventory, enforced.
 *
 * AGENTS.md states that *"the casts that exist in `src/` are structural, and
 * each is documented at the site"*, enumerates them, and closes with the rule
 * that matters: *"Adding another needs a reason of that kind."*
 *
 * That rule had quietly stopped being enforced. An audit
 * (`docs/audit-effect-ecosystem.md` E18) measured sixteen cast sites against
 * five enumerated ones -- the twelve in `durable/` and `testing/` were a third
 * and fourth *kind* nobody had written down. None of them violated the rule
 * that matters most (no caller needs a cast), but the enumeration that was
 * supposed to make adding one deliberate had become a list that happened to be
 * out of date.
 *
 * So the enumeration lives here too, and adding a cast fails this test until
 * the reason is written down. That is the same technique
 * `test/CodingPrompts.test.ts` uses for prompt constants: a convention nobody
 * can drift away from is one the build checks.
 *
 * **Why the AST and not a grep.** The obvious `grep " as any"` reports a false
 * positive on the phrase *"survives for as long as anyone holds it"* -- which
 * is not hypothetical, it is a real comment in `CodingToolkit.ts` and it is
 * how this test came to be written this way. Casts are syntax, so they are
 * found by parsing.
 */

interface CastSite {
  readonly file: string
  readonly type: string
}

const sourceFiles = (dir: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith(".ts")) found.push(path)
    }
  }
  walk(dir)
  return found
}

/**
 * Every cast in a file that *erases* a type.
 *
 * Not every `as` is one. `src/` holds 112 `as` expressions, and the great
 * majority are ordinary narrowings that TypeScript still checks for overlap --
 * they cannot turn a string into a number. Counting those would make this a
 * style rule nobody could satisfy, and would bury the sixteen that matter.
 *
 * Three forms erase, and they are the ones AGENTS.md names:
 *
 *   - `x as any`, which turns the checker off;
 *   - `x as unknown as T`, which routes around it -- the outer half is the
 *     erasure, and it is found by asking whether the inner expression is
 *     itself a cast to `any` / `unknown` / `never`.
 *   - `x as never`, which is maximally erasing in the *other* direction:
 *     `never` is assignable to everything, so it satisfies any target at all.
 *     It was uncounted at first because the predicate only looked for `any` in
 *     target position, and the inventory therefore missed one in `Agent.ts`.
 *
 * A bare `JSON.parse(x) as unknown` is deliberately **not** counted: it is the
 * safe direction, taking `any` down to `unknown` so the value must be decoded
 * before use. Counting it would punish the defensive idiom.
 *
 * `as const` is excluded for the same reason -- it narrows a literal, it never
 * claims one thing is another.
 */
const castsIn = (file: string): ReadonlyArray<CastSite> =>
  castsInSource(
    ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
    file.split("\\").join("/")
  )

/** The detector itself, over a parsed file, so a test can hand it a literal. */
const castsInSource = (
  source: ts.SourceFile,
  file = source.fileName
): ReadonlyArray<CastSite> => {
  const found: Array<CastSite> = []
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const type = node.type.getText(source)
      const inner =
        ts.isAsExpression(node.expression) ||
        ts.isTypeAssertionExpression(node.expression)
          ? node.expression.type.getText(source)
          : undefined
      const erases =
        type === "any" ||
        type === "never" ||
        (inner !== undefined && ["any", "unknown", "never"].includes(inner))
      if (erases) {
        found.push({ file, type: type.replace(/\s+/g, " ") })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * The inventory: how many casts each file is allowed, and why.
 *
 * Keyed by file rather than by line, so ordinary edits that move code do not
 * fail the test -- only *adding* or removing a cast does. Each entry mirrors a
 * bullet in AGENTS.md; changing one means changing both.
 */
const ALLOWED: ReadonlyArray<readonly [string, number, string]> = [
  [
    "src/Agent.ts",
    5,
    "the phantom `Tools` field, the `Toolkit.empty` default, the `definition` " +
      "assembly, `mergeHandled`'s two delegating calls, and " +
      "`withExecutionPlan`'s `as never` -- its return type is a conditional " +
      "on an unresolved parameter, which nothing but `never` satisfies"
  ],
  [
    "src/durable/DurableModel.ts",
    5,
    "wrapping a `LanguageModel.Service` whose method types are closed, and " +
      "widening an error channel to cross an `Activity` boundary"
  ],
  [
    "src/durable/DurableToolkit.ts",
    3,
    "the same service-wrapping shape, for a toolkit handler"
  ],
  [
    "src/mcp/McpToolkit.ts",
    1,
    "mapping a declared tool tuple element-wise through a type-preserving " +
      "function (`withRemoteFloor`): `Array.map` widens the tuple to an array"
  ],
  [
    "src/toolSource/ToolSource.ts",
    1,
    "the same tuple-preserving map, through `withSourceFloor`"
  ],
  [
    "src/code/CodeMode.ts",
    2,
    "restating requirements two wrappers erased: `Toolkit.WithHandler` is " +
      "invariant, so the groups constraint types tools as `any` and " +
      "`handle`'s services surface as `unknown` (the truth is " +
      "`ServicesOf<Groups>`, which `execute` declares); and " +
      "`ToolExecution.decide` is an `Effect.fn` whose generic requirement " +
      "collapses to `unknown` under this instantiation (the truth is the " +
      "policy's `R`)"
  ],
  [
    "src/testing/TestLanguageModel.ts",
    6,
    "the same service-wrapping shape: four for the scripted model, two for " +
      "`failingAfter` (one per entry point), which exists so a test never has " +
      "to write one"
  ]
]

describe("cast inventory", () => {
  it("src/ contains exactly the casts AGENTS.md accounts for", () => {
    const byFile = new Map<string, number>()
    for (const file of sourceFiles("src")) {
      const casts = castsIn(file)
      if (casts.length > 0) byFile.set(casts[0]!.file, casts.length)
    }

    const expected = new Map(ALLOWED.map(([file, count]) => [file, count]))
    const reasons = new Map(ALLOWED.map(([file, , why]) => [file, why]))

    // A file that gained a cast. The message carries the reason the file is
    // allowed the ones it has, so the next author sees what kind of argument
    // a new one has to make.
    for (const [file, count] of byFile) {
      const allowed = expected.get(file)
      assert.isDefined(
        allowed,
        `${file} has ${count} cast(s) and is not in the inventory. If this is ` +
          `sound and structural, add it to ALLOWED here and to the list in ` +
          `AGENTS.md, with the reason. If it is not, the fix is the signature.`
      )
      assert.strictEqual(
        count,
        allowed,
        `${file} has ${count} cast(s), the inventory allows ${allowed}. ` +
          `Existing ones are: ${reasons.get(file)}.`
      )
    }

    // A file that lost its casts: good news, and the inventory should shrink
    // rather than quietly over-permit.
    for (const [file, allowed] of expected) {
      assert.strictEqual(
        byFile.get(file) ?? 0,
        allowed,
        `${file} is allowed ${allowed} cast(s) but has ${byFile.get(file) ?? 0}. ` +
          `If they are gone, remove the entry here and the bullet in AGENTS.md.`
      )
    }
  })

  it("finds a cast that a naive grep would miss, and ignores prose that fools one", () => {
    // The detector is falsifiable in both directions, which is the point:
    // it must see real syntax and must not see English.
    const withCast = ts.createSourceFile(
      "t.ts",
      `const x = y as unknown as string`,
      ts.ScriptTarget.Latest,
      true
    )
    let seen = 0
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) seen = seen + 1
      ts.forEachChild(node, visit)
    }
    visit(withCast)
    // `y as unknown as string` is two nested `as` expressions.
    assert.strictEqual(seen, 2)

    // The real comment in `CodingToolkit.ts` that a grep for " as any" hits.
    const prose = ts.createSourceFile(
      "t.ts",
      `// an entry survives for as long as anyone holds it\nconst n = 1`,
      ts.ScriptTarget.Latest,
      true
    )
    let inProse = 0
    const visitProse = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) inProse = inProse + 1
      ts.forEachChild(node, visitProse)
    }
    visitProse(prose)
    assert.strictEqual(inProse, 0)
  })

  it("counts `as never`, which is erasing in target position", () => {
    // The blind spot this predicate was widened to close: `never` is
    // assignable to every type, so `x as never` satisfies any target at all --
    // the same hole as `as any`, approached from the other end.
    const write = (text: string) =>
      castsInSource(ts.createSourceFile("t.ts", text, ts.ScriptTarget.Latest, true))

    assert.strictEqual(write(`const x = y as never`).length, 1)
    // Still not a style rule: an ordinary narrowing stays uncounted.
    assert.strictEqual(write(`const x = y as string`).length, 0)
  })
})
