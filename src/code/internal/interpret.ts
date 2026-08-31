import type * as acorn from "acorn"
import { Effect, Option, Schema } from "effect"
import { CodeDiagnostic } from "./diagnostics.js"

/**
 * The owned tree-walking interpreter
 * (`docs/plan-code-mode-engine.md` step 4, the §5.4 minimal subset).
 *
 * Effect-based on purpose: every evaluation step is an `Effect`, so host
 * interruption propagates for free, tool calls run on the caller's fibre
 * (a `CurrentPrincipal` provided around `execute` reaches every nested
 * call), and concurrency (`Promise.all`) is `Effect.all` rather than a
 * second scheduler.
 *
 * Two failure channels, kept apart because a program must not be able to
 * swallow the host's refusals:
 *
 * - `ProgramThrow` is the program's own `throw` (and a tool's *declared*
 *   failure surfaced as one where the host chooses). `try`/`catch`
 *   catches it.
 * - `CodeDiagnostic` is the host refusing -- unsupported syntax, a
 *   blocked member, a limit. `try`/`catch` deliberately does not catch
 *   it, and every one names the fix.
 *
 * Security rests on two facts: nothing the program can reach closes over
 * host authority except the `invoke` hook the host supplied, and the
 * three prototype-reaching member names are refused on every access --
 * `x.constructor.constructor` is the classic route from any value to the
 * `Function` evaluator, and it is closed here, not in review.
 */

/** The program threw; the value is the program's own. */
export class ProgramThrow extends Schema.TaggedError<ProgramThrow>()(
  "@doeixd/effect-agent/code/ProgramThrow",
  { value: Schema.Unknown }
) {
  override get message() {
    const value: unknown = this.value
    if (typeof value === "object" && value !== null && "message" in value) {
      const message: unknown = value.message
      if (typeof message === "string") return message
    }
    return typeof value === "string" ? value : JSON.stringify(value)
  }
}

export type ProgramFailure = ProgramThrow | CodeDiagnostic

/**
 * How a value that only exists inside the interpreter should be described
 * to the model, or `undefined` for ordinary data.
 *
 * The runtime holds a few values a program can name but that cannot leave
 * it -- a closure, a tool path, an unawaited call. Without this the data
 * boundary describes them by their class, and "a ProgramFunction instance
 * cannot cross" tells the model about our implementation instead of about
 * its own program.
 */
export const internalKind = (value: unknown): string | undefined => {
  if (value instanceof ProgramFunction) return "a function"
  if (value instanceof ToolPath) return "a tool reference"
  if (value instanceof ProgramPromiseMarker) return "a value it never awaited"
  return undefined
}

/** How the host answers a nested tool call. */
export type Invoke<R = never> = (
  path: ReadonlyArray<string>,
  input: unknown
) => Effect.Effect<unknown, ProgramFailure, R>

export interface InterpretOptions<R = never> {
  readonly invoke: Invoke<R>
  /** Nested program-function call depth. Default 256: a bound, not a budget. */
  readonly maxCallDepth?: number | undefined
}

export interface Interpretation {
  /** What the program returned; `None` when it ran off the end. */
  readonly result: Option.Option<unknown>
  /** Everything `console.log` received, one entry per call. */
  readonly logs: ReadonlyArray<ReadonlyArray<unknown>>
}

// ---------------------------------------------------------------------------
// Runtime values the program can hold that are not plain data
// ---------------------------------------------------------------------------

/** The identity of an unawaited value, stable outside `interpret`. */
class ProgramPromiseMarker {}

/** A closure the program defined. */
class ProgramFunction {
  constructor(
    readonly params: ReadonlyArray<acorn.Pattern>,
    readonly body: acorn.Expression | acorn.BlockStatement,
    readonly env: Env,
    readonly isAsync: boolean
  ) {}
}

/** Member access on this accumulates a tool path; a call invokes it. */
class ToolPath {
  constructor(readonly segments: ReadonlyArray<string>) {}
}

interface Binding {
  value: unknown
  readonly mutable: boolean
}

