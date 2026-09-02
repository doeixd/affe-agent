import { Context, DateTime, Duration, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import type { LanguageModel, Tool } from "effect/unstable/ai"
import { Prompt } from "effect/unstable/ai"
import { HttpRouter } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import {
  DurableObject,
  DurableObjectAlarm,
  DurableObjectNamespace,
  DurableObjectSqlite,
  DurableObjectState,
  Worker,
  WorkerEnvironment
} from "effect-cf"
import * as Agent from "../Agent.js"
import * as AgentSessionEngine from "../AgentSession.js"
import * as AgentClient from "../client/AgentClient.js"
import * as AgentSessionHost from "../client/AgentSessionHost.js"
import * as DeliveryLog from "../durable/DeliveryLog.js"
import * as AgentHttp from "../http/AgentHttp.js"
import * as PromptWire from "../PromptWire.js"
import * as Scheduling from "../scheduling/Scheduling.js"
import * as Isolate from "./isolate.js"

/** Code mode in a Dynamic Worker: the executor and the broker it calls back through. */
export * as IsolateExecutor from "./isolate.js"

/**
 * The agent on Cloudflare: one Durable Object per session, a Worker routing
 * by session id, as a published host entry.
 *
 * **This is the one place `effect-cf` enters `src/`** -- decided 2026-09-01
 * against `docs/plan-effect-cf-and-webtransport.md` §3, which had said
 * "read and mine, do not adopt". The category is the same one
 * `/sandbox/local` established: host coupling lives behind its own entry
 * and nowhere else, and this entry *is* the Cloudflare host, so the
 * package that makes Cloudflare's primitives Effect services is what it is
 * meant to reach for. What it takes from `effect-cf`: `DurableObject.make`
 * (the class, the per-instance runtime, `DurableObjectState` as a service),
 * `DurableObjectSqlite` (the DO's SQLite as `SqlClient`), `DurableObjectAlarm`
 * (logical alarms over the one platform alarm, at-least-once with retry, in
 * one transaction with application writes), `DurableObjectNamespace` (the
 * stub as an Effect client) and `Worker.make`. What it does not take:
 * anything in the portable core. `verify-portability` still rejects
 * `effect-cf` everywhere but here.
 *
 * **The durability here is the platform's, not `/durable`'s.** Effect
 * Workflow stalls on workerd (`docs/status-history.md`, 2026-08-30), so a
 * session is durable the way a Durable Object is durable:
 *
 * - **History** is written to DO SQLite as every turn commits and restored
 *   when the object wakes, so the conversation survives hibernation and
 *   process death; a runtime lost mid-run costs the turn in flight.
 * - **Events** are journaled to the ordinary `DeliveryLog` through the
 *   session's synchronous `eventSink`; `events?after=N` is served from the
 *   journal above the cursor, then live, gaplessly.
 * - **Future work** goes through `/scheduling`'s `AgentDispatcher`, here a
 *   logical alarm per job: `dispatch` schedules one, the object's alarm
 *   handler prompts the session with every due job, and the platform alarm
 *   is reconciled by `effect-cf` in the same transaction as the schedule.
 *
 * The model and the agent's own services arrive as a `Layer` the caller
 * builds -- it may read bindings through `WorkerEnvironment` and the
 * object's SQLite through `SqlClient` -- and are built once per object
 * instance. `apps/worker` is this entry with the scripted model, proven on
 * workerd by `test/WorkerDurableObject.test.ts`.
 */

export interface Options<Tools extends Record<string, Tool.Any>, E, R> {
  readonly agent: Agent.AgentDefinition<Tools, E, R>
  /**
   * The model and the agent's services, built once per Durable Object
   * instance. May depend on `WorkerEnvironment` (bindings, secrets),
   * `DurableObjectState` and the object's `SqlClient`.
   */
  readonly layer: Layer.Layer<
    LanguageModel.LanguageModel | R,
    unknown,
    WorkerEnvironment | DurableObjectState.DurableObjectState | SqlClient.SqlClient | Isolate.CodeBroker
  >
  /** The Durable Object namespace binding the Worker routes to. Default `SESSIONS`. */
  readonly namespace?: string | undefined
  /**
   * Who is calling, resolved per request. Default: the `authorization`
   * header, or `anonymous`. A deployment fronts the Worker with real
   * authentication and forwards its verdict here.
   */
  readonly principal?: AgentSessionHost.Options<string>["principal"] | undefined
  readonly authorization?: AgentSessionHost.Options<string>["authorization"] | undefined
  readonly maxSessions?: number | undefined
  readonly maxRequestsPerSession?: number | undefined
  readonly maxRetainedSubmissions?: number | undefined
  /** How long a failed dispatched run waits before the alarm retries it. Default 30 seconds. */
  readonly retryFailedAfter?: Duration.Input | undefined
}

/** A prompt as JSON text: stored history, and a dispatched job's payload. */
const PromptJson = Schema.toCodecJson(PromptWire.Prompt)

/** The dispatched job as a logical alarm's payload: the prompt, encoded. */
const DISPATCH_TAG = "effect-agent/dispatch"

/**
 * The Durable Object's client: in-process sessions whose history persists
 * to the object's SQLite as each turn commits, and whose events are
 * journaled to the delivery log.
 */
const makeClient = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: Agent.AgentDefinition<Tools, E, R>,
  options: { readonly maxRetainedSubmissions: number }
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const delivery = yield* DeliveryLog.sqlLogWithTable()
    yield* sql`CREATE TABLE IF NOT EXISTS effect_agent_history (
      session_id TEXT PRIMARY KEY,
      history TEXT NOT NULL
    )`.pipe(Effect.orDie)
    const services = yield* Effect.context<LanguageModel.LanguageModel | R>()
    const open = new Map<string, AgentClient.RemoteSession>()

    const storedHistory = (sessionId: string) =>
      sql`SELECT history FROM effect_agent_history WHERE session_id = ${sessionId}`.pipe(
        Effect.orDie,
        Effect.flatMap((rows) => {
          const raw = rows[0]?.history
          if (typeof raw !== "string") return Effect.succeedNone
          return Schema.decodeEffect(PromptJson)(JSON.parse(raw)).pipe(Effect.orDie, Effect.asSome)
        })
      )

    const persistHistory = (sessionId: string, session: AgentSessionEngine.AgentSession<any, any, any>) =>
      AgentSessionEngine.history(session).pipe(
        Effect.flatMap((history) => Schema.encodeEffect(PromptJson)(history)),
        Effect.flatMap((encoded) => {
          const text = JSON.stringify(encoded)
          return sql`INSERT INTO effect_agent_history (session_id, history) VALUES (${sessionId}, ${text})
            ON CONFLICT(session_id) DO UPDATE SET history = ${text}`
        }),
        Effect.catchCause((cause) => Effect.logError("cloudflare: history persist failed", { sessionId, cause }))
      )

    /** The journal above a cursor, then live delivery, gaplessly: subscribe first, then read. */
    const eventsAfter = (sessionId: string, after: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const continuing = yield* delivery.subscribe(sessionId)
          const journal = yield* delivery.read(sessionId, { after })
          const highest = journal.length === 0 ? after : journal[journal.length - 1]!.sequence
          return Stream.concat(
            Stream.fromIterable(journal),
            Stream.filter(continuing, (envelope) => envelope.sequence > highest)
          ).pipe(Stream.catch((error) =>
            Stream.fail(new AgentClient.AgentTransportError({ sessionId, detail: error.message }))
          ))
        }).pipe(Effect.mapError((error) => new AgentClient.AgentTransportError({ sessionId, detail: error.message })))
      )

    const openSession = (sessionId: string): Effect.Effect<AgentClient.RemoteSession, AgentClient.RemoteError> =>
      Effect.gen(function* () {
        const existing = open.get(sessionId)
        if (existing !== undefined) return existing
        const scope = yield* Scope.make()
        const history = yield* storedHistory(sessionId)
        // A fresh session numbers its events from 1; the journal numbers the
        // conversation. The base is where the previous life stopped.
        const base = yield* delivery.read(sessionId).pipe(
          Effect.map((entries) => entries[entries.length - 1]?.sequence ?? 0),
          Effect.orDie
        )
        const shift = (envelope: Parameters<typeof delivery.append>[2]) =>
          ({ ...envelope, sequence: envelope.sequence + base })
        const session = yield* Scope.provide(
          AgentSessionEngine.makeEngine(agent, {
            sessionId,
            ...(Option.isSome(history) ? { history: history.value } : {}),
            // Synchronous, in sequence order: the journal sees every envelope
            // before the prompt can report the outcome those events describe.
            eventSink: (envelope) =>
              delivery.append(sessionId, String(envelope.sequence + base), shift(envelope)).pipe(
                Effect.catchCause((cause) => Effect.logError("cloudflare: journal append failed", { sessionId, cause })),
                Effect.asVoid
              )
          }),
          scope
        )
        // As each turn commits, and at the submission boundaries: a lost
        // runtime costs the turn in flight and nothing committed before it.
        yield* Effect.forkIn(
          Stream.runForEach(session.events, (envelope) =>
            envelope.event._tag === "TurnCompleted" ||
              envelope.event._tag === "SubmissionCompleted" ||
              envelope.event._tag === "SubmissionInterrupted"
              ? persistHistory(sessionId, session)
              : Effect.void
          ).pipe(Effect.catchCause(() => Effect.void)),
          scope
        )
        const remote = AgentClient.fromSession(session, { scope, maxRetainedSubmissions: options.maxRetainedSubmissions })
        const resumable: AgentClient.RemoteSession = {
          ...remote,
          events: (eventOptions) =>
            eventOptions?.after === undefined
              ? Stream.map(remote.events(), shift)
              : eventsAfter(sessionId, eventOptions.after)
        }
        open.set(sessionId, resumable)
        yield* Scope.addFinalizer(scope, Effect.sync(() => void open.delete(sessionId)))
        return resumable
      }).pipe(Effect.provide(services))

    const service: AgentClient.Service = {
      createSession: (createOptions) =>
        createOptions?.sessionId === undefined
          ? Effect.fail(
            new AgentClient.AgentTransportError({
              sessionId: "(unassigned)",
              detail: "this host addresses sessions by id; POST /sessions must name one"
            })
          )
          : openSession(createOptions.sessionId),
      // A session whose history the storage holds exists, whether or not
      // this instance has opened it; one that never committed a turn left no
      // row and is reported as not found so the client can create it again.
      session: (sessionId) => {
        const existing = open.get(sessionId)
        if (existing !== undefined) return Effect.succeed(existing)
        return storedHistory(sessionId).pipe(
          Effect.flatMap((history) =>
            Option.isSome(history)
              ? openSession(sessionId)
              : Effect.fail(new AgentClient.AgentSessionNotFoundError({ sessionId }))
          )
        )
      }
    }
    return service
  })

