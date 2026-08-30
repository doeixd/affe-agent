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
 * DO SQLite per completed submission, events journaled to the delivery log,
 * `events?after=N` gapless across hibernation and process death — is
 * documented and tested at `apps/worker/src/index.ts` and
 * `test/WorkerDurableObject.test.ts`. The model inside the checked-in entry
 * is the scripted test model; a real deployment copies `apps/worker` and
 * swaps `scriptedModel` for a provider layer (for Anthropic:
 * `AnthropicLanguageModel.layer(...)` over `FetchHttpClient.layer`, with the
 * key from a Worker secret), which is deliberately a code change in the
 * *application's* copy, not a flag in the library's.
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
      compatibility: { date: "2025-08-01" },
      // `env` is the typed bindings record: what the Worker sees as `env.*`.
      env: {
        // One Durable Object namespace, SQLite-backed, hosted by this
        // Worker: the class is `AgentSessionObject` in the entry above.
        SESSIONS: Cloudflare.DurableObject("Sessions", {
          className: "AgentSessionObject"
        })
      }
    })
    return { url: worker.url }
  })
) {}
