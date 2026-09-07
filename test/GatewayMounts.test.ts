import { assert, describe, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { build } from "esbuild"
import { convertV4MiniflareOptions, Miniflare } from "miniflare"
import * as fs from "node:fs/promises"
import { createServer } from "node:http"
import * as path from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentSessionHost } from "../src/client/index.js"
import { AgentHttp, AgentServer } from "../src/http/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `plan-deployment.md` §6.2, exercised rather than asserted: one `AgentServer`
 * serves an in-process mount **and** a mount whose client is the HTTP adapter
 * pointed at a real Durable Object host running on workerd, and a caller on
 * the outside cannot tell them apart -- same routes, same status codes, same
 * response shapes, same inventory row shape. The gateway adds no mechanism:
 * a mount is a host over *an* `AgentClient`, and `agentClientLayer` is one.
 *
 * The worker is `apps/worker`'s own entry on miniflare, listening on a real
 * port so the gateway reaches it over HTTP as it would reach a deployment.
 */

const bundleWorker = Effect.fn("GatewayMounts.bundle")(function* () {
  yield* Effect.promise(() => fs.mkdir(path.join(process.cwd(), "dist"), { recursive: true }))
  const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(process.cwd(), "dist", "worker-gateway-")))
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  )
  const outfile = path.join(directory, "worker.mjs")
  yield* Effect.promise(() =>
    build({
      entryPoints: [path.join(process.cwd(), "apps", "worker", "src", "index.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "browser"],
      outfile,
      logLevel: "silent",
      external: ["cloudflare:*", "node:*"],
      alias: {
        "affe-agent": path.join(process.cwd(), "src", "index.ts"),
        "affe-agent/cloudflare": path.join(process.cwd(), "src", "cloudflare", "index.ts"),
        "affe-agent/code": path.join(process.cwd(), "src", "code", "index.ts"),
        "affe-agent/AgentSession": path.join(process.cwd(), "src", "AgentSession.ts"),
        "affe-agent/client": path.join(process.cwd(), "src", "client", "index.ts"),
        "affe-agent/durable": path.join(process.cwd(), "src", "durable", "index.ts"),
        "affe-agent/http": path.join(process.cwd(), "src", "http", "index.ts"),
        "affe-agent/scheduling": path.join(process.cwd(), "src", "scheduling", "index.ts"),
        "affe-agent/testing": path.join(process.cwd(), "src", "testing", "index.ts")
      }
    })
  )
  return { directory, outfile }
})

/** The worker on a real port, so the gateway reaches it over HTTP. */
const workerListening = (outfile: string, persist: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const miniflare = new Miniflare(convertV4MiniflareOptions({
        modules: [{ type: "ESModule", path: outfile }],
        compatibilityDate: "2026-08-25",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { SESSIONS: { className: "AgentSessionObject", useSQLite: true } },
        workerLoaders: { LOADER: {} },
        resourcePersistencePath: persist,
        port: 0
      }))
      const url = await miniflare.ready
      return { miniflare, baseUrl: url.toString().replace(/\/$/, "") }
    }),
    ({ miniflare }) => Effect.promise(() => miniflare.dispose())
  )

const headers = { authorization: "Bearer gateway", "content-type": "application/json" }
const wireInput = (text: string) => ({ content: [{ options: {}, role: "user", content: text }] })

