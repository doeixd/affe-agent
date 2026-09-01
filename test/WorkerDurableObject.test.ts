import { assert, describe, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { build } from "esbuild"
import { convertV4MiniflareOptions, Miniflare } from "miniflare"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

/**
 * The Worker entry on real workerd (`docs/plan-deployment.md` §9):
 *
 * - a full submission runs with the session living in a Durable Object;
 * - the *same session* survives the death of the entire runtime -- a new
 *   Miniflare over the same persisted DO storage continues the
 *   conversation and serves `events?after=N` from the delivery log, which
 *   is the hibernation claim asserted against the log rather than observed;
 * - routing is by session id: two ids are two DOs, one id is one.
 *
 * The model inside the worker is the scripted test model: workerd in CI has
 * no provider key, and the deployment stack (`examples/deploy-cloudflare/`)
 * is where a real model is wired.
 */
const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const bundleWorker = Effect.fn("WorkerDurableObject.bundle")(function* () {
  // Repo-local rather than the OS temp dir: workerd refuses to load modules
  // mounted from outside the instance's root with an opaque "internal error".
  yield* Effect.promise(() => fs.mkdir(path.join(process.cwd(), "dist"), { recursive: true }))
  const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(process.cwd(), "dist", "worker-test-")))
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
      alias: {
        "@doeixd/effect-agent": path.join(process.cwd(), "src", "index.ts"),
        "@doeixd/effect-agent/AgentSession": path.join(process.cwd(), "src", "AgentSession.ts"),
        "@doeixd/effect-agent/client": path.join(process.cwd(), "src", "client", "index.ts"),
        "@doeixd/effect-agent/durable": path.join(process.cwd(), "src", "durable", "index.ts"),
        "@doeixd/effect-agent/http": path.join(process.cwd(), "src", "http", "index.ts"),
        "@doeixd/effect-agent/scheduling": path.join(process.cwd(), "src", "scheduling", "index.ts"),
        "@doeixd/effect-agent/testing": path.join(process.cwd(), "src", "testing", "index.ts")
      }
    })
  )
  return { directory, outfile }
})

const workerAt = (outfile: string, persist: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      // Miniflare 5's native options are its new schema; the classic shape
      // travels through the converter it ships for exactly this.
      new Miniflare(convertV4MiniflareOptions({
        modules: [{ type: "ESModule", path: outfile }],
        compatibilityDate: "2025-08-01",
        durableObjects: {
          SESSIONS: { className: "AgentSessionObject", useSQLite: true }
        },
        resourcePersistencePath: persist
      }))
    ),
    (miniflare) => Effect.promise(() => miniflare.dispose())
  )

/** A text prompt in the wire codec's encoded form. */
const wireInput = (text: string) => ({ content: [{ options: {}, role: "user", content: text }] })

const jsonRequest = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json", authorization: "Bearer worker" },
  body: JSON.stringify(body)
})

const call = (miniflare: Miniflare, pathname: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
  promise(() => miniflare.dispatchFetch(`http://worker${pathname}`, init)).pipe(
    Effect.flatMap((response) =>
      promise(() => response.text()).pipe(
        Effect.map((text) => ({ status: response.status, body: text }))
      )
    )
  )

/**
 * An SSE response is a live stream with no natural end; read what arrives
 * within the window and cancel. The delivery log's history is written before
 * live delivery continues, so a short window after the events exist is enough.
 */
const readSse = (miniflare: Miniflare, pathname: string, windowMillis: number) =>
  promise(async () => {
    const response = await miniflare.dispatchFetch(`http://worker${pathname}`, {
      headers: { authorization: "Bearer worker", accept: "text/event-stream" }
    })
    if (response.body === null) return { status: response.status, body: "" }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let accumulated = ""
    const deadline = Date.now() + windowMillis
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        )
      ])
      if (chunk.done) break
      accumulated += decoder.decode(chunk.value)
    }
    await reader.cancel().catch(() => undefined)
    return { status: response.status, body: accumulated }
  })

const json = (payload: { readonly status: number; readonly body: string }): any => {
  assert.isBelow(payload.status, 300, `expected success, got ${payload.status}: ${payload.body.slice(0, 300)}`)
  return JSON.parse(payload.body)
}

