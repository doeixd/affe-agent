import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

/**
 * The Cloudflare deployment as one Effect program
 * (`docs/plan-deployment.md` §5): the Worker, its per-session Durable
 * Object namespace, and nothing else — Alchemy provisions what
 * `apps/worker` serves.
 *
 * Typechecked in CI, deployed by hand: `npx alchemy deploy` (or
 * `npx alchemy dev` for a local run) from this directory, with a Cloudflare
 * account configured. Alchemy is a *deployment-time* dependency of this
 * application; the library knows nothing about it — that line is the plan's
 * §5.2, and it is why this file lives in `examples/` rather than `src/`.
 *
 * What the worker itself does — one DO per session id, history persisted to
 * DO SQLite at every committed turn, events journaled to the delivery log,
 * `events?after=N` gapless across hibernation and process death, dispatched
 * work as logical alarms — is `@doeixd/effect-agent/cloudflare`'s, built on
 * `effect-cf`, and tested at `test/WorkerDurableObject.test.ts`. The model
 * inside the checked-in entry is the scripted test model; a real deployment
 * copies `apps/worker` and swaps `scriptedModel` for a provider layer (for
 * Anthropic: `AnthropicLanguageModel.layer(...)` over `FetchHttpClient.layer`,
 * with the key read from a Worker secret through `WorkerEnvironment`), which
 * is deliberately a code change in the *application's* copy, not a flag in
 * the library's.
 */
export default class AgentStack extends Alchemy.Stack<AgentStack>()(
  "effect-agent",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state()
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("agent", {
      // Alchemy bundles the entry itself; the same file the miniflare test
      // bundles with esbuild, resolved through this repository's sources.
      main: "../../apps/worker/src/index.ts",
      // effect-cf's floor, and `nodejs_compat` for the `node:async_hooks`
      // it reaches for.
      compatibility: { date: "2026-08-25", flags: ["nodejs_compat"] },
      // `env` is the typed bindings record: what the Worker sees as `env.*`.
      env: {
        // One Durable Object namespace, SQLite-backed, hosted by this
        // Worker: the class is `AgentSessionObject` in the entry above.
        SESSIONS: Cloudflare.DurableObject("Sessions", {
          className: "AgentSessionObject"
        }),
        // The Worker Loader the isolate executor loads code-mode programs
        // through: one fresh isolate per program, `globalOutbound: null`.
        LOADER: Cloudflare.WorkerLoader("LOADER")
      }
    })
    return { url: worker.url }
  })
) {}
