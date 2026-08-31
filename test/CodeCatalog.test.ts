import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { Catalog } from "../src/code/index.js"

/**
 * Code mode's interpreter-free half (`research-code-mode.md` §5.4 step 1):
 * signatures the model can call, a budget that never hides a namespace,
 * and search that is deterministic arithmetic rather than a model call.
 */

const ListIssues = Tool.make("list_issues", {
  description: "List issues in a repository",
  parameters: Schema.Struct({
    owner: Schema.String.annotate({ description: "Repository owner" }),
    repo: Schema.String,
    perPage: Schema.optional(Schema.Number).annotate({
      description: "Results per page",
      default: 30
    })
  }),
  success: Schema.Unknown
})

const CreateIssue = Tool.make("create_issue", {
  description: "Create an issue",
  parameters: Schema.Struct({
    owner: Schema.String,
    repo: Schema.String,
    title: Schema.String,
    body: Schema.optional(Schema.String)
  }),
  success: Schema.Unknown
})

const OddName = Tool.make("resolve-library-id", {
  description: "Resolve a library id",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.Unknown
})

const Ping = Tool.make("ping", {
  parameters: Schema.Struct({}),
  success: Schema.Unknown
})

const Deploy = Tool.make("deploy", {
  description: "Deploy the service and ping the target until it answers",
  parameters: Schema.Struct({ target: Schema.String }),
  success: Schema.Unknown
})

const groupOf = (...tools: ReadonlyArray<Tool.Any>): Catalog.ToolGroup => ({
  tools: Object.fromEntries(tools.map((tool) => [tool.name, tool]))
})

describe("Catalog.signatureOf", () => {
  it("renders a JSDoc-annotated TypeScript signature with defaults as tags", () => {
    const signature = Catalog.signatureOf("github", ListIssues)
    assert.strictEqual(
      signature,
      [
        "/** List issues in a repository */",
        "tools.github.list_issues(input: {",
        "  /** Repository owner */",
        "  owner: string,",
        "  repo: string,",
        "  /**",
        "   * Results per page",
        "   * @default 30",
        "   */",
        "  perPage?: number | null,",
        "}): Promise<unknown>"
      ].join("\n")
    )
  })

  it("a non-identifier segment renders as a usable index expression, and no parameters as ()", () => {
    assert.include(
      Catalog.signatureOf("context7", OddName),
      'tools.context7["resolve-library-id"](input:'
    )
    assert.include(Catalog.signatureOf("net", Ping), "tools.net.ping(): Promise<unknown>")
  })
})

describe("Catalog memoisation", () => {
  it("one tool under two namespaces renders both paths", () => {
    // Derived facts are cached on the tool object by identity, so the
    // namespace has to be part of the key -- otherwise the second
    // namespace would serve the first one's path, and a program written
    // from the catalog would call a tool that is not there.
    const out = Catalog.catalog({ alpha: groupOf(Ping), beta: groupOf(Ping) })
    assert.include(out.text, "tools.alpha.ping")
    assert.include(out.text, "tools.beta.ping")
    assert.deepStrictEqual(
      out.all.map((entry) => entry.path),
      ["tools.alpha.ping", "tools.beta.ping"]
    )
    // And repeated calls stay identical, cache warm or cold.
    assert.strictEqual(
      Catalog.catalog({ alpha: groupOf(Ping), beta: groupOf(Ping) }).text,
      out.text
    )
  })
})

