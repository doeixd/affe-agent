import { Context, Duration, Effect, Option, Result, Schema, Semaphore, Stream } from "effect"
import { positiveInteger } from "../internal/positive.js"
import type { Tool, Toolkit } from "effect/unstable/ai"
import * as Elicitation from "../Elicitation.js"
import * as Permission from "../Permission.js"
import * as ToolExecution from "../ToolExecution.js"
import { CodeDiagnostic } from "./internal/diagnostics.js"
import { interpret, ProgramThrow, type Invoke, type ProgramFailure } from "./internal/interpret.js"
import { parse } from "./internal/parse.js"
import { recover } from "./internal/recover.js"
import { toData } from "./internal/data.js"

/**
 * The code-mode host API (`docs/plan-code-mode-engine.md` step 5).
 *
 * A program the model wrote runs against the toolkits the host supplied,
 * and nothing else -- the engine confines it to those tools and decides
 * nothing about what the tools may do (invariant 1: authority is chosen
 * by the host, per tool, before the program runs).
 *
 * A nested call is a tool call (invariant 2): the same `Permission`
 * projection and policy that govern a direct call govern it here, so code
 * mode is never a cheaper path to a tool. The failure shape is the
 * executor split, decided in the plan: a tool's *declared* failure comes
 * back to the program as `{ ok: false, error }` -- a value its happy path
 * can branch on -- a policy refusal *throws* into the program, and an
 * unknown host failure is opaque.
 *
 * Program outcomes are data, not failures (invariant 3): `execute`
 * succeeds with what happened -- returned, ran off the end, threw, or was
 * refused with a diagnostic naming the fix -- and fails only the host's
 * own way (interruption stays interruption).
 */

/**
 * Anything that groups handled tools under a namespace.
 *
 * `WithHandler<any>` in the *constraint* because `WithHandler` is
 * invariant in its tools: a concrete toolkit is not assignable to
 * `WithHandler<Record<string, Tool.Any>>`. Precision is recovered where
 * it matters -- `ServicesOf` infers the real tool map, and the test pins
 * that `execute`'s requirements are not `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolGroups = Record<string, Toolkit.WithHandler<any>>

/** The services every handler in every group needs. */
export type ServicesOf<Groups extends ToolGroups> = {
  [Namespace in keyof Groups]: Groups[Namespace] extends Toolkit.WithHandler<infer Tools>
    ? Tool.HandlerServices<Tools[keyof Tools]>
    : never
}[keyof Groups]

/** Budgets are host policy: nothing here has a default (plan decision 6). */
export interface Limits {
  /** Nested tool calls one program may make. */
  readonly maxToolCalls?: number | undefined
  /** Wall-clock bound for the whole program. */
  readonly timeout?: Duration.Input | undefined
  /** Cap on the UTF-8 size of the returned value, in bytes. */
  readonly maxOutputBytes?: number | undefined
  /**
   * How many nested calls may be in flight at once.
   *
   * `Promise.all` in a program is `Effect.all` unbounded, which is what
   * JavaScript itself does -- and what lets one program open a hundred
   * connections to an upstream that expected a handful. Bounded here, at
   * the host's boundary, rather than in the interpreter, so every
   * executor obeys it. Unbounded when unset, no default: budgets are
   * host policy.
   */
  readonly maxConcurrentCalls?: number | undefined
}

