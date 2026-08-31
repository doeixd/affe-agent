import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"
import { DataViolation, toData } from "../src/code/internal/data.js"

/**
 * The plain-data boundary (`plan-code-mode-engine.md` step 2): what
 * crosses between host and program crosses as plain data or is refused
 * with the fix named -- never serialised into nonsense.
 */

const ok = (value: unknown, options?: Parameters<typeof toData>[1]): unknown => {
  const out = toData(value, options)
  if (Result.isFailure(out)) {
    assert.fail(`expected data, got: ${out.failure.message}`)
  }
  return out.success
}

const refused = (value: unknown, options?: Parameters<typeof toData>[1]): DataViolation => {
  const out = toData(value, options)
  if (Result.isSuccess(out)) {
    assert.fail(`expected a violation, got data: ${JSON.stringify(out.success)}`)
  }
  return out.failure
}

describe("toData", () => {
  it("plain data crosses rebuilt, with JSON semantics for undefined", () => {
    assert.deepStrictEqual(
      ok({ a: 1, b: "x", c: [true, undefined, null], d: undefined }),
      { a: 1, b: "x", c: [true, null, null] }
    )
    // Rebuilt, not shared: mutating the copy cannot reach the original.
    const original = { nested: { n: 1 } }
    const crossed = ok(original)
    assert.notStrictEqual(crossed, original)
    assert.notStrictEqual((crossed as { nested: object }).nested, original.nested)
    assert.deepStrictEqual(crossed, original)
    // A root undefined is null, data's closest honest value.
    assert.strictEqual(ok(undefined), null)
  })

  it("Date and URL serialise; Uint8Array crosses as a copy", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const crossed = ok({
      at: new Date("2026-08-31T00:00:00.000Z"),
      href: new URL("https://example.com/x?y=1"),
      bytes
    }) as { at: string; href: string; bytes: Uint8Array }
    assert.strictEqual(crossed.at, "2026-08-31T00:00:00.000Z")
    assert.strictEqual(crossed.href, "https://example.com/x?y=1")
    assert.deepStrictEqual(crossed.bytes, bytes)
    assert.notStrictEqual(crossed.bytes, bytes)
  })

  it("prototype-reaching keys are dropped, and foreign prototypes never cross", () => {
    const hostile: Record<string, unknown> = { safe: 1 }
    Object.defineProperty(hostile, "__proto__", {
      value: { polluted: true },
      enumerable: true
    })
    hostile["constructor"] = "x"
    hostile["prototype"] = "y"
    const crossed = ok(hostile) as Record<string, unknown>
    assert.deepStrictEqual(Object.keys(crossed), ["safe"])
    assert.isUndefined((({} as Record<string, unknown>)["polluted"]))

    class Fancy {
      value = 1
    }
    const violation = refused(new Fancy())
    assert.strictEqual(violation.reason, "unsupported")
    assert.include(violation.fix, "Fancy")
    assert.include(violation.fix, "plain objects")
  })

  it("promises and functions are refused with the fix named, at their path", () => {
    const promise = refused({ result: { pending: Promise.resolve(1) } })
    assert.strictEqual(promise.reason, "promise")
    assert.strictEqual(promise.path, "result.pending")
    assert.include(promise.fix, "await")

    const fn = refused({ items: [() => 1] })
    assert.strictEqual(fn.reason, "function")
    assert.strictEqual(fn.path, "items[0]")
    assert.include(fn.fix, "data, not behaviour")
  })

  it("cycles and the depth bound are refused naming the path", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const cycle = refused(cyclic)
    assert.strictEqual(cycle.reason, "cycle")
    assert.strictEqual(cycle.path, "self")

    // The same object twice is sharing, not a cycle.
    const shared = { n: 1 }
    assert.deepStrictEqual(ok({ a: shared, b: shared }), { a: { n: 1 }, b: { n: 1 } })

    const deep = refused({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2 })
    assert.strictEqual(deep.reason, "too-deep")
    assert.strictEqual(deep.path, "a.b")
    assert.include(deep.fix, "2-level")
  })

  it("maps, sets, symbols and bigints are refused as unsupported", () => {
    assert.strictEqual(refused(new Map()).reason, "unsupported")
    assert.strictEqual(refused(new Set()).reason, "unsupported")
    assert.strictEqual(refused({ id: Symbol("x") }).reason, "unsupported")
    const big = refused({ n: 10n })
    assert.strictEqual(big.reason, "unsupported")
    assert.include(big.fix, "bigint")
  })
})
