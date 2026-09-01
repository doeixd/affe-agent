import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type * as Elicitation from "../Elicitation.js"
import type * as Permission from "../Permission.js"
import * as Catalog from "./Catalog.js"
import * as CodeMode from "./CodeMode.js"

/**
 * The model-facing half of code mode
 * (`docs/plan-code-mode-engine.md` step 5).
 *
 * One tool the model calls with a program. Its *description* carries the
 * budgeted catalog, which is the entire point of code mode: a large tool
 * surface reaches the model as a few thousand tokens of signatures plus
 * a statement of what was elided, instead of hundreds of tool
 * definitions -- and the program can then loop, branch and combine
 * results without a round trip per call.
 *
 * The result is deliberately a flat record with a discriminant, for the
 * reason `/coding`'s `shell` returns `{exit_code, stdout, stderr}`: the
 * model should not have to parse prose to learn what happened. Nested
 * calls are reported as they settle, through the preliminary-result
 * channel the kernel already projects as `ToolCallProgress` events, so
 * `apps/tui`, `/observability`, `/export` and the MCP frontend see a
 * running program without this module knowing any of them exist.
 */

const Call = Schema.Struct({
  /** `data.lookup`, as the program addressed it. */
  path: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "refused"])
})

/**
 * What the model gets back.
 *
 * `running` is a preliminary result -- progress while the program is
 * still going -- and never the final one.
 */
export const Result = Schema.Struct({
  outcome: Schema.Literals([
    "running",
    "awaiting-approval",
    "returned",
    "nothing",
    "threw",
    /**
     * The engine paused and the host holds the state to resume it.
     *
     * **No field of this result carries that state**, and that is a rule
     * rather than an oversight: it is an opaque executor value, and a
     * model handed one will try to reason about it or echo it back. The
     * host receives it through `CodeTool.Options.onSuspend`; the model
     * receives `fix`, which tells it what it is waiting for.
     */
    "suspended",
    "refused"
  ]),
  /** The value the program returned, when it returned one. */
  value: Schema.optional(Schema.Unknown),
  /** What the program threw, when it threw. */
  error: Schema.optional(Schema.Unknown),
  /** What to do instead, when the engine refused. Always names a fix. */
  fix: Schema.optional(Schema.String),
  /** 1-based line the refusal concerns, when one applies. */
  line: Schema.optional(Schema.Number),
  /** Everything the program logged, one entry per `console.log`. */
  logs: Schema.Array(Schema.String),
  /** Every nested tool call, in order. */
  calls: Schema.Array(Call),
  /**
   * Set on an `awaiting-approval` progress result: the question the
   * program is paused on, and the `id` an answer is delivered under.
   */
  awaiting: Schema.optional(Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    action: Schema.String,
    resource: Schema.String
  }))
})
export type Result = typeof Result.Type

const Parameters = Schema.Struct({
  /**
   * Named `program` rather than `code`, because what the model writes is
   * a whole program with a `return`, not an expression.
   */
  program: Schema.String
})

const INSTRUCTIONS = [
  "Run a JavaScript program against the tools below. Prefer this over many separate tool calls:",
  "a program can loop, branch, and combine results without a round trip each time.",
  "",
  "Write **plain JavaScript** (no TypeScript types), as the body of an async function:",
  "`return` your answer, and `await` every tool call.",
  "",
  "Each tool call returns `{ ok: true, value }` or `{ ok: false, error }` -- check `ok`",
  "rather than assuming success. A call the policy refuses throws instead, so wrap",
  "risky calls in try/catch if you want to continue past a refusal.",
  "",
  "Supported: const/let, arrow functions, template strings, destructuring, if,",
  "for...of, while, try/catch/finally, throw, await, Promise.all, console.log, JSON,",
  "Math, Object.keys/values/entries/fromEntries, and array methods including",
  "map/filter/find/some/every/forEach/reduce.",
  "Not supported (each refusal names the fix): classes, function declarations, var,",
  "classic for loops, for...in, regular expressions, optional chaining, and `==`.",
  ""
].join("\n")

