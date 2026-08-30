import { NodeHttpServer } from "@effect/platform-node"
import { Client as V2Client, StreamableHTTPClientTransport as V2HttpTransport } from "@modelcontextprotocol/client"
import { Effect, Layer, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { McpProtocol, McpServer } from "effect/unstable/ai"
import { Sse } from "effect/unstable/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { createServer } from "node:http"
import { AgentA2A } from "../src/a2a/index.js"
import { AgentAgUi } from "../src/ag-ui/index.js"
import { AgentProtocol } from "../src/client/index.js"
import { AgentHttp } from "../src/http/index.js"
import { AgentMcp } from "../src/mcp/index.js"
import { AgentRpc } from "../src/rpc/index.js"
import * as Matrix from "./HostConformance.js"

/**
 * The five adapters, each driving the shared host through its own wire.
 * See `HostConformance.ts` for the rows and what a driver may declare.
 */
const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)
const DEFAULT_AUTH = "Bearer matrix"
const sid = (value: string) => AgentProtocol.SessionId.make(value)
const rid = (value: string) => AgentProtocol.RequestId.make(value)
let counter = 0
const fresh = (prefix: string) => `${prefix}-${++counter}`

/** A typed client's error, in the matrix's words. */
const fromError = (error: { readonly _tag: string; readonly message: string }): Matrix.Outcome => {
  const byTag: Record<string, Matrix.Refusal> = {
    AgentCapacityExceededError: "capacity",
    AgentRequestCapacityExceededError: "capacity",
    AgentForbiddenError: "forbidden",
    AgentUnauthorizedError: "unauthorized",
    AgentBusyError: "busy"
  }
  return { kind: "refused", reason: byTag[error._tag] ?? "other", detail: `${error._tag}: ${error.message}` }
}

const completed = (result: AgentProtocol.RemoteResult): Matrix.Outcome => ({
  kind: "completed",
  status: result.status,
  text: result.text
})

/** Serve routes on an ephemeral port inside the current scope; returns the base URL. */
const serve = <E>(routes: Layer.Layer<never, E, HttpRouter.HttpRouter>) =>
  Effect.gen(function* () {
    const built = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        // A stream still open at teardown must not turn the scope's close into
        // the test's failure; the server drains rather than pre-empting.
        Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true }))
      )
    )
    const server = yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(built))
    return HttpServer.formatAddress(server.address)
  }).pipe(Effect.orDie)

/** Read SSE frames from a fetch response until `done` says so. */
const readSse = (response: Response, done: (event: Sse.Event) => boolean, abort?: AbortController) =>
  Effect.gen(function* () {
    const body = response.body
    if (body === null) return yield* Effect.die(new Error("SSE response had no body"))
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const seen: Array<Sse.Event> = []
    let finished = false
    const parser = Sse.makeParser((event) => {
      if (event._tag === "Event") {
        seen.push(event)
        if (done(event)) finished = true
      }
    })
    while (!finished) {
      const chunk = yield* promise(() => reader.read())
      if (chunk.done) break
      const parseError = parser.feed(decoder.decode(chunk.value))
      if (parseError !== undefined) return yield* Effect.die(parseError)
    }
    yield* promise(() => reader.cancel()).pipe(Effect.ignore)
    abort?.abort()
    return seen
  })

// ---------------------------------------------------------------------------
// HTTP

const http: Matrix.Driver = {
  name: "HTTP",
  make: (host) =>
    Effect.gen(function* () {
      const base = yield* serve(AgentHttp.serverLayer({ host: Matrix.Host }).pipe(Layer.provide(host)))
      const client = yield* HttpApiClient.make(AgentHttp.Api, { baseUrl: base }).pipe(Effect.provide(FetchHttpClient.layer))
      const created = new Set<string>()
      const ensure = (session: string, auth: string) =>
        created.has(session)
          ? Effect.void
          : client.sessions.createSession({
            headers: { authorization: auth },
            payload: { requestId: rid(fresh("create")), sessionId: sid(session) }
          }).pipe(
            // Two prompts racing to open one session: the loser's answer is
            // that it exists, which is what it wanted.
            Effect.catchTag("AgentSessionAlreadyExistsError", () => Effect.void),
            Effect.map(() => void created.add(session))
          )
      return {
        prompt: (session, text, options) =>
          Effect.gen(function* () {
            const auth = options?.auth ?? DEFAULT_AUTH
            yield* ensure(session, auth)
            const { result } = yield* client.sessions.prompt({
              params: { id: sid(session) },
              headers: { authorization: auth },
              payload: { requestId: rid(options?.requestId ?? fresh("prompt")), input: Prompt.make(text) }
            })
            return completed(result)
          }).pipe(Effect.catch((error) => Effect.succeed(fromError(error)))),
        interrupt: (session) =>
          client.sessions.interrupt({
            params: { id: sid(session) },
            headers: { authorization: DEFAULT_AUTH },
            payload: { requestId: rid(fresh("interrupt")) }
          }).pipe(Effect.asVoid, Effect.orDie),
        eventsAfter: (session, after) =>
          Effect.gen(function* () {
            const abort = new AbortController()
            const response = yield* promise(() =>
              fetch(`${base}/sessions/${session}/events?after=${after}`, { headers: { authorization: DEFAULT_AUTH }, signal: abort.signal })
            )
            const events = yield* readSse(response, (event) => event.event === "SubmissionCompleted", abort)
            return events.map((event) => Number(event.id))
          }),
        unsupported: {}
      } satisfies Matrix.Ops
    })
}

