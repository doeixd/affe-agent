import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Catalog, CodeTool } from "../src/code/index.js"
import { withSession } from "./helpers.js"

/**
 * Search as a tool the model can call
 * (`docs/plan-code-mode-executors.md` step 2).
 *
 * `Catalog.search` was good and unreachable: a PARTIAL catalog told the
 * model to "use search for the rest" while search was a function only the
 * host could call. This is the other half of that sentence.
 */

/**
 * Seven tools, declared rather than generated.
 *
 * A generated list needs a handler record built with `Object.fromEntries`,
 * and that record's type is `Record<string, ...>` -- which `Agent.toolkit`
 * rightly refuses against a tuple of named tools. The first draft of this
 * file reached for `as never` there. Test code counts as user code
 * (AGENTS.md), so the list is written out instead: seven tools with long
 * descriptions are enough to overflow a small budget, which is all the
 * generated forty were for.
 */
const report = (index: number) =>
  Tool.make(`report_${index}`, {
    description:
      `Generate report number ${index}, with a deliberately long description so that a small catalog budget cannot fit every signature`,
    parameters: Schema.Struct({ since: Schema.String }),
    success: Schema.String
  })

const Report0 = report(0)
const Report1 = report(1)
const Report2 = report(2)
const Report3 = report(3)
const Report4 = report(4)
const Report5 = report(5)

const Invoices = Tool.make("list_invoices", {
  description: "List the invoices for a customer",
  parameters: Schema.Struct({ customer: Schema.String }),
  success: Schema.Array(Schema.String)
})

const groups = Effect.gen(function*() {
  const billing = yield* Agent.toolkit(
    [Report0, Report1, Report2, Report3, Report4, Report5, Invoices],
    {
      report_0: () => Effect.succeed("ok"),
      report_1: () => Effect.succeed("ok"),
      report_2: () => Effect.succeed("ok"),
      report_3: () => Effect.succeed("ok"),
      report_4: () => Effect.succeed("ok"),
      report_5: () => Effect.succeed("ok"),
      list_invoices: () => Effect.succeed(["inv-1"])
    }
  )
  return { billing }
})

// ---------------------------------------------------------------------------
// Compile-time assertions, in the same form as `CodeTypes.test.ts`. Each has
// been broken once to confirm it is enforced.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

type Billing = Effect.Success<typeof groups>["billing"]
type Search = ReturnType<typeof CodeTool.searchTool<{ billing: Billing }>>

/**
 * `searchTool` is a plain function, not an `Effect`.
 *
 * That is the claim specific to this module, and the one that can
 * regress: the obvious "fix" for a future maintainer is to make it an
 * `Effect` for symmetry with `tool`, which would make every caller
 * `yield*` a value that never needed a context. Broken once by returning
 * `Effect.succeed(bound)`.
 */
export type _SearchIsNotAnEffect = Assert<
  Extends<Search, Agent.BoundTool<Tool.Any>>
>

/**
 * It needs no service either.
 *
 * Worth knowing this pin is **guaranteed upstream**: breaking it from the
 * library side is not possible while the code still compiles, because
 * `Agent.Handler` already requires `never` and rejects a requirement at
 * `Agent.tool` before this is consulted (confirmed by injecting one). It
 * is kept as a regression pin on that seam, not as evidence about
 * `searchTool` -- and is labelled so, because an assertion that cannot
 * fail proves nothing and should at least say which.
 */
export type _SearchNeedsNothing = Assert<Extends<Agent.ServicesOf<[Search]>, never>>
/** ...and the requirement really is `never`, not `any` wearing its face. */
export type _SearchServicesNotAny = Assert<
  IsAny<Agent.ServicesOf<[Search]>> extends true ? false : true
>
/** The success type is the declared struct, not `any`. */
type Found = typeof CodeTool.SearchResult.Type
export type _ResultIsNotAny = Assert<IsAny<Found> extends true ? false : true>
export type _ResultCarriesSignature = Assert<
  Extends<Found["results"][number]["signature"], string>
>