/**
 * The line that tells the model a search tool exists, when one does.
 *
 * Conditional on purpose: a model told to search when nothing can search
 * is worse off than one told nothing, because it will spend a turn
 * calling a tool that is not there. The name is threaded through rather
 * than hard-coded so the two descriptions cannot disagree about it.
 */
const searchLine = (name: string): string =>
  `If a tool you need is not listed below, call \`${name}\` to find it -- the results carry full signatures, ready to use here.\n\n`

export interface Options<Groups extends CodeMode.ToolGroups, R> {
  readonly tools: Groups
  /** The tool's name. `execute` by default, as in every code-mode host. */
  readonly name?: string | undefined
  /** Per nested call, over each tool's own projection. */
  readonly permission?: Permission.Policy<R> | undefined
  readonly limits?: CodeMode.Limits | undefined
  readonly executor?: CodeMode.CodeExecutor | undefined
  /**
   * Where an in-program approval is asked. Pass the session's own
   * elicitor, so the question appears in `session.pending` and is
   * answered through the same channel as any other. Absent, an `Ask`
   * throws into the program rather than running unapproved.
   */
  readonly elicitor?: Elicitation.Elicitor | undefined
  /** Signature budget for the catalog in the description. Defaults to 2000. */
  readonly catalogBudgetTokens?: number | undefined
  /**
   * Where a suspended run's state goes, for an executor that can suspend.
   *
   * The owned interpreter never suspends, so a host that has not chosen
   * another executor never needs this. With one that does, a host that
   * omits it gets the model's `suspended` result and no way to resume --
   * the run is not lost (nothing was rolled back), but its settled work
   * is unreachable. Stated here because the alternative is discovering it
   * from a program that pauses in production.
   */
  readonly onSuspend?:
    | ((suspension: { readonly state: unknown; readonly reason: string }) => Effect.Effect<void>)
    | undefined
  /**
   * The name of the `searchTool` mounted beside this one, if there is one.
   *
   * Set it and the description tells the model to search when a tool it
   * needs is not listed; leave it and the description says nothing about
   * searching. A name rather than a boolean because the two descriptions
   * must not be able to disagree about what the tool is called -- a model
   * told to call `search` when the host mounted it as `find_tools` spends
   * a turn on a tool that does not exist.
   *
   * Worth setting exactly when `Catalog.catalog(tools).complete` is
   * false. A search tool over a complete catalog is prompt cost for
   * nothing.
   */
  readonly searchToolName?: string | undefined
}

/**
 * There is deliberately no `resumeFrom` here.
 *
 * A bound tool is built once and mounted on an agent; a resumption is one
 * run continuing. A build-time `resumeFrom` would apply to *every* program
 * the model subsequently wrote, which is not a resumption of anything, and
 * it would read as though the model could resume -- it cannot, because it
 * never holds the state.
 *
 * Resuming is a host operation at the level that has one: build a
 * `CodeMode.make` runtime over the same tools and call
 * `execute(program, { resumeFrom })`. Dropping to the primitives is taking
 * a field, not going around the API.
 */

const render = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value) ?? String(value)

/**
 * Build the `execute` tool over the supplied toolkits.
 *
 * ```ts
 * const agent = Agent.make({
 *   tools: [yield* CodeTool.tool({ tools: { github, linear } })]
 * })
 * ```
 *
 * An `Effect`, for the same reason `Agent.toolkit` is one: a bound
 * tool's handler must carry no requirement of its own, so whatever the
 * permission policy and the grouped handlers need is discharged *here*,
 * from the context where the tool is built. Nothing is passed at call
 * time and nothing is cast.
 *
 * Whether this *replaces* the underlying tools or sits beside them is
 * the application's decision, deliberately not this module's: opencode
 * defers MCP tools into code mode and keeps native ones direct, which
 * looks right and is still policy.
 */
export const tool = <Groups extends CodeMode.ToolGroups, R = never>(
  options: Options<Groups, R>
) =>
  Effect.map(
    Effect.context<R | CodeMode.ServicesOf<Groups>>(),
    (environment) => build(options, environment)
  )

