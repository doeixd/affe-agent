import { assert, describe, it } from "@effect/vitest"
import { Tool } from "effect/unstable/ai"
import { CodingToolkit } from "../src/coding/index.js"
import * as Prompts from "../src/coding/internal/prompts.js"
import * as ReadFormat from "../src/coding/internal/readFormat.js"
import * as SearchFormat from "../src/coding/internal/searchFormat.js"
import * as Truncate from "../src/coding/internal/truncate.js"

/**
 * The descriptions a model reads must agree with the code that enforces them.
 *
 * A prompt quoting "2000 lines" while the reader stops at 4000 is worse than a
 * prompt saying nothing, because the model plans around the number it was
 * given. These tests make that drift impossible to merge: every limit named in
 * prose has to be a value some constant currently holds.
 */

/** Every run of digits in a string, as numbers. */
const numbersIn = (text: string): ReadonlyArray<number> =>
  [...text.matchAll(/\d+/g)].map((match) => Number(match[0]))

/** The byte figure quoted by the read cap's label, e.g. 50 from "50 KB". */
const labelNumber = Number(ReadFormat.MAX_BYTES_LABEL.replace(/\D/g, ""))

describe("tool descriptions: every tool has one", () => {
  for (const tool of CodingToolkit.tools) {
    it(`${tool.name} is described`, () => {
      const description = Tool.getDescription(tool)
      assert.isString(description)
      assert.isAbove((description ?? "").length, 80)
    })
  }
})

describe("tool descriptions: quoted limits are real constants", () => {
  /**
   * What each description is allowed to contain a number for. Anything else is
   * a literal someone typed, which is exactly the drift being guarded against.
   *
   * Incidental numbers are listed explicitly rather than waved through, so
   * adding one is a decision rather than an accident.
   */
  const allowed: ReadonlyArray<readonly [name: string, text: string, numbers: ReadonlyArray<number>]> = [
    [
      "read_file",
      Prompts.READ_FILE,
      [
        ReadFormat.DEFAULT_LIMIT,
        ReadFormat.MAX_LINE_LENGTH,
        labelNumber,
        1 // "(1-indexed)"
      ]
    ],
    ["write_file", Prompts.WRITE_FILE, []],
    ["edit_file", Prompts.EDIT_FILE, []],
    ["list_files", Prompts.LIST_FILES, []],
    ["search", Prompts.SEARCH, [SearchFormat.SEARCH_LIMIT]],
    ["shell", Prompts.shell("Bash"), [Truncate.MAX_LINES, Truncate.MAX_BYTES]]
  ]

  for (const [name, text, numbers] of allowed) {
    it(`${name} quotes no number that is not a constant`, () => {
      const permitted = new Set(numbers)
      for (const found of numbersIn(text)) {
        assert.isTrue(
          permitted.has(found),
          `${name} description mentions ${found}, which is not one of its constants ` +
            `(${[...permitted].join(", ")}). Interpolate the constant instead of typing the number.`
        )
      }
    })
  }
})

describe("tool descriptions: the limits that matter are actually stated", () => {
  it("read_file states its line, byte and line-length caps", () => {
    assert.include(Prompts.READ_FILE, String(ReadFormat.DEFAULT_LIMIT))
    assert.include(Prompts.READ_FILE, ReadFormat.MAX_BYTES_LABEL)
    assert.include(Prompts.READ_FILE, String(ReadFormat.MAX_LINE_LENGTH))
  })

  it("search states its result limit", () => {
    assert.include(Prompts.SEARCH, String(SearchFormat.SEARCH_LIMIT))
  })

  it("shell states its output caps and where full output is kept", () => {
    assert.include(Prompts.shell("Bash"), String(Truncate.MAX_LINES))
    assert.include(Prompts.shell("Bash"), String(Truncate.MAX_BYTES))
    assert.include(Prompts.shell("Bash"), Truncate.OUTPUT_DIR)
  })

  it("shell names the configured dialect first, and claims no other", () => {
    // The first sentence is the one a model reads before choosing syntax.
    assert.match(Prompts.shell("Bash"), /^Run a command in the workspace using Bash\./)
    const pwsh = Prompts.shell("PowerShell 7 (pwsh)")
    assert.match(pwsh, /^Run a command in the workspace using PowerShell 7 \(pwsh\)\./)
    assert.notInclude(pwsh, "with bash")
    assert.notInclude(pwsh, "Bash")
    // The shared remainder is dialect-neutral: identical for every shell.
    const tail = (text: string) => text.slice(text.indexOf("\n"))
    assert.strictEqual(tail(pwsh), tail(Prompts.shell("Bash")))
  })

  it("the read and edit descriptions agree on the line-number prefix", () => {
    // One contract split across two tools: read_file adds the prefix, and
    // edit_file fails confusingly if the model copies it back in. Both must
    // say so, or the rule is only half-taught.
    assert.include(Prompts.READ_FILE, "<line>: <content>")
    assert.include(Prompts.READ_FILE, "old_string")
    assert.include(Prompts.EDIT_FILE, "<line>: ")
    assert.include(Prompts.EDIT_FILE, "never include any part of that prefix")
  })

  it("shell points at the dedicated tools by their real names", () => {
    // A prompt naming a tool that does not exist is worse than no guidance.
    const names = CodingToolkit.tools.map((tool) => tool.name)
    for (const mentioned of ["search", "read_file", "write_file", "edit_file"]) {
      assert.include(names, mentioned)
      assert.include(Prompts.shell("Bash"), `\`${mentioned}\``)
    }
  })
})