// ---------------------------------------------------------------------------
// RPC (over HTTP, ndjson)

const rpc: Matrix.Driver = {
  name: "RPC",
  make: (host) =>
    Effect.gen(function* () {
      const routes = RpcServer.layerHttp({ group: AgentRpc.Protocol, path: "/rpc", protocol: "http" }).pipe(
        Layer.provide(AgentRpc.serverLayer({ host: Matrix.Host }).pipe(Layer.provide(host))),
        Layer.provide(RpcSerialization.layerNdjson)
      )
      const base = yield* serve(routes)
      const client = yield* Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient
        const protocol = yield* RpcClient.makeProtocolHttp(
          HttpClient.mapRequest(httpClient, HttpClientRequest.prependUrl(`${base}/rpc`))
        )
        return yield* RpcClient.make(AgentRpc.Protocol).pipe(Effect.provideService(RpcClient.Protocol, protocol))
      }).pipe(Effect.provide(Layer.mergeAll(RpcSerialization.layerNdjson, FetchHttpClient.layer)))
      const created = new Set<string>()
      const withAuth = (auth: string) => ({ headers: { authorization: auth } })
      const ensure = (session: string, auth: string) =>
        created.has(session)
          ? Effect.void
          : client.createSession({ requestId: rid(fresh("create")), sessionId: sid(session) }, withAuth(auth)).pipe(
            Effect.catchTag("AgentSessionAlreadyExistsError", () => Effect.void),
            Effect.map(() => void created.add(session))
          )
      return {
        prompt: (session, text, options) =>
          Effect.gen(function* () {
            const auth = options?.auth ?? DEFAULT_AUTH
            yield* ensure(session, auth)
            const { result } = yield* client.prompt(
              { requestId: rid(options?.requestId ?? fresh("prompt")), sessionId: sid(session), input: Prompt.make(text) },
              withAuth(auth)
            )
            return completed(result)
          }).pipe(Effect.catch((error) => Effect.succeed(fromError(error)))),
        interrupt: (session) =>
          client.interrupt({ requestId: rid(fresh("interrupt")), sessionId: sid(session) }, withAuth(DEFAULT_AUTH)).pipe(
            Effect.asVoid,
            Effect.orDie
          ),
        eventsAfter: (session, after) =>
          client.events({ sessionId: sid(session), after }, withAuth(DEFAULT_AUTH)).pipe(
            Stream.takeUntil((envelope) => envelope.event._tag === "SubmissionCompleted"),
            Stream.map((envelope) => envelope.sequence),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.orDie
          ),
        unsupported: {}
      } satisfies Matrix.Ops
    })
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP, official v2 client)

const decodeStarted = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(AgentMcp.StartAgent.successSchema)))
const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(AgentProtocol.RemoteResult)))
const decodeLog = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(AgentProtocol.EventLogResponse)))

const firstText = (result: { readonly content?: unknown; readonly contents?: unknown }): string => {
  const list = Array.isArray(result.content) ? result.content : Array.isArray(result.contents) ? result.contents : []
  const first: unknown = list[0]
  return typeof first === "object" && first !== null && "text" in first && typeof first.text === "string" ? first.text : ""
}

