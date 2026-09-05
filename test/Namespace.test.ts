import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import * as Namespace from "../src/internal/namespace.js"

/**
 * Decision 1 of `docs/plan-two-decisions.md`: the package's wire-level and
 * storage-level identifiers are frozen, spelled in one module, and will not
 * follow a rename. Two checks, because they catch different things:
 *
 * - **value**: every identifier the code builds through `Namespace` is in
 *   `test/fixtures/namespace-manifest.json`, and every manifest entry is
 *   built somewhere. The manifest's values are written out as strings and
 *   do not derive from the constants, so editing `NAMESPACE` fails here
 *   even though every call site would still compile;
 * - **location**: no literal `"affe-agent/`, `"affe_<table>"` or
 *   `"affe-agent:` remains in `src` outside the one module, so an
 *   identifier cannot creep back as a string the manifest never sees.
 *
 * Both are done by reading the source, which is the point: the manifest is
 * independent of the code under test, and a grep is independent of the type
 * system.
 */

const SRC = join(import.meta.dirname, "..", "src")
const NAMESPACE_MODULE = join(SRC, "internal", "namespace.ts")

const sources = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []
  )

/** Code lines only: a doc comment may name an identifier in prose. */
const codeLines = (file: string): Array<string> =>
  readFileSync(file, "utf8").split("\n").filter((line) => {
    const stripped = line.trimStart()
    return !(stripped.startsWith("*") || stripped.startsWith("//") || stripped.startsWith("/**"))
  })

const manifest: ReadonlyArray<string> = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "namespace-manifest.json"), "utf8"))
)

describe("the frozen namespace", () => {
  it("every identifier the code builds is in the manifest, and every manifest entry is built", () => {
    const built = new Set<string>()
    const call = /Namespace\.(tag|table|keyPrefix)\((["`])([^"`]+)\2\)/g
    for (const file of sources(SRC)) {
      if (file === NAMESPACE_MODULE) continue
      for (const line of codeLines(file)) {
        for (const match of line.matchAll(call)) {
          const [, kind, , name] = match
          // An interpolated name (`elicitation/${id}`) is a family, not an entry.
          if (name!.includes("${")) continue
          built.add(kind === "tag" ? Namespace.tag(name!) : kind === "table" ? Namespace.table(name!) : Namespace.keyPrefix(name!))
        }
      }
    }
    const expected = new Set(manifest)
    const missingFromManifest = [...built].filter((id) => !expected.has(id)).sort()
    const noLongerBuilt = [...expected].filter((id) => !built.has(id)).sort()
    assert.deepStrictEqual(missingFromManifest, [], "identifiers built but not in the manifest: add them, this is a new wire or storage name")
    assert.deepStrictEqual(noLongerBuilt, [], "manifest entries nothing builds any more: a name changed or went, which is a wire or storage change")
    assert.isAbove(built.size, 100)
  })

  it("no identifier is spelled as a literal outside the one module", () => {
    const literal = /["`]affe-agent\/|"affe_[a-z_]+"|"affe-agent:/
    const offenders: Array<string> = []
    for (const file of sources(SRC)) {
      if (file === NAMESPACE_MODULE) continue
      codeLines(file).forEach((line) => {
        // The sandbox's default workspace directory is a local path, not an identifier.
        if (literal.test(line) && !line.includes("/tmp/affe-agent/")) offenders.push(`${relative(SRC, file)}: ${line.trim()}`)
      })
    }
    assert.deepStrictEqual(offenders, [])
  })

  it("the roots are the frozen values, and a built identifier keeps its literal type", () => {
    // Written as strings on purpose: these are the protocol, not the package name.
    assert.strictEqual(Namespace.NAMESPACE, "affe-agent")
    assert.strictEqual(Namespace.TABLE_PREFIX, "affe_")
    assert.strictEqual(Namespace.tag("relay/RelaySupersededError"), "affe-agent/relay/RelaySupersededError")
    assert.strictEqual(Namespace.table("session"), "affe_session")
    assert.strictEqual(Namespace.keyPrefix("compaction"), "affe-agent:compaction:")
    // Literal, so a `Schema.TaggedError` built from it keeps a literal `_tag`
    // and `catchTag` narrows. Break by widening `tag`'s return to `string`.
    const t = Namespace.tag("x/Y")
    type Assert<T extends true> = T
    type _Literal = Assert<typeof t extends "affe-agent/x/Y" ? ("affe-agent/x/Y" extends typeof t ? true : false) : false>
    assert.isTrue(manifest.includes("affe-agent/relay/RelaySupersededError"))
  })
})