describe("CodeTool.searchTool", () => {
  it.effect("finds a tool the budgeted catalog had to leave out", () =>
    Effect.gen(function*() {
      const { billing } = yield* groups
      // The premise: this catalog really is partial, so the search tool
      // is answering a question the description actually raises.
      const catalog = Catalog.catalog({ billing }, { budgetTokens: 300 })
      assert.isFalse(catalog.complete)
      assert.include(catalog.text, "use search for the rest")

      const search = CodeTool.searchTool({ tools: { billing } })
      const { events } = yield* withSession(
        [
          { toolCalls: [{ id: "s1", name: "search", params: { query: "invoices" } }] },
          { text: "found it" }
        ],
        Agent.make({ tools: [search] }),
        ({ session }) => AgentSession.prompt(session, "find the invoice tool")
      )

      const succeeded = events.filter(AgentEvent.is("ToolCallSucceeded"))
      assert.strictEqual(succeeded.length, 1)
      const result = succeeded[0]!.event.result as CodeTool.SearchResult
      assert.strictEqual(result.results[0]!.path, "tools.billing.list_invoices")
      // The signature comes back with the match, which is what makes one
      // tool enough: nothing further to look up before writing a program.
      assert.include(result.results[0]!.signature, "list_invoices")
      assert.include(result.results[0]!.signature, "customer")
    })
  )

  it.effect("pages deterministically, and says when there is no next page", () =>
    Effect.gen(function*() {
      const { billing } = yield* groups
      const search = CodeTool.searchTool({ tools: { billing }, limit: 3 })
      const run = (params: Record<string, unknown>) =>
        withSession(
          [
            { toolCalls: [{ id: "s1", name: "search", params }] },
            { text: "ok" }
          ],
          Agent.make({ tools: [search] }),
          ({ session }) => AgentSession.prompt(session, "search")
        ).pipe(
          Effect.map(({ events }) =>
            events.filter(AgentEvent.is("ToolCallSucceeded"))[0]!.event.result as CodeTool.SearchResult
          )
        )

      const first = yield* run({ query: "report" })
      assert.strictEqual(first.results.length, 3)
      assert.strictEqual(first.total, 6)
      assert.strictEqual(first.nextOffset, 3)

      const second = yield* run({ query: "report", offset: 3 })
      // Deterministic scoring is what makes an offset mean what the model
      // thinks it means: the same query never reshuffles under paging.
      assert.notDeepEqual(second.results, first.results)
      const again = yield* run({ query: "report" })
      assert.deepStrictEqual(again.results, first.results)

      const last = yield* run({ query: "report", offset: 5 })
      assert.strictEqual(last.results.length, 1)
      assert.strictEqual(last.nextOffset, undefined)
    })
  )

  it.effect("a query matching nothing is an empty answer, not an error", () =>
    Effect.gen(function*() {
      const { billing } = yield* groups
      const search = CodeTool.searchTool({ tools: { billing } })
      const { events } = yield* withSession(
        [
          { toolCalls: [{ id: "s1", name: "search", params: { query: "zzzznothing" } }] },
          { text: "ok" }
        ],
        Agent.make({ tools: [search] }),
        ({ session }) => AgentSession.prompt(session, "search")
      )
      const result = events.filter(AgentEvent.is("ToolCallSucceeded"))[0]!.event
        .result as CodeTool.SearchResult
      // `total: 0` rather than a failure: "no such tool" is an answer the
      // model can act on, and a failed tool call is not.
      assert.deepStrictEqual(result.results, [])
      assert.strictEqual(result.total, 0)
      assert.strictEqual(result.nextOffset, undefined)
    })
  )

  it.effect("an empty query matches nothing, and a budget-hidden tool is still findable", () =>
    Effect.gen(function*() {
      const { billing } = yield* groups
      const search = CodeTool.searchTool({ tools: { billing } })
      const run = (query: string) =>
        withSession(
          [
            { toolCalls: [{ id: "s1", name: "search", params: { query } }] },
            { text: "ok" }
          ],
          Agent.make({ tools: [search] }),
          ({ session }) => AgentSession.prompt(session, "search")
        ).pipe(
          Effect.map(({ events }) =>
            events.filter(AgentEvent.is("ToolCallSucceeded"))[0]!.event.result as CodeTool.SearchResult
          )
        )

      // Scoring is additive over query tokens, so no tokens is no score.
      // Pinned because "" plausibly reads as "list everything" and does
      // not: a model that wants the list has the catalog.
      assert.strictEqual((yield* run("")).total, 0)

      // Visibility is not authority. A tool the token budget left out of
      // the catalog is still findable here, deliberately: what the model
      // may *call* is the permission policy's decision, never a
      // side-effect of how many signatures fitted in the prompt.
      const tight = Catalog.catalog({ billing }, { budgetTokens: 60 })
      assert.isFalse(tight.complete)
      const hidden = Catalog.entries({ billing }).filter((entry) =>
        !tight.inlined.some((shown) => shown.path === entry.path)
      )
      assert.isAbove(hidden.length, 0)
      const found = yield* run(hidden[0]!.name)
      assert.isTrue(found.results.some((one) => one.path === hidden[0]!.path))
    })
  )

  it.effect("the execute tool mentions search only when one is mounted", () =>
    Effect.gen(function*() {
      const { billing } = yield* groups
      const silent = yield* CodeTool.tool({ tools: { billing }, catalogBudgetTokens: 300 })
      // A model told to search when nothing can search spends a turn on a
      // tool that is not there. Break once by making `searchLine`
      // unconditional and this fails.
      assert.notInclude(silent.tool.description ?? "", "to find it")

      const told = yield* CodeTool.tool({
        tools: { billing },
        catalogBudgetTokens: 300,
        searchToolName: "find_tools"
      })
      const description = told.tool.description ?? ""
      assert.include(description, "call `find_tools` to find it")
      // The name is threaded, not hard-coded: the two descriptions cannot
      // disagree about what the tool is called.
      assert.notInclude(description, "call `search` to find it")
    })
  )

  it.effect("the result carries the same signature the catalog would have shown", () =>
    Effect.gen(function*() {
      // One tool covers what other code-mode surfaces split into `search`
      // and `describe`, and this is the property that makes that true:
      // a found tool needs no follow-up lookup.
      const { billing } = yield* groups
      const search = CodeTool.searchTool({ tools: { billing } })
      const { events } = yield* withSession(
        [
          { toolCalls: [{ id: "s1", name: "search", params: { query: "invoices" } }] },
          { text: "ok" }
        ],
        Agent.make({ tools: [search] }),
        ({ session }) => AgentSession.prompt(session, "search")
      )
      const found = (events.filter(AgentEvent.is("ToolCallSucceeded"))[0]!.event
        .result as CodeTool.SearchResult).results[0]!
      const entry = Catalog.entries({ billing }).find((one) => one.path === found.path)!
      assert.strictEqual(found.signature, entry.signature)
      assert.strictEqual(found.description, entry.description)
    })
  )
})
