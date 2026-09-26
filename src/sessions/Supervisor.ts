import { Cause, Clock, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Schema } from "effect"
import { AiError } from "effect/unstable/ai"
import type { LanguageModel, Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"
import * as Budget from "../budget/Budget.js"
import { positiveInteger } from "../internal/positive.js"

/**
 * OTP-style supervision, in process
 * ([plan-supervision.md](../../docs/plan-supervision.md) §4).
 *
 * A supervisor runs a list of children and restarts them by a policy:
 *
 * - **Children are effects.** A child is any `Effect` with an id and a restart
 *   type. `task` builds the common one: an agent session that runs one
 *   prompt. A nested supervisor is `child(id, run(spec))`, so a tree is
 *   supervisors all the way up and one piece of code.
 * - **Restart types** are OTP's. `permanent` restarts after any exit,
 *   `transient` after an abnormal one only, `temporary` never.
 * - **Strategies** are OTP's. `one_for_one` restarts the child that exited.
 *   `one_for_all` stops and restarts every other running child with it.
 *   `rest_for_one` does the same for the children after it, in order.
 *   A temporary child is stopped with its siblings but never restarted.
 * - **Intensity.** More than `maxRestarts` restarts within `within` ends the
 *   supervisor. So does a restart once the children have spent `maxTokens`,
 *   because a restart costs money as well as time.
 *
 * **Classification: the failure decides, not only the policy.** Before an
 * abnormal exit is restarted, `classify` decides whether it should be. The
 * default restarts only an `AiError` that its provider marks `isRetryable`,
 * and escalates everything else. Restarting an agent re-spends what its turns
 * cost, so an unknown failure is escalated rather than retried blindly.
 *
 * **One rule `classify` cannot override.** A failure carrying
 * `DurableToolUnresolvedError`, a tool whose outcome is unknown, always
 * escalates. Restarting it would repeat a side effect that may already have
 * happened.
 *
 * **Escalation** stops every running child and fails `run` with
 * `SupervisorEscalatedError`. A parent supervisor sees that as its child's
 * failure, and escalates it too by default, so a tree gives up from the leaf
 * that could not be fixed.
 *
 * `run` ends when no child is left running: each has exited, and none is due a
 * restart. A permanent child therefore keeps it running until its scope closes.
 * In process only: restart history lives in memory (§5 is the durable form).
 */

export type Restart = "permanent" | "transient" | "temporary"

export type Strategy = "one_for_one" | "one_for_all" | "rest_for_one"

/** One supervised effect. */
export interface Child<E = unknown, R = never> {
  readonly id: string
  readonly run: Effect.Effect<unknown, E, R>
  readonly restart: Restart
}

/** A child from any effect. Transient by default: restarted after an abnormal exit only. */
export const child = <E, R>(
  id: string,
  run: Effect.Effect<unknown, E, R>,
  options?: { readonly restart?: Restart | undefined }
): Child<E, R> => ({ id, run, restart: options?.restart ?? "transient" })

/** A task's submission was interrupted by something other than its supervisor. */
export class TaskInterruptedError extends Schema.TaggedError<TaskInterruptedError>()("TaskInterruptedError", {
  child: Schema.String
}) {
  get message(): string {
    return `task ${this.child} was interrupted before it finished`
  }
}

/**
 * A child that runs `agent` on `prompt`, in a fresh session each time it starts.
 *
 * A restart is a new session asked the same thing: OTP's restart, which
 * starts from the initial state. A completed submission is a normal exit, and
 * a failed or interrupted one is abnormal.
 */
export const task = <
  Tools extends Record<string, Tool.Any>,
  E,
  R,
  Value,
  Input,
  LE
>(
  id: string,
  agent: AgentDefinition<Tools, E, R | Budget.Budget, LanguageModel.LanguageModel, Value, Input>,
  options: {
    readonly prompt: NoInfer<Input>
    /** The child's world: its model and whatever its tools need. */
    readonly provide: Layer.Layer<LanguageModel.LanguageModel | R, LE>
    readonly restart?: Restart | undefined
  }
): Child<AgentSession.PromptError<Tools, E> | TaskInterruptedError | LE, never> =>
  child(
    id,
    Effect.scoped(
      Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        // Explicit type arguments: a generic `Input` is not inferred through
        // `Effect.fn`'s wrapper when it is the caller's own type parameter.
        const result = yield* AgentSession.prompt<Tools, E, Value, Input>(session, options.prompt)
        if (result.status === "interrupted") return yield* new TaskInterruptedError({ child: id })
        return result
      })
    ).pipe((body) =>
      // The budget in context, which is the supervisor's when it caps its
      // children, or a fresh one: provided innermost, a fresh budget would
      // shadow the supervisor's and it would never see what a task spent.
      Effect.flatMap(Effect.serviceOption(Budget.Budget), (ambient) =>
        Effect.provide(
          body,
          Layer.merge(
            options.provide,
            Option.match(ambient, {
              onNone: () => Budget.fresh(),
              onSome: (service) => Layer.succeed(Budget.Budget, service)
            })
          )
        ))
    ),
    { restart: options.restart }
  )

