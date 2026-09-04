# Deploying the agent to Cloudflare

`alchemy.run.ts` provisions what [`apps/worker`](../../apps/worker/src/index.ts)
serves -- `affe-agent/cloudflare` with the scripted model: one
Worker, one SQLite-backed Durable Object namespace, one DO per session id,
`nodejs_compat` on and the compatibility date at `effect-cf`'s floor. It is a single Effect program — resources are Effects, bindings
are typed, and there is no YAML — per `docs/plan-deployment.md` §5.

## Run it

Two ways to the same Worker, from this directory:

```bash
# with `wrangler login` done -- wrangler.jsonc mirrors the stack below
npx wrangler deploy
npx wrangler deploy --config wrangler.free.jsonc   # the free-plan entry, see below

# or as the Alchemy stack, with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
# (Alchemy keeps its own credentials and does not read wrangler's login;
#  beta.75 exits silently here, see docs/upstream/alchemy-silent-exit.md)
npx alchemy dev      # local, on miniflare/workerd
npx alchemy deploy   # for real
```

If the login can see more than one account, set `CLOUDFLARE_ACCOUNT_ID`:
wrangler refuses to choose one non-interactively.

## Proved on real Cloudflare, 2026-09-02

`worker-without-code-mode.ts` deployed as `affe-agent-free` from a Workers
**free** plan, and the smoke over HTTPS did what the miniflare test does:
`POST /sessions` twice made two Durable Objects; each `prompt` ran a
two-turn scripted submission whose tool call echoed the object's own name
back; `events?after=0` streamed the journal from sequence 1; a second prompt
on the first session ran as `submission-2` with the first still there.

What that deployment leaves out is the code tool. **Dynamic Workers -- the
`LOADER` binding the isolate executor loads programs through -- is the one
binding that needs a paid plan** (Cloudflare refuses the upload with error
10195); SQLite-backed Durable Objects and alarms are on free. `apps/worker`
as checked in, with the loader, deploys the moment the account is upgraded;
nothing in it changes. The model in both entries is still the scripted one,
so the remaining half of "a real deployment" is a provider key in a Worker
secret, exactly the swap the entry's header describes.

The stack's output is the Worker URL. The HTTP surface is the same one every
other deployment serves (`/sessions`, `/sessions/{id}/prompt`, `…/events`);
`POST /sessions` must name its session, because the session id is the
routing key to the Durable Object.

## What is deliberately true here

- **The library never depends on Alchemy.** This file is an application's
  deployment; delete the directory and `src/` does not notice.
- **The checked-in worker answers with the scripted test model**, so CI can
  run it on real workerd with no provider key
  (`test/WorkerDurableObject.test.ts`). A real deployment copies
  `apps/worker`, swaps `scriptedModel` for a provider layer, and puts the
  key in a Worker secret.
- **Durability is the platform's.** History persists to DO SQLite at every
  committed turn; events are journaled to the ordinary `DeliveryLog`;
  `events?after=N` resumes gaplessly across hibernation and process death;
  dispatched work is a logical alarm that outlives the runtime.
  Effect Workflow does not run inside a DO today (measured — see
  `docs/status-history.md`, 2026-08-30), so `/durable` stays on hosts whose
  engine runs.

## Cost

A deployment from a clean account uses: Workers, one SQLite-backed DO
namespace (on the free plan), DO storage billed per stored byte and per
billed request unit, and -- for `apps/worker`'s code tool -- Dynamic
Workers, which needs the paid plan. There is no D1, R2 or
Container in this stack. Tear it down with `npx alchemy destroy`, or `npx wrangler delete` for a
wrangler deployment.
