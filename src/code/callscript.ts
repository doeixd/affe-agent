import {
  executeScript,
  parseJsScript,
  earlyReturn,
  ScriptValidationError,
  validateScript,
  type ExecuteResult,
  type RunState,
  type Script,
  type ScriptLimits
} from "callscript"
import { Effect, FiberSet, Option } from "effect"
import type * as CodeMode from "./CodeMode.js"
import { CodeDiagnostic } from "./internal/diagnostics.js"
import { ProgramThrow, type Invoke } from "./internal/interpret.js"

/**
 * CallScript as a `CodeExecutor`
 * (`docs/plan-code-mode-executors.md` step 4).
 *
 * The same premise as the owned interpreter, reached from the other end.
 * The model writes JavaScript-shaped source, and **nothing executes it**:
 * `parseJsScript` compiles it into an inert JSON plan of three verbs, and
 * an engine walks that plan. Giving up Turing-completeness buys three
 * things the interpreter cannot have -- the whole program validated
 * before any call runs, a static upper bound on total calls, and a run
 * that **suspends and resumes across a process boundary**, because the
 * plan plus its settled step outputs *is* the state.
 *
 * Neither design subsumes the other, and choosing between them is the
 * host's business:
 *
 * - the owned interpreter has real control flow, `try`/`catch`, and
 *   diagnostics that name the fix. It never suspends.
 * - this one is inspectable, persistable and resumable, and refuses
 *   anything the plan language cannot express.
 *
 * ```ts
 * const runtime = CodeMode.make({
 *   tools: { github },
 *   executor: CallScript.executor()
 * })
 * ```
 *
 * **It never mounts your tools.** Not `fromAISDKTools`, not `fromMCP`.
 * Every call goes back through the host's `invoke` hook, so a nested call
 * passes the same `Permission` decision, emits the same `AgentEvent`s and
 * is redacted the same way as one the interpreter makes. Invariant 2 --
 * *code mode is never a cheaper path to a tool* -- is exactly what an
 * integration with its own tool mounting breaks, and it would break
 * silently, because the program would still work.
 *
 * Everything above this seam is unchanged: `Catalog` renders the same
 * signatures (the authoring surface is JavaScript either way), `CodeTool`
 * is the same tool, the limits are the host's, and `CurrentPrincipal`
 * still reaches every call, because `invoke` runs on the calling fibre.
 */

/** Options this adapter passes through to the engine. */
export interface Options {
  /**
   * CallScript's own plan bounds -- steps, fan-out width, total calls.
   *
   * Distinct from `CodeMode.Limits`, and both apply: these are checked
   * against the *plan*, before it runs, which is the thing this engine
   * can do and the interpreter cannot. The host's `maxToolCalls` and
   * `maxConcurrentCalls` still bound the calls themselves, at the
   * `invoke` boundary, so they hold for every executor.
   *
   * Left unset, the engine's own defaults apply -- unlike
   * `CodeMode.Limits`, which deliberately has none. That is the
   * engine's policy, not a default this module chose.
   */
  readonly limits?: Partial<ScriptLimits> | undefined
  /**
   * Gate a step before it dispatches: `true` parks the run.
   *
   * This is the engine's own approval mechanism, and it is what makes
   * `Suspended` reachable -- the plan pauses, the host persists the state
   * and asks whoever must answer, and a later `execute` with that state
   * continues. The predicate is the host's, so "has this been approved
   * yet" is answered from wherever the host keeps that.
   *
   * **Distinct from `Permission`, and not a replacement for it.** The
   * policy still runs per call inside `invoke`, for both executors, and an
   * `Ask` there is answered by the session's elicitor *within* the run.
   * This gates a step *before* dispatch and can outlive the process, which
   * is the thing the interpreter cannot do at all. A host that wants
   * neither leaves it unset and nothing suspends.
   *
   * **Synchronous**, though the engine would also take a promise. The
   * predicate is consulted from inside the engine's own promise, where
   * there is no fibre to run an `Effect` on, so an async gate here would
   * be an invitation to do I/O outside Effect entirely -- untraced,
   * uninterruptible, and outside every budget. Read a value the host
   * already holds; fetch it before the run, not during it.
   */
  readonly suspendOn?: ((step: { readonly stepId: string; readonly tool: string }) => boolean) | undefined
}

/**
 * What the handler returns when the host refused, to end the run.
 *
 * A sentinel object rather than a string or `undefined`: it becomes the
 * plan's `output` for exactly as long as it takes to be recognised here,
 * and it must not be confusable with a value a program could have
 * produced.
 */
