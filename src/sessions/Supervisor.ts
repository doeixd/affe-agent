import { Cause, Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Schema, Scope, Semaphore } from "effect"
import { AiError, Prompt, Tool } from "effect/unstable/ai"
import type { LanguageModel } from "effect/unstable/ai"
import { PersistedQueue } from "effect/unstable/persistence"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"
import * as Budget from "../budget/Budget.js"
import * as Namespace from "../internal/namespace.js"
import { positiveInteger } from "../internal/positive.js"
import * as Messaging from "./Messaging.js"
import * as SessionInbox from "./SessionInbox.js"

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
 * **An agent can be consulted instead** (§4.1). Given `onGiveUp: ask(...)`,
 * the supervisor does not escalate at once. It opens a decision, tells a
 * supervising agent through `notify`, and waits. The agent acts through
 * `control`'s tools and ends with `resume` or `give_up`. With no decision in
 * time, the supervisor escalates exactly as it would have.
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
  /**
   * Whether a start can take a supervisor's note (`restart_child`'s
   * `instructions`). A fresh task can; any other child is refused one rather
   * than having it silently dropped.
   */
  readonly guidance?: boolean | undefined
}

/** A child from any effect. Transient by default: restarted after an abnormal exit only. */
export const child = <E, R>(
  id: string,
  run: Effect.Effect<unknown, E, R>,
  options?: { readonly restart?: Restart | undefined }
): Child<E, R> => ({ id, run, restart: options?.restart ?? "transient" })

/** What a supervisor can read of a child's session, and how it steers one that is running. */
export interface SessionView {
  readonly sessionId: string
  readonly history: Effect.Effect<Prompt.Prompt>
  /** Steer the session's running submission. Fails with a sentence when it is not running. */
  readonly steer: (text: string) => Effect.Effect<void, string>
}

/**
 * What the supervisor tells one start of one child.
 *
 * Provided by the supervisor to each start; `None` outside one, where a task
 * behaves as a fresh task with no supervisor to tell.
 */
export interface ChildContext {
  readonly id: string
  /** The supervisor's scope. A `resubmit` task keeps its session in it. */
  readonly scope: Scope.Scope
  /** A note for this start, from `restart_child`. */
  readonly guidance: Option.Option<string>
  /** Tell the supervisor which session this start is running, for `inspect_child`. */
  readonly publish: (view: SessionView) => Effect.Effect<void>
}

export const CurrentChild = Context.Reference<Option.Option<ChildContext>>(Namespace.tag("sessions/CurrentChild"), {
  defaultValue: () => Option.none()
})

/** A task's submission was interrupted by something other than its supervisor. */
export class TaskInterruptedError extends Schema.TaggedError<TaskInterruptedError>()("TaskInterruptedError", {
  child: Schema.String
}) {
  get message(): string {
    return `task ${this.child} was interrupted before it finished`
  }
}

