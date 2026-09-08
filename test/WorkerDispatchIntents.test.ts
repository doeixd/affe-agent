import { assert, describe, it } from "@effect/vitest"
import { Effect, Schedule } from "effect"
import { build } from "esbuild"
import { convertV4MiniflareOptions, Miniflare } from "miniflare"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { dispatchFailpoints } from "../src/cloudflare/dispatchFailpoints.js"

/**
 * Item 47c: dispatch intents for the Durable Object host, proved on workerd.
 *
 * A dispatched job is an alarm plus an intent row written in one
 * transaction; the alarm handler reads the intent before doing anything, and
 * the run's settlement marks it `settled` in the same transaction as the
 * history it settles. So a runtime lost at either durable boundary --
 * after the job's submission was launched, or after its settlement committed
 * but before the platform acknowledged the alarm -- ends with the job having
 * run **exactly once**: the alarm fires again in the next life, and the
 * intent, not the alarm, says whether there is anything left to do.
 *
 * The entry bundled here is `test/workers/dispatch-intents.worker.ts`: the
 * host as shipped, with a failpoint armed from a binding so a boundary dies
 * on real workerd. The locations come from `dispatchFailpoints`,
 * so a boundary added to the host is a boundary this drives.
 */

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

const bundleEntry = Effect.fn("WorkerDispatchIntents.bundle")(function* () {
  yield* Effect.promise(() => fs.mkdir(path.join(process.cwd(), "dist"), { recursive: true }))
  const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(process.cwd(), "dist", "worker-intents-")))
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  )
  const outfile = path.join(directory, "worker.mjs")
  yield* Effect.promise(() =>
    build({
      entryPoints: [path.join(process.cwd(), "test", "workers", "dispatch-intents.worker.ts")],
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
        "affe-agent/testing": path.join(process.cwd(), "src", "testing", "index.ts")
      }
    })
  )
  return { directory, outfile }
})

const workerAt = (outfile: string, persist: string, failpoint?: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      new Miniflare(convertV4MiniflareOptions({
        modules: [{ type: "ESModule", path: outfile }],
        compatibilityDate: "2026-08-25",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { SESSIONS: { className: "AgentSessionObject", useSQLite: true } },
        bindings: failpoint === undefined ? {} : { AFFE_FAILPOINT: failpoint },
        resourcePersistencePath: persist
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
const historyOf = (miniflare: Miniflare, sessionId: string) =>
  Effect.map(call(miniflare, `/sessions/${sessionId}/history`, { headers: { authorization: "Bearer worker" } }), (r) => r.body)
/** How many model answers the history holds: the scripted model numbers them. */
const runsIn = (history: string) => (history.match(/ran-\d+/g) ?? []).length

describe("dispatch intents on workerd", () => {
  it.live("a runtime lost at either boundary leaves a job that ran exactly once", () =>
    Effect.gen(function* () {
      const { directory, outfile } = yield* bundleEntry()
      const outcomes: Array<{ readonly location: string; readonly runs: number }> = []

      for (const location of dispatchFailpoints.all) {
        const persist = path.join(directory, `do-${location.replace(/[^a-z]/gi, "-")}`)
        const sessionId = "jobs"

        // ----- First life: warm the session, dispatch a job due now, and die at the boundary. -----
        yield* Effect.scoped(
          Effect.gen(function* () {
            const miniflare = yield* workerAt(outfile, persist, location)
            json(yield* call(miniflare, "/sessions", jsonRequest("POST", { requestId: "create", sessionId })))
            json(yield* call(miniflare, `/sessions/${sessionId}/prompt`, jsonRequest("POST", {
              requestId: "prompt-1",
              input: wireInput("warm up")
            })))
            const dispatched = yield* call(miniflare, `/sessions/${sessionId}/dispatch`, jsonRequest("POST", {
              input: "the job",
              delayMillis: 0
            }))
            assert.strictEqual(dispatched.status, 202, dispatched.body)
            // The job's run commits whether or not the handler that launched
            // it survives: wait for its answer to be in the history, then
            // give a same-life re-fire a moment, then kill the runtime.
            yield* Effect.retry(
              Effect.flatMap(historyOf(miniflare, sessionId), (history) =>
                runsIn(history) >= 2 ? Effect.void : Effect.fail("not yet" as const)
              ),
              { times: 200, schedule: Schedule.spaced("50 millis") }
            )
            yield* Effect.sleep("600 millis")
            const afterCrash = yield* historyOf(miniflare, sessionId)
            assert.strictEqual(runsIn(afterCrash), 2, `${location}: the job ran more than once before the runtime died`)
          })
        )

        // ----- Second life: the alarm, if unacknowledged, fires again; the intent says it is settled. -----
        const runs = yield* Effect.scoped(
          Effect.gen(function* () {
            const miniflare = yield* workerAt(outfile, persist)
            // Waking the object re-arms whatever the table still holds.
            yield* historyOf(miniflare, sessionId)
            yield* Effect.sleep("1500 millis")
            const history = yield* historyOf(miniflare, sessionId)
            assert.include(history, "the job", `${location}: the job's input did not survive`)
            return runsIn(history)
          })
        )
        outcomes.push({ location, runs })
      }

      // One warm-up answer and exactly one job answer per boundary: never
      // zero (the job was lost) and never three (the job ran again).
      assert.deepStrictEqual(
        outcomes,
        dispatchFailpoints.all.map((location) => ({ location, runs: 2 }))
      )
    }),
    180_000
  )
})