describe("the Worker entry on workerd", () => {
  it.live("a session lives in a Durable Object and survives the runtime's death, delivery log included", () =>
    Effect.gen(function* () {
      const { directory, outfile } = yield* bundleWorker()
      const persist = path.join(directory, "do-storage")

      // ----- First life: create, prompt, read the log's shape. -----
      const firstEvents = yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist)
          const created = json(yield* call(miniflare, "/sessions", jsonRequest("POST", {
            requestId: "create-1",
            sessionId: "do-session"
          })))
          assert.strictEqual(created.session.sessionId, "do-session")

          const answered = json(yield* call(miniflare, "/sessions/do-session/prompt", jsonRequest("POST", {
            requestId: "prompt-1",
            input: wireInput("hello from outside")
          })))
          assert.strictEqual(answered.result.status, "completed")
          assert.strictEqual(answered.result.text, "reply-1")

          // Two ids are two DOs: a second session neither sees nor disturbs the first.
          json(yield* call(miniflare, "/sessions", jsonRequest("POST", { requestId: "create-2", sessionId: "other" })))
          const other = json(yield* call(miniflare, "/sessions/other/prompt", jsonRequest("POST", {
            requestId: "prompt-other",
            input: wireInput("unrelated")
          })))
          assert.strictEqual(other.result.text, "reply-1")

          // The read of what the log holds so far, over SSE.
          const events = yield* readSse(miniflare, "/sessions/do-session/events?after=0", 2000)
          return events.body
        })
      )
      const sequencesBefore = [...firstEvents.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))
      assert.isAbove(sequencesBefore.length, 2, `expected a journaled event stream, saw: ${firstEvents.slice(0, 200)}`)
      const cursor = sequencesBefore[1]!

      // ----- Second life: a new runtime over the same storage. -----
      yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist)

          // The conversation continues where it stopped: same session, next reply.
          const answered = json(yield* call(miniflare, "/sessions/do-session/prompt", jsonRequest("POST", {
            requestId: "prompt-2",
            input: wireInput("still there?")
          })))
          // The scripted model is per process -- each life's replies restart
          // at reply-1. What persists is the conversation, not the script.
          assert.strictEqual(answered.result.text, "reply-1")

          // History is the storage's, not the process's: both exchanges.
          const history = json(yield* call(miniflare, "/sessions/do-session/history", {
            headers: { authorization: "Bearer worker" }
          }))
          const texts = JSON.stringify(history)
          assert.include(texts, "hello from outside")
          assert.include(texts, "still there?")

          // The hibernation claim, against the log: a reader resuming from a
          // cursor taken in the previous life receives every event above it
          // -- the first life's remainder and the second life's, in order.
          const resumed = yield* readSse(miniflare, `/sessions/do-session/events?after=${cursor}`, 2000)
          const sequences = [...resumed.body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))
          assert.isAbove(sequences.length, 0)
          assert.strictEqual(sequences[0], cursor + 1, "the resumed stream must begin exactly after the cursor")
          for (let index = 1; index < sequences.length; index++) {
            assert.strictEqual(sequences[index], sequences[0]! + index, "no gaps, no repeats")
          }
          assert.isTrue(
            Math.max(...sequences) > Math.max(...sequencesBefore),
            "the resumed stream must include events from the second life"
          )
        })
      )
    }),
    120_000
  )

  /**
   * History is written as each turn commits, so a runtime lost mid-run
   * costs the turn in flight and nothing before it. The scripted model's
   * second prompt in a life runs two tool turns and then hangs; the runtime
   * is killed with that submission in flight, and the next life holds
   * exactly the two committed turns. Broken once by persisting per
   * submission again: the second life saw only the first exchange.
   */
  it.live("a runtime lost mid-run keeps every committed turn", () =>
    Effect.gen(function* () {
      const { directory, outfile } = yield* bundleWorker()
      const persist = path.join(directory, "do-storage-turns")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist)
          json(yield* call(miniflare, "/sessions", jsonRequest("POST", { requestId: "create", sessionId: "turns" })))
          const first = json(yield* call(miniflare, "/sessions/turns/prompt", jsonRequest("POST", {
            requestId: "prompt-1",
            input: wireInput("first")
          })))
          assert.strictEqual(first.result.text, "reply-1")

          // Admitted, not awaited: turn 3 of this submission never returns.
          json(yield* call(miniflare, "/sessions/turns/submit", jsonRequest("POST", {
            requestId: "prompt-2",
            input: wireInput("second")
          })))
          // Wait until both tool turns have committed and been written.
          yield* Effect.retry(
            Effect.flatMap(
              call(miniflare, "/sessions/turns/history", { headers: { authorization: "Bearer worker" } }),
              (history) =>
                (history.body.match(/"tool-result"/g) ?? []).length >= 2
                  ? Effect.void
                  : Effect.fail("not yet" as const)
            ),
            { times: 100, schedule: Schedule.spaced("50 millis") }
          )
          // The runtime dies here, with the submission's third turn hung.
        })
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist)
          const history = json(yield* call(miniflare, "/sessions/turns/history", {
            headers: { authorization: "Bearer worker" }
          }))
          const texts = JSON.stringify(history)
          assert.include(texts, "first")
          assert.include(texts, "second")
          // Exactly the two committed tool turns: no more, and not none.
          assert.strictEqual((texts.match(/"tool-result"/g) ?? []).length, 2)
        })
      )
    }),
    120_000
  )

  /**
   * A job dispatched through `AgentDispatcher` is persisted to the DO's
   * SQLite and fires from the alarm -- including when the runtime that
   * dispatched it died first, because a wake re-arms from the table.
   */
  it.live("a dispatched job survives the runtime that dispatched it and fires from the alarm", () =>
    Effect.gen(function* () {
      const { directory, outfile } = yield* bundleWorker()
      const persist = path.join(directory, "do-storage-alarm")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist)
          json(yield* call(miniflare, "/sessions", jsonRequest("POST", { requestId: "create", sessionId: "sched" })))
          json(yield* call(miniflare, "/sessions/sched/prompt", jsonRequest("POST", {
            requestId: "prompt-1",
            input: wireInput("now")
          })))
          const dispatched = yield* call(miniflare, "/sessions/sched/dispatch", jsonRequest("POST", {
            input: "later",
            delayMillis: 1500
          }))
          assert.strictEqual(dispatched.status, 202, dispatched.body)
          // The runtime dies before the job is due.
        })
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const miniflare = yield* workerAt(outfile, persist)
          // Any request wakes the object, which re-arms the alarm from the
          // table; the job is then the platform's to fire.
          json(yield* call(miniflare, "/sessions/sched/history", { headers: { authorization: "Bearer worker" } }))
          yield* Effect.retry(
            Effect.flatMap(
              call(miniflare, "/sessions/sched/history", { headers: { authorization: "Bearer worker" } }),
              (history) => history.body.includes("later") ? Effect.void : Effect.fail("not yet" as const)
            ),
            { times: 100, schedule: Schedule.spaced("100 millis") }
          )
          const history = json(yield* call(miniflare, "/sessions/sched/history", {
            headers: { authorization: "Bearer worker" }
          }))
          const texts = JSON.stringify(history)
          assert.include(texts, "now")
          assert.include(texts, "later")
        })
      )
    }),
    120_000
  )
})