/** The HTTP surface, built once per instance over the client. */
class Surface extends Context.Service<Surface, { readonly handle: (request: Request) => Promise<Response> }>()(
  "@doeixd/effect-agent/cloudflare/Surface"
) {}

/** The session this object is: named by the Worker's `idFromName`. */
const sessionIdOfObject = Effect.map(DurableObjectState.DurableObjectState, (state) => Option.fromNullishOr(state.id.name))

/** `POST /sessions/{id}/dispatch`: `{ input, delayMillis? }`, the host's own route. */
const dispatchRequest = (request: Request) =>
  Effect.gen(function* () {
    if (request.method !== "POST") return undefined
    const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "")
    if (segments.length !== 3 || segments[0] !== "sessions" || segments[2] !== "dispatch") return undefined
    const body = yield* Effect.tryPromise(() => request.clone().json() as Promise<{ input?: unknown; delayMillis?: unknown }>).pipe(
      Effect.orElseSucceed(() => ({}) as { input?: unknown; delayMillis?: unknown })
    )
    if (typeof body.input !== "string") return undefined
    return {
      input: body.input,
      delayMillis: typeof body.delayMillis === "number" && body.delayMillis >= 0 ? body.delayMillis : 0
    }
  })

/**
 * What `make` returns: the two classes a Worker entry exports.
 *
 * Typed by effect-cf's class shapes with the RPC surface empty -- this host
 * exposes HTTP, not RPC -- and the runtime services erased: what a
 * deployment does with these is `export` them, and wrangler, miniflare and
 * Alchemy read the class, not its type.
 */
