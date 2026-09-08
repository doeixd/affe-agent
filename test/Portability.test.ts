import { assert, describe, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * The portability guardrail is itself code, and a guardrail with false
 * negatives is worse than none: it would certify coupling it did not see.
 * These fixtures pin what it must catch and what it must leave alone.
 */

const scan = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-portability-"))
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    try {
      const output = execFileSync(
        process.execPath,
        [path.join(process.cwd(), "scripts", "verify-portability.mjs"), dir],
        { encoding: "utf8", stdio: "pipe" }
      )
      return { ok: true as const, output }
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      return { ok: false as const, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("verify-portability", () => {
  it("catches every form of host coupling", () => {
    const result = scan({
      "a.ts": `import * as fs from "node:fs"\nexport const x = fs`,
      "b.ts": `import { spawn } from "child_process"\nexport const y = spawn`,
      "c.ts": `import { NodeHttpServer } from "@effect/platform-node"\nexport const z = NodeHttpServer`,
      "d.ts": `export const home = process.env.HOME`,
      "e.ts": `export const b = Buffer.from("x")`,
      "f.ts": `const m = require("fs")\nexport const g = m`,
      "g.ts": `export const here = __dirname`,
      "h.ts": `export const lazy = () => import("node:path")`,
      "i.ts": `import type { Stats } from "node:fs"\nexport type S = Stats`
    })
    assert.isFalse(result.ok)
    for (const expected of [
      'a.ts: imports Node built-in "node:fs"',
      'b.ts: imports Node built-in "child_process"',
      'c.ts: imports host package "@effect/platform-node"',
      'd.ts: uses host global "process.env"',
      'e.ts: uses host global "Buffer"',
      'f.ts: uses host global "require("',
      'g.ts: uses host global "__dirname"',
      'h.ts: imports Node built-in "node:path"',
      // A type-only import still puts Node's types in the declarations a
      // consumer compiles against.
      'i.ts: imports Node built-in "node:fs"'
    ]) {
      assert.include(result.output, expected)
    }
  })

  it("leaves portable code alone", () => {
    const result = scan({
      "ok.ts": [
        `import { Effect } from "effect"`,
        `import { SqlClient } from "effect/unstable/sql"`,
        `// process.env is fine to mention in a comment, as is require("x")`,
        `/* and Buffer in a block comment */`,
        `export const id = globalThis.crypto.randomUUID()`,
        `export const bytes = new TextEncoder().encode("x")`,
        `export const url = "https://example.com//path"`,
        `export const subprocess = { exec: 1 }`,
        `export const ab: ArrayBuffer = new ArrayBuffer(1)`,
        `export const preprocess = (x: string) => x`,
        `export const n = SqlClient`,
        `export const e = Effect.void`
      ].join("\n"),
      // Declared host modules are exempt.
      "sandbox/local.ts": `import * as fs from "node:fs"\nexport const x = process.platform`
    })
    assert.isTrue(result.ok, result.output)
  })

  it("does not let a comment hide a violation on the same line", () => {
    const result = scan({
      "x.ts": `export const p = process.platform // not really a comment`
    })
    assert.isFalse(result.ok)
    assert.include(result.output, 'uses host global "process.platform"')
  })

  it("rejects side-effect imports and deferred bracket access to globals", () => {
    const result = scan({
      "side-effect.ts": `import "node:fs"; export const x = 1`,
      "host.ts": `import "@effect/platform-node"`,
      "deferred.ts": `export const platform = () => process["platform"]`,
      "type.ts": `export type S = import("node:fs").Stats`,
      "reexport.ts": `export * from "node:path"`
    })
    assert.isFalse(result.ok)
    for (const expected of [
      'side-effect.ts: imports Node built-in "node:fs"',
      'host.ts: imports host package "@effect/platform-node"',
      'deferred.ts: uses host global "process["platform"]"',
      'type.ts: imports Node built-in "node:fs"',
      'reexport.ts: imports Node built-in "node:path"'
    ]) assert.include(result.output, expected)
  })

  it("does not mistake strings, property names or local bindings for host globals", () => {
    const result = scan({
      "safe.ts": [
        `export const text = 'process.env Buffer require("fs")'`,
        `export const example = 'import "node:fs"'`,
        `export const pattern = /process.platform/`,
        `export const fields = { process: "safe", Buffer: "text" }`,
        `export const value = fields.process`,
        `export const local = (process: { platform: string }) => process["platform"]`
      ].join("\n")
    })
    assert.isTrue(result.ok, result.output)
  })
})