const build = <Groups extends CodeMode.ToolGroups, R>(
  options: Options<Groups, R>,
  environment: Context.Context<R | CodeMode.ServicesOf<Groups>>
) => {
  const catalog = Catalog.catalog(options.tools, {
    ...(options.catalogBudgetTokens === undefined
      ? {}
      : { budgetTokens: options.catalogBudgetTokens })
  })

  const definition = Tool.make(options.name ?? "execute", {
    description: `${INSTRUCTIONS}${
      options.searchToolName === undefined ? "" : searchLine(options.searchToolName)
    }${catalog.text}`,
    parameters: Parameters,
    success: Result
  })

  const runtime = CodeMode.make<Groups, R>({
    tools: options.tools,
    ...(options.permission === undefined ? {} : { permission: options.permission }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.elicitor === undefined ? {} : { elicitor: options.elicitor })
  })

  const handler: Agent.Handler<typeof definition> = ({ program }, context) =>
    Effect.gen(function*() {
      // Captured at build time (see `tool`): the handler itself requires
      // nothing, which is what lets it be an ordinary bound tool.
      const seen: Array<typeof Call.Type> = []
      const result = yield* runtime.execute(program, {
        // Namespaced by this tool call, so an answer can never be matched
        // to a different program's question.
        ...(context.toolCallId === undefined
          ? {}
          : { approvalPrefix: context.toolCallId }),
        ...(options.onSuspend === undefined ? {} : { onSuspend: options.onSuspend }),
        onCall: (call) => {
          seen.push({ path: call.path.join("."), outcome: call.outcome })
          // A preliminary result: the kernel emits it as
          // `ToolCallProgress` and keeps waiting for the final one.
          return context.preliminary({
            outcome: "running",
            logs: [],
            calls: [...seen]
          })
        },
        // The only way an in-program approval becomes visible to a
        // renderer: the event bus is not reachable from a handler, so the
        // question rides the progress channel, carrying the id an answer
        // is delivered under.
        onApproval: (pending) =>
          context.preliminary({
            outcome: "awaiting-approval",
            logs: [],
            calls: [...seen],
            awaiting: {
              id: pending.id,
              path: pending.path.join("."),
              action: pending.detail.action,
              resource: pending.detail.resource
            }
          })
      })

      const logs = result.logs.map((entry) => entry.map(render).join(" "))
      const calls = result.calls.map((call) => ({
        path: call.path.join("."),
        outcome: call.outcome
      }))

      switch (result.outcome._tag) {
        case "Returned":
          return { outcome: "returned" as const, value: result.outcome.value, logs, calls }
        case "RanOffTheEnd":
          return {
            outcome: "nothing" as const,
            fix: "the program returned nothing; end it with `return <your answer>`",
            logs,
            calls
          }
        case "Threw":
          return { outcome: "threw" as const, error: result.outcome.error, logs, calls }
        case "Suspended":
          // `result.outcome.state` is deliberately not read here. It
          // reached the host through `onSuspend`; putting it in a field
          // the model can see would invite the model to reason about an
          // opaque engine value, and `test/CodeExecutors.test.ts`
          // asserts structurally that no field carries it.
          //
          // The `fix` is composed rather than passed through, and that is
          // the load-bearing part. Every other `fix` in this switch is an
          // instruction; the executor's `reason` is a *status*. A model
          // told only "waiting on the approval gate", holding a list of
          // the calls the program already made, does the obvious thing
          // and runs the program again -- which starts a fresh run with
          // no `resumeFrom` and repeats every one of those calls. That is
          // the retry-for-a-resume hazard `interpreted` refuses, one
          // layer up and worse, because here nothing asked a human.
          return {
            outcome: "suspended" as const,
            fix:
              `${result.outcome.reason}. This run is paused, not failed: the host holds its state and will resume it. Do not run this program again -- a new run would repeat the calls this one already made.`,
            logs,
            calls
          }
        case "Refused":
          return {
            outcome: "refused" as const,
            fix: result.outcome.fix,
            ...(result.outcome.line === undefined ? {} : { line: result.outcome.line }),
            logs,
            calls
          }
      }
    }).pipe(Effect.provide(environment))

  return Agent.tool(definition, handler)
}

// ---------------------------------------------------------------------------
// Search: the other half of a PARTIAL catalog

/**
 * What the model asks for.
 *
 * `offset` rather than a page token, because `Catalog.search` is
 * deterministic: the same query scores the same tools in the same order
 * every time, so an offset means exactly what the model thinks it does.
 */