export interface MakeOptions<Groups extends ToolGroups, R> {
  readonly tools: Groups
  /**
   * Evaluated per nested call, over the tool's own `Permission`
   * projection. `allowAll` when omitted -- the same default a session
   * has. A `Deny` throws into the program; an `Ask` is refused the same
   * way until step 6 wires elicitation, and its message says so.
   */
  readonly permission?: Permission.Policy<R> | undefined
  readonly limits?: Limits | undefined
  /** The engine. The owned interpreter unless a host supplies another. */
  readonly executor?: CodeExecutor | undefined
  /**
   * Where an `Ask` decision is asked (plan step 6).
   *
   * The host supplies it -- usually the very elicitor its session was
   * built with, so an in-program approval is answered through the same
   * channel and appears in `session.pending` beside any other. Absent,
   * an `Ask` throws into the program saying so: no elicitor means no way
   * to ask, and failing closed is the only honest answer.
   *
   * **Not durable.** With a durable elicitor the workflow suspends and
   * the program is re-executed from the top on resume; only journalled
   * tool calls are replay-safe. Durable suspension of a *paused program*
   * is explicitly out of scope (`plan-code-mode-engine.md` decision 7).
   */
  readonly elicitor?: Elicitation.Elicitor | undefined
}

/** One nested call, observed. What step 5's events project from. */
export interface ObservedCall {
  readonly path: ReadonlyArray<string>
  readonly input: unknown
  readonly outcome: "succeeded" | "failed" | "refused"
}

export type Outcome =
  | { readonly _tag: "Returned"; readonly value: unknown }
  | { readonly _tag: "RanOffTheEnd" }
  | { readonly _tag: "Threw"; readonly error: unknown }
  | {
    readonly _tag: "Refused"
    readonly reason: CodeDiagnostic["reason"]
    readonly line: number | undefined
    readonly fix: string
  }

export interface ExecuteResult {
  readonly outcome: Outcome
  readonly logs: ReadonlyArray<ReadonlyArray<unknown>>
  readonly calls: ReadonlyArray<ObservedCall>
  /** What `recover` unwrapped before the program ran. */
  readonly recovered: ReadonlyArray<"fence" | "export-default" | "bare-arrow">
}

/**
 * The engine seam (plan decision 1): one engine today, and the shape that
 * lets a `node:vm` or QuickJS engine arrive behind its own package entry
 * without touching anything above it.
 */
export interface CodeExecutor {
  readonly run: <R>(
    code: string,
    hooks: { readonly invoke: Invoke<R> }
  ) => Effect.Effect<
    {
      readonly result: Option.Option<unknown>
      readonly logs: ReadonlyArray<ReadonlyArray<unknown>>
    },
    ProgramFailure,
    R
  >
}

/** The owned tree-walking interpreter as a `CodeExecutor`. */
export const interpreted: CodeExecutor = {
  run: (code, hooks) =>
    Effect.gen(function*() {
      const parsed = parse(code)
      if (Result.isFailure(parsed)) return yield* parsed.failure
      return yield* interpret(parsed.success, { invoke: hooks.invoke })
    })
}

/** An approval this program is waiting on. */
export interface PendingApproval {
  readonly id: string
  readonly path: ReadonlyArray<string>
  readonly detail: Permission.ApprovalDetail
}

/** Per-run hooks. Progress is the caller's to project. */
export interface ExecuteOptions {
  /**
   * Namespace for the elicitation ids this run allocates. A caller with
   * a tool call id should pass it, so an answer can never be matched to
   * a different program's question. Defaults to a random prefix.
   */
  readonly approvalPrefix?: string | undefined
  /**
   * Called when the program pauses for approval, before the wait begins.
   *
   * The kernel's event bus is not reachable from a tool handler, so this
   * is how an in-program approval becomes visible: `CodeTool` reports it
   * as a preliminary result, which is projected as `ToolCallProgress`.
   * The request is also in `session.pending`, because the elicitor is
   * the session's own.
   */
  readonly onApproval?: ((pending: PendingApproval) => Effect.Effect<void>) | undefined
  /**
   * Called as each nested call settles, so a caller can report progress
   * while the program is still running -- `CodeTool` turns these into
   * preliminary results, which the kernel already projects as
   * `ToolCallProgress` events.
   */
  readonly onCall?: ((call: ObservedCall) => Effect.Effect<void>) | undefined
}

