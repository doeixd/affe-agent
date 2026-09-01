import type { DurableObjectNamespace, DurableObjectState, DurableObjectStorage } from "@cloudflare/workers-types"
import { Context, Effect, Layer, ManagedRuntime, Option, Schema, Scope, Stream } from "effect"
import { LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import { HttpRouter } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { Agent, AgentLoop, PromptWire } from "@doeixd/effect-agent"
import * as AgentSessionEngine from "@doeixd/effect-agent/AgentSession"
import { AgentClient, AgentSessionHost } from "@doeixd/effect-agent/client"
import { DeliveryLog } from "@doeixd/effect-agent/durable"
import { AgentHttp } from "@doeixd/effect-agent/http"
import { Scheduling } from "@doeixd/effect-agent/scheduling"
import { TestLanguageModel } from "@doeixd/effect-agent/testing"

/**
 * The agent on Cloudflare: one Durable Object per session, the Worker
 * routing by session id (`docs/plan-deployment.md` §3, §7 item 1).
 *
 * **The durability here is the platform's, not `/durable`'s — a decision,
 * not an accident.** The plan's §3.2 left open whether Effect Workflow
 * should run inside a DO or is redundant there. Measured: a bare
 * two-activity workflow under `ClusterWorkflowEngine` + `SingleRunner` over
 * DO SQLite times out on workerd while the identical program completes in
 * ~140ms on Node (`docs/status-history.md`, 2026-08-30). Until that is
 * fixed upstream, a DO session is durable the way a DO is durable:
 *
 * - **History** is written to DO SQLite as every turn commits — the
 *   session's `TurnCompleted` is emitted inside the same uninterruptible
 *   region as the commit, so what is written is always a conversation that
 *   existed — and restored when the DO wakes, so the conversation survives
 *   hibernation and process death.
 * - **Events** are journaled to the same `DeliveryLog` every other durable
 *   deployment uses, through the session's `eventSink` — the synchronous
 *   sink that exists precisely so a recorder cannot miss an envelope. A
 *   client reconnecting with `events?after=N` is served the journal above
 *   its cursor, then live delivery, gaplessly.
 * - **Mid-run process loss loses the turn in flight, not the run's
 *   committed turns and not the conversation** — the DO equivalent of a
 *   Node process without `/durable`. The submission itself is gone: its
 *   caller sees a failed request, and the next prompt continues from the
 *   last committed turn. Runs that must survive their process still need
 *   the workflow engine, on a host it runs on.
 * - **Future work** goes through `/scheduling`'s `AgentDispatcher`, backed
 *   here by DO SQLite and the object's alarm: `dispatch` persists the job
 *   and arms the alarm for its due time, `alarm()` prompts the session with
 *   every due job, and a wake re-arms from the table — so a job dispatched
 *   by a runtime that then died still fires.
 *
 * The model is the scripted test model unless the deployment wires a real
 * one (see `examples/deploy-cloudflare/`): this entry must run under plain
 * workerd in CI, where there is no key.
 *
 * Portability: portable entries plus `@effect/sql-sqlite-do`, workerd's own
 * storage driver — this file is the workerd host entry. No `node:*`.
 */

export interface Env {
  readonly SESSIONS: DurableObjectNamespace
}

/** A tool with no effect, so the scripted model can drive a multi-turn run. */
const Tick = Tool.make("tick", {
  description: "Advance one step.",
  parameters: Schema.Struct({}),
  success: Schema.String
})

const agent = Agent.make({
  instructions: "You are a helpful assistant running inside a Durable Object.",
  tools: [Agent.tool(Tick, () => Effect.succeed("tick"))],
  loop: AgentLoop.bounded(4)
})

/**
 * The script is per process: a fresh runtime starts it again. The first
 * call answers in text; the second prompt in a life runs two tool turns and
 * then hangs, which is how `test/WorkerDurableObject.test.ts` leaves a run
 * mid-flight when it kills the runtime.
 */
const scriptedModel = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      TestLanguageModel.text("reply-1"),
      TestLanguageModel.toolCall("tick", {}, { id: "tick-1" }),
      TestLanguageModel.toolCall("tick", {}, { id: "tick-2" }),
      { hang: true },
      ...Array.from({ length: 60 }, (_, index) => TestLanguageModel.text(`reply-${index + 2}`))
    ]),
    ({ layer }) => layer
  )
)

