import { assert, describe, it } from "@effect/vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

/**
 * Every defaulted `Context.Reference` in `src/`, classified (item 110, plan
 * §22).
 *
 * A `Context.Reference` has a default, so a program that forgets to provide
 * it still compiles and still runs -- with whatever the default does. That is
 * right when absence means "no feature" (no elicitor, no principal, no
 * failpoint). It is a trap when absence silently weakens something the caller
 * believed was on: an authorization check, a durable store, a sandbox. Those
 * must be required, or an explicit value the caller writes.
 *
 * So each Reference is listed here with why its default is safe, and adding
 * one fails this test until someone has written that reason down -- or found
 * there is none, and made it required instead. Found by parsing, as the cast
 * inventory is: a Reference is syntax, and a grep matches its doc comments.
 */

type Class =
  /** Absent means the feature is off; nothing the caller relies on weakens. */
  | "no-feature"
  /** A test or diagnostic seam whose default is a no-op. */
  | "seam"

const classified: Record<string, { readonly class: Class; readonly why: string }> = {
  "src/AgentInput.ts:Current": {
    class: "no-feature",
    why: "no pending input: the agent reads none"
  },
  "src/Elicitation.ts:Current": {
    class: "no-feature",
    why: "no elicitor: a tool that asks is told nobody can answer"
  },
  "src/Principal.ts:CurrentPrincipal": {
    class: "no-feature",
    why: "no principal: visibility rules see None, and hosts that authenticate always set it"
  },
  "src/internal/failpoint.ts:Failpoint": {
    class: "seam",
    why: "no-op outside the crash tests"
  },
  "src/internal/delegatedEvents.ts:ParentEvents": {
    class: "no-feature",
    why: "not delegated: events have no parent to forward to"
  },
  "src/internal/currentSession.ts:CurrentSessionId": {
    class: "no-feature",
    why: "outside a session: nothing session-scoped is reachable"
  },
  "src/ToolExecution.ts:Alone": {
    class: "no-feature",
    why: "a tool is not exclusive unless it says so; the output tool annotates itself"
  },
  "src/ToolScheduling.ts:Current": {
    class: "no-feature",
    why: "no host constraint: calls run as the agent's strategy says, as before the service existed"
  }
}

const sourceFiles = (dir: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith(".ts")) found.push(path)
    }
  }
  walk(dir)
  return found
}

/** `file:name` for every `const name = Context.Reference(...)`, and a marker for an anonymous one. */
const references = (): ReadonlyArray<string> => {
  const found: Array<string> = []
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8")
    if (!text.includes("Reference")) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const at = relative(process.cwd(), file).replaceAll("\\", "/")
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isCallExpression(node.expression) ? node.expression.expression : node.expression
        if (callee.getText(source) === "Context.Reference") {
          let owner: ts.Node | undefined = node.parent
          while (owner !== undefined && !ts.isVariableDeclaration(owner)) owner = owner.parent
          found.push(`${at}:${owner !== undefined && ts.isIdentifier(owner.name) ? owner.name.text : "<anonymous>"}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found.sort()
}

describe("Context.Reference inventory (item 110)", () => {
  it("every defaulted Reference in src is classified, and every classified one still exists", () => {
    const found = references()
    const unclassified = found.filter((key) => !(key in classified))
    assert.deepStrictEqual(
      unclassified,
      [],
      "a new Context.Reference: classify it here with why its default is safe, or make it required"
    )
    assert.deepStrictEqual(found, Object.keys(classified).sort(), "a classified Reference no longer exists")
  })

  it("the scanner finds a Reference, so an empty inventory cannot pass by finding nothing", () => {
    assert.isAtLeast(references().length, 8)
  })
})
