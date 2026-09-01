import type * as acorn from "acorn"
import type { CodeDiagnostic } from "./diagnostics.js"

/**
 * Pre-flight: every refusal the program earns, in one pass
 * (`docs/plan-code-mode-executors.md` step 3).
 *
 * The interpreter refuses the first problem it *reaches*, at the moment it
 * reaches it. A program that makes three expensive calls and then names a
 * fourth tool that does not exist pays for all three, returns one
 * diagnostic, and spends the next turn discovering the next problem.
 * CallScript's line for this is the right one: arbitrary code can only
 * fail at runtime, one error at a time.
 *
 * **This is a diagnostic pass, never a semantic one.** A program that
 * passes here must behave exactly as it did before this file existed, and
 * `test/CodePreflight.test.ts` pins that from the other end.
 *
 * ## What it checks, and why not more
 *
 * The plan for this step assumed the interpreter kept a table of supported
 * node kinds that both could share. It does not: its refusals are inline
 * and several are *contextual* -- "assigning loop variables", "a computed
 * destructuring key" -- which is what makes their fixes good. Lifting
 * those into a table would flatten exactly the thing worth keeping.
 *
 * So this checks the subset that is decidable from a node alone, with no
 * knowledge of where it sits. Anything contextual stays the interpreter's
 * to refuse when it gets there. That makes this a strict *subset* of the
 * interpreter's refusals, which is the property that keeps the two from
 * drifting apart into disagreement -- and it is tested as containment
 * (everything named here is also refused at runtime) rather than asserted
 * by a shared constant.
 *
 * The one thing checked here that the interpreter *cannot* check early is
 * an unknown tool path, because the interpreter has never seen the
 * toolkit. That is the check worth the whole file: it is the one that
 * saves calls that already happened.
 */

/** One problem, in the same shape `CodeDiagnostic` carries. */
export interface Finding {
  readonly reason: CodeDiagnostic["reason"]
  readonly line: number | undefined
  readonly fix: string
}

/**
 * The most findings one pass reports.
 *
 * A bound, not a budget: the point is to give the model several fixes at
 * once, and a program with fifty problems needs rewriting rather than
 * annotating. It also keeps a pathological program from turning a
 * diagnostic into an output-size problem of its own.
 */
const MAX_FINDINGS = 10

const BLOCKED_MEMBERS = new Set(["__proto__", "constructor", "prototype"])

const lineOf = (node: acorn.Node): number | undefined => node.loc?.start.line

interface Node extends acorn.Node {
  readonly type: string
  readonly [key: string]: unknown
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null &&
  typeof (value as { type?: unknown }).type === "string"

/**
 * Every node, parents before children.
 *
 * Written here rather than taken from `acorn-walk` because the walk is
 * six lines and a second dependency for six lines is not a trade -- the
 * engine plan pinned exactly one (`acorn`) and said why.
 */
const walkFrom = (root: unknown, visit: (node: Node) => void): void => {
  // `unknown` then a type guard, rather than `as unknown as Node`.
  // Assigning *to* `unknown` is not a cast, and `isNode` is the same
  // check the walk already makes on every child -- so the root is
  // narrowed by the same rule as everything below it.
  if (isNode(root)) walk(root, visit)
}

const walk = (node: Node, visit: (node: Node) => void): void => {
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "loc" || key === "range") continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit)
    } else if (isNode(value)) {
      walk(value, visit)
    }
  }
}

/** The static `tools.a.b` path a member expression names, if it names one. */
const toolPath = (node: Node): string | undefined => {
  if (node.type !== "MemberExpression") return undefined
  const nameOf = (part: unknown): string | undefined => {
    if (!isNode(part)) return undefined
    if (part.type === "Identifier" && typeof part["name"] === "string") return part["name"]
    if (part.type === "Literal" && typeof part["value"] === "string") return part["value"]
    return undefined
  }
  const property = nameOf(node["property"])
  if (property === undefined) return undefined
  // A computed access with a non-literal key is not a static path, and
  // guessing at one would refuse a working program.
  if (node["computed"] === true && !(isNode(node["property"]) && node["property"].type === "Literal")) {
    return undefined
  }
  const object = node["object"]
  if (!isNode(object) || object.type !== "MemberExpression") return undefined
  const namespace = nameOf(object["property"])
  if (namespace === undefined) return undefined
  if (
    object["computed"] === true &&
    !(isNode(object["property"]) && object["property"].type === "Literal")
  ) {
    return undefined
  }
  const root = object["object"]
  if (!isNode(root) || root.type !== "Identifier" || root["name"] !== "tools") return undefined
  return `${namespace}.${property}`
}