const Host = AgentSessionHost.Tag<string>("apps/worker/host")

const HistoryJson = Schema.toCodecJson(PromptWire.Prompt)

/**
 * The DO-backed client: in-process sessions whose history persists to DO
 * SQLite and whose events are journaled to the delivery log.
 */
const makeClient = Effect.fn("worker.makeClient")(function* () {
  const sql = yield* SqlClient.SqlClient
  const delivery = yield* DeliveryLog.sqlLogWithTable()
  yield* sql`CREATE TABLE IF NOT EXISTS worker_history (
    session_id TEXT PRIMARY KEY,
    history TEXT NOT NULL
  )`.pipe(Effect.orDie)
  const services = yield* Effect.context<LanguageModel.LanguageModel>()
  const open = new Map<string, AgentClient.RemoteSession>()

  const storedHistory = (sessionId: string) =>
    sql`SELECT history FROM worker_history WHERE session_id = ${sessionId}`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => {
        const raw = rows[0]?.history
        if (typeof raw !== "string") return Effect.succeedNone
        return Schema.decodeEffect(HistoryJson)(JSON.parse(raw)).pipe(Effect.orDie, Effect.asSome)
      })
    )

  const persistHistory = (sessionId: string, session: AgentSessionEngine.AgentSession<any, any>) =>
    AgentSessionEngine.history(session).pipe(
      Effect.flatMap((history) => Schema.encodeEffect(HistoryJson)(history)),
      Effect.flatMap((encoded) => {
        const text = JSON.stringify(encoded)
        return sql`INSERT INTO worker_history (session_id, history) VALUES (${sessionId}, ${text})
          ON CONFLICT(session_id) DO UPDATE SET history = ${text}`
      }),
      Effect.catchCause((cause) => Effect.logError("worker: history persist failed", { sessionId, cause }))
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
      // *conversation*. The base is where the previous life stopped, and
      // shifting both the sink and the live stream by it is what keeps one
      // cursor vocabulary across lives.
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
              Effect.catchCause((cause) => Effect.logError("worker: journal append failed", { sessionId, cause })),
              Effect.asVoid
            )
        }),
        scope
      )
      // History persists as each turn commits, so a runtime lost mid-run
      // costs the turn in flight and nothing committed before it. The
      // submission boundaries are kept too: a follow-up's prompt is
      // committed before its first turn, and the completion write catches
      // a submission whose last turn added nothing.
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
      const remote = AgentClient.fromSession(session, { scope, maxRetainedSubmissions: 16 })
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
    createSession: (options) =>
      options?.sessionId === undefined
        ? Effect.fail(
          new AgentClient.AgentTransportError({
            sessionId: "(unassigned)",
            detail: "this deployment addresses sessions by id; POST /sessions must name one"
          })
        )
        : openSession(options.sessionId),
    // Re-adoption is what makes the DO's sleep invisible: a session whose
    // history the storage holds *exists*, whether or not this instance has
    // opened it yet. One that never committed a turn left no row -- its run
    // died with its process before anything landed -- and is reported as
    // not found so the client can create it again.
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

// ---------------------------------------------------------------------------
// Future work: `/scheduling`'s job store over DO SQLite, armed by the alarm.

const PromptJson = Schema.toCodecJson(PromptWire.Prompt)

/**
 * The persisted half of the dispatcher: a `Scheduling.JobStore` over one
 * table, plus what the alarm needs that the seam does not -- the next due
 * time, and which session the jobs belong to. One DO is one session, so
 * the session id is remembered once, by the first `dispatch`.
 */
interface Jobs {
  readonly store: Scheduling.JobStore
  readonly nextDue: Effect.Effect<Option.Option<number>>
  readonly remember: (sessionId: string) => Effect.Effect<void>
  readonly sessionId: Effect.Effect<Option.Option<string>>
}

/** The jobs, as a service, so the layer can build them beside the client. */
class JobsService extends Context.Service<JobsService, Jobs>()("apps/worker/Jobs") {}

