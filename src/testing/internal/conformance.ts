import { Cause, Effect, Exit } from "effect"

/**
 * What the shipped conformance suites share.
 *
 * Each suite is a list of named Effects that fail with the suite's own
 * tagged `Failure` -- framework-agnostic, because `@effect/vitest` is a
 * development dependency of this package and must not be imported from
 * `/testing`. A test runner wires the cases with one line each; `report`
 * runs them all and says which held. What this module holds is the two
 * things every suite would otherwise re-derive: structural equality for the
 * assertions, and the run-everything-and-report loop.
 */

export interface Report {
  readonly passed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<{ readonly name: string; readonly detail: string }>
}

/**
 * Run every case and report. Never fails: a failing case is a line in the
 * report, and a defect is reported as the case's failure too. `detail` is
 * read off the suite's `Failure`; any other error is shown as pretty-printed
 * cause, so a store that fails with its own `StorageError` still names it.
 */
export const report = <E, R>(
  cases: ReadonlyArray<{ readonly name: string; readonly run: Effect.Effect<void, E, R> }>
): Effect.Effect<Report, never, R> =>
  Effect.gen(function* () {
    const passed: Array<string> = []
    const failed: Array<{ name: string; detail: string }> = []
    for (const entry of cases) {
      const exit = yield* Effect.exit(entry.run)
      if (Exit.isSuccess(exit)) {
        passed.push(entry.name)
      } else {
        failed.push({ name: entry.name, detail: describeCause(exit.cause) })
      }
    }
    return { passed, failed }
  })

const describeCause = (cause: Cause.Cause<unknown>): string => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") {
      const error = reason.error
      if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") {
        return error.detail
      }
      return `failed: ${show(error)}`
    }
  }
  return `defect: ${Cause.pretty(cause)}`
}

/** A readable rendering of a value for a failure's `detail`. */
export const show = (value: unknown): string => {
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "bigint") return `${value}n`
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/**
 * Structural equality for what the suites compare: primitives, arrays,
 * byte arrays, dates, and plain objects by their own enumerable properties
 * -- which covers `Option`, tagged structs and encoded prompts. Functions
 * compare by identity, since two handlers are never "the same value".
 */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

/**
 * The assertion vocabulary a suite builds over its own `Failure`: `fail`
 * makes one for a case, and the rest are the checks every case is written
 * in. Returned as functions of the case name so a failure always says which
 * case it was.
 */
export const checks = <F>(fail: (name: string, detail: string) => F) => {
  const that = (name: string) => (condition: boolean, detail: string): Effect.Effect<void, F> =>
    condition ? Effect.void : Effect.fail(fail(name, detail))
  const equal = (name: string) => (actual: unknown, expected: unknown, what: string): Effect.Effect<void, F> =>
    deepEqual(actual, expected)
      ? Effect.void
      : Effect.fail(fail(name, `${what}: expected ${show(expected)}, got ${show(actual)}`))
  /**
   * The error an effect is expected to fail with. Unlike `Effect.flip`, an
   * unexpected success is the case's failure rather than the success value
   * wearing the error channel.
   */
  const failureOf = (name: string) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<E, F, R> =>
    Effect.matchEffect(effect, {
      onSuccess: (value) => Effect.fail(fail(name, `expected a failure, got ${show(value)}`)),
      onFailure: (error) => Effect.succeed(error)
    })
  return { that, equal, failureOf }
}