export interface Spec<Children extends ReadonlyArray<Child<any, any>>> {
  /** Names the supervisor in its escalation and its spans. */
  readonly name: string
  readonly strategy?: Strategy | undefined
  /** Restarts allowed within a window before the supervisor gives up. Default 3 within 1 minute. */
  readonly intensity?: {
    readonly maxRestarts: number
    readonly within: Duration.Input
  } | undefined
  /**
   * Tokens the children may spend before a restart is refused. Their turns
   * are charged to a budget of the supervisor's, and to the ambient one too
   * when there is one.
   */
  readonly maxTokens?: number | undefined
  /** Whether an abnormal exit is restarted. See the module notes for the default. */
  readonly classify?: ((cause: Cause.Cause<unknown>) => "restart" | "escalate") | undefined
  readonly children: Children
}

/** One child's requirement. A naked type parameter, so it distributes over `never` and yields `never`. */
type RequirementOf<C> = C extends Child<any, infer R> ? R : never

/** What `run` requires: the union of its children's requirements, `never` for none. */
type RequirementsOf<Children extends ReadonlyArray<Child<any, any>>> = RequirementOf<Children[number]>

/** Why a supervisor gave up. */
export class SupervisorEscalatedError extends Schema.TaggedError<SupervisorEscalatedError>()(
  "SupervisorEscalatedError",
  {
    supervisor: Schema.String,
    child: Schema.String,
    reason: Schema.Literals(["failure", "unresolved", "intensity", "budget"]),
    detail: Schema.String
  }
) {
  get message(): string {
    const why = {
      failure: "failed in a way its classifier would not restart",
      unresolved: "left a tool outcome unknown, which is never restarted",
      intensity: "exceeded the supervisor's restart intensity",
      budget: "would restart after the children spent their token budget"
    }[this.reason]
    return `supervisor ${this.supervisor} gave up: child ${this.child} ${why}: ${this.detail}`
  }
}

/** What a supervisor did, once it ends. */
export interface Report {
  /** Each child, in order, with how many times it was started. */
  readonly children: ReadonlyArray<{ readonly id: string; readonly starts: number }>
}

/** Restart an `AiError` its provider marks retryable; escalate everything else. */
export const defaultClassify = (cause: Cause.Cause<unknown>): "restart" | "escalate" => {
  const failure = cause.reasons.find(Cause.isFailReason)
  return failure !== undefined && AiError.isAiError(failure.error) && failure.error.isRetryable
    ? "restart"
    : "escalate"
}

const tagOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
    ? value._tag
    : undefined

/**
 * Whether a cause carries an unknown tool outcome, as a failure or a defect.
 * By tag, so this module does not import `/durable` to recognise its error.
 */
const unresolved = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) =>
    (Cause.isFailReason(reason) && tagOf(reason.error) === "DurableToolUnresolvedError") ||
    (Cause.isDieReason(reason) && tagOf(reason.defect) === "DurableToolUnresolvedError")
  )