/** The same conversation, through one mount: create, prompt, history, and the shapes seen. */
/** A JSON object, decoded rather than asserted: what a response body is, or the test fails loudly. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const decodeObject = Schema.decodeUnknownSync(JsonObject)

const converse = (base: string, mountPath: string, sessionId: string) =>
  Effect.promise(async () => {
    const post = async (pathname: string, body: unknown) => {
      const response = await fetch(`${base}${mountPath}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) })
      return { status: response.status, json: decodeObject(await response.json()) }
    }
    const created = await post("/sessions", { requestId: `create-${sessionId}`, sessionId })
    const answered = await post(`/sessions/${sessionId}/prompt`, { requestId: `prompt-${sessionId}`, input: wireInput("hello through the gateway") })
    const history = await fetch(`${base}${mountPath}/sessions/${sessionId}/history`, { headers })
    const historyBody = await history.text()
    return {
      statuses: [created.status, answered.status, history.status],
      createdKeys: Object.keys(created.json).sort(),
      answeredKeys: Object.keys(answered.json).sort(),
      resultKeys: Object.keys(decodeObject(answered.json.result ?? {})).sort(),
      resultStatus: decodeObject(answered.json.result ?? {}).status,
      historyHasPrompt: historyBody.includes("hello through the gateway")
    }
  })

describe("one gateway, a local mount and a Durable Object mount", () => {
  it.live("a caller cannot tell the DO-backed mount from the in-process one", () =>
    Effect.gen(function* () {
      const { directory, outfile } = yield* bundleWorker()
      const persist = path.join(directory, "do-storage")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* workerListening(outfile, persist)

          // The in-process mount: a scripted agent, hosted like any other.
          const Local = AgentSessionHost.Tag<string>(`test/GatewayMounts/local/${globalThis.crypto.randomUUID()}`)
          const { layer: model } = yield* TestLanguageModel.script([
            TestLanguageModel.text("reply-1"),
            TestLanguageModel.text("reply-2")
          ])
          const localHost = AgentSessionHost.layer(Local, {
            principal: { resolve: () => Effect.succeed("gateway") },
            authorization: AgentSessionHost.allowAll(),
            maxSessions: 8,
            maxRequestsPerSession: 64
          }).pipe(
            Layer.provide(AgentClient.layer(Agent.make({ instructions: "Local.", loop: AgentLoop.bounded(2) }))),
            Layer.provide(model)
          )

          // The remote mount: the same host shape over the HTTP adapter,
          // pointed at the Durable Object host on workerd. No new mechanism.
          const Remote = AgentSessionHost.Tag<string>(`test/GatewayMounts/remote/${globalThis.crypto.randomUUID()}`)
          const remoteHost = AgentSessionHost.layer(Remote, {
            principal: { resolve: () => Effect.succeed("gateway") },
            authorization: AgentSessionHost.allowAll(),
            maxSessions: 8,
            maxRequestsPerSession: 64
          }).pipe(
            Layer.provide(
              AgentHttp.agentClientLayer({ baseUrl: worker.baseUrl, headers: { authorization: "Bearer worker" } })
            ),
            Layer.provide(FetchHttpClient.layer)
          )

          const mounts = {
            agents: [
              AgentServer.mount("local", { host: Local }),
              AgentServer.mount("billing", { host: Remote })
            ]
          }
          const routes = AgentServer.serverLayer(mounts).pipe(Layer.provide(Layer.merge(localHost, remoteHost)))
          const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, gracefulShutdownTimeout: 100 }))
          )

          const seen = yield* Effect.scoped(
            Effect.gen(function* () {
              const httpServer = yield* HttpServer.HttpServer
              const base = HttpServer.formatAddress(httpServer.address)
              const local = yield* converse(base, "/agents/local", "gw-local")
              const remote = yield* converse(base, "/agents/billing", "gw-remote")
              const inventory = yield* Effect.promise(async () => {
                const response = await fetch(`${base}/inventory`, { headers })
                return Schema.decodeUnknownSync(Schema.Struct({ agents: Schema.Array(JsonObject) }))(await response.json())
              })
              return { local, remote, inventory }
            }).pipe(Effect.provide(Layer.mergeAll(server, FetchHttpClient.layer)))
          )

          // Same statuses, same response shapes, same result shape and status:
          // from the outside the two mounts are the same kind of thing.
          assert.deepStrictEqual(seen.local.statuses, [200, 200, 200])
          assert.deepStrictEqual(seen.remote.statuses, seen.local.statuses)
          assert.deepStrictEqual(seen.remote.createdKeys, seen.local.createdKeys)
          assert.deepStrictEqual(seen.remote.answeredKeys, seen.local.answeredKeys)
          assert.deepStrictEqual(seen.remote.resultKeys, seen.local.resultKeys)
          assert.strictEqual(seen.local.resultStatus, "completed")
          assert.strictEqual(seen.remote.resultStatus, "completed")
          assert.isTrue(seen.local.historyHasPrompt)
          assert.isTrue(seen.remote.historyHasPrompt, "the prompt did not reach the Durable Object's history")
          // And the inventory describes both mounts in one shape.
          const rows = seen.inventory.agents.map((row) => ({ name: row.name, path: row.path, keys: Object.keys(row).sort() }))
          assert.deepStrictEqual(rows.map((r) => [r.name, r.path]), [["local", "/agents/local"], ["billing", "/agents/billing"]])
          assert.deepStrictEqual(rows[0]!.keys, rows[1]!.keys)
        })
      )
    }),
    120_000
  )
})