const makeJobs = Effect.fn("worker.makeJobs")(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS worker_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_after INTEGER NOT NULL,
    prompt TEXT NOT NULL
  )`.pipe(Effect.orDie)
  yield* sql`CREATE TABLE IF NOT EXISTS worker_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`.pipe(Effect.orDie)

  const store: Scheduling.JobStore = {
    enqueue: (job) =>
      Schema.encodeEffect(PromptJson)(job.prompt).pipe(
        Effect.flatMap((encoded) =>
          sql`INSERT INTO worker_jobs (run_after, prompt) VALUES (${job.runAfterMillis}, ${JSON.stringify(encoded)})`
        ),
        Effect.orDie,
        Effect.asVoid
      ),
    // Claim-and-take, as the seam requires: read the due rows, delete them
    // by id, decode. A DO's SQLite runs each request serially, which is the
    // isolation `claimDue` needs.
    claimDue: (now) =>
      sql`SELECT id, prompt FROM worker_jobs WHERE run_after <= ${now} ORDER BY id`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            sql`DELETE FROM worker_jobs WHERE id = ${row.id as number}`.pipe(
              Effect.andThen(Schema.decodeEffect(PromptJson)(JSON.parse(row.prompt as string))),
              Effect.map((prompt): Scheduling.PersistedJob => ({ prompt, runAfterMillis: now }))
            ))
        ),
        Effect.orDie
      )
  }

  const nextDue = sql`SELECT MIN(run_after) AS due FROM worker_jobs`.pipe(
    Effect.orDie,
    Effect.map((rows) => {
      const due = rows[0]?.due
      return typeof due === "number" ? Option.some(due) : Option.none()
    })
  )
  const remember = (sessionId: string) =>
    sql`INSERT INTO worker_meta (key, value) VALUES ('session_id', ${sessionId})
      ON CONFLICT(key) DO UPDATE SET value = ${sessionId}`.pipe(Effect.orDie, Effect.asVoid)
  const sessionId = sql`SELECT value FROM worker_meta WHERE key = 'session_id'`.pipe(
    Effect.orDie,
    Effect.map((rows) => {
      const value = rows[0]?.value
      return typeof value === "string" ? Option.some(value) : Option.none()
    })
  )
  const jobs: Jobs = { store, nextDue, remember, sessionId }
  return jobs
})

// ---------------------------------------------------------------------------

/**
 * Everything one DO instance holds: the client and the jobs over its SQLite,
 * the HTTP handler over the client, and the alarm's two duties. Built once
 * per instance; workerd evicts the instance when it hibernates and this is
 * rebuilt on the next request or alarm, reading the same storage.
 */
interface DurableHost {
  readonly handler: (request: Request) => Promise<Response>
  /** Persist a job for this session and arm the alarm for its due time. */
  readonly dispatch: (sessionId: string, input: string, delayMillis: number) => Promise<void>
  /** Run every due job against the session, then re-arm for the next. */
  readonly alarm: () => Promise<void>
}

const makeHost = async (storage: DurableObjectStorage): Promise<DurableHost> => {
  // The whole storage object, not just `.sql`: the driver runs transactions
  // through the DO's own transaction API, which plain `SqlStorage` lacks.
  const sqlLayer = SqliteClient.layer({ storage })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.effect(AgentClient.AgentClient, makeClient()),
      Layer.effect(JobsService, makeJobs())
    ).pipe(Layer.provide(sqlLayer), Layer.provideMerge(scriptedModel))
  )
  // Resolved once so the HTTP handler and the alarm share one client -- and
  // therefore one open session per id -- rather than each building its own.
  const [client, jobs] = await runtime.runPromise(Effect.all([AgentClient.AgentClient, JobsService]))

  const host = AgentSessionHost.layer(Host, {
    // One DO serves one session id's requests; the principal is whoever the
    // Worker let through. A deployment fronts this with real authentication
    // at the Worker and forwards its verdict.
    principal: {
      resolve: ({ headers }) => Effect.succeed(headers.authorization ?? "anonymous")
    },
    authorization: AgentSessionHost.allowAll(),
    maxSessions: 4,
    maxRequestsPerSession: 64
  }).pipe(Layer.provide(Layer.succeed(AgentClient.AgentClient, client)))
  const web = HttpRouter.toWebHandler(
    AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host)),
    { disableLogger: true }
  )

  /** Arm the alarm for the earliest job, if any is waiting. */
  const arm = Effect.flatMap(jobs.nextDue, (due) =>
    Option.isSome(due)
      ? Effect.promise(() => storage.setAlarm(due.value))
      : Effect.void
  )
  // A wake re-arms from the table: a job dispatched by a runtime that then
  // died is still due, whether or not the platform kept its alarm.
  await runtime.runPromise(arm)

  const dispatcher = Scheduling.queued(jobs.store)

  return {
    handler: (request) => web.handler(request),
    dispatch: (sessionId, input, delayMillis) =>
      runtime.runPromise(
        jobs.remember(sessionId).pipe(
          Effect.andThen(Scheduling.dispatch({ input, delay: delayMillis })),
          Effect.andThen(arm),
          Effect.provide(dispatcher)
        )
      ),
    alarm: () =>
      runtime.runPromise(
        // Scoped: a session created here for a job is released with the
        // alarm; the client keeps it open by id regardless.
        Effect.scoped(Effect.gen(function* () {
          const sessionId = yield* jobs.sessionId
          if (Option.isNone(sessionId)) return
          const due = yield* jobs.store.claimDue(Date.now())
          for (const job of due) {
            // The session, existing or re-adopted from storage; a job for a
            // session that never committed a turn creates it.
            const session = yield* client.session(sessionId.value).pipe(
              Effect.catchTag("AgentSessionNotFoundError", () =>
                client.createSession({ sessionId: sessionId.value }))
            )
            yield* session.prompt(Prompt.make(job.prompt)).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("worker: a dispatched run failed", { sessionId: sessionId.value, cause }))
            )
          }
          yield* arm
        }))
      )
  }
}

// ---------------------------------------------------------------------------
// The Durable Object: the session host, addressed by session id.

/** `POST /sessions/{id}/dispatch`: `{ input, delayMillis? }`. */
const dispatchRequest = async (request: Request): Promise<{ sessionId: string; input: string; delayMillis: number } | undefined> => {
  if (request.method !== "POST") return undefined
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "")
  if (segments.length !== 3 || segments[0] !== "sessions" || segments[2] !== "dispatch") return undefined
  try {
    const body = await request.clone().json() as { input?: unknown; delayMillis?: unknown }
    if (typeof body.input !== "string") return undefined
    return {
      sessionId: decodeURIComponent(segments[1]!),
      input: body.input,
      delayMillis: typeof body.delayMillis === "number" && body.delayMillis >= 0 ? body.delayMillis : 0
    }
  } catch {
    return undefined
  }
}

export class AgentSessionObject {
  private readonly storage: DurableObjectStorage
  private host: Promise<DurableHost> | undefined
  constructor(state: DurableObjectState) {
    this.storage = state.storage
  }
  private ready(): Promise<DurableHost> {
    return this.host ??= makeHost(this.storage)
  }
  async fetch(request: Request): Promise<Response> {
    const host = await this.ready()
    // Dispatch is the one route the HTTP surface does not have: it is this
    // host's own, and a deployment puts it behind the same authentication
    // the Worker applies to the rest.
    const dispatch = await dispatchRequest(request)
    if (dispatch !== undefined) {
      await host.dispatch(dispatch.sessionId, dispatch.input, dispatch.delayMillis)
      return new Response(JSON.stringify({ dispatched: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    }
    return host.handler(request)
  }
  async alarm(): Promise<void> {
    const host = await this.ready()
    await host.alarm()
  }
}

// ---------------------------------------------------------------------------
// The Worker: route by session id, nothing else. `POST /sessions` names its
// session in the body; every other route carries it in the path.

const sessionIdOf = async (request: Request): Promise<string | undefined> => {
  const url = new URL(request.url)
  const segments = url.pathname.split("/").filter((segment) => segment !== "")
  if (segments[0] !== "sessions") return undefined
  if (segments.length >= 2) return decodeURIComponent(segments[1]!)
  if (request.method === "POST") {
    try {
      const body = await request.clone().json() as { sessionId?: unknown }
      return typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sessionId = await sessionIdOf(request)
    if (sessionId === undefined) {
      return new Response(
        JSON.stringify({ error: "expected /sessions/{id}/... or POST /sessions with a sessionId" }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    }
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId))
    // The DO's fetch has the workers-types Request/Response nominally; the
    // values are the same web platform objects this handler received.
    return stub.fetch(request as never) as unknown as Response
  }
}