const REFUSED = { "@doeixd/effect-agent/code/callscript": "refused" }

/** `namespace.name` back to the path `invoke` takes. */
const pathOf = (tool: string): ReadonlyArray<string> => tool.split(".")

/**
 * A compile failure as one diagnostic carrying every issue.
 *
 * This is the half of pre-flight the interpreter cannot do at all
 * (step 3): CallScript validates the *whole* plan -- unknown tools,
 * unbound references, malformed arguments, limits -- before a single call
 * runs, so every problem arrives in one turn. `CodeDiagnostic.more` is
 * already the carrier for that, which is why step 3 came first.
 */
const compileFailure = (error: ScriptValidationError): CodeDiagnostic => {
  const issues = error.issues.length > 0
    ? error.issues
    : [{ path: "", message: error.message }]
  const fixOf = (issue: { readonly path: string; readonly message: string }) =>
    issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`
  const [first, ...rest] = issues
  return new CodeDiagnostic({
    reason: "plan-invalid",
    fix: fixOf(first!),
    ...(rest.length === 0
      ? {}
      : { more: rest.map((issue) => ({ reason: "plan-invalid" as const, fix: fixOf(issue) })) })
  })
}

/** Why the run paused, in words a model can act on. */
const suspensionReason = (result: Extract<ExecuteResult, { status: "suspended" }>): string => {
  const first = result.suspensions[0]
  const what = first?.interaction?.title ?? first?.tool ?? first?.key ?? "an external event"
  return result.suspensions.length > 1
    ? `waiting on ${what} and ${result.suspensions.length - 1} more`
    : `waiting on ${what}`
}

/**
 * Build the executor.
 *
 * Requires `callscript` to be installed -- it is an *optional* peer
 * dependency, so it is present only for a host that asked for it, and
 * importing this module without it fails at the import rather than
 * halfway through a run.
 */
export const executor = (options?: Options): CodeMode.CodeExecutor => ({
  // `R` is named here rather than inferred from the interface, because the
  // fibre-set runner has to be instantiated at it: that is what carries
  // the host's services -- `CurrentPrincipal` included -- across the
  // promise boundary the engine's handler puts in the way.
  run: <R>(
    code: string,
    hooks: {
      readonly invoke: Invoke<R>
      readonly resumeFrom?: unknown | undefined
      readonly knownTools: ReadonlySet<string>
    }
  ) =>
    // Scoped for the fibre set: a runner interrupted mid-plan takes its
    // in-flight calls with it, rather than leaving them running against a
    // program nobody is waiting for.
    Effect.scoped(Effect.gen(function*() {
      // Typed at `R`: the runner carries the host's requirements onto the
      // promise boundary, which is what lets a nested call still see
      // `CurrentPrincipal` and the toolkits' own services.
      const runPromise = yield* FiberSet.makeRuntimePromise<R>()

      // A state this engine did not produce is refused, not ignored.
      //
      // The first version started fresh on an unrecognised value, which is
      // the *same* hazard `interpreted` refuses and for the same reason: a
      // host that swapped executors and kept its resume path would get a
      // silent retry -- every call the first attempt made, made again --
      // and a successful-looking run to go with it. "I cannot continue
      // this" is the only safe reading, whichever engine cannot.
      let resumed: RunState | undefined
      if (hooks.resumeFrom !== undefined) {
        if (!isRunState(hooks.resumeFrom)) {
          return yield* new CodeDiagnostic({
            reason: "not-resumable",
            fix:
              "this suspended state was not produced by the plan engine; resume it with the executor that saved it, or start a new run deliberately"
          })
        }
        // Bound here so the guard's narrowing is what types it: reading
        // `hooks.resumeFrom` again below would need a cast, and a cast for
        // something the control flow already proved is the signature's
        // fault, not the world's.
        resumed = hooks.resumeFrom
      }

      // The compiler is given the host's tool list, so an unknown tool is
      // a *compile* error naming every offender -- the check the
      // interpreter can only make from `validate`'s static pass, made here
      // by the engine itself.
      const script: Script = yield* Effect.try({
        // Two calls, not one, and the second is the one that checks tools.
        // `parseJsScript`'s own `tools` only disambiguates a detached call
        // from a plain expression; unknown *names* are `validateScript`'s
        // business. Compiling without it produced a plan that failed at
        // the call, one name at a time -- which is the runtime behaviour
        // this whole step exists to replace, arrived at by accident.
        try: () =>
          validateScript(parseJsScript(code, { tools: hooks.knownTools }), {
            tools: hooks.knownTools,
            unknownToolHint: "check the catalog, or search for it",
            ...(options?.limits ?? {})
          }),
        catch: (error) =>
          error instanceof ScriptValidationError
            ? compileFailure(error)
            : new CodeDiagnostic({
              reason: "parse-error",
              fix: `the program does not compile to a plan: ${
                error instanceof Error ? error.message : String(error)
              }`
            })
      })

      /**
       * A host refusal that escaped through the promise boundary.
       *
       * The reason this exists is a real difference between the engines,
       * and it is the kind that would not have shown up in a test written
       * from the happy path. CallScript hands a rejected `call` to the
       * step's own `onError` policy, so a step marked `onError: "skip"`
       * would **swallow** it. That is right for a tool's declared failure
       * and right for a policy refusal (both are the program's to see and
       * handle -- the interpreter lets `try`/`catch` take them too), and
       * wrong for a `CodeDiagnostic`, which is the *host* refusing:
       * `tool-limit`, a value that cannot cross the data boundary, a
       * handler defect. Those are deliberately not catchable in the
       * interpreter, and letting a plan step skip past one would make
       * code mode's budget advisory.
       *
       * So the handler throws the engine's own `earlyReturn` instead of
       * rejecting: the run ends *at* that step, and the diagnostic is
       * re-raised here. Rejecting and re-raising afterwards also worked,
       * but it let the plan keep going -- every later call refused by
       * `invoke` in turn, so no handler ran twice, yet a budget that only
       * fails a run after it has walked the whole plan is a budget in
       * name. Stopping is what a limit means.
       */
      let refusal: CodeDiagnostic | undefined

      const result = yield* Effect.tryPromise({
        try: () =>
          executeScript(script, {
            handlers: {
              call: (request) =>
                runPromise(
                  hooks.invoke(pathOf(request.tool), request.args).pipe(
                    // A `CodeDiagnostic` is the host refusing and must not
                    // be ignorable; a `ProgramThrow` is the program's own
                    // error and is handed to the plan, which is exactly
                    // what the interpreter does with it.
                    Effect.tapError((failure) =>
                      Effect.sync(() => {
                        if (failure instanceof CodeDiagnostic && refusal === undefined) {
                          refusal = failure
                        }
                      })
                    ),
                    // `catchIf` rather than a rejection: the promise must
                    // *end the run*, and `earlyReturn` is how this engine
                    // is told to do that from inside a handler.
                    Effect.catchIf(
                      (failure): failure is CodeDiagnostic => failure instanceof CodeDiagnostic,
                      () => Effect.sync((): unknown => { throw earlyReturn(REFUSED) })
                    )
                  )
                )
            },
            ...(options?.limits === undefined ? {} : { limits: options.limits }),
            ...(options?.suspendOn === undefined ? {} : { suspend: options.suspendOn }),
            ...(resumed === undefined ? {} : { state: resumed })
          }),
        // The engine itself failing is the host's problem, never the
        // model's fault, and its cause does not reach the program.
        catch: (cause) =>
          new CodeDiagnostic({
            reason: "internal",
            fix: `the plan engine could not run this program: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          })
      })

      if (refusal !== undefined) return yield* refusal

      switch (result.status) {
        case "ok":
          // CallScript has no "ran off the end": a plan without an
          // `output` yields `undefined`, which is the same fact, so it is
          // reported as the same outcome.
          return {
            _tag: "Completed" as const,
            result: result.output === undefined
              ? Option.none()
              : Option.some(result.output),
            logs: []
          }
        case "suspended":
          return {
            _tag: "Suspended" as const,
            state: result.state,
            reason: suspensionReason(result),
            logs: []
          }
        case "error":
          // A step failed and the plan did not handle it. The program's
          // own error, so it travels as a `ProgramThrow` carrying plain
          // data -- never the thrown object.
          return yield* new ProgramThrow({
            value: {
              message: result.error.message,
              ...(result.error.code === undefined ? {} : { code: result.error.code }),
              at: result.at
            }
          })
      }
    }))
})

/**
 * Is this a state this engine produced?
 *
 * Shape-checked rather than trusted, because the seam types it `unknown`
 * (deliberately: the schema belongs to whichever engine saved it) and a
 * host holding two executors can hand back the wrong one.
 */
const isRunState = (value: unknown): value is RunState =>
  typeof value === "object" && value !== null &&
  (value as { readonly version?: unknown }).version === "2" &&
  typeof (value as { readonly steps?: unknown }).steps === "object"
