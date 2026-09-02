import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `docs/guide-code-mode.md` states the interpreter's boundary as a
 * list of confinements, each cited from the test that pins it. A citation
 * that names a test which no longer exists is a claim nobody checks, so
 * this reads the list and looks each name up in the file it cites.
 *
 * The format is fixed on purpose: `- \`test/<File>.test.ts\`: "<name>"`.
 * Broken once by editing a cited name in the guide; it failed.
 */

const root = join(import.meta.dirname, "..")

const citations = (): ReadonlyArray<{ readonly file: string; readonly name: string }> => {
  const guide = readFileSync(join(root, "docs/guide-code-mode.md"), "utf8").replace(/\r\n/g, "\n")
  const start = guide.indexOf("## What the boundary is")
  const end = guide.indexOf("## A read-only code mode")
  assert.isAbove(start, -1, "the guide has the boundary section")
  assert.isAbove(end, start, "the boundary section ends where the recipe begins")
  const section = guide.slice(start, end)
  const found: Array<{ file: string; name: string }> = []
  for (const match of section.matchAll(/^- `(test\/[A-Za-z]+\.test\.ts)`: "([^"]+)"$/gm)) {
    found.push({ file: match[1]!, name: match[2]! })
  }
  return found
}

describe("the code-mode boundary", () => {
  it("cites tests, and every one exists where it says", () => {
    const cited = citations()
    assert.isAbove(cited.length, 8, "the section lists its confinements")
    for (const { file, name } of cited) {
      const source = readFileSync(join(root, file), "utf8")
      assert.include(source, JSON.stringify(name), `${file} has no test named ${name}`)
    }
  })

  it("cites at least the interpreter, the hardening pass and the host API", () => {
    const files = new Set(citations().map((c) => c.file))
    assert.isTrue(files.has("test/CodeInterpret.test.ts"))
    assert.isTrue(files.has("test/CodeHardening.test.ts"))
    assert.isTrue(files.has("test/CodeMode.test.ts"))
  })
})