const describe = (cause: Cause.Cause<unknown>): string => {
  const failure = cause.reasons.find(Cause.isFailReason)
  if (failure !== undefined) {
    return failure.error instanceof Error ? failure.error.message : String(failure.error)
  }
  const defect = cause.reasons.find(Cause.isDieReason)
  if (defect !== undefined) return defect.defect instanceof Error ? defect.defect.message : String(defect.defect)
  return "interrupted"
}

interface Exited {
  readonly id: string
  readonly generation: number
  readonly exit: Exit.Exit<unknown, unknown>
}

/**
 * Run `spec`'s children under its policy until none is left running.
 *
 * Fails with `SupervisorEscalatedError` when a failure is not to be
 * restarted, or when intensity or the budget runs out. Interrupting `run`
 * interrupts every child.
 */
export const run = Effect.fn("Supervisor.run")(function*<const Children extends ReadonlyArray<Child<any, any>>>(
  spec: Spec<Children>
) {
  yield* Effect.annotateCurrentSpan({ "supervisor.name": spec.name, "supervisor.children": spec.children.length })
  const ids = new Set<string>()
  for (const entry of spec.children) {
    if (ids.has(entry.id)) return yield* Effect.die(new RangeError(`Supervisor ${spec.name}: duplicate child ${entry.id}`))
    ids.add(entry.id)
  }
  const strategy = spec.strategy ?? "one_for_one"
  const maxRestarts = positiveInteger("Supervisor maxRestarts", spec.intensity?.maxRestarts ?? 3)
  const window = Duration.toMillis(Duration.fromInputUnsafe(spec.intensity?.within ?? "1 minute"))
  const classify = spec.classify ?? defaultClassify
  if (spec.maxTokens !== undefined && !(Number.isFinite(spec.maxTokens) && spec.maxTokens >= 0)) {
    return yield* Effect.die(new RangeError(`Supervisor ${spec.name}: maxTokens must be a finite, non-negative number`))
  }

  // The children's budget, when the spec caps them. It counts their turns
  // and forwards each charge to the ambient budget, so a supervisor inside a
  // budgeted parent is still charged to it.
  const budget = spec.maxTokens === undefined
    ? Option.none<{ readonly own: Budget.Budget["Service"]; readonly provided: Budget.Budget["Service"] }>()
    : Option.some(yield* Effect.gen(function*() {
      const own = yield* Effect.provide(Budget.Budget, Budget.fresh())
      const ambient = yield* Effect.serviceOption(Budget.Budget)
      const provided = Option.match(ambient, {
        onNone: () => own,
        // The ambient totals are what a child reads, as a delegated child
        // reads its parent's: `Budget.within` in a child must see what the
        // application spent before, or it could overrun the application's
        // own limit. The supervisor's count is only for `maxTokens`, and it
        // reads `own` directly.
        onSome: (outer): Budget.Budget["Service"] => ({
          ...outer,
          spend: (tokens, key) => Effect.andThen(own.spend(tokens, key), outer.spend(tokens, key)),
          spendCost: (amount, key) => Effect.andThen(own.spendCost(amount, key), outer.spendCost(amount, key))
        })
      })
      return { own, provided }
    }))

  return yield* Effect.scoped(Effect.gen(function*() {
    const scope = yield* Effect.scope
    const exits = yield* Queue.unbounded<Exited>()
    const running = new Map<string, { readonly fiber: Fiber.Fiber<void>; readonly generation: number }>()
    const generations = new Map<string, number>()
    const starts = new Map<string, number>()
    let restarts: ReadonlyArray<number> = []

    const start = (entry: Child<any, any>) =>
      Effect.gen(function*() {
        const generation = (generations.get(entry.id) ?? 0) + 1
        generations.set(entry.id, generation)
        starts.set(entry.id, (starts.get(entry.id) ?? 0) + 1)
        const body = Option.match(budget, {
          onNone: () => entry.run,
          onSome: ({ provided }) => Effect.provideService(entry.run, Budget.Budget, provided)
        })
        const fiber = yield* body.pipe(
          Effect.exit,
          Effect.flatMap((exit) => Queue.offer(exits, { id: entry.id, generation, exit })),
          Effect.asVoid,
          Effect.forkIn(scope)
        )
        running.set(entry.id, { fiber, generation })
      })

    /** Stop a running child. Its generation moves on first, so its exit, if it reports one, is stale. */
    const stop = (id: string) =>
      Effect.gen(function*() {
        const entry = running.get(id)
        if (entry === undefined) return
        generations.set(id, entry.generation + 1)
        running.delete(id)
        yield* Fiber.interrupt(entry.fiber)
      })

    /** Stop every running child, last started first. */
    const stopAll = Effect.suspend(() =>
      Effect.forEach([...spec.children].reverse(), (entry) => stop(entry.id), { discard: true })
    )

    const escalate = (id: string, reason: SupervisorEscalatedError["reason"], detail: string) =>
      Effect.andThen(
        stopAll,
        Effect.fail(new SupervisorEscalatedError({ supervisor: spec.name, child: id, reason, detail }))
      )

    for (const entry of spec.children) yield* start(entry)

    while (running.size > 0) {
      const exited = yield* Queue.take(exits)
      // An exit from a child the supervisor itself stopped, or from an
      // earlier start of a child already restarted: not news.
      if (generations.get(exited.id) !== exited.generation) continue
      running.delete(exited.id)
      const index = spec.children.findIndex((entry) => entry.id === exited.id)
      const entry = spec.children[index]!
      // Before the restart type: an unknown side effect needs someone told,
      // even from a temporary child that would not be restarted anyway.
      if (Exit.isFailure(exited.exit) && unresolved(exited.exit.cause)) {
        return yield* escalate(entry.id, "unresolved", describe(exited.exit.cause))
      }
      const normal = Exit.isSuccess(exited.exit)
      const due = entry.restart === "permanent" || (entry.restart === "transient" && !normal)
      if (!due) continue

      if (Exit.isFailure(exited.exit) && classify(exited.exit.cause) === "escalate") {
        return yield* escalate(entry.id, "failure", describe(exited.exit.cause))
      }

      const now = yield* Clock.currentTimeMillis
      restarts = restarts.filter((at) => at > now - window)
      if (restarts.length >= maxRestarts) {
        return yield* escalate(entry.id, "intensity", `${restarts.length} restarts within ${window}ms`)
      }
      if (Option.isSome(budget) && spec.maxTokens !== undefined) {
        // The children's own spend, not the ambient total they read.
        const spent = yield* budget.value.own.spent
        if (spent >= spec.maxTokens) {
          return yield* escalate(entry.id, "budget", `${spent} of ${spec.maxTokens} tokens spent`)
        }
      }
      restarts = [...restarts, now]
      yield* Effect.annotateCurrentSpan({ "supervisor.restarted": entry.id })

      // Who restarts with it: nobody, everyone running, or everyone after it.
      const siblings = strategy === "one_for_one"
        ? []
        : spec.children.filter((other, position) =>
          other.id !== entry.id && running.has(other.id) && (strategy === "one_for_all" || position > index)
        )
      for (const other of [...siblings].reverse()) yield* stop(other.id)
      for (const other of spec.children) {
        if (other.id === entry.id || siblings.some((sibling) => sibling.id === other.id && other.restart !== "temporary")) {
          yield* start(other)
        }
      }
    }

    const report: Report = {
      children: spec.children.map((entry) => ({ id: entry.id, starts: starts.get(entry.id) ?? 0 }))
    }
    return report
    // A plain `as`, and the only one here. The children are typed
    // `Child<any, any>` so that one list can hold differently typed effects,
    // so the body's requirement reads as `any`. `RequirementsOf` is the union
    // the list actually carries, and stating it keeps `any` from reaching the
    // caller. Every child error is caught by `Effect.exit`, so the error
    // channel needs no such help.
  })) as Effect.Effect<Report, SupervisorEscalatedError, RequirementsOf<Children>>
})