/** Does the program bind the name `tools` itself? */
const shadowsTools = (program: acorn.Program): boolean => {
  let shadowed = false
  walkFrom(program, (node) => {
    if (shadowed) return
    if (node.type === "Identifier" && node["name"] === "tools") return
    if (
      (node.type === "VariableDeclarator" || node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionDeclaration") &&
      JSON.stringify(node["id"] ?? node["params"] ?? null).includes("\"tools\"")
    ) {
      shadowed = true
    }
  })
  return shadowed
}

/**
 * Every context-free problem in the program.
 *
 * `knownTools` is `namespace.name` for each tool the host will accept. An
 * empty set disables the tool-path check rather than refusing everything,
 * because "the host told us nothing" and "the host has no tools" are not
 * distinguishable here and the safe reading of the ambiguity is silence.
 */
export const validate = (
  program: acorn.Program,
  options: { readonly knownTools: ReadonlySet<string> }
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = []
  const add = (node: acorn.Node, reason: Finding["reason"], fix: string) => {
    if (findings.length >= MAX_FINDINGS) return
    findings.push({ reason, line: lineOf(node), fix })
  }

  // A program that binds `tools` itself may legitimately address anything
  // through it, so the whole check stands down rather than guessing.
  const checkTools = options.knownTools.size > 0 && !shadowsTools(program)

  walkFrom(program, (node) => {
    switch (node.type) {
      case "VariableDeclaration":
        if (node["kind"] === "var") add(node, "unsupported-syntax", "var is not supported; use const or let")
        return
      case "FunctionDeclaration":
        add(node, "unsupported-syntax", "function declarations are not supported; use const name = (...) => { ... }")
        return
      case "ClassDeclaration":
      case "ClassExpression":
        add(node, "unsupported-syntax", "classes are not supported; use plain objects and functions")
        return
      case "ForStatement":
        add(node, "unsupported-syntax", "classic for is not supported; use for...of over an array, or while")
        return
      case "ForInStatement":
        add(node, "unsupported-syntax", "for...in is not supported; use for...of over an array, or while")
        return
      case "NewExpression":
        add(node, "unsupported-syntax", "new is not supported; build plain objects and arrays directly")
        return
      case "BinaryExpression":
        if (node["operator"] === "==" || node["operator"] === "!=") {
          add(node, "unsupported-syntax", `the ${String(node["operator"])} operator is not supported; use === or !==`)
        }
        return
      case "PrivateIdentifier":
        add(node, "unsupported-syntax", "private members are not supported; there are no classes here")
        return
      case "Super":
        add(node, "unsupported-syntax", "super is not supported; there are no classes here")
        return
      case "ChainExpression":
        add(node, "unsupported-syntax", "optional chaining is not supported; check with if or && first")
        return
      case "Literal":
        if (node["regex"] !== undefined) {
          add(
            node,
            "unsupported-syntax",
            "a RegExp literal is not supported; use string methods such as includes/startsWith/split"
          )
        }
        return
      case "MemberExpression": {
        if (node["computed"] !== true && isNode(node["property"])) {
          const name = node["property"]["name"]
          if (typeof name === "string" && BLOCKED_MEMBERS.has(name)) {
            add(node, "blocked-member", `${name} cannot be reached; use the value's own properties`)
            return
          }
        }
        if (!checkTools) return
        const path = toolPath(node)
        // Only a fully static path is checked. `tools[ns][name]` is not a
        // finding, it is simply not checkable -- and a false positive here
        // would refuse a working program, which costs far more than the
        // round trip it saves.
        if (path !== undefined && !options.knownTools.has(path)) {
          add(node, "unknown-tool", `there is no tool at tools.${path}; check the catalog or search for it`)
        }
        return
      }
      default:
        return
    }
  })

  // Line order, so the model reads them in the order it wrote them.
  // Stable within a line: `findings` is already in walk order.
  return [...findings].sort((left, right) => (left.line ?? 0) - (right.line ?? 0))
}
