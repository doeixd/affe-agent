import { assert, describe, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `docs/getting-started.md` shows `examples/getting-started.ts`, and the two
 * must not drift: the document is the first thing a reader copies, and the
 * example is what typechecks, runs and carries the inference assertions.
 *
 * The one permitted difference is the import path -- the example reaches
 * the repository's `src/`, the document the published package -- so the
 * comparison rewrites those and nothing else. Broken once by editing a
 * comment in the document alone; it failed.
 */

const root = join(import.meta.dirname, "..")

const imports: ReadonlyArray<readonly [example: string, published: string]> = [
  ['"../src/index.js"', '"@doeixd/effect-agent"'],
  ['"../src/testing/index.js"', '"@doeixd/effect-agent/testing"']
]

/** The example's code, from its first import to just before the assertions. */
const exampleBody = (): string => {
  const source = readFileSync(join(root, "examples/getting-started.ts"), "utf8")
  const start = source.indexOf("import ")
  const end = source.indexOf("// --- Type assertions")
  assert.isAbove(start, -1, "the example starts with an import")
  assert.isAbove(end, start, "the example ends with the assertion block")
  let body = source.slice(start, end).trimEnd()
  for (const [example, published] of imports) {
    assert.include(body, example, `the example imports ${example}`)
    body = body.replaceAll(example, published)
  }
  return body
}

/** The document's first TypeScript block. */
const documentBlock = (): string => {
  const source = readFileSync(join(root, "docs/getting-started.md"), "utf8")
  const match = /```ts\n([\s\S]*?)```/.exec(source)
  assert.isNotNull(match, "the document has a TypeScript block")
  return match![1]!.trimEnd()
}

describe("getting started", () => {
  it("shows the example verbatim, with the published imports", () => {
    assert.strictEqual(documentBlock(), exampleBody())
  })
})