describe("Catalog.catalog", () => {
  it("a complete catalog says so, and lists every namespace with its count", () => {
    const out = Catalog.catalog({
      github: groupOf(ListIssues, CreateIssue),
      net: groupOf(Ping)
    })
    assert.isTrue(out.complete)
    assert.include(out.text, "COMPLETE list")
    assert.include(out.text, "## github (2 tools)")
    assert.include(out.text, "## net (1 tool)")
    assert.strictEqual(out.inlined.length, 3)
  })

  it("under budget, every namespace is represented before any is complete, and the text states partiality", () => {
    // The discriminating budget: it fits BOTH github signatures with
    // nothing left over, so a greedy fill that finishes github first
    // starves net entirely. Round-robin places github's cheapest and ping
    // in round one (ping is smaller than github's second signature, so
    // they fit together), and github's second no longer fits in round two.
    const pingTokens = Catalog.estimateTokens(Catalog.signatureOf("net", Ping))
    const githubTokens = [
      Catalog.estimateTokens(Catalog.signatureOf("github", ListIssues)),
      Catalog.estimateTokens(Catalog.signatureOf("github", CreateIssue))
    ].sort((left, right) => left - right)
    assert.isBelow(pingTokens, githubTokens[1]!, "fixture: ping must be cheaper than github's larger signature")
    const out = Catalog.catalog(
      { github: groupOf(ListIssues, CreateIssue), net: groupOf(Ping) },
      { budgetTokens: githubTokens[0]! + githubTokens[1]! }
    )
    assert.isFalse(out.complete)
    assert.include(out.text, "PARTIAL - 2 of 3 shown")
    // Both namespaces placed one signature; neither got everything. A
    // greedy fill would have shown github twice and net not at all.
    assert.deepStrictEqual(
      out.inlined.map((entry) => entry.namespace).sort(),
      ["github", "net"]
    )
    // The namespace header still names the full count, and what was elided.
    assert.include(out.text, "## github (2 tools, 1 shown)")
    assert.include(out.text, "// not shown:")
  })

  it("namespaces are always listed even when nothing of theirs fits", () => {
    const out = Catalog.catalog(
      { github: groupOf(ListIssues, CreateIssue) },
      { budgetTokens: 1 }
    )
    assert.include(out.text, "## github (2 tools, 0 shown)")
    assert.strictEqual(out.inlined.length, 0)
  })
})

describe("Catalog.search", () => {
  const namespaces = {
    github: groupOf(ListIssues, CreateIssue),
    net: groupOf(Ping)
  }

  it("scores are additive and field-weighted: a path-segment hit outranks a description hit", () => {
    const out = Catalog.search(namespaces, "issues")
    // `list_issues` matches the token as a path segment (singular variant
    // matches "issue" too via description); `create_issue` matches the
    // singular as a segment.
    assert.isAtLeast(out.results.length, 2)
    assert.strictEqual(out.results[0]!.path, "tools.github.list_issues")
    // Every result carries the same signature the catalog inlines.
    assert.strictEqual(
      out.results[0]!.signature,
      Catalog.signatureOf("github", ListIssues)
    )
  })

  it("a path-segment hit outranks a description-only hit", () => {
    // `ping` is net.ping's own name (segment weight) and only prose on
    // github.deploy (description weight). Flattening the segment weight
    // reverses this ordering, which is the pin.
    const out = Catalog.search(
      { github: groupOf(Deploy), net: groupOf(Ping) },
      "ping"
    )
    assert.strictEqual(out.results.length, 2)
    assert.strictEqual(out.results[0]!.path, "tools.net.ping")
    assert.strictEqual(out.results[1]!.path, "tools.github.deploy")
    assert.isAbove(out.results[0]!.score, out.results[1]!.score)
  })

  it("naive singularisation and property-name text both match", () => {
    // `repos` -> `repo`, which is a property name on both github tools and
    // in no path or description.
    const out = Catalog.search(namespaces, "repos")
    assert.isAtLeast(out.results.length, 2)
    for (const result of out.results) {
      assert.strictEqual(result.namespace, "github")
    }
  })

  it("pagination hands back an offset that continues the same ordering", () => {
    const all = Catalog.search(namespaces, "issue")
    const first = Catalog.search(namespaces, "issue", { limit: 1 })
    assert.strictEqual(first.results.length, 1)
    assert.deepStrictEqual(first.next, { offset: 1 })
    const second = Catalog.search(namespaces, "issue", { ...first.next, limit: 1 })
    assert.strictEqual(second.results[0]!.path, all.results[1]!.path)
    const last = Catalog.search(namespaces, "issue", { offset: all.total })
    assert.strictEqual(last.results.length, 0)
    assert.isUndefined(last.next)
  })

  it("no match is an empty result, not an error", () => {
    const out = Catalog.search(namespaces, "zzz-nothing")
    assert.deepStrictEqual(out.results, [])
    assert.strictEqual(out.total, 0)
  })
})
