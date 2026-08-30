# Plan: `submit` / `await` on every client surface, with a retention contract

Written 2026-08-29. Item 4 of [remaining-work.md](./remaining-work.md);
closes the "retention half" that `STATUS.md` ("Three issues from a review
pass") left undecided and that
[effect-plan-2.txt](./effect-plan-2.txt) §2 names as the prerequisite for a
`SessionInbox`.

**Status: implemented 2026-08-29.** The contract below is as built; the
"As built" section at the end records where implementation corrected the
draft.

## What exists

- `AgentSession.submit(input, options) → SubmissionReceipt` admits a
  submission and returns without waiting. Deliberately *receipt-only*: the
  in-process session retains no outcomes, because an `Agent` is a value and a
  session's scope is the caller's.
- `AgentSessionHost` (behind HTTP and RPC) already keeps a **per-session
  request table**: every mutation is reserved under its `requestId` with a
  fingerprint of the request, a `Deferred` that ends up holding the encoded
  response, and a `completed` flag. Same id + same fingerprint joins the
  entry; same id + different fingerprint is `AgentRequestConflictError`.
  The table is bounded by `maxRequestsPerSession`; a closed session's table
  is kept in a FIFO of `maxSessions` closed buckets.
- `DurableSessionStore.claim({ key })` recognises a retry of the *running*
  submission by the caller's key, and forgets the key at `finish`.

So the pieces are there. What was missing was a stated rule for how long a
completed outcome is kept, and a surface that lets a caller come back for it.

## The contract

### Surface

On `AgentSession` (in-process) and on `RemoteSession` (every transport):

```ts
submit(input, options?: { idempotencyKey?: string; stream?: boolean })
  : Effect<SubmissionReceipt, ...>           // returns at admission
awaitSubmission(submissionId)
  : Effect<RemoteResult, ...>                 // resolves at quiescence
```

(`await` is a reserved word in modules, hence `awaitSubmission`; the RPC
procedure carries the same name.)

`prompt(input)` keeps its meaning and is, semantically, `submit` then
`await`. It need not be implemented that way.

### Idempotency

`requestId` is the existing idempotency key, and the existing rule applies
verbatim:

```text
same requestId + same request     → the same receipt (join the entry)
same requestId + different request → AgentRequestConflictError
```

### Retention

Retention lives where sessions live: in the `AgentClient` implementation
that owns them, one table per session, bounded by that client's
`maxRetainedSubmissions` (default 64). The host's request table dedupes the
*submit request* -- a retry joins the receipt already given -- and adds no
second table for outcomes; `awaitSubmission` on the host delegates to the
session's own client. One place, one bound.

1. **In flight is never evicted.** A submission that has not settled keeps
   its slot no matter what; with the table full of those, admission fails
   with `AgentRequestCapacityExceededError` rather than dropping live work.
   (A session runs one submission at a time, so in practice this guards a
   `maxRetainedSubmissions` of one.)
2. **Settled outcomes are evicted only to admit a new submission,
   oldest-settled first.** An outcome is therefore retained *at least* until
   `maxRetainedSubmissions` newer submissions on the same session have both
   been admitted and settled. `prompt`'s outcomes are retained by the same
   rule, so the two surfaces tell one story.
3. **The idempotency key lives and dies with the outcome.** A key is
   remembered for exactly as long as its submission is retained: a retry
   joins the receipt, a different request under it is
   `AgentRequestConflictError`, and once the outcome is evicted the key is
   unknown again.
4. **After eviction, `awaitSubmission` fails with
   `AgentSubmissionNotFoundError`.** It never re-executes and never returns
   some other submission's result.
5. **Interruption and failure are outcomes too.** An interrupted submission
   retains a result with `status: "interrupted"`; a failed one retains its
   `AgentExecutionError`, and `awaitSubmission` raises it exactly as `prompt`
   would have.
6. **A closed session's outcomes go with it.** Closing is the caller's
   explicit act; await before closing. (The draft had them surviving in the
   host's closed-session buckets; with retention in the client that would
   have meant a second copy, and the case was dropped rather than the
   invariant bent.)

Why a bound in *submissions* rather than in time: a time-based expiry needs a
clock policy the library would have to own and every deployment would have to
tune blind. "The N most recent settled submissions on this session" is a
bound a retrying caller can reason about directly -- size
`maxRetainedSubmissions` to the retry window times the submission rate.

What this deliberately does **not** promise: idempotency beyond retention. A
caller whose retries can arrive later than `maxRetainedSubmissions` newer
submissions wants the durable client, whose retention is the journal.

In the kernel itself (`AgentSession.awaitSubmission`) there is exactly one
retained entry: the most recently settled submission's fibre stays joinable
until the next submission starts. A session runs one at a time, so that is
well-defined, and it is what makes `submit` then `awaitSubmission` safe even
when the run finishes before the waiter attaches. Anything older is the
client boundary's to keep.

### Durable client

The journal is the retention: the workflow engine keeps a completed
execution's result and never evicts it. No index was needed after all: the
workflow's idempotency key is `name:sessionId:submissionId`, and the engine
derives the execution id from that key alone, so a settled submission's
execution is addressable from its ids. Existence is the session store's to
answer -- a freshly dispatched execution can be invisible to `poll` for a
moment, so `None` there means "not yet", not "never" -- and the store minted
the id (`<session>:submission-<n>`, `n` at most its submission count), so it
can say whether this session ever made it. A retry under a key whose claim
already carries an execution is handed that execution rather than dispatched
again, and a *different* request under a known key is a conflict, as it is
everywhere else.

### Wire

- HTTP: `POST /sessions/:id/submit` (the prompt body) →
  `{ requestId, submissionId }`; `GET /sessions/:id/submissions/:submissionId`
  → `{ result }`, held open until the submission settles.
- RPC: `submit`, `awaitSubmission`.
- `Operation` gains `submit` (a write, authorised like `prompt`) and
  `awaitSubmission` (a read).
- `AgentSubmissionNotFoundError { sessionId, submissionId }` joins the
  protocol error union (HTTP 404). Like #73's widening, an older client sees
  it as a transport error until it upgrades.

### Non-goals

- No callbacks, webhooks or ping-back: `await` is a pull. The `SessionInbox`
  design builds on this; it is not this.
- No cross-session or host-wide submission lookup: a submission is addressed
  by its session.
- No change to `prompt`'s semantics or to the event stream.

## Acceptance

Run through the shared `AgentClientContract` (local, HTTP, RPC,
durable-memory), so every surface gives one answer:

| case | required |
| --- | --- |
| submit then await | `await` returns what `prompt` would have; history agrees |
| await while running | joins; resolves at quiescence with the result |
| await twice | the same retained result, no second run |
| same requestId + same input | the same `submissionId`, one execution |
| same requestId + different input | `AgentRequestConflictError` |
| await unknown | `AgentSubmissionNotFoundError` |
| eviction | after `maxRequestsPerSession` newer settled requests, `await` is not-found, not a re-run |
| in flight is safe | a running submission is never evicted to admit another |
| interrupted / failed | the retained outcome is the interruption / the typed failure |

Each mechanism broken once.

## As built (2026-08-29)

Everything above is as shipped, with these corrections to the first draft:
retention is the client's, not the host's, and the bound is
`maxRetainedSubmissions` rather than `maxRequestsPerSession`; the durable
client needs no `settled` index; the after-close case is dropped; the
kernel keeps exactly one settled fibre. Surfaces: `AgentSession.awaitSubmission`,
`RemoteSession.submit` / `awaitSubmission` on the in-process, HTTP, RPC and
durable clients, `AgentSessionHost.submit` / `awaitSubmission`,
`AgentSubmissionNotFoundError` in the protocol union (HTTP 404, OpenAI
`not_found_error`). Tests: the shared `AgentClientContract` "submit and
awaitSubmission" cases over local, HTTP and durable-memory (eviction against
the bounded clients, journal persistence against the durable one), and the
new error in the protocol-errors contract for HTTP and RPC. Broken once: the
in-process eviction, and the kernel's settled fibre (four cases fail without
it -- a fast run settles before the waiter attaches).
