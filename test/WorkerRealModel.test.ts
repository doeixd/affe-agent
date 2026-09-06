import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { build } from "esbuild"
import { convertV4MiniflareOptions, Miniflare } from "miniflare"
import * as fs from "node:fs/promises"
import * as path from "node:path"

/**
 * The real-model Cloudflare entry, proved on workerd without a key or a
 * network (item 19, first slice of the deployment milestone).
 *
 * `examples/deploy-cloudflare/worker-real-model.ts` is bundled *as is* --
 * the same file the quickstart deploys -- and run under miniflare with the
 * bindings `wrangler.real.jsonc` declares plus a test secret. Miniflare's
 * outbound service stands in for Anthropic: every fetch the Worker makes
 * lands in this test, which asserts it is the provider call the entry
 * promises (the endpoint, the key in `x-api-key`, the model from the var)
 * and answers as the provider would. So what is proved is the wiring the
 * deployer relies on and cannot see: the secret reaches the client, the
 * var picks the model, the reply flows back through the Durable Object and
 * out over the HTTP surface, and history persists across the runtime's
 * death. What is not proved here is Anthropic itself; the opt-in live smoke
 * in `scripts/smoke-cloudflare.mjs` does that against a deployment.
 */

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const bundleEntry = Effect.fn("WorkerRealModel.bundle")(function* () {
  yield* Effect.promise(() => fs.mkdir(path.join(process.cwd(), "dist"), { recursive: true }))
  const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(process.cwd(), "dist", "worker-real-")))
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  )
  const outfile = path.join(directory, "worker.mjs")
  yield* Effect.promise(() =>
    build({
      entryPoints: [path.join(process.cwd(), "examples", "deploy-cloudflare", "worker-real-model.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "browser"],
      outfile,
      logLevel: "silent",
      external: ["cloudflare:*", "node:*"],
      alias: {
        "affe-agent": path.join(process.cwd(), "src", "index.ts"),
        "affe-agent/cloudflare": path.join(process.cwd(), "src", "cloudflare", "index.ts")
      }
    })
  )
  return { directory, outfile }
})

/** What the provider saw, for the assertions. */
interface Seen {
  readonly url: string
  readonly apiKey: string | null
  readonly version: string | null
  readonly model: unknown
  readonly messages: unknown
}

/** What the test reads off the provider request; the rest is the client's business. */
const ProviderRequest = Schema.Struct({ model: Schema.Unknown, messages: Schema.Unknown })

/** A minimal Anthropic Messages reply: one text block, ended by the model. */
const anthropicReply = (model: string, text: string) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 12,
    output_tokens: 4,
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    service_tier: null
  }
})

const workerAt = (outfile: string, persist: string, seen: Array<Seen>) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      new Miniflare(convertV4MiniflareOptions({
        modules: [{ type: "ESModule", path: outfile }],
        compatibilityDate: "2026-08-25",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          SESSIONS: { className: "AgentSessionObject", useSQLite: true }
        },
        bindings: { ANTHROPIC_MODEL: "claude-haiku-4-5", ANTHROPIC_API_KEY: "sk-ant-test-secret" },
        resourcePersistencePath: persist,
        // The provider, as far as the Worker can tell.
        outboundService: async (request: Request) => {
          const body = Schema.decodeUnknownSync(ProviderRequest)(await request.json())
          seen.push({
            url: request.url,
            apiKey: request.headers.get("x-api-key"),
            version: request.headers.get("anthropic-version"),
            model: body.model,
            messages: body.messages
          })
          return new Response(JSON.stringify(anthropicReply(String(body.model), `reply ${seen.length} from the provider`)), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        }
      }))
    ),
    (miniflare) => Effect.promise(() => miniflare.dispose())
  )

