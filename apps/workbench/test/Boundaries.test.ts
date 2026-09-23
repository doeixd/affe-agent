/**
 * W0 acceptance 8, and the repository-shape rule: the UI-neutral layers name
 * no UI library, and nothing in the workbench reaches past `affe-agent`'s
 * published subpaths into engine internals.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"

const src = fileURLToPath(new URL("../src", import.meta.url))

const files = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []
  )

const importsOf = (file: string): ReadonlyArray<string> =>
  // Static imports and re-exports with or without `from` (a bare `import "x"`
  // loads a module too), and dynamic `import("x")`.
  [
    ...readFileSync(file, "utf8").matchAll(
      /^\s*(?:import|export)\b(?:[^"';]*?\bfrom)?\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm
    )
  ].map((match) => match[1] ?? match[2] ?? "")

const neutral = ["domain", "store", "runtime", "protocol", "client", "ui-core"]

describe("workbench boundaries", () => {
  it("finds the modules it polices", () => {
    // A glob that matched nothing would make both rules below vacuous.
    assert.isAtLeast(files(src).length, 7)
  })

  it("UI-neutral layers import no UI library", () => {
    const offending = files(src)
      .filter((file) => neutral.includes(relative(src, file).split(/[\\/]/)[0] ?? ""))
      .flatMap((file) =>
        importsOf(file)
          .filter((specifier) => /^(react|react-dom|@assistant-ui\/|solid-js|@opentui\/)/.test(specifier))
          .map((specifier) => `${relative(src, file)} -> ${specifier}`)
      )
    assert.deepStrictEqual(offending, [])
  })

  it("the assistant-ui adapter is deletable: nothing outside it imports it or assistant-ui", () => {
    const adapter = join(src, "assistant-ui")
    const outside = files(src).filter((file) => !file.startsWith(adapter))
    const offending = outside.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.includes("assistant-ui/"))
        .map((specifier) => `${relative(src, file)} -> ${specifier}`)
    )
    assert.deepStrictEqual(offending, [])
    // And the rule polices something: the adapter exists and does import assistant-ui.
    assert.isTrue(files(adapter).some((file) => importsOf(file).some((specifier) => specifier.startsWith("@assistant-ui/"))))
  })

  it("reaches affe-agent only through its published subpaths", () => {
    const offending = files(src).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => /(^|\/)src\//.test(specifier) || /^\.\.\/\.\.\/\.\./.test(specifier))
        .map((specifier) => `${relative(src, file)} -> ${specifier}`)
    )
    assert.deepStrictEqual(offending, [])
  })
})
