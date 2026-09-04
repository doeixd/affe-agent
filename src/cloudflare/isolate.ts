import { Context, Effect, Layer, Option, Ref } from "effect"
import { Binding, DurableObjectState, WorkerEnvironment } from "effect-cf"
import type * as CodeMode from "../code/CodeMode.js"
import { CodeDiagnostic } from "../code/internal/diagnostics.js"
import { type Invoke, ProgramThrow } from "../code/internal/interpret.js"

/**
 * Code mode in an isolate: a `CodeExecutor` that runs the model's program
 * in a Dynamic Worker with no outbound network
 * (`docs/plan-effect-agent-comparison.md` §3.5, item 9).
 *
 * The owned interpreter confines a program by construction of the
 * language and runs it in the host's process; this one confines it by the
 * platform. Each program is loaded as its own worker through the Worker
 * Loader binding, with CPU and subrequest limits, and is discarded when
 * the program ends. The program is real JavaScript, compiled by the
 * runtime rather than evaluated (Workers forbid `eval`), so a program the
 * interpreter's subset would refuse runs here in full.
 *
 * **Every nested call is still a tool call**, and that is the whole point
 * of the seam. The isolate's `globalOutbound` is the Durable Object's own
 * stub, so any request it makes lands on the object; the main module
 * keeps the real `fetch` for its broker call and removes `fetch` and
 * `WebSocket` from the program's globals, so the program itself can reach
 * nothing. (A TCP socket from `cloudflare:sockets` follows the same
 * outbound to a stub that does not speak TCP.) The broker route,
 * `POST /code/invoke`, answers by the `invoke` hook `CodeMode` gave this
 * executor, on a fibre carrying the context the run started with -- the
 * same `Permission` decision, the same events and the same
 * `CurrentPrincipal` as a call the interpreter makes. A per-run token,
 * minted here and never shown to the program, is what lets the broker tell
 * the run's own calls from anyone else's; and the route is unreachable
 * from the public Worker, whose paths all carry the session segment.
 *
 * Two things this executor does not do. It never suspends: a Dynamic
 * Worker's state is its heap, and a paused program is a program that is
 * still running. And it does not soften a refusal: a `CodeDiagnostic` the
 * host raised inside a call is recorded by the broker and *wins* the run
 * whatever the program returned, so a `try`/`catch` around the call
 * changes what the program did, not what the host reports.
 */

/** What the isolate is told about a call, on the wire. */
type Reply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

/**
 * The broker: which runs are live, and how the object answers a call
 * from one of them. Provided by `CloudflareHost.make`; the executor
 * registers each run under a fresh token, and the object's fetch routes
 * `POST /code/invoke` here.
 */
export class CodeBroker extends Context.Service<CodeBroker, {
  readonly register: (
    invoke: (path: ReadonlyArray<string>, input: unknown) => Effect.Effect<Reply>
  ) => Effect.Effect<{ readonly token: string; readonly release: Effect.Effect<void> }>
  /** The `/code/invoke` route. A bad token is a 403 and says nothing else. */
  readonly handle: (request: Request) => Effect.Effect<Response>
}>()("affe-agent/cloudflare/CodeBroker") {}

export const brokerLayer: Layer.Layer<CodeBroker> = Layer.effect(
  CodeBroker,
  Effect.gen(function* () {
    const live = yield* Ref.make(
      new Map<string, (path: ReadonlyArray<string>, input: unknown) => Effect.Effect<Reply>>()
    )
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    return {
      register: (invoke) =>
        Effect.gen(function* () {
          const token = crypto.randomUUID()
          yield* Ref.update(live, (all) => new Map(all).set(token, invoke))
          return {
            token,
            release: Ref.update(live, (all) => {
              const next = new Map(all)
              next.delete(token)
              return next
            })
          }
        }),
      handle: (request) =>
        Effect.gen(function* () {
          const body = yield* Effect.tryPromise(() =>
            request.json() as Promise<{ token?: unknown; path?: unknown; input?: unknown }>
          ).pipe(Effect.orElseSucceed(() => ({}) as { token?: unknown; path?: unknown; input?: unknown }))
          const invoke = typeof body.token === "string" ? (yield* Ref.get(live)).get(body.token) : undefined
          if (invoke === undefined) return json(403, { ok: false, message: "unknown run" })
          const path = Array.isArray(body.path) && body.path.every((p) => typeof p === "string")
            ? (body.path as ReadonlyArray<string>)
            : undefined
          if (path === undefined) return json(400, { ok: false, message: "a call names its tool as a path" })
          return json(200, yield* invoke(path, body.input))
        })
    }
  })
)

