import type { DurableObjectNamespace, DurableObjectState, DurableObjectStorage } from "@cloudflare/workers-types"
import { Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { HttpRouter } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { Agent, AgentLoop, PromptWire } from "@doeixd/effect-agent"
import * as AgentSessionEngine from "@doeixd/effect-agent/AgentSession"
import { AgentClient, AgentSessionHost } from "@doeixd/effect-agent/client"
import { DeliveryLog } from "@doeixd/effect-agent/durable"
import { AgentHttp } from "@doeixd/effect-agent/http"
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
 * - **History** is written to DO SQLite after every completed submission
 *   and restored when the DO wakes, so the conversation survives
 *   hibernation and process death.
 * - **Events** are journaled to the same `DeliveryLog` every other durable
 *   deployment uses, through the session's `eventSink` — the synchronous
 *   sink that exists precisely so a recorder cannot miss an envelope. A
 *   client reconnecting with `events?after=N` is served the journal above
 *   its cursor, then live delivery, gaplessly.
 * - **Mid-run process loss** loses the run, not the conversation — the DO
 *   equivalent of a Node process without `/durable`. Runs that must survive
 *   their process still need the workflow engine, on a host it runs on.
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

const agent = Agent.make({
  instructions: "You are a helpful assistant running inside a Durable Object.",
  loop: AgentLoop.bounded(2)
})

const scriptedModel = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script(
      Array.from({ length: 64 }, (_, index) => TestLanguageModel.text(`reply-${index + 1}`))
    ),
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
      // History persists as each submission completes; the session is idle
      // then, so what is written is a conversation that existed.
      yield* Effect.forkIn(
        Stream.runForEach(session.events, (envelope) =>
          envelope.event._tag === "SubmissionCompleted" || envelope.event._tag === "SubmissionInterrupted"
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
    // opened it yet. One that never completed a submission left no row --
    // its run died with its process, which is this deployment's contract --
    // and is reported as not found so the client can create it again.
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

/**
 * The whole stack over one DO's SQLite. Built once per DO instance; workerd
 * evicts the instance when it hibernates and this is rebuilt on the next
 * request, reading the same storage.
 */
const makeHandler = (storage: DurableObjectStorage) => {
  // The whole storage object, not just `.sql`: the driver runs transactions
  // through the DO's own transaction API, which plain `SqlStorage` lacks.
  const sqlLayer = SqliteClient.layer({ storage })
  const client = Layer.effect(AgentClient.AgentClient, makeClient()).pipe(
    Layer.provide(sqlLayer),
    Layer.provideMerge(scriptedModel)
  )
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
  }).pipe(Layer.provide(client))
  return HttpRouter.toWebHandler(
    AgentHttp.serverLayer({ host: Host }).pipe(Layer.provide(host)),
    { disableLogger: true }
  )
}

// ---------------------------------------------------------------------------
// The Durable Object: the session host, addressed by session id.

export class AgentSessionObject {
  private readonly storage: DurableObjectStorage
  private handler: ReturnType<typeof makeHandler> | undefined
  constructor(state: DurableObjectState) {
    this.storage = state.storage
  }
  async fetch(request: Request): Promise<Response> {
    this.handler ??= makeHandler(this.storage)
    return this.handler.handler(request)
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
