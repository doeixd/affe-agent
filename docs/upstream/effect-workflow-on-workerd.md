# Draft upstream issue — effect: Workflow activities never resume on workerd (ClusterWorkflowEngine + SingleRunner)

*Draft for the Effect repository; not yet filed. Written 2026-08-30 against
`effect@4.0.0-rc.112`. See `docs/status-history.md` (same date) for how it was
found.*

## Summary

A minimal two-activity `Workflow` executed through `ClusterWorkflowEngine` +
`SingleRunner` over `@effect/sql-sqlite-do` **starts but never completes on
workerd** (Cloudflare's runtime, exercised via miniflare). The byte-identical
program over `@effect/sql-sqlite-node` completes in ~140 ms on Node. The
workflow's own effects run — events emitted before the first `Activity` are
observable — and the stall is at the first activity boundary; the SQL client
stays responsive throughout (a concurrent `SELECT 1` answers mid-hang), so it
is the suspend/resume machinery, not storage, that does not progress.

## Reproduction

```ts
import { Activity, Workflow } from "effect/unstable/workflow"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { Crypto, Duration, Effect, Layer, Schema } from "effect"

const Probe = Workflow.make("Probe", {
  payload: { id: Schema.String },
  idempotencyKey: ({ id }) => id,
  success: Schema.String
})

const probeLayer = Probe.toLayer(({ id }) =>
  Effect.gen(function* () {
    const first = yield* Activity.make({ name: "first", success: Schema.String, execute: Effect.succeed("a1") })
    const second = yield* Activity.make({ name: "second", success: Schema.String, execute: Effect.succeed("a2") })
    return `${id}:${first}:${second}`
  })
)

// Inside a Durable Object (constructor receives `state`):
const WebCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => new Uint8Array(await crypto.subtle.digest(algorithm, data)))
  })
)
const sqlLayer = SqliteClient.layer({ storage: state.storage })
const engine = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(SingleRunner.layer({
    runnerStorage: "sql",
    shardingConfig: {
      entityMessagePollInterval: Duration.millis(200),
      entityReplyPollInterval: Duration.millis(50)
    }
  }).pipe(Layer.provide(sqlLayer), Layer.provide(WebCrypto)))
)
// Probe.execute({ id: "wf" }) provided with probeLayer + engine:
//   Node   (@effect/sql-sqlite-node): completes in ~140ms
//   workerd (@effect/sql-sqlite-do, miniflare, compat 2025-08-01):
//     times out (>20s, also >60s in a larger program)
```

Note: reaching the point where this runs at all requires working around a
second, separate issue (nested transaction in `SqlMessageStorage`'s sqlite
migration — see the companion draft); with a re-entrant `withTransaction`
wrapper the engine builds and migrates fine, and the stall above is what
remains.

## Observations

- Debug logs (`MinimumLogLevel: "Debug"`) are identical on both runtimes up to
  and including `Starting singleton …/RunnerHealth`; on Node the workflow then
  completes, on workerd nothing further is logged.
- Lowering `entityMessagePollInterval`/`entityReplyPollInterval` to
  200 ms / 50 ms does not change the outcome, so it is not poll cadence.
- In a larger program (an agent run journaling its lifecycle), events emitted
  *inside the workflow before the first activity* are durably written —
  the workflow body demonstrably executes — and the journal stops at the
  first activity boundary.
- A concurrent plain query through the same `SqlClient` succeeds during the
  hang, so the DO driver's transaction semaphore is not held.

## Environment

- `effect@4.0.0-rc.112`, `@effect/sql-sqlite-do@4.0.0-rc.112`
- `miniflare@5.20260828.0-alpha` (workerd 1.2026…), `compatibilityDate:
  "2025-08-01"`, Durable Object with `useSQLite: true`
- Node control: `@effect/sql-sqlite-node@4.0.0-rc.112`, node 22.23
