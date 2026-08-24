import { assert, describe, it } from "@effect/vitest"
import * as LineEndings from "../src/coding/internal/lineEndings.js"
import * as Replace from "../src/coding/internal/replace.js"

/**
 * The replacer chain's contract.
 *
 * Two separate properties are tested, and conflating them is a mistake:
 *
 * - **What each strategy can do**, by driving its generator directly. The
 *   strategies overlap on purpose (defence in depth), so several can often
 *   solve the same input.
 * - **Which one the driver lets answer**, through `replace`. The order is the
 *   design -- strictest first -- so a change that lets a looser strategy answer
 *   first is a regression even when the resulting file is identical.
 */

/** Replace and require success, returning the whole outcome. */
const replaced = (content: string, find: string, to: string, all = false) => {
  const outcome = Replace.replace(content, find, to, all)
  if (outcome._tag !== "Replaced") {
    throw new Error(`expected a replacement, got ${outcome._tag}`)
  }
  return outcome
}

describe("replace: what each strategy can do", () => {
  it("1. simple -- the exact text", () => {
    const out = replaced("const x = 1\nconst y = 2", "const x = 1", "const x = 42")
    assert.strictEqual(out.strategy, "simple")
    assert.strictEqual(out.content, "const x = 42\nconst y = 2")
  })

  it("2. line-trimmed -- trailing whitespace and indentation drift", () => {
    // The file has trailing spaces the model did not reproduce.
    const file = "function f() {\n  return 1;   \n}\n"
    const out = replaced(file, "  return 1;\n", "  return 2;\n")
    assert.strictEqual(out.strategy, "line-trimmed")
    assert.include(out.content, "return 2;")
    // The span selected was the file's own text, trailing spaces included.
    assert.include(out.matched, "   ")
  })

  it("3. block-anchor -- anchors hold, the middle was rewritten", () => {
    const file = [
      "export function calc(a, b) {",
      "  const scaled = a * 2",
      "  const shifted = scaled + b",
      "  return shifted",
      "}"
    ].join("\n")
    // Middle lines differ from the file but the first and last lines anchor.
    const find = [
      "export function calc(a, b) {",
      "  const scaled = a * 2.0",
      "  const shifted = scaled + b + 0",
      "  return shifted",
      "}"
    ].join("\n")
    const out = replaced(file, find, "export function calc() { return 0 }")
    assert.strictEqual(out.strategy, "block-anchor")
    assert.strictEqual(out.content, "export function calc() { return 0 }")
  })

  it("3b. block-anchor declines when the middle is unrelated", () => {
    const file = ["open {", "  alpha", "  beta", "  gamma", "close }"].join("\n")
    const unrelated = ["open {", "  zzzzzzzz", "  yyyyyyyy", "  xxxxxxxx", "close }"].join("\n")
    assert.deepStrictEqual(Replace.candidatesOf("block-anchor", file, unrelated), [])
  })

  it("4. whitespace-normalized -- interior spacing differs", () => {
    const file = "const gap = {  a:   1  }"
    const out = replaced(file, "{ a: 1 }", "{ a: 2 }")
    assert.strictEqual(out.strategy, "whitespace-normalized")
    assert.strictEqual(out.content, "const gap = { a: 2 }")
  })

  it("5. indentation-flexible -- a wholesale re-indent", () => {
    // Driven directly: line-trimmed is stricter and also copes with pure
    // indentation drift, so in the chain it answers first (see the ordering
    // test below). This strategy's own job is the re-indented block.
    const file = "class C {\n    method() {\n      return 1\n    }\n}"
    const candidates = Replace.candidatesOf(
      "indentation-flexible",
      file,
      "method() {\n  return 1\n}"
    )
    assert.isAbove(candidates.length, 0)
    const first = candidates[0] ?? ""
    // It points at the file's own indented text, not at the dedented form.
    assert.include(first, "      return 1")
    assert.include(file, first)
  })

  it("6. escape-normalized -- the model escaped its escapes", () => {
    const file = "const s = 'a\nb'"
    // A newline arrived as the two characters backslash-n.
    const out = replaced(file, "const s = 'a\\nb'", "const s = 'x'")
    assert.strictEqual(out.strategy, "escape-normalized")
    assert.strictEqual(out.content, "const s = 'x'")
  })

  it("7. trimmed-boundary -- stray blank lines around the quotation", () => {
    // Driven directly, for the same reason as indentation-flexible: the
    // whitespace-normalized strategy sits earlier and also copes with padding.
    const candidates = Replace.candidatesOf(
      "trimmed-boundary",
      "top\nmiddle\nbottom",
      "\n\nmiddle\n\n"
    )
    assert.include(candidates, "middle")
    // Padding that is already absent gives it nothing to do.
    assert.deepStrictEqual(Replace.candidatesOf("trimmed-boundary", "top\nmiddle", "middle"), [])
  })

  it("8. context-aware -- same size, anchors exact, half the middle intact", () => {
    const file = ["if (ok) {", "  a()", "  b()", "  c()", "}"].join("\n")
    // Same line count, both anchors exact, one of three middle lines changed.
    const find = ["if (ok) {", "  a()", "  CHANGED()", "  c()", "}"].join("\n")
    assert.deepStrictEqual(Replace.candidatesOf("context-aware", file, find), [file])
    // Too much of the middle differs: it declines rather than guessing.
    const tooDifferent = ["if (ok) {", "  x()", "  y()", "  z()", "}"].join("\n")
    assert.deepStrictEqual(Replace.candidatesOf("context-aware", file, tooDifferent), [])
  })

  it("9. multi-occurrence -- exact text everywhere, under replace_all", () => {
    const out = replaced("a\na\na", "a", "b", true)
    assert.strictEqual(out.count, 3)
    assert.strictEqual(out.content, "b\nb\nb")
  })
})