class Env {
  private readonly bindings = new Map<string, Binding>()
  constructor(private readonly parent: Env | undefined) {}
  child(): Env {
    return new Env(this)
  }
  declare(name: string, value: unknown, mutable: boolean): void {
    this.bindings.set(name, { value, mutable })
  }
  lookup(name: string): Binding | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name)
  }
}

// ---------------------------------------------------------------------------
// Completions: how statements report control flow to their enclosing block
// ---------------------------------------------------------------------------

type Completion =
  | { readonly kind: "normal" }
  | { readonly kind: "return"; readonly value: unknown }
  | { readonly kind: "break" }
  | { readonly kind: "continue" }

const NORMAL: Completion = { kind: "normal" }

const BLOCKED_MEMBERS = new Set(["__proto__", "constructor", "prototype"])

const lineOf = (node: acorn.Node): number | undefined => node.loc?.start.line

const unsupported = (node: acorn.Node, what: string, fix: string) =>
  new CodeDiagnostic({
    reason: "unsupported-syntax",
    ...(lineOf(node) === undefined ? {} : { line: lineOf(node) }),
    fix: `${what} is not supported; ${fix}`
  })

/**
 * What a thrown host value looks like to the program.
 *
 * Plain data with a `message`, never the thrown object itself: an `Error`
 * carries a stack and whatever a host attached to it, and the program is
 * untrusted. The message survives because it is the program's own mistake
 * being described -- `JSON.parse` on malformed text is the case that
 * matters, and "Unexpected token" is exactly what the model needs to fix
 * it. A *handler* defect is different and stays opaque; `CodeMode` makes
 * that one an internal diagnostic before it can reach here.
 */
const thrownValue = (cause: unknown): unknown =>
  cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { message: String(cause) }

const truthy = (value: unknown): boolean => Boolean(value)

/**
 * Run a program.
 *
 * The program is the body of an implicit async function: top-level
 * `return` produces the result, top-level `await` is allowed, and running
 * off the end returns `None`.
 */
