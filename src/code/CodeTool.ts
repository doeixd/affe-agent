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
    description: `${INSTRUCTIONS}${catalog.text}`,
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

/** The catalog this tool would advertise, for a host that wants to show it. */
export const catalogOf = <Groups extends CodeMode.ToolGroups>(
  tools: Groups,
  options?: { readonly budgetTokens?: number | undefined }
): Catalog.Catalog => Catalog.catalog(tools, options)
