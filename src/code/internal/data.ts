import { Result, Schema } from "effect"

/**
 * The plain-data boundary (`docs/plan-code-mode-engine.md` step 2).
 *
 * Everything that crosses between host and program -- tool results in,
 * tool arguments and the final result out -- passes through here. The
 * research calls this the source of silent corruption if deferred, and
 * each rule below is one of those corruptions made impossible:
 *
 * - foreign prototypes never cross (objects are rebuilt);
 * - `__proto__` / `constructor` / `prototype` keys are dropped, so a
 *   crafted value cannot pollute a prototype on either side;
 * - promises never cross (a half-awaited value is refused, with the fix
 *   named, rather than serialised into nonsense);
 * - cycles and unbounded depth are refused naming the path.
 *
 * Refusals are values, not exceptions: the caller decides whether a
 * violation is a diagnostic handed to the model or a defect.
 */

/** Where in the value the violation sits: `result.items[3].next`. */
const renderPath = (path: ReadonlyArray<string | number>): string =>
  path.length === 0
    ? "(root)"
    : path
      .map((segment) =>
        typeof segment === "number"
          ? `[${segment}]`
          : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
          ? `.${segment}`
          : `[${JSON.stringify(segment)}]`
      )
      .join("")
      .replace(/^\./, "")

/**
 * A value that cannot cross, and what to do instead (invariant 6: every
 * diagnostic names the fix).
 */
export class DataViolation extends Schema.TaggedError<DataViolation>()(
  "@doeixd/effect-agent/code/DataViolation",
  {
    reason: Schema.Literals(["promise", "function", "unsupported", "cycle", "too-deep"]),
    path: Schema.String,
    fix: Schema.String
  }
) {
  override get message() {
    return `${this.reason} at ${this.path}: ${this.fix}`
  }
}

export interface ToDataOptions {
  /** How deep a value may nest. A bound, not a budget; default 64. */
  readonly maxDepth?: number | undefined
}

const BLOCKED = new Set(["__proto__", "constructor", "prototype"])

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Convert a value to plain data, or say precisely why it cannot cross.
 *
 * Total over its accepted domain and JSON-shaped on purpose: `undefined`
 * in an array becomes `null`, an `undefined` property is dropped, a
 * `Date` becomes its ISO string, a `URL` its href, a `Uint8Array` a
 * copy. Symbols and non-enumerable members do not cross -- they are not
 * data the other side was meant to see.
 */
export const toData = (
  value: unknown,
  options?: ToDataOptions
): Result.Result<unknown, DataViolation> => {
  const maxDepth = options?.maxDepth ?? 64
  const seen = new Set<object>()

  const refuse = (
    reason: DataViolation["reason"],
    path: ReadonlyArray<string | number>,
    fix: string
  ) => Result.fail(new DataViolation({ reason, path: renderPath(path), fix }))

  const walk = (
    current: unknown,
    path: ReadonlyArray<string | number>,
    depth: number
  ): Result.Result<unknown, DataViolation> => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return Result.succeed(current)
    }
    if (current === undefined) return Result.succeed(undefined)
    if (typeof current === "bigint") {
      return refuse("unsupported", path, "convert the bigint to a number or a string before it crosses")
    }
    if (typeof current === "function") {
      return refuse("function", path, "return data, not behaviour; call the function and return its result")
    }
    if (typeof current === "symbol") {
      return refuse("unsupported", path, "symbols cannot cross; use a string")
    }
    if (typeof current !== "object") {
      return refuse("unsupported", path, `a ${typeof current} cannot cross; use plain data`)
    }

    // Specific shapes before the generic object cases.
    if (current instanceof Promise || (typeof (current as { then?: unknown }).then === "function" && !Array.isArray(current))) {
      return refuse("promise", path, "await it before it crosses; promises never cross the boundary")
    }
    if (current instanceof Date) {
      return Result.succeed(current.toISOString())
    }
    if (current instanceof URL) {
      return Result.succeed(current.href)
    }
    if (current instanceof Uint8Array) {
      return Result.succeed(current.slice())
    }

    if (depth >= maxDepth) {
      return refuse("too-deep", path, `nesting exceeds the ${maxDepth}-level bound; flatten the value`)
    }
    if (seen.has(current)) {
      return refuse("cycle", path, "the value refers to itself; break the cycle before it crosses")
    }

    if (Array.isArray(current)) {
      seen.add(current)
      try {
        const out: Array<unknown> = []
        for (let index = 0; index < current.length; index++) {
          const walked = walk(current[index], [...path, index], depth + 1)
          if (Result.isFailure(walked)) return walked
          // JSON semantics, stated: a hole or undefined entry is null.
          out.push(walked.success === undefined ? null : walked.success)
        }
        return Result.succeed(out)
      } finally {
        seen.delete(current)
      }
    }

    if (!isPlainObject(current)) {
      return refuse(
        "unsupported",
        path,
        `a ${current.constructor?.name ?? "class"} instance cannot cross; use plain objects and arrays`
      )
    }

    seen.add(current)
    try {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(current)) {
        // Prototype pollution is not a value: the three names that reach a
        // prototype are dropped rather than copied, on both directions.
        if (BLOCKED.has(key)) continue
        const walked = walk(
          (current as Record<string, unknown>)[key],
          [...path, key],
          depth + 1
        )
        if (Result.isFailure(walked)) return walked
        // An undefined property is absent, as JSON would have it.
        if (walked.success !== undefined) out[key] = walked.success
      }
      return Result.succeed(out)
    } finally {
      seen.delete(current)
    }
  }

  const walked = walk(value, [], 0)
  if (Result.isFailure(walked)) return walked
  // A root-level undefined is data's closest honest value: null.
  return Result.succeed(walked.success === undefined ? null : walked.success)
}
