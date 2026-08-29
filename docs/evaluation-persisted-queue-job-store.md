# PersistedQueue versus scheduling JobStore

Evaluated 2026-08-27 against the installed Effect v4 implementation and the
current `/scheduling` package. This closes the last Phase 0 spike in
[`effect-plan-2.txt`](./effect-plan-2.txt).

## Decision

Retain `Scheduling.JobStore` for arbitrary durable delayed dispatch. Use Effect
`PersistedQueue` for immediate durable handoff, including the proposed
`SessionInbox`. Do not replace the delayed path with a queue, and do not split
`Scheduling.queued` between two stores until a real immediate-only scheduling
caller needs the stronger delivery contract.

The two abstractions overlap in persistence, but not in semantics:

| Requirement | `Scheduling.JobStore` | Effect `PersistedQueue` |
| --- | --- | --- |
| Arbitrary due time | `runAfterMillis` plus `claimDue(now)` | No due-time field or delayed-take operation |
| Successful processing | Removed when claimed, before the agent runs | ACKed when the scoped `take` handler succeeds |
| Worker failure | At-most-once; a crash after claim loses the job | Requeued until `maxAttempts` |
| Worker interruption | Claimed job is already gone | Requeued without consuming an attempt |
| Duplicate suppression | Store owns identity; no public idempotency key | Caller-supplied `id`, unique within a named queue |
| Payload boundary | `Prompt.Prompt`; durable adapters encode it | Any schema-encoded value |
| Supplied backends | Memory implementation plus the `JobStore` seam | Memory, Redis, and SQL |

`PersistedQueue` is not a timer. A worker can only take the next available
element; neither `offer` nor `take` accepts a due time. Delaying the producer
before `offer` would make persistence begin only after the delay and therefore
would not survive producer failure. Polling and failing a not-yet-due queue
item would misuse retry attempts as time and can block ready work behind it.

## Dedupe and acknowledgement details

Custom queue ids are retained after successful acknowledgement, not merely
while an item is pending:

- the memory store retains the id in its queue-local `Set`;
- the Redis store retains it in the queue's id set;
- the SQL store retains the completed row behind a unique `(id, queue_name)`
  index.

That is the long-lived idempotency window the proposed `SessionInbox` needs.
The inbox worker should ACK after `session.submit({ requestId })` admits or
rejoins a submission, not after the agent completes. A suspended or long-running
agent submission must not hold a queue processing lease.

Failure and interruption differ deliberately. A typed failure increments the
attempt count and requeues until `maxAttempts`; interruption requeues without
incrementing it. `test/PersistedQueueEvaluation.test.ts` locks down dedupe after
ACK, retry metadata, and interruption behavior against the installed Effect
version.

## Consequences for `/scheduling`

No production refactor is justified by this spike:

- `local` remains `Effect.delay` plus a scoped fiber;
- `recurring` remains `Effect.repeat` over `Schedule`;
- cluster recurrence remains `ScheduledAgent` over `ClusterCron`;
- delayed queue-backed dispatch retains `JobStore` and its documented
  at-most-once contract;
- future immediate at-least-once handoff uses `PersistedQueue` under a distinct
  API whose retry and idempotency semantics are explicit.

Do not fork `PersistedQueue` or `PersistedQueueFactory`. `SessionInbox` should
be a thin domain adapter around the upstream queue, which also isolates the
rest of the package from its `unstable` import path. A private fork that added
due times would have to own three backend implementations, Redis scripts, SQL
migrations and indexes, polling, leases, retries, and cleanup. That is a new
scheduler, not an inbox customization.

If scheduling later requires durable retry as well as an arbitrary due time,
that is a new contract. It should use a due-time store with leases/visibility
timeouts or a platform timing primitive such as Workflow `DurableClock` or
cluster `DeliverAt`; it should not be presented as a mechanical JobStore
backend swap.
