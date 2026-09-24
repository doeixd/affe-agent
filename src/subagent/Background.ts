import { Cause, Clock, Context, Duration, Effect, Layer, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentSession from "../AgentSession.js"
import * as Budget from "../budget/Budget.js"
import { CurrentSessionId } from "../internal/currentSession.js"
import * as Namespace from "../internal/namespace.js"
import * as Schedules from "../internal/schedules.js"
import * as SessionInbox from "../sessions/SessionInbox.js"

/**
 * Background delegation: a child that outlives the run that started it, and
 * reports back when it is done.
 *
 * `Subagent.tool` is attached — the child runs inside the delegating tool's
 * scope, so the parent waits and an interruption takes both. This is the
 * other shape: a tool *starts* a child and returns, the child runs to
 * completion in the scope the caller opened around this value, and its
 * completion is published as a `Report`.
 *
 * **The reports are the caller's to deliver.** This module deliberately does
 * not know how a report reaches the parent's conversation; it publishes them
 * on a stream and the application decides, with the client it already has.
 * `SessionInbox` is the durable way — an item with `kind: "framework"` is a
 * report committed with framework provenance and no application input — and
 * `examples/ref-subagent-forms.ts` demonstrates the whole wiring by hand. The
 * alternative, having this battery deliver, would need the `AgentClient` that
 * serves the agent whose tools use the battery, and that is a layer cycle:
 * the client is built from the agent, the agent's tools need the battery, and
 * the battery would need the client. Publishing instead of delivering removes
 * the cycle and keeps the policy (when a report lands, what a busy parent
 * does) where `SessionInbox` says it belongs — with the caller.
 */

/** What a finished child run reports. */
export interface Report {
  /** The id `start` returned for this child. */
  readonly worker: string
  /** How the child's run ended. `"failed"` covers a failure, an interruption and a defect. */
  readonly status: "completed" | "failed"
  /** The child's final text, or the failure's description. */
  readonly text: string
  readonly turns: number
  /**
   * A per-background sequence, assigned when the run ends. It is what makes a
   * report's idempotency key stable — `background:<worker>:<sequence>` — so a
   * replay or a redelivery is one report rather than a second one.
   */
  readonly sequence: number
  /**
   * The session that started the worker, read from `CurrentSessionId` at the
   * `start` call; `None` when nothing started it (a direct call in a test).
   * `reportToParent` delivers only where there is a parent.
   */
  readonly parent: Option.Option<string>
}

/** One background worker, as `list` reports it. */
export interface WorkerStatus {
  readonly worker: string
  /** The child session's status: `"idle"`, `"running"` or `"closed"`. */
  readonly status: string
}

interface BackgroundShape {
  readonly start: (question: string) => Effect.Effect<string>
  readonly followUp: (worker: string, question: string) => Effect.Effect<string, string>
  readonly list: Effect.Effect<ReadonlyArray<WorkerStatus>>
  readonly cancel: (worker: string) => Effect.Effect<string, string>
  readonly stop: (worker: string) => Effect.Effect<string, string>
}

class Background extends Context.Service<Background, BackgroundShape>()(
  Namespace.tag("subagent/Background")
) {}

export interface Options<R, LE = never> {
  /**
   * What `start` is for, written for the parent model. The only thing the
   * parent knows about the child.
   */
  readonly description: string
  /**
   * The child's world: its model, and any services its tools need. Built once,
   * when the background is constructed, and shared by every child — this is
   * `Subagent.toolScoped`'s lifetime, for the same reason: a background child
   * is a long-lived thing, not one call.
   */
  readonly provide: Layer.Layer<LanguageModel.LanguageModel | R, LE>
}

/**
 * Build a background delegation of `agent`, which is asked with a prompt.
 *
 * ```ts
 * const research = yield* Subagent.background("research", Researcher, {
 *   description: "Research a question in the background; report when done.",
 *   provide: childModel
 * })
 *
 * const Lead = Agent.make({ instructions: "…", toolkit: research.toolkit })
 * // at the application edge, where the client exists:
 * //   Layer.provide(research.layer) alongside the Lead's own client
 * //   and deliver `research.reports` however the application wants —
 * //   through `SessionInbox` as a framework item, or a steer.
 * ```
 *
 * An `Effect` rather than a plain value because `provide` is built once here,
 * which is a scope the caller opens. The `Scope` around it is also the child's
 * lifetime: closing it ends the background work.
 *
 * **Provide `layer` for the application, not for one run.** A child is forked
 * into the layer's scope, so `Effect.provide(layer)` around a single
 * `Agent.run` ties the child to that run and cancels it when the run returns.
 * Build the layer in the application's scope — `Layer.build(layer)` beside the
 * client, or `Effect.provide` around the whole program.
 *
 * The toolkit carries five tools. `start_background` and
 * `follow_up_background` do the work; `list_background`, `cancel_background`
 * (ends one run, keeps the worker followable) and `stop_background` (seals it,
 * so a later follow-up is refused) are the control surface.
 */
export const background = <Tools extends Record<string, Tool.Any>, E, R, Value, LE = never>(
  name: string,
  agent: AgentDefinition<Tools, E, R | Budget.Budget, LanguageModel.LanguageModel, Value, Prompt.RawInput>,
  options: Options<R, LE>
) =>
  Effect.gen(function* () {
    // A fresh budget, deliberately: a background child is a different session
    // on a different lifetime, so charging a parent that may have ended is
    // worse than charging nobody. (An attached child's spend is the parent's
    // by default; background is the reverse, and the reason is in
    // `plan-background-delegation.md`.)
    const services = yield* Layer.build(Layer.merge(options.provide, Budget.fresh()))
    const reports = yield* Queue.unbounded<Report>()

    const Start = Tool.make("start_background", {
      description: options.description,
      parameters: Schema.Struct({ question: Schema.String }),
      success: Schema.String,
      failure: Schema.String,
      dependencies: [Background]
    })
    const FollowUp = Tool.make("follow_up_background", {
      description: "Send more input to a background worker started by start_background.",
      parameters: Schema.Struct({ worker: Schema.String, question: Schema.String }),
      success: Schema.String,
      failure: Schema.String,
      dependencies: [Background]
    })
    const List = Tool.make("list_background", {
      description: "List the background workers this session started, with their status.",
      parameters: Schema.Struct({}),
      success: Schema.Array(Schema.Struct({ worker: Schema.String, status: Schema.String })),
      failure: Schema.String,
      dependencies: [Background]
    })
    const Cancel = Tool.make("cancel_background", {
      description: "Cancel a background worker's current run. The worker stays and can be followed up.",
      parameters: Schema.Struct({ worker: Schema.String }),
      success: Schema.String,
      failure: Schema.String,
      dependencies: [Background]
    })
    const Stop = Tool.make("stop_background", {
      description: "Stop a background worker for good: cancel its run and seal it, so follow-ups are refused.",
      parameters: Schema.Struct({ worker: Schema.String }),
      success: Schema.String,
      failure: Schema.String,
      dependencies: [Background]
    })

    const layer = Layer.effect(
      Background,
      Effect.gen(function* () {
        // The scope the caller opened around `background`: a child forked here
        // outlives the run that started it.
        const scope = yield* Effect.scope
        const workers = yield* Ref.make<
          ReadonlyMap<string, {
            readonly session: AgentSession.AgentSession<Tools, E, Value, Prompt.RawInput>
            readonly parent: Option.Option<string>
          }>
        >(new Map())
        const counter = yield* Ref.make(0)
        const reportSeq = yield* Ref.make(0)

        /** Assign the report's sequence and publish it. */
        const offer = (
          worker: string,
          status: Report["status"],
          text: string,
          turns: number,
          parent: Option.Option<string>
        ): Effect.Effect<void> =>
          Effect.flatMap(Ref.updateAndGet(reportSeq, (n) => n + 1), (sequence) =>
            Queue.offer(reports, { worker, status, text, turns, sequence, parent }))

        const runChild = (
          session: AgentSession.AgentSession<Tools, E, Value, Prompt.RawInput>,
          worker: string,
          question: string,
          parent: Option.Option<string>
        ): Effect.Effect<void> =>
          AgentSession.prompt<Tools, E, Value, Prompt.RawInput>(session, question).pipe(
            Effect.provide(services),
            Effect.flatMap((result) =>
              offer(worker, result.status === "interrupted" ? "failed" : "completed", result.text, result.turns, parent)),
            Effect.catchCause((cause) => offer(worker, "failed", Cause.pretty(cause), 0, parent))
          )

        const start = (question: string): Effect.Effect<string> =>
          Effect.gen(function* () {
            const worker = `worker-${yield* Ref.updateAndGet(counter, (n) => n + 1)}`
            // Read here, inside the tool call: the report's destination is the
            // session that started the worker, not whichever session happens
            // to exist when it finishes.
            const parent = yield* CurrentSessionId
            const session = yield* AgentSession.makeEngine(agent, {}).pipe(
              Effect.provide(services),
              Effect.provideService(Scope.Scope, scope)
            )
            yield* Ref.update(workers, (all) => new Map(all).set(worker, { session, parent }))
            yield* Effect.forkIn(scope)(runChild(session, worker, question, parent))
            return worker
          })

        const followUp = (worker: string, question: string): Effect.Effect<string, string> =>
          Effect.gen(function* () {
            const found = (yield* Ref.get(workers)).get(worker)
            if (found === undefined) {
              return yield* Effect.fail(`no background worker "${worker}"; start one first`)
            }
            yield* Effect.forkIn(scope)(runChild(found.session, worker, question, found.parent))
            return `sent to ${worker}`
          })

        const list: Effect.Effect<ReadonlyArray<WorkerStatus>> = Effect.gen(function* () {
          const all = Array.from(yield* Ref.get(workers))
          return yield* Effect.forEach(
            all,
            ([worker, { session }]) =>
              Effect.map(AgentSession.status(session), (status): WorkerStatus => ({ worker, status })),
            { concurrency: "unbounded" }
          )
        })

        const cancel = (worker: string): Effect.Effect<string, string> =>
          Effect.gen(function* () {
            const found = (yield* Ref.get(workers)).get(worker)
            if (found === undefined) return yield* Effect.fail(`no background worker "${worker}"`)
            return yield* AgentSession.interrupt(found.session).pipe(
              Effect.as(`cancelled ${worker}'s current run`),
              Effect.catchTags({
                AgentIdleError: () => Effect.succeed(`${worker} is not running`),
                AgentClosedError: () => Effect.fail(`${worker} is sealed`)
              })
            )
          })

        const stop = (worker: string): Effect.Effect<string, string> =>
          Effect.gen(function* () {
            const found = (yield* Ref.get(workers)).get(worker)
            if (found === undefined) return yield* Effect.fail(`no background worker "${worker}"`)
            yield* AgentSession.interrupt(found.session).pipe(Effect.ignore)
            // Sealed by removing it, so a later follow-up finds no worker. The
            // session's own resources release with the scope `background` was
            // opened in -- the application's, not one run.
            yield* Ref.update(workers, (all) => {
              const next = new Map(all)
              next.delete(worker)
              return next
            })
            return `stopped ${worker}`
          })

        return { start, followUp, list, cancel, stop }
      })
    )

    const toolkit = Agent.toolkit([Start, FollowUp, List, Cancel, Stop], {
      start_background: ({ question }) => Effect.flatMap(Background, (background) => background.start(question)),
      follow_up_background: ({ worker, question }) =>
        Effect.flatMap(Background, (background) => background.followUp(worker, question)),
      list_background: () => Effect.flatMap(Background, (background) => background.list),
      cancel_background: ({ worker }) => Effect.flatMap(Background, (background) => background.cancel(worker)),
      stop_background: ({ worker }) => Effect.flatMap(Background, (background) => background.stop(worker))
    })

    return { toolkit, layer, reports: Stream.fromQueue(reports) }
  })

/** The default report rendering: a system message the parent's model reads. */
const defaultRender = (report: Report): string =>
  report.status === "completed"
    ? `Background worker ${report.worker} finished. Findings: ${report.text}`
    : `Background worker ${report.worker} did not finish: ${report.text}`

/**
 * Deliver every report to the session that started its worker, as a framework
 * item through `SessionInbox` -- committed with framework provenance and no
 * application input, so the parent's model reads it as the framework's message
 * and never as something the person typed.
 *
 * An `Effect` the caller forks, deliberately. The battery cannot deliver its
 * own reports: it would need the `AgentClient` that serves the agent whose
 * tools use it, and that is a layer cycle. `SessionInbox` says the reporting
 * decision is the caller's, so this is a helper the caller runs, not a flag
 * the battery hides. Provide the same `AgentClient` the parent runs on, plus
 * a `PersistedQueue` for the inbox.
 *
 * A busy parent is retried, not interrupted: the item waits for the session's
 * next idle point. A report whose worker nothing started (`CurrentSessionId`
 * was `None`) has no parent and is skipped. An `Undeliverable` item is logged
 * and dropped -- a session that is gone is gone.
 */
export const reportToParent = (
  background: { readonly reports: Stream.Stream<Report> },
  options?: {
    /** The inbox's name, and so its identity in the store. */
    readonly name?: string | undefined
    /** How a report becomes the parent model's message. Defaults to a system message. */
    readonly render?: ((report: Report) => string) | undefined
  }
) =>
  Effect.gen(function* () {
    const inbox = yield* SessionInbox.make({
      name: options?.name ?? Namespace.tag("subagent/background-reports")
    })
    const render = options?.render ?? defaultRender
    yield* Stream.runForEach(background.reports, (report) =>
      Option.match(report.parent, {
        onNone: () => Effect.void,
        onSome: (sessionId) =>
          Effect.gen(function* () {
            const id = `background:${report.worker}:${report.sequence}`
            yield* inbox.enqueue({
              id,
              sessionId,
              kind: "framework",
              input: Prompt.fromMessages([Prompt.systemMessage({ content: render(report) })]),
              source: { kind: "background", id: report.worker },
              createdAt: yield* Clock.currentTimeMillis
            })
            yield* inbox.deliver.pipe(
              Effect.retry({
                // Start fast, back off, and never poll harder than the cap: a
                // parent busy for a long time must not be spun at 25ms for ever.
                while: (error) => error._tag === "SessionBusyError",
                schedule: Schedules.backoff({
                  start: Duration.millis(25),
                  cap: Schedules.defaultPollCap
                })
              }),
              Effect.tap((outcome) =>
                outcome._tag === "Undeliverable"
                  ? Effect.logWarning(`background report ${id}: ${outcome.reason}`)
                  : Effect.void),
              Effect.catchTag("InboxError", (error) =>
                Effect.logWarning(`background report ${id}: ${error.message}`)),
              Effect.asVoid
            )
          })
      })
    )
  })