describe("replace: which strategy the driver lets answer", () => {
  it("every strategy is registered, exact first", () => {
    assert.strictEqual(Replace.strategyOrder[0], "simple")
    assert.strictEqual(Replace.strategyOrder.length, 9)
    assert.deepStrictEqual(
      [...Replace.strategyOrder].sort(),
      Object.keys(Replace.strategyByName).sort()
    )
  })

  it("the strictest strategy that can answer is the one that does", () => {
    // Text that several strategies could match still reports the strictest.
    assert.strictEqual(replaced("  return 1\n", "  return 1", "  return 2").strategy, "simple")
    // A wholesale re-indent: indentation-flexible could solve it, but the
    // stricter line-trimmed can too, so line-trimmed answers.
    const file = "class C {\n    method() {\n      return 1\n    }\n}"
    const out = replaced(file, "method() {\n  return 1\n}", "method() {\n  return 2\n}")
    assert.strictEqual(out.strategy, "line-trimmed")
    assert.include(out.content, "return 2")
    // Blank-line padding: trimmed-boundary could solve it; whitespace-
    // normalized sits earlier and does.
    const padded = replaced("top\nmiddle\nbottom", "\n\nmiddle\n\n", "MIDDLE")
    assert.strictEqual(padded.strategy, "whitespace-normalized")
    assert.strictEqual(padded.content, "top\nMIDDLE\nbottom")
  })
})

describe("replace: the three terminal failures", () => {
  it("not found -- nothing resembling the text is in the file", () => {
    assert.strictEqual(Replace.replace("hello world", "goodbye", "x")._tag, "NotFound")
  })

  it("ambiguous -- found, but in more than one place", () => {
    assert.strictEqual(Replace.replace("a\na\na", "a", "b")._tag, "Ambiguous")
  })

  it("an empty find is never a match-everywhere", () => {
    assert.strictEqual(Replace.replace("hello", "", "x")._tag, "NotFound")
  })

  it("a runaway span is refused, never applied", () => {
    // Repeating anchors far apart: a block candidate could otherwise swallow
    // forty lines to satisfy a three-line request.
    const body = Array.from({ length: 40 }, (_, i) => `  line ${i}`).join("\n")
    const file = `start {\n${body}\n}\nstart {\n  line a\n}`
    const outcome = Replace.replace(file, "start {\n  line a\n}", "start {}")
    if (outcome._tag === "Replaced") {
      // If it matched at all, it matched the small block -- never the large one.
      assert.isBelow(outcome.matched.split("\n").length, 6)
    } else {
      assert.strictEqual(outcome._tag, "Disproportionate")
    }
  })
})