/**
 * A child that runs `agent` on `prompt`.
 *
 * - **`fresh`** (the default): a new session each start, which is OTP's
 *   restart, from the initial state. A supervisor's note, when
 *   `restart_child` gives one, is seeded into the new session after the
 *   agent's own instructions.
 * - **`resubmit`**: one session for the life of the supervisor, asked again
 *   on each start, so a retry sees the failed attempt in its history. It
 *   takes no note; steering it is item 140.
 *
 * A completed submission is a normal exit, and a failed or interrupted one is
 * abnormal.
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
    readonly mode?: "fresh" | "resubmit" | undefined
  }
): Child<AgentSession.PromptError<Tools, E> | TaskInterruptedError | LE, never> => {
  const mode = options.mode ?? "fresh"
  // One kept session per supervisor, keyed by its scope: a task value reused
  // by two supervisors must not hand one's session to the other.
  const kept = new WeakMap<Scope.Scope, AgentSession.AgentSession<Tools, E, Value, Input>>()

  const ask = (session: AgentSession.AgentSession<Tools, E, Value, Input>, context: Option.Option<ChildContext>) =>
    Effect.gen(function*() {
      if (Option.isSome(context)) {
        yield* context.value.publish({
          sessionId: session.id,
          history: AgentSession.history(session),
          // A user-role steer, framed: it is the supervisor's, not the person's.
          steer: (text) =>
            AgentSession.steer(session, `A note from your supervisor: ${text}`).pipe(
              Effect.mapError((error) => error.message)
            )
        })
      }
      // Explicit type arguments: a generic `Input` is not inferred through
      // `Effect.fn`'s wrapper when it is the caller's own type parameter.
      const result = yield* AgentSession.prompt<Tools, E, Value, Input>(session, options.prompt)
      if (result.status === "interrupted") return yield* new TaskInterruptedError({ child: id })
      return result
    })

  const body = Effect.gen(function*() {
    const context = yield* CurrentChild
    if (mode === "resubmit" && Option.isSome(context)) {
      const existing = kept.get(context.value.scope)
      const session = existing ?? (yield* AgentSession.make(agent).pipe(Scope.provide(context.value.scope)))
      kept.set(context.value.scope, session)
      return yield* ask(session, context)
    }
    const note = Option.flatMap(context, (current) => current.guidance)
    return yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* AgentSession.make(
        agent,
        Option.match(note, {
          onNone: () => ({}),
          // The agent's instructions first, as they would be without a
          // history, then the supervisor's note.
          onSome: (text) => ({
            history: Prompt.fromMessages([
              ...Option.match(agent.instructions, {
                onNone: () => [],
                onSome: (content) => [Prompt.systemMessage({ content })]
              }),
              Prompt.systemMessage({ content: `A note from your supervisor, for this attempt: ${text}` })
            ])
          })
        })
      )
      return yield* ask(session, context)
    }))
  })

  return {
    id,
    restart: options.restart ?? "transient",
    guidance: mode === "fresh",
    run: body.pipe((run) =>
      // The budget in context, which is the supervisor's when it caps its
      // children, or a fresh one: provided innermost, a fresh budget would
      // shadow the supervisor's and it would never see what a task spent.
      Effect.flatMap(Effect.serviceOption(Budget.Budget), (ambient) =>
        Effect.provide(
          run,
          Layer.merge(
            options.provide,
            Option.match(ambient, {
              onNone: () => Budget.fresh(),
              onSome: (service) => Layer.succeed(Budget.Budget, service)
            })
          )
        ))
    )
  }
}

// ---------------------------------------------------------------------------
// An agent as supervisor (§4.1)

/** How a consultation ended. */
export type Outcome = "resumed" | "gave-up" | "timed-out"

/** One consultation, as `Report.decisions` records it. */
export interface Decision {
  readonly child: string
  readonly reason: SupervisorEscalatedError["reason"]
  /** What the agent did, in order: `restart a`, `stop b`. */
  readonly actions: ReadonlyArray<string>
  readonly outcome: Outcome
  /** The agent's note (`resume`) or reason (`give_up`). */
  readonly note: Option.Option<string>
}

/** What a running supervisor lets its control do. Internal: the tools call it. */
interface Attached {
  readonly name: string
  readonly list: Effect.Effect<string>
  readonly inspect: (id: string) => Effect.Effect<string, string>
  readonly restart: (id: string, instructions: Option.Option<string>) => Effect.Effect<string, string>
  readonly stop: (id: string) => Effect.Effect<string, string>
  readonly steer: (id: string, text: string) => Effect.Effect<string, string>
  readonly start: (template: string, input: string) => Effect.Effect<string, string>
  readonly decide: (
    decision: { readonly _tag: "resume" | "give_up"; readonly note: Option.Option<string> }
  ) => Effect.Effect<string, string>
}

const noSupervisor = "no supervisor is attached to this control; there is nothing to act on"

const listDefinition = (prefix: string) =>
  Tool.make(`${prefix}list_children`, {
    description: "List the supervised children: status, starts, and last failure.",
    parameters: Schema.Struct({}),
    success: Schema.String,
    failure: Schema.String
  }).annotate(Tool.Readonly, true)

const inspectDefinition = (prefix: string) =>
  Tool.make(`${prefix}inspect_child`, {
    description: "Read one child's status and, for an agent task, the end of its latest session.",
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  }).annotate(Tool.Readonly, true)