const mcp: Matrix.Driver = {
  name: "MCP",
  make: (host) =>
    Effect.gen(function* () {
      const server = McpServer.layerHttp({
        name: "host-conformance",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18]
      })
      const base = yield* serve(AgentMcp.serverLayer({ host: Matrix.Host }).pipe(Layer.provide(server), Layer.provide(host)))
      // One connection per principal the matrix uses, opened in the driver's
      // scope so the ops themselves need none.
      const clients = new Map<string, V2Client>()
      for (const auth of [DEFAULT_AUTH, "Bearer forbidden"]) {
        const client = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const created = new V2Client({ name: "matrix", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
            yield* promise(() =>
              created.connect(new V2HttpTransport(new URL("/mcp", base), { requestInit: { headers: { authorization: auth } } }))
            )
            return created
          }),
          (client) => promise(() => client.close()).pipe(Effect.ignore)
        )
        clients.set(auth, client)
      }
      const connect = (auth: string): Effect.Effect<V2Client> => {
        const client = clients.get(auth)
        return client === undefined ? Effect.die(new Error(`no MCP connection for ${auth}`)) : Effect.succeed(client)
      }
      const call = (auth: string, name: string, args: Record<string, unknown>) =>
        Effect.flatMap(connect(auth), (client) =>
          promise(() => client.callTool({ name, arguments: args })).pipe(
            Effect.map((result) => ({ text: firstText(result), isError: result.isError === true }))
          ))
      return {
        prompt: (session, text, options) =>
          Effect.gen(function* () {
            const auth = options?.auth ?? DEFAULT_AUTH
            const started = yield* call(auth, "agent_start", { prompt: text, sessionId: session })
            if (started.isError) return Matrix.refused(undefined, started.text)
            const ticket = decodeStarted(started.text)
            const awaited = yield* call(auth, "agent_await", { requestId: ticket.requestId })
            if (awaited.isError) return Matrix.refused(undefined, awaited.text)
            return completed(decodeResult(awaited.text))
          }),
        interrupt: (session) => call(DEFAULT_AUTH, "agent_interrupt", { sessionId: session }).pipe(Effect.asVoid),
        eventsAfter: (session, after) =>
          Effect.flatMap(connect(DEFAULT_AUTH), (client) =>
            promise(() => client.readResource({ uri: `agent://session/${session}/events/after/${after}` })).pipe(
              Effect.map((result) => {
                const log = decodeLog(firstText(result))
                const terminal = log.events.findIndex((envelope) => envelope.event._tag === "SubmissionCompleted")
                return log.events.slice(0, terminal === -1 ? undefined : terminal + 1).map((envelope) => envelope.sequence)
              })
            )),
        unsupported: {
          idempotency:
            "request ids are minted by agent_start, not chosen by the caller; the idempotent form is awaiting one ticket twice, covered by McpServerConformance"
        }
      } satisfies Matrix.Ops
    })
}

// ---------------------------------------------------------------------------
// A2A (REST binding, raw fetch so headers can be set)

interface RestTask {
  readonly id: string
  readonly contextId: string
  readonly status?: {
    readonly state?: string
    readonly message?: { readonly parts?: ReadonlyArray<{ readonly text?: string }> } | undefined
  } | undefined
  readonly artifacts?: ReadonlyArray<{ readonly parts?: ReadonlyArray<{ readonly text?: string }> }> | undefined
}