export const interpret = <R = never>(
  program: acorn.Program,
  options: InterpretOptions<R>
): Effect.Effect<Interpretation, ProgramFailure, R> =>
  Effect.gen(function*() {
    /**
     * A not-yet-awaited value: what a tool call or an async arrow returns.
     * Declared here so its effect can carry the hook requirement `R`, over
     * a module-scope base so `internalKind` can recognise one from outside.
     */
    class ProgramPromise extends ProgramPromiseMarker {
      constructor(readonly effect: Effect.Effect<unknown, ProgramFailure, R>) {
        super()
      }
    }
    const logs: Array<ReadonlyArray<unknown>> = []
    const maxCallDepth = options.maxCallDepth ?? 256
    let callDepth = 0

    const root = new Env(undefined)
    root.declare("tools", new ToolPath([]), false)
    root.declare("undefined", undefined, false)
    root.declare("console", {
      log: (...values: ReadonlyArray<unknown>) => {
        logs.push(values)
        return undefined
      }
    }, false)
    root.declare("JSON", {
      stringify: (value: unknown, _replacer?: unknown, space?: string | number) =>
        JSON.stringify(value, undefined, space),
      parse: (text: string) => JSON.parse(text) as unknown
    }, false)
    root.declare("Math", Math, false)
    root.declare("Object", {
      keys: (value: object) => Object.keys(value),
      values: (value: object) => Object.values(value),
      entries: (value: object) => Object.entries(value),
      fromEntries: (pairs: Iterable<readonly [PropertyKey, unknown]>) => Object.fromEntries(pairs)
    }, false)
    root.declare("Array", { isArray: (value: unknown) => Array.isArray(value) }, false)
    root.declare("Number", (value: unknown) => Number(value), false)
    root.declare("String", (value: unknown) => String(value), false)
    root.declare("Boolean", (value: unknown) => Boolean(value), false)
    // `Promise` is a namespace here, never a constructor: programs get
    // promises only from tool calls and async arrows.
    root.declare("Promise", "__promise_namespace__", false)

    const settle = (value: unknown): Effect.Effect<unknown, ProgramFailure, R> =>
      value instanceof ProgramPromise ? value.effect : Effect.succeed(value)

    /** Call a program-defined closure. */
    const callProgramFunction = (
      fn: ProgramFunction,
      args: ReadonlyArray<unknown>,
      site: acorn.Node
    ): Effect.Effect<unknown, ProgramFailure, R> =>
      Effect.gen(function*() {
        if (callDepth >= maxCallDepth) {
          return yield* new CodeDiagnostic({
            reason: "call-depth",
            ...(lineOf(site) === undefined ? {} : { line: lineOf(site) }),
            fix: `function calls nest deeper than ${maxCallDepth}; use iteration instead of recursion`
          })
        }
        const env = fn.env.child()
        for (let index = 0; index < fn.params.length; index++) {
          yield* bindPattern(fn.params[index]!, args[index], env, true)
        }
        callDepth += 1
        try {
          if (fn.body.type === "BlockStatement") {
            const completion = yield* runBlock(fn.body, env)
            return completion.kind === "return" ? completion.value : undefined
          }
          return yield* evaluate(fn.body, env)
        } finally {
          callDepth -= 1
        }
      })

    /** A program function as a host-callable, for interpreter-provided HOFs. */
    const asCallable = (
      value: unknown,
      site: acorn.Node
    ): ((...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, ProgramFailure, R>) => {
      if (value instanceof ProgramFunction) {
        return (...args) => callProgramFunction(value, args, site)
      }
      if (typeof value === "function") {
        return (...args) =>
          Effect.try({
            try: () => (value as (...inner: ReadonlyArray<unknown>) => unknown)(...args),
            catch: (cause) => new ProgramThrow({ value: thrownValue(cause) })
          })
      }
      return () =>
        Effect.fail(
          new CodeDiagnostic({
            reason: "not-callable",
            ...(lineOf(site) === undefined ? {} : { line: lineOf(site) }),
            fix: "this callback is not a function; pass an arrow function"
          })
        )
    }

    /**
     * Higher-order array methods run inside the interpreter, because a
     * program's arrow cannot be handed to the native method: the arrow's
     * body is an Effect, and a native `map` cannot await it.
     */
    const arrayHof = (
      array: ReadonlyArray<unknown>,
      method: string,
      args: ReadonlyArray<unknown>,
      site: acorn.Node
    ): Effect.Effect<unknown, ProgramFailure, R> | undefined => {
      const callback = args[0]
      if (!(callback instanceof ProgramFunction)) return undefined
      const call = asCallable(callback, site)
      switch (method) {
        case "map":
          return Effect.gen(function*() {
            const out: Array<unknown> = []
            for (let index = 0; index < array.length; index++) {
              out.push(yield* call(array[index], index))
            }
            return out
          })
        case "filter":
          return Effect.gen(function*() {
            const out: Array<unknown> = []
            for (let index = 0; index < array.length; index++) {
              if (truthy(yield* call(array[index], index))) out.push(array[index])
            }
            return out
          })
        case "find":
          return Effect.gen(function*() {
            for (let index = 0; index < array.length; index++) {
              if (truthy(yield* call(array[index], index))) return array[index]
            }
            return undefined
          })
        case "some":
          return Effect.gen(function*() {
            for (let index = 0; index < array.length; index++) {
              if (truthy(yield* call(array[index], index))) return true
            }
            return false
          })
        case "every":
          return Effect.gen(function*() {
            for (let index = 0; index < array.length; index++) {
              if (!truthy(yield* call(array[index], index))) return false
            }
            return true
          })
        case "forEach":
          return Effect.gen(function*() {
            for (let index = 0; index < array.length; index++) {
              yield* call(array[index], index)
            }
            return undefined
          })
        case "reduce":
          return Effect.gen(function*() {
            let accumulator = args.length > 1 ? args[1] : array[0]
            for (let index = args.length > 1 ? 0 : 1; index < array.length; index++) {
              accumulator = yield* call(accumulator, array[index], index)
            }
            return accumulator
          })
        default:
          return undefined
      }
    }

    const readMember = (
      object: unknown,
      key: string,
      node: acorn.Node
    ): Effect.Effect<unknown, ProgramFailure, R> =>
      Effect.gen(function*() {
        if (BLOCKED_MEMBERS.has(key)) {
          return yield* new CodeDiagnostic({
            reason: "blocked-member",
            ...(lineOf(node) === undefined ? {} : { line: lineOf(node) }),
            fix: `"${key}" is not accessible; work with plain values`
          })
        }
        if (object instanceof ToolPath) {
          return new ToolPath([...object.segments, key])
        }
        if (object === null || object === undefined) {
          return yield* new ProgramThrow({
            value: { message: `cannot read "${key}" of ${String(object)}` }
          })
        }
        if (typeof object === "string" || Array.isArray(object)) {
          const member: unknown = Reflect.get(Object(object), key)
          return typeof member === "function" ? member.bind(object) : member
        }
        if (typeof object === "object") {
          if (!Object.prototype.hasOwnProperty.call(object, key)) {
            // Inherited members of plain data are the prototype's, not the
            // program's; absent is the honest answer.
            return undefined
          }
          return (object as Record<string, unknown>)[key]
        }
        if (typeof object === "number" || typeof object === "boolean") {
          const member: unknown = Reflect.get(Object(object), key)
          return typeof member === "function" ? member.bind(object) : member
        }
        return undefined
      })

    const bindPattern = (
      pattern: acorn.Pattern,
      value: unknown,
      env: Env,
      mutable: boolean
    ): Effect.Effect<void, ProgramFailure, R> =>
      Effect.gen(function*() {
        switch (pattern.type) {
          case "Identifier": {
            env.declare(pattern.name, value, mutable)
            return
          }
          case "ArrayPattern": {
            if (!Array.isArray(value)) {
              return yield* new ProgramThrow({
                value: { message: "cannot destructure a non-array as an array" }
              })
            }
            for (let index = 0; index < pattern.elements.length; index++) {
              const element = pattern.elements[index]
              if (element === null || element === undefined) continue
              if (element.type === "RestElement") {
                yield* bindPattern(element.argument, value.slice(index), env, mutable)
                return
              }
              yield* bindPattern(element, value[index], env, mutable)
            }
            return
          }
          case "ObjectPattern": {
            if (typeof value !== "object" || value === null) {
              return yield* new ProgramThrow({
                value: { message: "cannot destructure a non-object" }
              })
            }
            const taken = new Set<string>()
            for (const property of pattern.properties) {
              if (property.type === "RestElement") {
                const rest: Record<string, unknown> = {}
                for (const [key, entry] of Object.entries(value)) {
                  if (!taken.has(key) && !BLOCKED_MEMBERS.has(key)) rest[key] = entry
                }
                yield* bindPattern(property.argument, rest, env, mutable)
                continue
              }
              if (property.computed || property.key.type !== "Identifier") {
                return yield* unsupported(property, "a computed destructuring key", "destructure named keys")
              }
              const key = property.key.name
              taken.add(key)
              yield* bindPattern(property.value, yield* readMember(value, key, property), env, mutable)
            }
            return
          }
          case "AssignmentPattern": {
            yield* bindPattern(
              pattern.left,
              value === undefined ? yield* evaluate(pattern.right, env) : value,
              env,
              mutable
            )
            return
          }
          default:
            return yield* unsupported(pattern, `the ${pattern.type} pattern`, "use plain names and array/object destructuring")
        }
      })

    const evaluate = (
      node: acorn.Expression | acorn.Super | acorn.PrivateIdentifier,
      env: Env
    ): Effect.Effect<unknown, ProgramFailure, R> =>
      Effect.gen(function*() {
        // Captured before the switch: in the default branch `node` has
        // narrowed to `never`, and the name is for the diagnostic only.
        const nodeType: string = node.type
        switch (node.type) {
          case "Literal": {
            if (node.regex !== undefined) {
              return yield* unsupported(node, "a RegExp literal", "use string methods such as includes/startsWith/split")
            }
            return node.value
          }
          case "Identifier": {
            const found = env.lookup(node.name)
            if (found === undefined) {
              return yield* new ProgramThrow({ value: { message: `${node.name} is not defined` } })
            }
            return found.value
          }
          case "TemplateLiteral": {
            let out = node.quasis[0]?.value.cooked ?? ""
            for (let index = 0; index < node.expressions.length; index++) {
              out += String(yield* settle(yield* evaluate(node.expressions[index]!, env)))
              out += node.quasis[index + 1]?.value.cooked ?? ""
            }
            return out
          }
          case "ArrayExpression": {
            const out: Array<unknown> = []
            for (const element of node.elements) {
              if (element === null) {
                out.push(undefined)
              } else if (element.type === "SpreadElement") {
                const spread = yield* evaluate(element.argument, env)
                if (!Array.isArray(spread)) {
                  return yield* new ProgramThrow({ value: { message: "spread of a non-array" } })
                }
                out.push(...spread)
              } else {
                out.push(yield* evaluate(element, env))
              }
            }
            return out
          }
          case "ObjectExpression": {
            const out: Record<string, unknown> = {}
            for (const property of node.properties) {
              if (property.type === "SpreadElement") {
                const spread = yield* evaluate(property.argument, env)
                if (typeof spread === "object" && spread !== null) {
                  for (const [key, entry] of Object.entries(spread)) {
                    if (!BLOCKED_MEMBERS.has(key)) out[key] = entry
                  }
                }
                continue
              }
              if (property.kind !== "init") {
                return yield* unsupported(property, "a getter/setter", "use plain properties")
              }
              const key = property.computed
                ? String(yield* evaluate(property.key, env))
                : property.key.type === "Identifier"
                ? property.key.name
                : property.key.type === "Literal"
                ? String(property.key.value)
                : undefined
              if (key === undefined) {
                return yield* unsupported(property, "this property key", "use a name, string or computed key")
              }
              if (BLOCKED_MEMBERS.has(key)) {
                return yield* new CodeDiagnostic({
                  reason: "blocked-member",
                  ...(lineOf(property) === undefined ? {} : { line: lineOf(property) }),
                  fix: `"${key}" cannot be a property; choose another name`
                })
              }
              out[key] = yield* evaluate(property.value as acorn.Expression, env)
            }
            return out
          }
          case "MemberExpression": {
            if (node.object.type === "Super") {
              return yield* unsupported(node, "super", "there are no classes here")
            }
            if (node.optional) {
              return yield* unsupported(node, "optional chaining", "check with if or && first")
            }
            const object = yield* settle(yield* evaluate(node.object, env))
            const key = node.computed
              ? String(yield* settle(yield* evaluate(node.property as acorn.Expression, env)))
              : node.property.type === "Identifier"
              ? node.property.name
              : undefined
            if (key === undefined) {
              return yield* unsupported(node, "this member access", "use a name or [expression]")
            }
            return yield* readMember(object, key, node)
          }
          case "CallExpression": {
            if (node.optional) {
              return yield* unsupported(node, "optional calls", "check the value first")
            }
            if (node.callee.type === "Super") {
              return yield* unsupported(node, "super", "there are no classes here")
            }
            // Arguments first-class, spread included.
            const args: Array<unknown> = []
            for (const argument of node.arguments) {
              if (argument.type === "SpreadElement") {
                const spread = yield* evaluate(argument.argument, env)
                if (!Array.isArray(spread)) {
                  return yield* new ProgramThrow({ value: { message: "spread of a non-array" } })
                }
                args.push(...spread)
              } else {
                args.push(yield* evaluate(argument, env))
              }
            }

            // Method call: evaluate the object once, dispatch by shape.
            if (node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object.type !== "Super" && node.callee.property.type === "Identifier") {
              const method = node.callee.property.name
              const object = yield* settle(yield* evaluate(node.callee.object, env))
              if (object instanceof ToolPath) {
                const path = [...object.segments, method]
                return new ProgramPromise(options.invoke(path, args[0]))
              }
              // `Promise.all` / `Promise.resolve` over program promises.
              if (object === "__promise_namespace__") {
                if (method === "all") {
                  const list = args[0]
                  if (!Array.isArray(list)) {
                    return yield* new ProgramThrow({ value: { message: "Promise.all takes an array" } })
                  }
                  return new ProgramPromise(
                    Effect.all(list.map((entry) => settle(entry)), { concurrency: "unbounded" })
                  )
                }
                if (method === "resolve") {
                  return new ProgramPromise(settle(args[0]))
                }
                return yield* unsupported(node, `Promise.${method}`, "only Promise.all and Promise.resolve exist here")
              }
              if (Array.isArray(object)) {
                const hof = arrayHof(object, method, args, node)
                if (hof !== undefined) return yield* hof
              }
              const member = yield* readMember(object, method, node)
              if (member instanceof ProgramFunction) {
                return yield* callProgramFunction(member, args, node)
              }
              if (typeof member !== "function") {
                return yield* new ProgramThrow({
                  value: { message: `${method} is not a function` }
                })
              }
              if (args.some((argument) => argument instanceof ProgramFunction)) {
                return yield* new CodeDiagnostic({
                  reason: "host-value",
                  ...(lineOf(node) === undefined ? {} : { line: lineOf(node) }),
                  fix: `${method} cannot take an arrow function here; use map/filter/find/some/every/forEach/reduce, or a loop`
                })
              }
              // Guarded, not called bare: a builtin that throws --
              // `JSON.parse` on bad text, `repeat(-1)` -- must be the
              // program's catchable error, not a defect that fails the run.
              return yield* Effect.try({
                try: () => (member as (...inner: ReadonlyArray<unknown>) => unknown)(...args),
                catch: (cause) => new ProgramThrow({ value: thrownValue(cause) })
              })
            }

            const callee = yield* settle(yield* evaluate(node.callee, env))
            if (callee instanceof ToolPath) {
              // Held in a variable and then called. The interpreter cannot
              // tell a namespace from a tool -- it has never seen the
              // toolkit -- so the message says the one thing that is true
              // either way, and names the form that works.
              const rendered = `tools${callee.segments.map((segment) => `.${segment}`).join("")}`
              return yield* new ProgramThrow({
                value: {
                  message: `${rendered} cannot be called through a variable; call it directly as ${rendered}(...)`
                }
              })
            }
            if (callee instanceof ProgramFunction) {
              const invoked = callProgramFunction(callee, args, node)
              return callee.isAsync ? new ProgramPromise(invoked) : yield* invoked
            }
            if (typeof callee === "function") {
              if (args.some((argument) => argument instanceof ProgramFunction)) {
                return yield* new CodeDiagnostic({
                  reason: "host-value",
                  ...(lineOf(node) === undefined ? {} : { line: lineOf(node) }),
                  fix: "this host function cannot take an arrow function; compute the value first"
                })
              }
              return yield* Effect.try({
                try: () => (callee as (...inner: ReadonlyArray<unknown>) => unknown)(...args),
                catch: (cause) => new ProgramThrow({ value: thrownValue(cause) })
              })
            }
            return yield* new CodeDiagnostic({
              reason: "not-callable",
              ...(lineOf(node) === undefined ? {} : { line: lineOf(node) }),
              fix: "this value is not callable; check the path against the catalog"
            })
          }
          case "ChainExpression": {
            return yield* unsupported(node, "optional chaining", "check with if or && first")
          }
          case "ArrowFunctionExpression": {
            return new ProgramFunction(node.params, node.body, env, node.async)
          }
          case "AwaitExpression": {
            return yield* settle(yield* evaluate(node.argument, env))
          }
          case "BinaryExpression": {
            if (node.left.type === "PrivateIdentifier") {
              return yield* unsupported(node, "private members", "there are no classes here")
            }
            const left = yield* settle(yield* evaluate(node.left, env))
            const right = yield* settle(yield* evaluate(node.right, env))
            switch (node.operator) {
              case "+":
                return (left as number) + (right as number)
              case "-":
                return (left as number) - (right as number)
              case "*":
                return (left as number) * (right as number)
              case "/":
                return (left as number) / (right as number)
              case "%":
                return (left as number) % (right as number)
              case "**":
                return (left as number) ** (right as number)
              case "===":
                return left === right
              case "!==":
                return left !== right
              case "<":
                return (left as number) < (right as number)
              case "<=":
                return (left as number) <= (right as number)
              case ">":
                return (left as number) > (right as number)
              case ">=":
                return (left as number) >= (right as number)
              case "==":
              case "!=":
                return yield* unsupported(node, `the ${node.operator} operator`, "use === or !==")
              default:
                return yield* unsupported(node, `the ${node.operator} operator`, "use arithmetic and strict comparison")
            }
          }
          case "LogicalExpression": {
            const left = yield* settle(yield* evaluate(node.left, env))
            switch (node.operator) {
              case "&&":
                return truthy(left) ? yield* settle(yield* evaluate(node.right, env)) : left
              case "||":
                return truthy(left) ? left : yield* settle(yield* evaluate(node.right, env))
              case "??":
                return left === null || left === undefined
                  ? yield* settle(yield* evaluate(node.right, env))
                  : left
            }
          }
          case "UnaryExpression": {
            const value = yield* settle(yield* evaluate(node.argument, env))
            switch (node.operator) {
              case "!":
                return !truthy(value)
              case "-":
                return -(value as number)
              case "+":
                return +(value as number)
              case "typeof":
                return value instanceof ProgramFunction ? "function" : typeof value
              default:
                return yield* unsupported(node, `the ${node.operator} operator`, "use !, -, + or typeof")
            }
          }
          case "ConditionalExpression": {
            return truthy(yield* settle(yield* evaluate(node.test, env)))
              ? yield* evaluate(node.consequent, env)
              : yield* evaluate(node.alternate, env)
          }
          case "AssignmentExpression": {
            if (node.operator !== "=") {
              return yield* unsupported(node, `the ${node.operator} operator`, "assign the computed value with =")
            }
            const value = yield* evaluate(node.right, env)
            if (node.left.type === "Identifier") {
              const binding = env.lookup(node.left.name)
              if (binding === undefined) {
                return yield* new ProgramThrow({ value: { message: `${node.left.name} is not defined` } })
              }
              if (!binding.mutable) {
                return yield* new ProgramThrow({ value: { message: `${node.left.name} is a constant` } })
              }
              binding.value = value
              return value
            }
            if (node.left.type === "MemberExpression" && node.left.object.type !== "Super") {
              const object = yield* settle(yield* evaluate(node.left.object, env))
              const key = node.left.computed
                ? String(yield* settle(yield* evaluate(node.left.property as acorn.Expression, env)))
                : node.left.property.type === "Identifier"
                ? node.left.property.name
                : undefined
              if (key === undefined || BLOCKED_MEMBERS.has(key)) {
                return yield* new CodeDiagnostic({
                  reason: "blocked-member",
                  ...(lineOf(node) === undefined ? {} : { line: lineOf(node) }),
                  fix: `cannot assign "${String(key)}"; choose another name`
                })
              }
              if (Array.isArray(object) || (typeof object === "object" && object !== null && !(object instanceof ToolPath) && !(object instanceof ProgramPromise))) {
                ;(object as Record<string, unknown>)[key] = value
                return value
              }
              return yield* new ProgramThrow({ value: { message: `cannot assign to ${key} on this value` } })
            }
            return yield* unsupported(node, "this assignment target", "assign to a name or a member")
          }
          default:
            return yield* unsupported(
              node,
              nodeType,
              "use the documented subset: literals, arrows, calls, member access, arithmetic, template strings, destructuring, if/for...of/while, try/catch, await and Promise.all"
            )
        }
      })

    const runBlock = (
      block: acorn.BlockStatement | acorn.Program,
      env: Env
    ): Effect.Effect<Completion, ProgramFailure, R> =>
      Effect.gen(function*() {
        for (const statement of block.body) {
          const completion = yield* runStatement(statement, env)
          if (completion.kind !== "normal") return completion
        }
        return NORMAL
      })

    const runStatement = (
      statement: acorn.Statement | acorn.ModuleDeclaration,
      env: Env
    ): Effect.Effect<Completion, ProgramFailure, R> =>
      Effect.gen(function*() {
        switch (statement.type) {
          case "ExpressionStatement": {
            yield* evaluate(statement.expression, env)
            return NORMAL
          }
          case "VariableDeclaration": {
            if (statement.kind === "var") {
              return yield* unsupported(statement, "var", "use const or let")
            }
            for (const declarator of statement.declarations) {
              const value = declarator.init === null || declarator.init === undefined
                ? undefined
                : yield* evaluate(declarator.init, env)
              yield* bindPattern(declarator.id, value, env, statement.kind === "let")
            }
            return NORMAL
          }
          case "ReturnStatement": {
            const value = statement.argument === null || statement.argument === undefined
              ? undefined
              : yield* settle(yield* evaluate(statement.argument, env))
            return { kind: "return", value }
          }
          case "IfStatement": {
            if (truthy(yield* settle(yield* evaluate(statement.test, env)))) {
              return yield* runStatement(statement.consequent, env.child())
            }
            if (statement.alternate !== null && statement.alternate !== undefined) {
              return yield* runStatement(statement.alternate, env.child())
            }
            return NORMAL
          }
          case "BlockStatement": {
            return yield* runBlock(statement, env.child())
          }
          case "ForOfStatement": {
            const iterable = yield* settle(yield* evaluate(statement.right, env))
            if (!Array.isArray(iterable) && typeof iterable !== "string") {
              return yield* new CodeDiagnostic({
                reason: "not-iterable",
                ...(lineOf(statement) === undefined ? {} : { line: lineOf(statement) }),
                fix: "for...of iterates arrays and strings here; use Object.entries(value) for an object"
              })
            }
            for (const entry of iterable) {
              const scope = env.child()
              if (statement.left.type === "VariableDeclaration") {
                yield* bindPattern(statement.left.declarations[0]!.id, entry, scope, statement.left.kind !== "const")
              } else {
                return yield* unsupported(statement, "assigning loop variables", "declare with const or let")
              }
              const completion = yield* runStatement(statement.body, scope)
              if (completion.kind === "break") return NORMAL
              if (completion.kind === "return") return completion
            }
            return NORMAL
          }
          case "WhileStatement": {
            while (truthy(yield* settle(yield* evaluate(statement.test, env)))) {
              const completion = yield* runStatement(statement.body, env.child())
              if (completion.kind === "break") return NORMAL
              if (completion.kind === "return") return completion
            }
            return NORMAL
          }
          case "BreakStatement":
            return { kind: "break" }
          case "ContinueStatement":
            return { kind: "continue" }
          case "ThrowStatement": {
            const value = yield* settle(yield* evaluate(statement.argument, env))
            return yield* new ProgramThrow({ value })
          }
          case "TryStatement": {
            const attempted = yield* Effect.result(runBlock(statement.block, env.child()))
            if (attempted._tag === "Success") {
              if (statement.finalizer !== null && statement.finalizer !== undefined) {
                const cleanup = yield* runBlock(statement.finalizer, env.child())
                if (cleanup.kind !== "normal") return cleanup
              }
              return attempted.success
            }
            const failure = attempted.failure
            // A diagnostic is the host refusing; the program cannot catch it.
            if (failure instanceof CodeDiagnostic) {
              return yield* failure
            }
            let outcome: Completion = NORMAL
            if (statement.handler !== null && statement.handler !== undefined) {
              const scope = env.child()
              if (statement.handler.param !== null && statement.handler.param !== undefined) {
                yield* bindPattern(statement.handler.param, failure.value, scope, false)
              }
              outcome = yield* runBlock(statement.handler.body, scope)
            } else if (statement.finalizer === null || statement.finalizer === undefined) {
              return yield* failure
            }
            if (statement.finalizer !== null && statement.finalizer !== undefined) {
              const cleanup = yield* runBlock(statement.finalizer, env.child())
              if (cleanup.kind !== "normal") return cleanup
              if (statement.handler === null || statement.handler === undefined) {
                return yield* failure
              }
            }
            return outcome
          }
          case "EmptyStatement":
            return NORMAL
          case "FunctionDeclaration":
            return yield* unsupported(statement, "function declarations", "use const name = (...) => { ... }")
          case "ClassDeclaration":
            return yield* unsupported(statement, "classes", "use plain objects and functions")
          case "ForStatement":
          case "ForInStatement":
            return yield* unsupported(statement, `${statement.type === "ForInStatement" ? "for...in" : "classic for"}`, "use for...of over an array, or while")
          default:
            return yield* unsupported(statement, `${statement.type}`, "use the documented statement subset")
        }
      })

    const completion = yield* runBlock(program, root)
    return {
      result: completion.kind === "return" ? Option.some(completion.value) : Option.none(),
      logs
    }
  })