const restartDefinition = (prefix: string) =>
  Tool.make(`${prefix}restart_child`, {
    description:
      "Start a child again. `instructions` is a note its fresh session starts with. Counts toward the restart limit and the budget.",
    parameters: Schema.Struct({ id: Schema.String, instructions: Schema.optional(Schema.String) }),
    success: Schema.String,
    failure: Schema.String
  })

const stopDefinition = (prefix: string) =>
  Tool.make(`${prefix}stop_child`, {
    description: "Stop a running child. It is not restarted.",
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })

const steerDefinition = (prefix: string) =>
  Tool.make(`${prefix}steer_child`, {
    description: "Give a running agent task a note it reads at its next turn.",
    parameters: Schema.Struct({ id: Schema.String, text: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })

const startDefinition = (prefix: string) =>
  Tool.make(`${prefix}start_child`, {
    description:
      "Start a new child from one of the supervisor's templates, which list_children names, with an input for it. Returns its id.",
    parameters: Schema.Struct({ template: Schema.String, input: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })

const resumeDefinition = (prefix: string) =>
  Tool.make(`${prefix}resume`, {
    description: "End the decision: the supervisor carries on with the children as they now are.",
    parameters: Schema.Struct({ note: Schema.optional(Schema.String) }),
    success: Schema.String,
    failure: Schema.String
  })

const giveUpDefinition = (prefix: string) =>
  Tool.make(`${prefix}give_up`, {
    description: "End the decision: the supervisor stops its children and escalates, with your reason.",
    parameters: Schema.Struct({ reason: Schema.String }),
    success: Schema.String,
    failure: Schema.String
  })

/**
 * What decides for a supervisor: the tools a supervising agent acts
 * through, and the same operations as plain effects, for an operator or a
 * UI to decide with instead. Bound to one supervisor.
 *
 * Make one, build the agent with `control.tools`, and give the supervisor
 * `ask({ control, ... })`: `run` attaches to the control while it runs. The
 * operations that change anything act only while the supervisor is waiting
 * for a decision; at any other time they say so. Every operation fails with
 * a sentence, which is what a tool returns to its model.
 */
export const control = Effect.fn("Supervisor.control")(function*(options?: {
  /** Prefixes every tool name, for an agent that supervises more than one. */
  readonly prefix?: string | undefined
}) {
  const prefix = options?.prefix ?? ""
  const attached = yield* Ref.make(Option.none<Attached>())
  const on = <A>(use: (supervisor: Attached) => Effect.Effect<A, string>) =>
    Effect.flatMap(Ref.get(attached), Option.match({ onNone: () => Effect.fail(noSupervisor), onSome: use }))
  const list = on((supervisor) => supervisor.list)
  const inspect = (id: string) => on((supervisor) => supervisor.inspect(id))
  const restart = (id: string, instructions?: string) =>
    on((supervisor) => supervisor.restart(id, Option.fromNullishOr(instructions)))
  const stop = (id: string) => on((supervisor) => supervisor.stop(id))
  const steer = (id: string, text: string) => on((supervisor) => supervisor.steer(id, text))
  const start = (template: string, input: string) => on((supervisor) => supervisor.start(template, input))
  const resume = (note?: string) =>
    on((supervisor) => supervisor.decide({ _tag: "resume", note: Option.fromNullishOr(note) }))
  const giveUp = (reason: string) => on((supervisor) => supervisor.decide({ _tag: "give_up", note: Option.some(reason) }))
  const tools = [
    Agent.tool(listDefinition(prefix), () => list),
    Agent.tool(inspectDefinition(prefix), ({ id }) => inspect(id)),
    Agent.tool(restartDefinition(prefix), ({ id, instructions }) => restart(id, instructions)),
    Agent.tool(stopDefinition(prefix), ({ id }) => stop(id)),
    Agent.tool(steerDefinition(prefix), ({ id, text }) => steer(id, text)),
    Agent.tool(startDefinition(prefix), ({ template, input }) => start(template, input)),
    Agent.tool(resumeDefinition(prefix), ({ note }) => resume(note)),
    Agent.tool(giveUpDefinition(prefix), ({ reason }) => giveUp(reason))
  ] as const
  return {
    tools,
    list,
    inspect,
    restart,
    stop,
    steer,
    start,
    resume,
    giveUp,
    /** Which supervisor is attached. `run` sets it; nothing else should. */
    attached
  }
})

export type Control = Effect.Success<ReturnType<typeof control>>

/** A supervisor that consults an agent where it would give up. */
export interface Ask {
  readonly control: Control
  /** Tell the supervising agent a decision is waiting. See `toInbox`. */
  readonly notify: (message: string) => Effect.Effect<void>
  /** How long to wait for `resume` or `give_up` before giving up anyway. */
  readonly timeout: Duration.Input
  /** Restarts the agent may make beyond the intensity limit, over the supervisor's life. Default 0. */
  readonly grant?: { readonly restarts: number } | undefined
}

/** `onGiveUp`'s value. */
export const ask = (options: Ask): Ask => options

/**
 * A `notify` that puts the message into `sessionId`'s inbox, as a framework
 * system message on `Messaging`'s queue, so the loop that delivers messages
 * delivers it when the agent is idle.
 */
export const toInbox = Effect.fn("Supervisor.toInbox")(function*(
  sessionId: string,
  options?: { readonly name?: string | undefined }
) {
  const queue = yield* PersistedQueue.make({ name: options?.name ?? Messaging.defaultName, schema: SessionInbox.Item })
  return (message: string): Effect.Effect<void> =>
    Effect.gen(function*() {
      // One item per consultation: a fresh id, because each is a new request.
      const id = `supervisor:${globalThis.crypto.randomUUID()}`
      yield* queue.offer({
        id,
        sessionId,
        kind: "framework",
        input: Prompt.fromMessages([Prompt.systemMessage({ content: message })]),
        source: { kind: "supervisor" },
        createdAt: yield* Clock.currentTimeMillis
      }, { id })
    }).pipe(
      // A notice the queue refused is the timeout's to handle: the
      // supervisor gives up as it would have, rather than failing here. The
      // typed failure only: an interruption is not a refusal, and must not
      // be turned into a success.
      Effect.catch((error) => Effect.logWarning("Supervisor.toInbox: the decision notice was not queued", error))
    )
})

// ---------------------------------------------------------------------------

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
  /**
   * Whether an abnormal exit is restarted. See the module notes for the
   * default. `"ask"` consults `onGiveUp`'s agent about this exit, and without
   * one it is `"escalate"`.
   */
  readonly classify?: ((cause: Cause.Cause<unknown>) => "restart" | "escalate" | "ask") | undefined
  /** Consult an agent where the supervisor would give up (§4.1). */
  readonly onGiveUp?: Ask | undefined
  /**
   * Children the agent may start with `start_child`, by name. A template
   * makes a child that requires nothing: the model supplies only its input.
   */
  readonly templates?: Readonly<Record<string, Template>> | undefined
  /** How many children `start_child` may start, over the supervisor's life. Default 8. */
  readonly maxTemplateStarts?: number | undefined
  readonly children: Children
}

/** A child the supervising agent may start, from a string it supplies. */
export interface Template {
  /** What the child does, written for the supervising model. */
  readonly description: string
  /** Make the child. Its id is `id`, which the supervisor chooses. */
  readonly make: (options: { readonly id: string; readonly input: string }) => Child<unknown, never>
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
  /** Each consultation of the supervising agent, in order. */
  readonly decisions: ReadonlyArray<Decision>
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

/** How much of a child's session `inspect_child` shows. */
const inspectMessages = 6
const inspectCharacters = 4_000

const renderHistory = (prompt: Prompt.Prompt): string => {
  const text = prompt.content.slice(-inspectMessages).map((message) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(" ")
    return `${message.role}: ${content}`
  }).join("\n")
  return text.length > inspectCharacters ? `…${text.slice(-inspectCharacters)}` : text
}

interface Exited {
  readonly id: string
  readonly generation: number
  readonly exit: Exit.Exit<unknown, unknown>
}

type Status = "running" | "exited" | "failed" | "stopped"

interface ChildState {
  status: Status
  starts: number
  last: Option.Option<string>
  unknownOutcome: boolean
  guidance: Option.Option<string>
  view: Option.Option<SessionView>
}

/** What the main loop does after one exit. */
type Step =
  | { readonly _tag: "Continue" }
  | {
    readonly _tag: "GiveUp"
    readonly child: string
    readonly reason: SupervisorEscalatedError["reason"]
    readonly detail: string
  }

const reasonText: Record<SupervisorEscalatedError["reason"], string> = {
  failure: "failed in a way its classifier would not restart",
  unresolved: "left a tool outcome unknown; it cannot be restarted",
  intensity: "exceeded the restart intensity",
  budget: "would restart after the children spent their token budget"
}

/**
 * Run `spec`'s children under its policy until none is left running.
 *
 * Fails with `SupervisorEscalatedError` when a failure is not to be
 * restarted, or when intensity or the budget runs out, unless `onGiveUp`'s
 * agent resumes it. Interrupting `run` interrupts every child.
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
  const consult = spec.onGiveUp
  // Parsed here, so a bad timeout fails the spec at once, not at the first
  // consultation, which may be long after.
  const consultTimeout = consult === undefined ? undefined : Duration.fromInputUnsafe(consult.timeout)
  const grantRestarts = consult?.grant?.restarts ?? 0
  const templates = spec.templates ?? {}
  const maxTemplateStarts = spec.maxTemplateStarts ?? 8
  if (!Number.isSafeInteger(maxTemplateStarts) || maxTemplateStarts < 0) {
    return yield* Effect.die(new RangeError(`Supervisor ${spec.name}: maxTemplateStarts must be a non-negative integer`))
  }
  if (!Number.isSafeInteger(grantRestarts) || grantRestarts < 0) {
    return yield* Effect.die(new RangeError(`Supervisor ${spec.name}: grant.restarts must be a non-negative integer`))
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
    // The supervisor's own context, which every start runs in, replaced
    // whole: a restart the agent asks for is started from the agent's tool
    // fibre, and must see the supervisor's services, not the agent's.
    // Typed `any` for the reason the final assertion below gives: the
    // children's bodies require `any`, and a context is invariant.
    const services = yield* Effect.context<any>()
    const exits = yield* Queue.unbounded<Exited>()
    // One permit: the main loop and the agent's tools both change the
    // children, and each change must see the state the last one left.
    const lock = yield* Semaphore.make(1)
    const running = new Map<string, { readonly fiber: Fiber.Fiber<void>; readonly generation: number }>()
    const generations = new Map<string, number>()
    const fresh = (): ChildState => ({
      status: "exited",
      starts: 0,
      last: Option.none(),
      unknownOutcome: false,
      guidance: Option.none(),
      view: Option.none()
    })
    const states = new Map<string, ChildState>(spec.children.map((entry) => [entry.id, fresh()]))
    // Children the agent started from templates, in the order it started
    // them: after the spec's own, so `rest_for_one` reads them as later.
    const started: Array<Child<any, any>> = []
    const children = (): ReadonlyArray<Child<any, any>> => [...spec.children, ...started]
    const stateOf = (id: string): ChildState => states.get(id)!
    const decisions: Array<Decision> = []
    let restarts: ReadonlyArray<number> = []
    let grantLeft = grantRestarts
    let pending = Option.none<{
      readonly child: string
      readonly deferred: Deferred.Deferred<{ readonly _tag: "resume" | "give_up"; readonly note: Option.Option<string> }>
      readonly actions: Array<string>
    }>()

    const start = (entry: Child<any, any>) =>
      Effect.gen(function*() {
        const generation = (generations.get(entry.id) ?? 0) + 1
        generations.set(entry.id, generation)
        const state = stateOf(entry.id)
        state.starts += 1
        state.status = "running"
        const guidance = state.guidance
        state.guidance = Option.none()
        const context: ChildContext = {
          id: entry.id,
          scope,
          guidance,
          publish: (view) => Effect.sync(() => void (stateOf(entry.id).view = Option.some(view)))
        }
        const provided = Effect.provideService(entry.run, CurrentChild, Option.some(context))
        const body = Option.match(budget, {
          onNone: () => provided,
          onSome: (service) => Effect.provideService(provided, Budget.Budget, service.provided)
        })
        const fiber = yield* body.pipe(
          Effect.exit,
          Effect.flatMap((exit) => Queue.offer(exits, { id: entry.id, generation, exit })),
          Effect.asVoid,
          (child) => Effect.updateContext(child, (_: Context.Context<never>) => services),
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
        stateOf(id).status = "stopped"
        yield* Fiber.interrupt(entry.fiber)
      })

    /** Stop every running child, last started first. */
    const stopAll = Effect.suspend(() =>
      Effect.forEach([...children()].reverse(), (entry) => stop(entry.id), { discard: true })
    )

    const escalate = (id: string, reason: SupervisorEscalatedError["reason"], detail: string) =>
      Effect.andThen(
        lock.withPermits(1)(stopAll),
        Effect.fail(new SupervisorEscalatedError({ supervisor: spec.name, child: id, reason, detail }))
      )

    /** Whether one more restart fits: the window, then the allowance, then the budget. */
    const admitRestart = Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      restarts = restarts.filter((at) => at > now - window)
      if (restarts.length >= maxRestarts) {
        return Option.some<SupervisorEscalatedError["reason"]>("intensity")
      }
      if (Option.isSome(budget) && spec.maxTokens !== undefined) {
        // The children's own spend, not the ambient total they read.
        if ((yield* budget.value.own.spent) >= spec.maxTokens) return Option.some<SupervisorEscalatedError["reason"]>("budget")
      }
      restarts = [...restarts, now]
      return Option.none<SupervisorEscalatedError["reason"]>()
    })

    const summary = (id: string): string => {
      const state = stateOf(id)
      const last = Option.match(state.last, { onNone: () => "", onSome: (text) => `; last failure: ${text}` })
      const unknown = state.unknownOutcome ? "; its tool outcome is unknown" : ""
      return `${id}: ${state.status}, ${state.starts} start(s)${last}${unknown}`
    }

    const find = (id: string): Effect.Effect<Child<any, any>, string> => {
      const entry = children().find((candidate) => candidate.id === id)
      return entry === undefined
        ? Effect.fail(`${id} is not a child of supervisor ${spec.name}; list_children names them`)
        : Effect.succeed(entry)
    }

    /** A change the agent asks for: only while a decision is pending, and under the lock. */
    const change = <A>(label: (a: A) => string, act: Effect.Effect<A, string>) =>
      lock.withPermits(1)(Effect.gen(function*() {
        if (Option.isNone(pending)) {
          return yield* Effect.fail(
            `supervisor ${spec.name} is not waiting for a decision; it is handling its children itself`
          )
        }
        const done = yield* act
        pending.value.actions.push(label(done))
        return done
      }))

    const attached: Attached = {
      name: spec.name,
      list: lock.withPermits(1)(Effect.gen(function*() {
        const spent = Option.isSome(budget)
          ? `\nSpent: ${yield* budget.value.own.spent} of ${spec.maxTokens} tokens.`
          : ""
        const names = Object.keys(templates)
        const offered = names.length === 0
          ? ""
          : `\nTemplates for start_child:\n${names.map((name) => `- ${name}: ${templates[name]!.description}`).join("\n")}`
        return `${children().map((entry) => summary(entry.id)).join("\n")}${spent}${offered}`
      })),
      inspect: (id) =>
        Effect.gen(function*() {
          yield* find(id)
          const view = stateOf(id).view
          const history = Option.isSome(view) ? `\nSession ${view.value.sessionId}:\n${renderHistory(yield* view.value.history)}` : ""
          return `${summary(id)}${history}`
        }),
      restart: (id, instructions) =>
        change((text: string) => text, Effect.gen(function*() {
          const entry = yield* find(id)
          const state = stateOf(id)
          if (state.unknownOutcome) {
            return yield* Effect.fail(`${id} left a tool outcome unknown; restarting it could repeat that side effect`)
          }
          if (Option.isSome(instructions) && entry.guidance !== true) {
            return yield* Effect.fail(`${id} takes no instructions; restart it without them`)
          }
          const refused = yield* admitRestart
          if (Option.isSome(refused)) {
            if (refused.value === "budget" || grantLeft === 0) {
              return yield* Effect.fail(
                refused.value === "budget"
                  ? `the children have spent their token budget; ${id} cannot be restarted`
                  : `the restart limit is reached and no allowance is left; ${id} cannot be restarted`
              )
            }
            grantLeft -= 1
          }
          yield* stop(id)
          state.guidance = instructions
          yield* start(entry)
          return `restart ${id}`
        })),
      stop: (id) =>
        change((text: string) => text, Effect.gen(function*() {
          yield* find(id)
          if (!running.has(id)) return yield* Effect.fail(`${id} is not running`)
          yield* stop(id)
          return `stop ${id}`
        })),
      steer: (id, text) =>
        change((done: string) => done, Effect.gen(function*() {
          yield* find(id)
          if (!running.has(id)) return yield* Effect.fail(`${id} is not running; only a running task can be steered`)
          const view = stateOf(id).view
          if (Option.isNone(view)) return yield* Effect.fail(`${id} is not an agent task; it has no session to steer`)
          yield* view.value.steer(text)
          return `steer ${id}`
        })),
      start: (name, input) =>
        change((done: string) => `start ${done}`, Effect.gen(function*() {
          const template = templates[name]
          if (template === undefined) {
            const names = Object.keys(templates)
            return yield* Effect.fail(
              names.length === 0
                ? `supervisor ${spec.name} has no templates`
                : `there is no template ${name}; the templates are ${names.join(", ")}`
            )
          }
          if (started.length >= maxTemplateStarts) {
            return yield* Effect.fail(`${maxTemplateStarts} children have been started from templates; no more may be`)
          }
          if (Option.isSome(budget) && spec.maxTokens !== undefined) {
            if ((yield* budget.value.own.spent) >= spec.maxTokens) {
              return yield* Effect.fail("the children have spent their token budget; no child can be started")
            }
          }
          // The supervisor names it, never the model: the id is unique by
          // construction and cannot collide with or impersonate another child.
          const taken = new Set(children().map((entry) => entry.id))
          let n = 1
          while (taken.has(`${name}-${n}`)) n += 1
          const id = `${name}-${n}`
          const made = template.make({ id, input })
          if (made.id !== id) {
            return yield* Effect.die(new RangeError(`Supervisor ${spec.name}: template ${name} made a child named ${made.id}, not ${id}`))
          }
          started.push(made)
          states.set(id, fresh())
          yield* start(made)
          return id
        })),
      decide: (decision) =>
        lock.withPermits(1)(Effect.gen(function*() {
          if (Option.isNone(pending)) {
            return yield* Effect.fail(`supervisor ${spec.name} is not waiting for a decision`)
          }
          yield* Deferred.succeed(pending.value.deferred, decision)
          return decision._tag === "resume" ? "The supervisor carries on." : "The supervisor gives up."
        }))
    }

    if (consult !== undefined) {
      const claimed = yield* Ref.modify(consult.control.attached, (current) =>
        Option.isSome(current) ? [false, current] as const : [true, Option.some(attached)] as const)
      if (!claimed) {
        return yield* Effect.die(new RangeError(`Supervisor ${spec.name}: its control is already attached to a running supervisor`))
      }
      yield* Effect.addFinalizer(() => Ref.set(consult.control.attached, Option.none()))
    }

    /**
     * Where the supervisor would give up: ask the agent, when there is one.
     * Runs outside the lock, so the agent's tools can take it.
     */
    const giveUp = (step: Extract<Step, { readonly _tag: "GiveUp" }>) =>
      Effect.gen(function*() {
        if (consult === undefined) return yield* escalate(step.child, step.reason, step.detail)
        const deferred = yield* Deferred.make<{ readonly _tag: "resume" | "give_up"; readonly note: Option.Option<string> }>()
        const actions: Array<string> = []
        yield* lock.withPermits(1)(Effect.sync(() => void (pending = Option.some({ child: step.child, deferred, actions }))))
        const timeout = consultTimeout ?? Duration.fromInputUnsafe(consult.timeout)
        const situation = [
          `Supervisor ${spec.name} needs a decision.`,
          `Child ${step.child} ${reasonText[step.reason]}: ${step.detail}.`,
          "Children:",
          ...children().map((entry) => `- ${summary(entry.id)}`),
          "Use list_children and inspect_child to look; restart_child, stop_child, steer_child and start_child to act.",
          "Then call resume to let the supervisor carry on, or give_up to let it escalate.",
          `Without a decision within ${Duration.format(timeout)}, it gives up.`
        ].join("\n")
        yield* consult.notify(situation)
        const decided = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeout))
        yield* lock.withPermits(1)(Effect.sync(() => void (pending = Option.none())))
        const outcome: Outcome = Option.match(decided, {
          onNone: () => "timed-out",
          onSome: (decision) => decision._tag === "resume" ? "resumed" : "gave-up"
        })
        const note = Option.flatMap(decided, (decision) => decision.note)
        decisions.push({ child: step.child, reason: step.reason, actions, outcome, note })
        yield* Effect.annotateCurrentSpan({ "supervisor.decision": outcome })
        if (outcome === "resumed") return
        const why = outcome === "timed-out"
          ? `the supervising agent did not decide within ${Duration.format(timeout)}`
          : `the supervising agent gave up: ${Option.getOrElse(note, () => "")}`
        return yield* escalate(step.child, step.reason, `${step.detail}; ${why}`)
      })

    /** One exit, under the lock: what to do about it. */
    const handle = (exited: Exited) =>
      Effect.gen(function*(): Generator<any, Step, any> {
        // An exit from a child the supervisor itself stopped, or from an
        // earlier start of a child already restarted: not news.
        if (generations.get(exited.id) !== exited.generation) return { _tag: "Continue" }
        running.delete(exited.id)
        const all = children()
        const index = all.findIndex((entry) => entry.id === exited.id)
        const entry = all[index]!
        const state = stateOf(entry.id)
        if (Exit.isSuccess(exited.exit)) {
          state.status = "exited"
        } else {
          state.status = "failed"
          state.last = Option.some(describe(exited.exit.cause))
        }
        // Before the restart type: an unknown side effect needs someone told,
        // even from a temporary child that would not be restarted anyway.
        if (Exit.isFailure(exited.exit) && unresolved(exited.exit.cause)) {
          state.unknownOutcome = true
          return { _tag: "GiveUp", child: entry.id, reason: "unresolved", detail: describe(exited.exit.cause) }
        }
        const normal = Exit.isSuccess(exited.exit)
        const due = entry.restart === "permanent" || (entry.restart === "transient" && !normal)
        if (!due) return { _tag: "Continue" }

        if (Exit.isFailure(exited.exit)) {
          const answer = classify(exited.exit.cause)
          if (answer !== "restart") {
            const detail = describe(exited.exit.cause)
            return {
              _tag: "GiveUp",
              child: entry.id,
              reason: "failure",
              detail: answer === "ask" ? `${detail} (the classifier asked for a decision)` : detail
            }
          }
        }
        const refused = yield* admitRestart
        if (Option.isSome(refused)) {
          const detail = refused.value === "intensity"
            ? `${restarts.length} restarts within ${window}ms`
            : `${Option.isSome(budget) ? yield* budget.value.own.spent : 0} of ${spec.maxTokens} tokens spent`
          return { _tag: "GiveUp", child: entry.id, reason: refused.value, detail }
        }
        yield* Effect.annotateCurrentSpan({ "supervisor.restarted": entry.id })

        // Who restarts with it: nobody, everyone running, or everyone after it.
        const siblings = strategy === "one_for_one"
          ? []
          : all.filter((other, position) =>
            other.id !== entry.id && running.has(other.id) && (strategy === "one_for_all" || position > index)
          )
        for (const other of [...siblings].reverse()) yield* stop(other.id)
        for (const other of all) {
          if (other.id === entry.id || siblings.some((sibling) => sibling.id === other.id && other.restart !== "temporary")) {
            yield* start(other)
          }
        }
        return { _tag: "Continue" }
      })

    yield* lock.withPermits(1)(Effect.forEach(spec.children, start, { discard: true }))

    while (running.size > 0) {
      const exited = yield* Queue.take(exits)
      const step = yield* lock.withPermits(1)(handle(exited))
      if (step._tag === "GiveUp") yield* giveUp(step)
    }

    const report: Report = {
      children: children().map((entry) => ({ id: entry.id, starts: stateOf(entry.id).starts })),
      decisions
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