export interface CodeMode<R> {
  readonly execute: (
    program: string,
    options?: ExecuteOptions
  ) => Effect.Effect<ExecuteResult, never, R>
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength

const encodeApproval = Schema.encodeSync(Schema.toCodecJson(Permission.ApprovalDetail))

/**
 * Namespace for one run's elicitation ids when the caller names none.
 *
 * Random rather than a counter: a counter resets with the process, and
 * two runtimes in one session would mint the same id for different
 * questions -- an answer would then be matched to the wrong program.
 */
const randomPrefix = (): string => {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  return `code-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

const refusedOf = (diagnostic: CodeDiagnostic): Outcome => ({
  _tag: "Refused",
  reason: diagnostic.reason,
  line: diagnostic.line,
  fix: diagnostic.fix
})

/**
 * Build a runtime over the supplied toolkits.
 *
 * ```ts
 * const runtime = CodeMode.make({
 *   tools: { github: githubToolkit, net: netToolkit },
 *   limits: { maxToolCalls: 40 }
 * })
 * const outcome = yield* runtime.execute(modelProgram)
 * ```
 */
export const make = <Groups extends ToolGroups, R = never>(
  options: MakeOptions<Groups, R>
): CodeMode<R | ServicesOf<Groups>> => {
  const policy: Permission.Policy<R> = options.permission ?? Permission.allowAll
  const executor = options.executor ?? interpreted

  const execute = (
    program: string,
    runOptions?: ExecuteOptions
  ): Effect.Effect<ExecuteResult, never, R | ServicesOf<Groups>> =>
    Effect.gen(function*() {
      const calls: Array<ObservedCall> = []
      let callCount = 0
      let approvalCount = 0
      const prefix = runOptions?.approvalPrefix ?? randomPrefix()
      const concurrency = options.limits?.maxConcurrentCalls
      const permits = concurrency === undefined
        ? undefined
        : yield* Semaphore.make(positiveInteger("CodeMode maxConcurrentCalls", concurrency))

      const observed = (
        path: ReadonlyArray<string>,
        input: unknown,
        outcome: ObservedCall["outcome"]
      ) =>
        Effect.suspend(() => {
          const call: ObservedCall = { path, input, outcome }
          calls.push(call)
          // Reported as it settles, not at the end: a program that runs
          // for a minute is otherwise invisible for exactly as long as
          // it is interesting.
          return runOptions?.onCall === undefined
            ? Effect.void
            : runOptions.onCall(call)
        })

      const invoke: Invoke<R | ServicesOf<Groups>> = (path, input) =>
        Effect.gen(function*() {
          const refuse = (diagnostic: CodeDiagnostic) =>
            observed(path, input, "refused").pipe(Effect.andThen(diagnostic))
          const rethrow = (error: ProgramThrow) =>
            observed(path, input, "refused").pipe(Effect.andThen(error))

          callCount += 1
          const limit = options.limits?.maxToolCalls
          if (limit !== undefined && callCount > limit) {
            return yield* refuse(
              new CodeDiagnostic({
                reason: "tool-limit",
                fix: `the program made more than ${limit} tool calls; batch work or raise the limit`
              })
            )
          }

          const [namespace, name, ...rest] = path
          const group = namespace === undefined ? undefined : options.tools[namespace]
          // Annotated, not cast: the group's `any` tools would otherwise
          // poison `decide`'s inference all the way to the hook signature.
          const tool: Tool.Any | undefined = group === undefined || name === undefined
            ? undefined
            : group.tools[name]
          if (group === undefined || name === undefined || tool === undefined || rest.length > 0) {
            return yield* rethrow(
              new ProgramThrow({
                value: { message: `no tool at tools.${path.join(".")}; check the catalog` }
              })
            )
          }

          // The boundary, inbound: program arguments become plain data
          // before anything reads them.
          const inputData = toData(input)
          if (Result.isFailure(inputData)) {
            return yield* rethrow(new ProgramThrow({ value: { message: inputData.failure.message } }))
          }

          // Invariant 2: the same permission decision a direct call gets.
          //
          // The second inventoried cast (AGENTS.md, `test/Casts.test.ts`):
          // `ToolExecution.decide` is an `Effect.fn`, and under this
          // instantiation its generic requirement collapses to `unknown`.
          // The only requirement-carrying input is `policy`, typed
          // `Permission.Policy<R>`, so `R` is the truth the wrapper lost.
          const decided = yield* (ToolExecution.decide(tool, {
            id: `code-${callCount}`,
            name: tool.name,
            params: inputData.success
          }, {
            sessionId: "code-mode",
            messages: [],
            permission: policy
          }).pipe(Effect.orDie) as unknown as Effect.Effect<
            | { readonly _tag: "InvalidParameters" }
            | {
              readonly _tag: "Decided"
              readonly decision: Permission.Decision
              readonly request: Permission.Request
            },
            never,
            R
          >)

          if (decided._tag === "Decided") {
            const decision = decided.decision
            if (decision._tag === "Deny") {
              // The executor split: a policy refusal throws into the
              // program -- it must not be ignorable on the happy path.
              return yield* rethrow(
                new ProgramThrow({
                  value: {
                    message: `permission denied for ${tool.name}${decision.reason === undefined ? "" : `: ${decision.reason}`}`
                  }
                })
              )
            }
            if (decision._tag === "Ask") {
              if (options.elicitor === undefined) {
                return yield* rethrow(
                  new ProgramThrow({
                    value: {
                      message: `${tool.name} requires approval and this runtime has no elicitor; call the tool directly`
                    }
                  })
                )
              }
              approvalCount += 1
              const id = `${prefix}-approval-${approvalCount}`
              const detail: Permission.ApprovalDetail = {
                toolName: tool.name,
                toolCallId: `code-${callCount}`,
                action: decided.request.action,
                resource: decided.request.resource,
                ...(decided.request.subject === undefined
                  ? {}
                  : { subject: decided.request.subject }),
                ...(decision.reason === undefined ? {} : { reason: decision.reason })
              }
              // Announced *after* the request registers and before the
              // wait -- the ordering `Elicitor.elicit` documents, and the
              // reason the announcement is passed rather than emitted here.
              const answer = yield* options.elicitor.elicit(
                { id, kind: "tool-approval", detail: encodeApproval(detail) },
                runOptions?.onApproval === undefined
                  ? Effect.void
                  : runOptions.onApproval({ id, path, detail })
              )
              if (!answer.granted) {
                // The executor split, again: a refused approval throws.
                // A program must not be able to ignore it on the happy path.
                return yield* rethrow(
                  new ProgramThrow({
                    value: { message: `approval refused for ${tool.name}` }
                  })
                )
              }
            }
          }

          /**
           * The one erasing cast in `/code`, inventoried in AGENTS.md and
           * `test/Casts.test.ts`. `Toolkit.WithHandler` is invariant in its
           * tools, so the groups are constrained as `WithHandler<any>` and
           * `handle`'s requirement surfaces as `unknown` -- a type-level
           * artifact of the variance boundary, not a missing service. The
           * cast restates the truth the `any` erased: the requirement is
           * `ServicesOf<Groups>`, which `execute` already declares and the
           * caller already provides.
           */
          const drained = group.handle(name, inputData.success).pipe(
            Effect.flatMap((stream) => Stream.runCollect(stream)),
            Effect.map((results) => {
              const all = Array.from(results)
              const final = [...all].reverse().find((entry) => !entry.preliminary)
              return final ?? all[all.length - 1]
            })
          ) as unknown as Effect.Effect<
            { readonly preliminary: boolean; readonly encodedResult: unknown } | undefined,
            unknown,
            ServicesOf<Groups>
          >
          const handled = yield* Effect.result(drained)

          if (Result.isFailure(handled)) {
            // A tool's declared failure is a value the program branches
            // on. Encoded through the data boundary like any result.
            const errorData = toData(handled.failure)
            yield* observed(path, input, "failed")
            return {
              ok: false,
              error: Result.isSuccess(errorData)
                ? errorData.success
                : { message: String(handled.failure) }
            }
          }

          const value = handled.success?.encodedResult
          const outData = toData(value)
          if (Result.isFailure(outData)) {
            return yield* refuse(
              new CodeDiagnostic({
                reason: "host-value",
                fix: `the result of ${tool.name} cannot cross into the program: ${outData.failure.message}`
              })
            )
          }
          yield* observed(path, input, "succeeded")
          return { ok: true, value: outData.success }
        }).pipe(
          // The host's bound on in-flight nested calls, applied around the
          // whole call including its approval wait: a program that is
          // parked on a question is not holding an upstream connection.
          (self) => permits === undefined ? self : permits.withPermits(1)(self),
          // A handler defect is the host's problem, and its cause never
          // reaches the program (invariant 4).
          Effect.catchDefect(() =>
            Effect.fail(
              new CodeDiagnostic({
                reason: "internal",
                fix: `${path.join(".")} failed internally; this is not the program's fault`
              })
            )
          )
        )

      const recovered = recover(program)
      const budget = options.limits?.timeout
      const bounded = executor.run(recovered.code, { invoke }).pipe(
        budget === undefined
          ? (self) => self
          : (self) =>
            Effect.timeout(self, budget).pipe(
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  new CodeDiagnostic({
                    reason: "timeout",
                    fix: `the program exceeded its ${Duration.toMillis(budget)}ms budget; do less per program`
                  })
                ))
            )
      )

      // A defect in the engine is the host's, and no model-written
      // program may fail the agent run with one: it becomes a refusal
      // naming no internals (invariants 3 and 4).
      //
      // **Defence in depth, with no reachable case today.** Every route
      // tried lands somewhere else first: pathological nesting is
      // refused by acorn as a parse error, runaway recursion by
      // `maxCallDepth`, a throwing builtin is converted to a program
      // throw, and a handler defect is caught per call below. It is kept
      // because the alternative to an unreachable guard here is an
      // interpreter bug taking down a run, and it is recorded as
      // unreachable so nobody mistakes it for tested behaviour.
      const attempted = yield* Effect.result(
        Effect.catchDefect(bounded, () =>
          Effect.fail(
            new CodeDiagnostic({
              reason: "internal",
              fix: "the engine could not run this program; simplify it and try again"
            })
          ))
      )
      const finish = (outcome: Outcome): ExecuteResult => ({
        outcome,
        logs: Result.isSuccess(attempted) ? attempted.success.logs : [],
        calls,
        recovered: recovered.applied
      })

      if (Result.isFailure(attempted)) {
        const failure = attempted.failure
        return failure instanceof CodeDiagnostic
          ? finish(refusedOf(failure))
          : finish({ _tag: "Threw", error: failure.value })
      }

      const returned = attempted.success.result
      if (Option.isNone(returned)) return finish({ _tag: "RanOffTheEnd" })

      // The boundary, outbound: the program's answer is plain data or a
      // refusal that says why.
      const outData = toData(returned.value)
      if (Result.isFailure(outData)) {
        return finish(refusedOf(
          new CodeDiagnostic({
            reason: outData.failure.reason === "promise" ? "host-value" : "host-value",
            fix: `the returned value cannot leave the program: ${outData.failure.message}`
          })
        ))
      }
      const maxOut = options.limits?.maxOutputBytes
      if (maxOut !== undefined) {
        // Bytes, as the name says: `.length` counts UTF-16 units, so a
        // budget could be overrun threefold by non-ASCII text alone.
        const size = utf8Bytes(JSON.stringify(outData.success) ?? "")
        if (size > maxOut) {
          return finish(refusedOf(
            new CodeDiagnostic({
              reason: "output-limit",
              fix: `the returned value is ${size} bytes against a ${maxOut}-byte budget; return less, or summarise`
            })
          ))
        }
      }
      return finish({ _tag: "Returned", value: outData.success })
    })

  return { execute }
}