const a2a: Matrix.Driver = {
  name: "A2A",
  make: (host) =>
    Effect.gen(function* () {
      const base = yield* serve(
        AgentA2A.serverLayer({
          host: Matrix.Host,
          path: "/a2a",
          card: {
            name: "Host conformance",
            description: "matrix",
            version: "1.0.0",
            skills: [{ id: "prompt", name: "Prompt", description: "text", tags: ["text"], examples: [], inputModes: ["text/plain"], outputModes: ["text/plain"] }]
          },
          principal: { subject: (principal) => principal },
          session: { resolve: ({ contextId }) => Effect.succeed(sid(`a2a:${contextId}`)) }
        }).pipe(Layer.provide(host))
      )
      const contexts = new Map<string, string>()
      const tasks = new Map<string, string>()
      const headers = (auth: string) => ({ authorization: auth, "A2A-Version": "1.0", "content-type": "application/json" })
      const json = (response: Response) => promise(() => response.json() as Promise<unknown>)
      const errorMessage = (body: unknown): string =>
        typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null &&
          "message" in body.error
          ? String(body.error.message)
          : JSON.stringify(body)
      const terminal = (state: string | undefined) =>
        state !== undefined && (state.includes("COMPLETED") || state.includes("CANCELED") || state.includes("FAILED"))
      const poll = (auth: string, taskId: string): Effect.Effect<RestTask> =>
        Effect.gen(function* () {
          while (true) {
            const response = yield* promise(() => fetch(`${base}/a2a/tasks/${taskId}`, { headers: headers(auth) }))
            const task = (yield* json(response)) as RestTask
            if (terminal(task.status?.state)) return task
            yield* Effect.sleep("20 millis")
          }
        })
      return {
        prompt: (session, text, options) =>
          Effect.gen(function* () {
            const auth = options?.auth ?? DEFAULT_AUTH
            const response = yield* promise(() =>
              fetch(`${base}/a2a/message:send`, {
                method: "POST",
                headers: headers(auth),
                body: JSON.stringify({
                  message: {
                    messageId: fresh("message"),
                    contextId: contexts.get(session) ?? "",
                    role: "ROLE_USER",
                    parts: [{ text, mediaType: "text/plain" }]
                  },
                  configuration: { returnImmediately: true, acceptedOutputModes: ["text/plain"] }
                })
              })
            )
            const body = yield* json(response)
            if (response.status !== 200) return Matrix.refused(response.status, errorMessage(body))
            // `message:send` answers `{ task }` (or `{ message }`); the task is inside.
            const submitted = (body as { readonly task: RestTask }).task
            contexts.set(session, submitted.contextId)
            tasks.set(session, submitted.id)
            const task = terminal(submitted.status?.state) ? submitted : yield* poll(auth, submitted.id)
            const state = task.status?.state ?? ""
            // A2A reports a host refusal as a *failed task* with the reason in
            // the status message -- the request itself is 200. That is the
            // protocol's shape, and the matrix classifies from the text.
            if (state.includes("FAILED")) {
              return Matrix.refused(undefined, task.status?.message?.parts?.[0]?.text ?? `task failed: ${JSON.stringify(task)}`)
            }
            return {
              kind: "completed",
              status: state.includes("CANCELED") ? "interrupted" : "completed",
              text: task.artifacts?.[0]?.parts?.[0]?.text ?? ""
            }
          }),
        interrupt: (session) =>
          Effect.gen(function* () {
            const taskId = tasks.get(session)
            if (taskId === undefined) return yield* Effect.die(new Error(`no task for ${session}`))
            const response = yield* promise(() =>
              fetch(`${base}/a2a/tasks/${taskId}:cancel`, { method: "POST", headers: headers(DEFAULT_AUTH), body: "{}" })
            )
            if (response.status !== 200) return yield* Effect.die(new Error(`cancel returned ${response.status}`))
          }),
        unsupported: {
          idempotency: "an A2A message id identifies a message, not a submission; a resent message is a new task",
          resumption: "A2A streams are per task (tasks/{id}:subscribe); the session-wide event cursor has no A2A form"
        }
      } satisfies Matrix.Ops
    })
}

// ---------------------------------------------------------------------------
// AG-UI (POST run, SSE events)

const agui: Matrix.Driver = {
  name: "AG-UI",
  make: (host) =>
    Effect.gen(function* () {
      const base = yield* serve(
        AgentAgUi.serverLayer({
          host: Matrix.Host,
          session: { resolve: ({ input }) => Effect.succeed(sid(`ag-ui:${input.threadId}`)) }
        }).pipe(Layer.provide(host))
      )
      const threads = new Map<string, Array<{ id: string; role: string; content: string }>>()
      return {
        prompt: (session, text, options) =>
          Effect.gen(function* () {
            const auth = options?.auth ?? DEFAULT_AUTH
            const history = threads.get(session) ?? []
            const messages = [...history, { id: fresh("user"), role: "user", content: text }]
            const response = yield* promise(() =>
              fetch(`${base}/ag-ui`, {
                method: "POST",
                headers: { authorization: auth, "content-type": "application/json" },
                body: JSON.stringify({
                  threadId: session,
                  runId: options?.requestId ?? fresh("run"),
                  state: {},
                  messages,
                  tools: [],
                  context: [],
                  forwardedProps: {}
                })
              })
            )
            if (response.status !== 200) {
              const body = yield* promise(() => response.text())
              return Matrix.refused(response.status, body)
            }
            const events = yield* readSse(response, (event) => {
              const type = (JSON.parse(event.data) as { type?: string }).type
              return type === "RUN_FINISHED" || type === "RUN_ERROR"
            })
            let answer = ""
            let failed: string | undefined
            for (const event of events) {
              const parsed = JSON.parse(event.data) as { type?: string; delta?: string; message?: string }
              if (parsed.type === "TEXT_MESSAGE_CONTENT") answer += parsed.delta ?? ""
              if (parsed.type === "RUN_ERROR") failed = parsed.message ?? "RUN_ERROR"
            }
            if (failed !== undefined) return Matrix.refused(undefined, failed)
            threads.set(session, [...messages, { id: fresh("assistant"), role: "assistant", content: answer }])
            return { kind: "completed", status: "completed", text: answer }
          }),
        unsupported: {
          interruption: "AG-UI has no cancel; a client disconnect is the only signal, and it is not an answer the run reports",
          idempotency: "a runId names a run for the event stream; AG-UI defines no retry-safe resubmission",
          resumption: "one run is one SSE response; there is no session-wide cursor to resume from"
        }
      } satisfies Matrix.Ops
    })
}

for (const driver of [http, rpc, mcp, a2a, agui]) Matrix.run(driver)