describe("replace: the proportionality guard itself", () => {
  it("refuses a span 2x longer, or 3+ lines longer", () => {
    assert.isTrue(Replace.isDisproportionate("a\nb\nc\nd", "a"))
    assert.isTrue(Replace.isDisproportionate("a\nb\nc\nd\ne\nf", "a\nb"))
  })

  it("allows an ordinary same-size or slightly larger match", () => {
    assert.isFalse(Replace.isDisproportionate("a\nb", "a\nb"))
    assert.isFalse(Replace.isDisproportionate("a\nb\nc", "a\nb"))
  })

  it("a single-line find may match one very long line", () => {
    assert.isFalse(Replace.isDisproportionate("x".repeat(5000), "x"))
  })

  it("a multi-line find is bounded by characters as well as lines", () => {
    assert.isTrue(Replace.isDisproportionate(`a\n${"x".repeat(2000)}`, "a\nb"))
  })
})

describe("replace: safety properties", () => {
  it("splices literally -- dollar patterns in the replacement are text", () => {
    assert.strictEqual(replaced("price = OLD", "OLD", "$&{amount}").content, "price = $&{amount}")
    assert.strictEqual(replaced("A A", "A", "$'", true).content, "$' $'")
  })

  it("the replaced span is always verbatim file content", () => {
    const file = "function f() {\n  return 1;   \n}\n"
    assert.include(file, replaced(file, "  return 1;\n", "  return 2;\n").matched)
  })

  it("nothing outside the matched span changes", () => {
    const out = replaced("alpha\nbeta\ngamma", "beta", "BETA")
    assert.isTrue(out.content.startsWith("alpha\n"))
    assert.isTrue(out.content.endsWith("\ngamma"))
  })
})

describe("replace: agreement with upstream", () => {
  /**
   * These cases were run against opencode's own `replace` at commit
   * 2a6be0a03b93a6734070e10a6c3b56863475f214 and produced identical results.
   * They are pinned here so the agreement survives: a refactor that changes any
   * of these outputs has drifted from the implementation this was ported from.
   *
   * The two known divergences are deliberate bug fixes, tested separately -- a
   * find ending in a newline (upstream leaves a blank line behind) and dollar
   * patterns in the replacement under replace_all (upstream interprets them).
   */
  const verified: ReadonlyArray<
    readonly [name: string, content: string, find: string, to: string, expected: string]
  > = [
    ["two blocks sharing anchors", "f {\n  a\n  b\n}\nf {\n  c\n  d\n}", "f {\n  a\n  b\n}", "X", "X\nf {\n  c\n  d\n}"],
    ["anchored block with blank middles", "open {\n\n\nclose }", "open {\n\n\nclose }", "X", "X"],
    ["tabs against spaces", "if\t(x)\treturn", "if (x) return", "STOP", "STOP"],
    ["re-indented block", "  a\n  b\n  c\n", "a\nb\nc", "X", "X\n"],
    ["over-escaped tab", "x\ty", "x\\ty", "z", "z"],
    ["padded single line", "alpha", "  alpha  ", "beta", "beta"],
    ["regex metacharacters are literal", "a.*b", "a.*b", "c", "c"],
    ["a dollar in the find", "cost = $5", "$5", "$6", "cost = $6"],
    ["unicode is not mangled", "const s = 'h\u00e9llo w\u00f6rld'", "h\u00e9llo", "hello", "const s = 'hello w\u00f6rld'"],
    ["emoji survive the splice", "x = '\u{1F389}'", "\u{1F389}", "\u{1F38A}", "x = '\u{1F38A}'"],
    ["crlf content", "a\r\nb\r\n", "b", "B", "a\r\nB\r\n"]
  ]

  for (const [name, content, find, to, expected] of verified) {
    it(name, () => {
      assert.strictEqual(replaced(content, find, to).content, expected)
    })
  }

  it("refuses what upstream refuses", () => {
    // An unrelated middle scores below the anchor threshold; an empty file has
    // nothing to match. Upstream reports both as not-found.
    const unrelated = Replace.replace(
      "open {\n  alpha\n  beta\nclose }",
      "open {\n  zzzzzzzzz\n  yyyyyyyyy\nclose }",
      "X"
    )
    assert.strictEqual(unrelated._tag, "NotFound")
    assert.strictEqual(Replace.replace("", "x", "y")._tag, "NotFound")
  })

  it("offers only the best-scoring anchored block, never a runner-up", () => {
    // Two blocks share both anchors. Only the closer one may ever be offered:
    // yielding the other as a fallback would edit the wrong block.
    const file = ["f {", "  a", "  b", "}", "f {", "  x", "  y", "}"].join("\n")
    const candidates = Replace.candidatesOf(
      "block-anchor",
      file,
      ["f {", "  a", "  b2", "}"].join("\n")
    )
    assert.strictEqual(candidates.length, 1)
    assert.include(candidates[0] ?? "", "  a")
  })
})