export interface Options {
  /** The Worker Loader binding. Default `LOADER`. */
  readonly loader?: string | undefined
  /** The Durable Object namespace binding the isolate calls back through. Default `SESSIONS`. */
  readonly namespace?: string | undefined
  /** The dynamic worker's compatibility date. Default `2026-08-25`. */
  readonly compatibilityDate?: string | undefined
  /** CPU budget for one program, in milliseconds. Default 10 000. */
  readonly cpuMs?: number | undefined
  /** Subrequests one program may make -- each tool call is one. Default 128. */
  readonly subRequests?: number | undefined
}

/** The isolate's main module: the loop the program runs in. Plain JS, compiled by the runtime. */
const MAIN_MODULE = `
import program from "./program.js"

// The one road out of the isolate is \`globalOutbound\`, which the host set
// to the object's own stub: every fetch lands on the object, whatever URL
// it names. The real fetch is kept here for the broker call, and the
// program is left with none -- a program with fetch could reach the
// object's other routes; a program without it can reach nothing.
const outbound = globalThis.fetch
const noNetwork = () => { throw new Error("the network is not available to a program; call a tool") }
globalThis.fetch = noNetwork
globalThis.WebSocket = undefined

const call = async (env, path, input) => {
  const response = await outbound("https://code.invalid/code/invoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: env.TOKEN, path, input })
  })
  const reply = await response.json()
  if (reply.ok) return reply.value
  throw new Error(reply.message)
}

/** tools.<namespace>.<name>(input): the catalog's shape, over the broker. */
const toolsFor = (env, known) => {
  const byNamespace = new Map()
  for (const entry of known) {
    const [namespace, name] = entry.split(".")
    if (!byNamespace.has(namespace)) byNamespace.set(namespace, new Map())
    byNamespace.get(namespace).set(name, (input) => call(env, [namespace, name], input))
  }
  const missing = (path) => () => { throw new Error("no tool at tools." + path + "; check the catalog") }
  return new Proxy({}, {
    get: (_, namespace) => {
      if (typeof namespace !== "string") return undefined
      const group = byNamespace.get(namespace)
      return new Proxy({}, {
        get: (_, name) => typeof name !== "string" ? undefined : (group?.get(name) ?? missing(namespace + "." + name))
      })
    }
  })
}

export default {
  async fetch(request, env) {
    const { known } = await request.json()
    const logs = []
    const record = (...args) => { logs.push(args) }
    const console = { log: record, info: record, warn: record, error: record, debug: record }
    try {
      const value = await program(toolsFor(env, known), console)
      return Response.json(value === undefined ? { tag: "RanOffTheEnd", logs } : { tag: "Returned", value, logs })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ tag: "Threw", message, logs })
    }
  }
}
`

/** The isolate's answer, as the main module writes it. */
type IsolateOutcome =
  | { readonly tag: "Returned"; readonly value: unknown; readonly logs: ReadonlyArray<ReadonlyArray<unknown>> }
  | { readonly tag: "RanOffTheEnd"; readonly logs: ReadonlyArray<ReadonlyArray<unknown>> }
  | { readonly tag: "Threw"; readonly message: string; readonly logs: ReadonlyArray<ReadonlyArray<unknown>> }

const isOutcome = (value: unknown): value is IsolateOutcome =>
  typeof value === "object" && value !== null && "tag" in value && "logs" in value && Array.isArray(value.logs)

/**
 * The executor, over this object's loader and namespace bindings.
 *
 * Built once per Durable Object instance (it reads the object's name as
 * the session the isolate calls back to) and handed to `CodeTool.tool` as
 * its `executor`. Requires `CodeBroker`, which `CloudflareHost.make`
 * provides.
 */
export const executor = (options?: Options): Effect.Effect<
  CodeMode.CodeExecutor,
  Binding.BindingNotFoundError,
  WorkerEnvironment | DurableObjectState.DurableObjectState | CodeBroker
> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment
    const state = yield* DurableObjectState.DurableObjectState
    const broker = yield* CodeBroker
    const loaderName = options?.loader ?? "LOADER"
    const namespaceName = options?.namespace ?? "SESSIONS"
    // `Cloudflare.Env` is the deployment's own interface; the bindings are read by name.
    const bindings = env as Record<string, unknown>
    const loader = bindings[loaderName]
    const namespace = bindings[namespaceName]
    if (loader === undefined || typeof loader !== "object" || loader === null || !("load" in loader)) {
      return yield* new Binding.BindingNotFoundError({ binding: loaderName, message: `binding ${loaderName} is not a Worker Loader` })
    }
    if (namespace === undefined || typeof namespace !== "object" || namespace === null || !("idFromName" in namespace)) {
      return yield* new Binding.BindingNotFoundError({ binding: namespaceName, message: `binding ${namespaceName} is not a Durable Object namespace` })
    }
    const sessionId = Option.fromNullishOr(state.id.name)

    const run = <R>(
      code: string,
      hooks: {
        readonly invoke: Invoke<R>
        readonly resumeFrom?: unknown | undefined
        readonly knownTools: ReadonlySet<string>
      }
    ): Effect.Effect<CodeMode.ExecutorOutcome, ProgramThrow | CodeDiagnostic, R> =>
      Effect.gen(function* () {
        if (hooks.resumeFrom !== undefined) {
          return yield* new CodeDiagnostic({
            reason: "not-resumable",
            fix: "an isolate never suspends; this state is not its own -- run the program again deliberately, or use an executor that suspends"
          })
        }
        if (Option.isNone(sessionId)) {
          return yield* new CodeDiagnostic({
            reason: "internal",
            fix: "the isolate calls back to its object by name, and this object has none; address sessions through idFromName"
          })
        }
        // The run's own context, so a call answered on the broker's fibre
        // sees the services -- and the principal -- the run started with.
        const context = yield* Effect.context<R>()
        const refused = yield* Ref.make<Option.Option<CodeDiagnostic>>(Option.none())
        const registration = yield* broker.register((path, input) =>
          hooks.invoke(path, input).pipe(
            Effect.provide(context),
            Effect.map((value): Reply => ({ ok: true, value })),
            Effect.catch((error): Effect.Effect<Reply> =>
              error instanceof CodeDiagnostic
                // Recorded, and reported to the program as a throw it can
                // catch -- but the host's verdict is what `run` returns.
                ? Ref.set(refused, Option.some(error)).pipe(Effect.as({ ok: false, message: `refused: ${error.fix}` }))
                : Effect.succeed({ ok: false, message: error.message }))
          )
        )
        const outcome = yield* Effect.tryPromise({
          try: async () => {
            // The object's own stub as the isolate's only outbound: a fetch
            // to any URL lands here, on the broker route, and nowhere else.
            const sessions = namespace as DurableObjectNamespace
            const self = sessions.get(sessions.idFromName(sessionId.value))
            const worker = (loader as WorkerLoader).load({
              compatibilityDate: options?.compatibilityDate ?? "2026-08-25",
              mainModule: "main.js",
              modules: {
                "main.js": MAIN_MODULE,
                "program.js": `export default async function program(tools, console) {\n${code}\n}`
              },
              env: { TOKEN: registration.token },
              globalOutbound: self,
              limits: { cpuMs: options?.cpuMs ?? 10_000, subRequests: options?.subRequests ?? 128 }
            })
            const response = await worker.getEntrypoint().fetch("https://isolate.invalid/run", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ known: [...hooks.knownTools] })
            })
            return (await response.json()) as unknown
          },
          catch: (cause) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            // The runtime compiles the program when the worker loads, so a
            // program that does not parse fails here, not in the interpreter's
            // parser; it gets the same diagnostic the interpreter would give.
            return cause instanceof SyntaxError || /SyntaxError/.test(message)
              ? new CodeDiagnostic({ reason: "parse-error", fix: `the program does not parse: ${message}` })
              : new CodeDiagnostic({ reason: "internal", fix: `the isolate could not run the program: ${message}` })
          }
        }).pipe(Effect.ensuring(registration.release))

        const verdict = yield* Ref.get(refused)
        if (Option.isSome(verdict)) return yield* verdict.value
        if (!isOutcome(outcome)) {
          return yield* new CodeDiagnostic({ reason: "internal", fix: "the isolate answered in a shape this executor does not know" })
        }
        switch (outcome.tag) {
          case "Returned":
            return { _tag: "Completed" as const, result: Option.some(outcome.value), logs: outcome.logs }
          case "RanOffTheEnd":
            return { _tag: "Completed" as const, result: Option.none(), logs: outcome.logs }
          case "Threw":
            return yield* new ProgramThrow({ value: { message: outcome.message } })
        }
      })

    return { run }
  })
