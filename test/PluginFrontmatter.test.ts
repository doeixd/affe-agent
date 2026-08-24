import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import * as Frontmatter from "../src/plugins/internal/frontmatter.js"

/**
 * The SKILL.md frontmatter parser. Total and dependency-free: it accepts the
 * documented Agent Skills subset (flat scalars + one `metadata` map) and returns
 * `None` for anything without a well-formed fence, which the loader treats as an
 * invalid skill to skip. These pin the parser against that contract.
 */

const get = (text: string): Frontmatter.Frontmatter =>
  Option.match(Frontmatter.parse(text), {
    onNone: () => {
      throw new Error("expected frontmatter to parse")
    },
    onSome: (fm) => fm
  })

describe("Frontmatter.parse", () => {
  it("parses the minimal required fields and the body", () => {
    const fm = get("---\nname: pdf-processing\ndescription: Handle PDFs.\n---\n# Instructions\n\nStep 1.")
    assert.strictEqual(fm.fields.name, "pdf-processing")
    assert.strictEqual(fm.fields.description, "Handle PDFs.")
    assert.strictEqual(fm.body, "# Instructions\n\nStep 1.")
    assert.deepStrictEqual(fm.metadata, {})
  })

  it("parses all optional scalar fields and a metadata block", () => {
    const fm = get(
      [
        "---",
        "name: pdf",
        "description: Extract text.",
        "license: Apache-2.0",
        "compatibility: Requires python",
        "allowed-tools: Bash(git:*) Read",
        "metadata:",
        "  author: example-org",
        "  version: \"1.0\"",
        "---",
        "body"
      ].join("\n")
    )
    assert.strictEqual(fm.fields.license, "Apache-2.0")
    assert.strictEqual(fm.fields.compatibility, "Requires python")
    assert.strictEqual(fm.fields["allowed-tools"], "Bash(git:*) Read")
    assert.deepStrictEqual(fm.metadata, { author: "example-org", version: "1.0" })
    assert.strictEqual(fm.body, "body")
  })

  it("strips single and double quotes and keeps colons inside quoted values", () => {
    const fm = get("---\nname: x\ndescription: \"Use when: PDFs, forms\"\nlicense: 'MIT'\n---\n")
    assert.strictEqual(fm.fields.description, "Use when: PDFs, forms")
    assert.strictEqual(fm.fields.license, "MIT")
  })

  it("splits on the first colon only, for unquoted values with colons", () => {
    const fm = get("---\nname: x\ndescription: a: b: c\n---\n")
    assert.strictEqual(fm.fields.description, "a: b: c")
  })

  it("ends the metadata block at the next unindented key", () => {
    const fm = get("---\nname: x\nmetadata:\n  k: v\ndescription: after\n---\n")
    assert.deepStrictEqual(fm.metadata, { k: "v" })
    assert.strictEqual(fm.fields.description, "after")
  })

  it("ignores blank lines and comments in the block", () => {
    const fm = get("---\n\n# a comment\nname: x\n\ndescription: y\n---\n")
    assert.strictEqual(fm.fields.name, "x")
    assert.strictEqual(fm.fields.description, "y")
  })

  it("handles CRLF line endings and a leading BOM", () => {
    const fm = get("﻿---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\nmore")
    assert.strictEqual(fm.fields.name, "x")
    assert.strictEqual(fm.body, "body\nmore")
  })

  it("returns None when there is no opening fence", () => {
    assert.isTrue(Option.isNone(Frontmatter.parse("name: x\ndescription: y\n")))
    assert.isTrue(Option.isNone(Frontmatter.parse("# just markdown\n")))
    assert.isTrue(Option.isNone(Frontmatter.parse("")))
  })

  it("returns None when the fence is never closed", () => {
    assert.isTrue(Option.isNone(Frontmatter.parse("---\nname: x\ndescription: y\n")))
  })

  it("treats an empty frontmatter block as parsed with no fields", () => {
    const fm = get("---\n---\nbody")
    assert.deepStrictEqual(fm.fields, {})
    assert.strictEqual(fm.body, "body")
  })
})