describe("line endings", () => {
  it("detects the dominant ending, not merely the first", () => {
    assert.strictEqual(LineEndings.detect("a\r\nb\r\nc\nd\r\n"), "\r\n")
    assert.strictEqual(LineEndings.detect("a\nb\nc\r\nd\n"), "\n")
    assert.strictEqual(LineEndings.detect("no newlines"), "\n")
  })

  it("converts without doubling text that already uses the ending", () => {
    assert.strictEqual(LineEndings.convert("a\r\nb", "\r\n"), "a\r\nb")
    assert.strictEqual(LineEndings.convert("a\nb", "\r\n"), "a\r\nb")
    assert.strictEqual(LineEndings.convert("a\r\nb", "\n"), "a\nb")
  })

  it("an LF-quoted edit applies to a CRLF file, which stays CRLF", () => {
    const file = "one\r\ntwo\r\nthree\r\n"
    const newline = LineEndings.detect(file)
    const out = replaced(file, LineEndings.convert("two", newline), LineEndings.convert("2", newline))
    assert.strictEqual(out.content, "one\r\n2\r\nthree\r\n")
    // No bare LF survived anywhere.
    assert.notInclude(out.content.replace(/\r\n/g, ""), "\n")
  })

  it("a multi-line LF-quoted edit converts to the file's CRLF", () => {
    const file = "a\r\nb\r\nc\r\n"
    const newline = LineEndings.detect(file)
    const out = replaced(
      file,
      LineEndings.convert("a\nb", newline),
      LineEndings.convert("x\ny", newline)
    )
    assert.strictEqual(out.content, "x\r\ny\r\nc\r\n")
  })

  it("a BOM is left exactly where it is", () => {
    const file = `${LineEndings.BOM}const x = 1`
    assert.isTrue(LineEndings.hasBom(file))
    const out = replaced(file, "const x = 1", "const x = 2")
    assert.isTrue(LineEndings.hasBom(out.content))
    assert.strictEqual(out.content, `${LineEndings.BOM}const x = 2`)
  })

  it("a file with mixed endings keeps every one it had outside the span", () => {
    // The dominant ending is CRLF; the stray LF on line 3 must survive, which
    // is what normalising the search strings rather than the file buys.
    const file = "a\r\nb\r\nc\nd\r\n"
    const newline = LineEndings.detect(file)
    const out = replaced(file, LineEndings.convert("b", newline), LineEndings.convert("B", newline))
    assert.strictEqual(out.content, "a\r\nB\r\nc\nd\r\n")
  })
})