export interface Host {
  readonly SessionObject: DurableObject.DurableObjectClass<Record<never, never>, never>
  readonly Worker: Worker.WorkerClass<Record<never, never>, never>
}

/**
 * Build the host: the Durable Object class and the Worker class.
 *
 * ```ts
 * const host = CloudflareHost.make({ agent, layer: AnthropicModel })
 * export const AgentSessionObject = host.SessionObject
 * export default host.Worker
 * ```
 *
 * with `SESSIONS` bound to `AgentSessionObject` in `wrangler.jsonc` (or the
 * Alchemy stack in `examples/deploy-cloudflare/`), and `LOADER` a Worker
 * Loader if `IsolateExecutor` is used.
 */
export const make = <Tools extends Record<string, Tool.Any>, E, R>(options: Options<Tools, E, R>): Host => {
  const namespace = options.namespace ?? "SESSIONS"
  const Host = AgentSessionHost.Tag<string>("@doeixd/effect-agent/cloudflare/host")

  const clientLayer = Layer.effect(
    AgentClient.AgentClient,
    makeClient(options.agent, { maxRetainedSubmissions: options.maxRetainedSubmissions ?? 16 })
  )
  const surfaceLayer = Layer.effect(
    Surface,
    Effect.gen(function* () {
      const client = yield* AgentClient.AgentClient
      const host = AgentSessionHost.layer(Host, {
        principal: options.principal ?? {
          resolve: ({ headers }) => Effect.succeed(headers.authorization ?? "anonymous")
        },
        authorization: options.authorization ?? AgentSessionHost.allowAll(),
        maxSessions: options.maxSessions ?? 4,
        maxRequestsPerSession: options.maxRequestsPerSession ?? 64
      }).pipe(Layer.provide(Layer.succeed(AgentClient.AgentClient, client)))
      const web = HttpRouter.toWebHandler(
        AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host)),
        { disableLogger: true }
      )
      return { handle: (request: Request) => web.handler(request) }
    })
  )

  /**
   * `/scheduling`'s seam over a logical alarm per job. `scheduleAlarm`
   * persists the job and reconciles the platform alarm in one transaction,
   * so a job survives the runtime that dispatched it whether or not the
   * platform kept its alarm.
   */
  const dispatcherLayer = Layer.effect(
    Scheduling.AgentDispatcher,
    Effect.gen(function* () {
      const alarms = yield* DurableObjectAlarm.DurableObjectAlarm
      const dispatch: Scheduling.AgentDispatcher["Service"]["dispatch"] = (job) =>
        // The seam's `dispatch` cannot fail: a job that cannot be persisted
        // is a defect of the host, as `queued`'s store failures are.
        Effect.orDie(
          Effect.gen(function* () {
            const now = yield* DateTime.now
            // `Dispatched.delay` is a `Duration.Input` -- "5 seconds" as
            // readily as a number -- and the seam's `queued` reads it the
            // same way. (The first draft coerced it with `Number`, which
            // made every string delay zero and the alarm test unable to
            // tell "fired after the delay" from "fired at once".)
            const runAt = job.delay === undefined
              ? now
              : DateTime.addDuration(now, Duration.fromInputUnsafe(job.delay))
            const payload = yield* Schema.encodeEffect(PromptJson)(Prompt.make(job.input)).pipe(Effect.orDie)
            yield* alarms.scheduleAlarm({
              tag: DISPATCH_TAG,
              id: crypto.randomUUID(),
              runAt,
              payload
            })
          })
        )
      return { dispatch }
    })
  )

  const objectLayer = Layer.mergeAll(clientLayer, surfaceLayer.pipe(Layer.provide(clientLayer)), dispatcherLayer).pipe(
    Layer.provideMerge(options.layer),
    // The broker before the caller's layer: an isolate executor built there
    // registers its runs with it.
    Layer.provideMerge(Isolate.brokerLayer),
    Layer.provideMerge(DurableObjectAlarm.DurableObjectAlarm.layer),
    Layer.provideMerge(DurableObjectSqlite.layer())
  )

  /**
   * Prompt this object's session with every due job.
   *
   * A handler failure makes `processDue` reschedule the job, so only what a
   * later attempt can fix is allowed to fail: a session busy with a
   * caller's own prompt, or a transport fault. An agent failure is the
   * run's outcome -- it is in history and the journal, and running it
   * again would repeat a failing model call every `retryFailedAfter`
   * forever -- and a payload that no longer decodes will never decode;
   * both are logged and the job is acknowledged.
   */
  const drain = Effect.gen(function* () {
    const sessionId = yield* sessionIdOfObject
    if (Option.isNone(sessionId)) return
    const client = yield* AgentClient.AgentClient
    // Explicit channels: the handler's failure is what makes `processDue`
    // retry the job, and inference does not carry it through the seam.
    yield* DurableObjectAlarm.processDue<never, AgentClient.RemoteError>(
      (event) =>
        Effect.gen(function* () {
          if (event.tag !== DISPATCH_TAG) return
          const decoded = yield* Effect.result(Schema.decodeUnknownEffect(PromptJson)(event.payload))
          if (decoded._tag === "Failure") {
            return yield* Effect.logError("cloudflare: a dispatched job's prompt does not decode; dropped", {
              sessionId: sessionId.value,
              alarm: event.id,
              error: decoded.failure.message
            })
          }
          const session = yield* client.session(sessionId.value).pipe(
            Effect.catchTag("AgentSessionNotFoundError", () => client.createSession({ sessionId: sessionId.value }))
          )
          yield* session.prompt(decoded.success).pipe(
            Effect.catchTag("AgentExecutionError", (error) =>
              Effect.logError("cloudflare: a dispatched run failed; not retried", {
                sessionId: sessionId.value,
                alarm: event.id,
                tag: error.tag,
                detail: error.detail
              }))
          )
        }).pipe(Effect.scoped),
      { retryFailedAfter: options.retryFailedAfter ?? "30 seconds" }
    )
  })

  const SessionObject = DurableObject.make(objectLayer, {
    fetch: Effect.gen(function* () {
      const request = yield* Worker.NativeRequest
      const dispatch = yield* dispatchRequest(request)
      if (dispatch !== undefined) {
        // The one route the HTTP surface does not have; a deployment puts
        // it behind the same authentication as the rest.
        yield* Scheduling.dispatch({ input: dispatch.input, delay: `${dispatch.delayMillis} millis` })
        return new Response(JSON.stringify({ dispatched: true }), {
          status: 202,
          headers: { "content-type": "application/json" }
        })
      }
      if (request.method === "POST" && new URL(request.url).pathname === "/code/invoke") {
        // A program in an isolate calling one of its tools; the broker
        // knows the run by its token and answers by the run's own hook.
        const broker = yield* Isolate.CodeBroker
        return yield* broker.handle(request)
      }
      const surface = yield* Surface
      return yield* Effect.promise(() => surface.handle(request))
    }),
    alarm: () => drain
  })

  /** The namespace binding, as effect-cf's Effect client. */
  class Sessions extends Context.Service<
    Sessions,
    DurableObjectNamespace.DurableObjectNamespaceEffectClient<object, undefined>
  >()("@doeixd/effect-agent/cloudflare/Sessions") {}

  const sessionIdOf = (request: Request) =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      const segments = url.pathname.split("/").filter((segment) => segment !== "")
      if (segments[0] !== "sessions") return undefined
      if (segments.length >= 2) return decodeURIComponent(segments[1]!)
      if (request.method === "POST") {
        const body = yield* Effect.tryPromise(() => request.clone().json() as Promise<{ sessionId?: unknown }>).pipe(
          Effect.orElseSucceed(() => ({}) as { sessionId?: unknown })
        )
        return typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined
      }
      return undefined
    })

  /** The Worker: route by session id, nothing else. */
  const WorkerClass = Worker.make(
    DurableObjectNamespace.layer(Sessions, { binding: namespace }),
    {
      fetch: Effect.gen(function* () {
        const request = yield* Worker.NativeRequest
        const sessionId = yield* sessionIdOf(request)
        if (sessionId === undefined) {
          return new Response(
            JSON.stringify({ error: "expected /sessions/{id}/... or POST /sessions with a sessionId" }),
            { status: 404, headers: { "content-type": "application/json" } }
          )
        }
        const sessions = yield* Sessions
        const stub = yield* sessions.getByName(sessionId)
        return yield* sessions.fetch(stub, request)
      })
    }
  )

  return { SessionObject, Worker: WorkerClass }
}
