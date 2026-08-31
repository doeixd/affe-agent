import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import { CodeTool } from "../src/code/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Code mode: many tools reach the model as one `execute` tool whose
 * description carries a budgeted catalog, and the model answers with a
 * *program* that loops, branches and combines results without a round
 * trip per call.
 *
 * Run it: `npx tsx examples/code-mode.ts`
 *
 * The scripted model stands in for a real one so the example is
 * deterministic; the program below is exactly what a model would write.
 */

const ListRepos = Tool.make("list_repos", {
  description: "List the repositories an owner has",
  parameters: Schema.Struct({
    owner: Schema.String.annotate({ description: "The account to list" })
  }),
  success: Schema.Array(Schema.String)
})

const OpenIssues = Tool.make("open_issues", {
  description: "Count the open issues on a repository",
  parameters: Schema.Struct({
    owner: Schema.String,
    repo: Schema.String
  }),
  success: Schema.Number
})

/**
 * The program the model writes. Without code mode this is five tool
 * calls and five round trips; here it is one.
 */
const program = [
  "const repos = await tools.github.list_repos({ owner: \"acme\" })",
  "const counts = []",
  "for (const repo of repos.value) {",
  "  const open = await tools.github.open_issues({ owner: \"acme\", repo })",
  "  if (open.value > 0) {",
  "    counts.push({ repo, open: open.value })",
  "  }",
  "}",
  "return counts"
].join("\n")

const main = Effect.gen(function*() {
  const github = yield* Agent.toolkit([ListRepos, OpenIssues], {
    list_repos: () => Effect.succeed(["harness", "docs", "sandbox"]),
    open_issues: ({ repo }) => Effect.succeed(repo === "docs" ? 0 : repo.length)
  })

  // One bound tool over the whole toolkit. `tool` is an Effect because a
  // bound handler must carry no requirement of its own: whatever the
  // toolkits and the policy need is discharged here, from this context.
  const execute = yield* CodeTool.tool({
    tools: { github },
    // A nested call is a tool call: the same policy that governs a direct
    // call governs one made inside a program.
    permission: Permission.allowAll,
    limits: { maxToolCalls: 20, maxConcurrentCalls: 4 }
  })

  const { layer } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "c1", name: "execute", params: { program } }] },
    { text: "acme has open issues on harness (7) and sandbox (7)." }
  ])

  yield* Effect.gen(function*() {
    const session = yield* AgentSession.make(
      Agent.make({ tools: [execute], loop: AgentLoop.bounded(3) })
    )
    const result = yield* session.prompt("Which acme repos have open issues?")

    console.log("--- what the model was told it could call ---")
    console.log(execute.tool.description)
    console.log("--- what the program answered ---")
    console.log(result.text)
  }).pipe(Effect.provide(layer), Effect.scoped)
})

// The example asserts what it claims: no cast is needed to use any of
// this, and the inference is precise rather than `any`.
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Main = typeof main
export type _MainIsNotAny = Assert<IsAny<Effect.Success<Main>> extends true ? false : true>
/** The example needs nothing but a scope: every requirement is discharged. */
export type _MainNeedsNoServices = Assert<
  [Effect.Services<Main>] extends [never] ? true : false
>

Effect.runPromise(Effect.scoped(main)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