const wireInput = (text: string) => ({ content: [{ options: {}, role: "user", content: text }] })
const jsonRequest = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json", authorization: "Bearer worker" },
  body: JSON.stringify(body)
})
const call = (miniflare: Miniflare, pathname: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
  promise(() => miniflare.dispatchFetch(`http://worker${pathname}`, init)).pipe(
    Effect.flatMap((response) =>
      promise(() => response.text()).pipe(Effect.map((text) => ({ status: response.status, body: text })))
    )
  )
const json = (payload: { readonly status: number; readonly body: string }): any => {
  assert.isBelow(payload.status, 300, `expected success, got ${payload.status}: ${payload.body.slice(0, 400)}`)
  return JSON.parse(payload.body)
}

describe("the real-model entry on workerd", () => {
  it.live("the secret reaches the provider, the var picks the model, the reply comes back, and history outlives the runtime", () =>
    Effect.gen(function* () {
      const { directory, outfile } = yield* bundleEntry()
      const persist = path.join(directory, "do-storage")
      const seen: Array<Seen> = []

      // ----- First life. -----
      yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist, seen)
          json(yield* call(miniflare, "/sessions", jsonRequest("POST", { requestId: "create-1", sessionId: "real-1" })))
          const answered = json(yield* call(miniflare, "/sessions/real-1/prompt", jsonRequest("POST", {
            requestId: "prompt-1",
            input: wireInput("say hello")
          })))
          assert.strictEqual(answered.result.status, "completed")
          assert.strictEqual(answered.result.text, "reply 1 from the provider")
        })
      )
      // Exactly one provider call, shaped as the entry promises.
      assert.strictEqual(seen.length, 1)
      assert.match(seen[0]!.url, /^https:\/\/api\.anthropic\.com\/v1\/messages(\?|$)/)
      assert.strictEqual(seen[0]!.apiKey, "sk-ant-test-secret", "the Worker secret did not reach the provider client")
      assert.isNotNull(seen[0]!.version)
      assert.strictEqual(seen[0]!.model, "claude-haiku-4-5", "the ANTHROPIC_MODEL var did not pick the model")
      assert.include(JSON.stringify(seen[0]!.messages), "say hello")

      // ----- Second life: a new runtime over the same storage. -----
      yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist, seen)
          const history = json(yield* call(miniflare, "/sessions/real-1/history", {
            headers: { authorization: "Bearer worker" }
          }))
          const rendered = JSON.stringify(history)
          assert.include(rendered, "say hello", "the prompt did not survive the runtime's death")
          assert.include(rendered, "reply 1 from the provider", "the provider's reply did not survive the runtime's death")
          // And the session goes on: a second prompt is the second provider call.
          const again = json(yield* call(miniflare, "/sessions/real-1/prompt", jsonRequest("POST", {
            requestId: "prompt-2",
            input: wireInput("and again")
          })))
          assert.strictEqual(again.result.text, "reply 2 from the provider")
        })
      )
      assert.strictEqual(seen.length, 2)
      // The second call carried the whole conversation, not just the new turn.
      assert.include(JSON.stringify(seen[1]!.messages), "say hello")
      assert.include(JSON.stringify(seen[1]!.messages), "and again")
    }),
    60_000
  )

  it.live("without the secret the object refuses to build a client, naming the binding, rather than calling unauthenticated", () =>
    Effect.gen(function* () {
      const { directory, outfile } = yield* bundleEntry()
      const seen: Array<Seen> = []
      const status = yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* Effect.acquireRelease(
            Effect.sync(() =>
              new Miniflare(convertV4MiniflareOptions({
                modules: [{ type: "ESModule", path: outfile }],
                compatibilityDate: "2026-08-25",
                compatibilityFlags: ["nodejs_compat"],
                durableObjects: { SESSIONS: { className: "AgentSessionObject", useSQLite: true } },
                bindings: { ANTHROPIC_MODEL: "claude-haiku-4-5" },
                resourcePersistencePath: path.join(directory, "do-storage-nokey"),
                outboundService: async () => {
                  seen.push({ url: "unexpected", apiKey: null, version: null, model: null, messages: null })
                  return new Response("should not be called", { status: 500 })
                }
              }))
            ),
            (m) => Effect.promise(() => m.dispose())
          )
          // The object builds its model layer when the session opens, so the
          // refusal is at creation, before any prompt.
          return yield* call(miniflare, "/sessions", jsonRequest("POST", { requestId: "create-1", sessionId: "nokey" }))
        })
      )
      assert.isAtLeast(status.status, 400, `expected a refusal, got ${status.status}: ${status.body.slice(0, 200)}`)
      assert.deepStrictEqual(seen, [], "the provider was called without a key")
      // What a deployer sees is a bare status: the binding's name is in the
      // Worker's log, not the response. Recorded as a finding (item 62), not
      // asserted away.
    }),
    60_000
  )
})
