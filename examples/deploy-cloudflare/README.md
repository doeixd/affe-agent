# Deploying the agent to Cloudflare with Alchemy

`alchemy.run.ts` provisions what [`apps/worker`](../../apps/worker/src/index.ts)
serves: one Worker, one SQLite-backed Durable Object namespace, one DO per
session id. It is a single Effect program — resources are Effects, bindings
are typed, and there is no YAML — per `docs/plan-deployment.md` §5.

## Run it

```bash
# from this directory, with a Cloudflare account configured for alchemy
npx alchemy dev      # local, on miniflare/workerd
npx alchemy deploy   # for real
```

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
- **Durability is the platform's.** History persists to DO SQLite per
  completed submission; events are journaled to the ordinary `DeliveryLog`;
  `events?after=N` resumes gaplessly across hibernation and process death.
  Effect Workflow does not run inside a DO today (measured — see
  `docs/status-history.md`, 2026-08-30), so `/durable` stays on hosts whose
  engine runs.

## Cost

A deployment from a clean account uses: Workers (paid plan required for
Durable Objects with SQLite storage), one DO namespace, and DO storage
billed per stored byte and per billed request unit. There is no D1, R2 or
Container in this stack. Tear it down with `npx alchemy destroy`.