const SearchParameters = Schema.Struct({
  query: Schema.String,
  /** Continue a previous search from `nextOffset`. Omit to start. */
  offset: Schema.optional(Schema.Number)
})

/**
 * What comes back: the same generated signature the inline catalog
 * carries, so a found tool is immediately callable and there is no second
 * "describe this one" round trip. That is why one tool covers what other
 * code-mode surfaces split into `search` and `describe`.
 */
export const SearchResult = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    /** `tools.github.list_issues` -- callable as written. */
    path: Schema.String,
    description: Schema.optional(Schema.String),
    signature: Schema.String
  })),
  /** Matches in total, so the model can tell "none" from "more". */
  total: Schema.Number,
  /** Pass back as `offset` for the next page. Absent when there is none. */
  nextOffset: Schema.optional(Schema.Number)
})
export type SearchResult = typeof SearchResult.Type

const SEARCH_DESCRIPTION = [
  "Find tools by name, description or parameter, when the catalog above is",
  "partial or you are not sure a tool exists. Returns each match's full",
  "signature, ready to call from a program -- there is nothing further to look up.",
  "Scoring is deterministic, so the same query always returns the same order."
].join("\n")

/**
 * `Catalog.search` as a tool the model can actually call.
 *
 * The budgeted catalog states its own completeness, and a PARTIAL one
 * tells the model to search for the rest -- which, until this existed,
 * was a promise the design did not keep: `Catalog.search` was a function
 * only the host could reach.
 *
 * Not an `Effect`, unlike `tool`: search reads the tool *declarations*,
 * never a handler or a policy, so there is no requirement to discharge
 * and nothing to bind. That is also why it is safe to mount beside any
 * agent -- it cannot call anything.
 *
 * **Mount it only when it earns its place.** A second tool is prompt cost
 * on every request, and for a toolkit whose catalog fits the budget it
 * buys nothing (`Catalog.catalog(tools).complete` is the test). Tell the
 * execute tool it exists with `Options.searchToolName`, so the two
 * descriptions cannot disagree about the name.
 *
 * **Pass the same `tools` you passed `tool`.** Nothing checks that they
 * match, and a mismatch is quiet in the worst direction: the model finds
 * `tools.billing.list_invoices`, writes a program around it, and the
 * program is told there is no tool at that path. Recoverable -- the
 * diagnostic names it -- but a wasted turn for a mistake with no other
 * symptom. The two take the groups separately because a host may want to
 * mount one without the other, not because they may differ.
 *
 * **Visibility is not authority.** Search reaches every tool in the
 * groups, including the ones the catalog's token budget left out; that is
 * the whole point of it. A tool the model must not call is one the
 * `Permission` policy refuses, never one the budget happened to hide --
 * budget is a prompt-size decision and makes no security claim.
 */
export const searchTool = <Groups extends CodeMode.ToolGroups>(
  options: {
    readonly tools: Groups
    /** Defaults to `search`. */
    readonly name?: string | undefined
    /** Matches per page. Defaults to 10, as `Catalog.search` does. */
    readonly limit?: number | undefined
  }
) => {
  const definition = Tool.make(options.name ?? "search", {
    description: SEARCH_DESCRIPTION,
    parameters: SearchParameters,
    success: SearchResult
  })

  const handler: Agent.Handler<typeof definition> = ({ offset, query }) =>
    Effect.sync(() => {
      const found = Catalog.search(options.tools, query, {
        ...(offset === undefined ? {} : { offset }),
        ...(options.limit === undefined ? {} : { limit: options.limit })
      })
      return {
        results: found.results.map((entry) => ({
          path: entry.path,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          signature: entry.signature
        })),
        total: found.total,
        ...(found.next === undefined ? {} : { nextOffset: found.next.offset })
      }
    })

  return Agent.tool(definition, handler)
}

/** The catalog this tool would advertise, for a host that wants to show it. */
export const catalogOf = <Groups extends CodeMode.ToolGroups>(
  tools: Groups,
  options?: { readonly budgetTokens?: number | undefined }
): Catalog.Catalog => Catalog.catalog(tools, options)
