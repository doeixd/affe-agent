# Limits

Every bound a user can hit is documented where they meet it, not only here.
This is the index — the source of truth is the JSDoc on the option or exported
constant it names.

| Area | Bound | Default | Where | What happens |
|------|-------|---------|-------|--------------|
| Host | `maxSessions` | required | `AgentSessionHost.Options` | `AgentCapacityExceededError` (429 on HTTP) — host never evicts live work |
| Host | `maxRequestsPerSession` | required | `AgentSessionHost.Options` | `AgentRequestCapacityExceededError` — oldest *completed* request record evicted FIFO |
| Sandbox | `ExecOptions.timeout` | `10 seconds` | `Sandbox.timeoutMillis` / `Sandbox.ExecOptions` | `TimeoutError` after `SIGTERM` + 1 s `SIGKILL` grace, awaited on `close` |
| Sandbox | `ExecOptions.maxOutputBytes` | `1 MiB` | `Sandbox.ExecOptions` | `OutputLimitError` |
| Compaction | `maxSessions` | `1024` | `Compaction.make({ maxSessions })` | oldest checkpoint evicted; session re-summarises next turn |
| MCP shared-host tickets | host `maxSessions` × `maxRequestsPerSession` | required by host | `AgentMcp.serverLayer({ host })` | evicts oldest settled ticket/bucket; refuses while every eligible slot is in flight |
| Memory | `limit` | `5` | `Memory.layer({ limit })` | recall returns best 5 |
| Truncation | `MAX_BYTES` / `MAX_LINES` | `50 KB` / `2000 lines` | `PiToolkit.MAX_BYTES`, `coding/internal/truncate.ts` | tail kept, banner names `50.0KB` or `2000 lines` limit and spills full output to `.affe-agent/tool-output/` |
| Read | window | `2000 lines`, `50 KB`, `2000 chars/line` | `coding/internal/readFormat.ts` — `DEFAULT_LIMIT`, `MAX_BYTES`, `MAX_LINE_LENGTH` | slice capped, footer with `offset=` to continue |
| Search | `SEARCH_LIMIT` | `100` | `coding/internal/searchFormat.ts` | `Found N matches (more matches available)` |
| Pi list | `LS_LIMIT` | `500` | `PiToolkit.LS_LIMIT` | truncated notice to narrow path or use search |
| Pi grep | `GREP_MAX_LINE_LENGTH` | `500 chars` | `PiToolkit.GREP_MAX_LINE_LENGTH` | `... (line truncated to 500 chars)` |
| Web search | `DEFAULT_LIMIT` / `MAX_LIMIT` / `MAX_RESPONSE_BYTES` / `TIMEOUT_MILLIS` / `MAX_CONCURRENT` | `8` / `10` / `1 MiB` / `15 s` / `4` | `web/brave.ts` | `WebSearchResponseTooLargeError` / `WebSearchTimeoutError` / semaphore queue |
| Web fetch | `MAX_RESPONSE_BYTES` / `MAX_REDIRECTS` / `TIMEOUT_MILLIS` / `MAX_CONCURRENT` | `1 MiB` / `5` / `20 s` / `4` | `web/http.ts` | `WebFetchResponseTooLargeError` / `RedirectLimitError` / `TimeoutError`; cross-origin redirects refused |
| Web capture | `MAX_RESPONSE_BYTES` / `TIMEOUT_MILLIS` / `MAX_CONCURRENT` | `2 MiB` / `30 s` / `4` | `web/cloudflare.ts` | `WebCaptureResponseTooLargeError` / `WebCaptureTimeoutError` / semaphore queue; the fetch provider's target guard applies |
| Web crawl | `DEFAULT_PAGES` → `MAX_PAGES` / `DEFAULT_DEPTH` → `MAX_DEPTH` / `MAX_TOTAL_BYTES` / `DEADLINE_MILLIS` / `CONCURRENCY` | `20` → `100` / `3` → `10` / `8 MiB` / `5 min` / `2` | `web/WebCrawl.ts` | a request above a ceiling is clamped to it; `CrawlResult.stoppedBy` names the bound that ended the crawl; a failed page is a row in `failed`, not a failure |
| Slack | `toleranceSeconds` | `300 s` | `Connectors.Slack.Options` | replay window guard |
| Durable polling | `clientOutcome` / `deliveryLog` / `workflowInterrupt` / `result` | `10 ms` / `250 ms` / `25 ms` / `10 ms` | `DurablePolling.defaults` / `EFFECT_AGENT_*_POLL_INTERVAL` | validated positive `Duration` via `Config`; also `DeliveryLog.live` fans out only in-process, cross-node via `read({ after })` |
| Interrupt | poll | `25 ms` | `DurablePolling.workflowInterrupt` | signal polled while submission runs |
| Tool progress | `toolProgress.maxBytes` | `8 MiB` per submission | `AgentSession.MakeOptions`, `internal/limits.ts` | `AgentToolProgressLimitError`; the call fails rather than truncating, and always fails the run rather than returning to the model |
| One-shot trace | `traceLimits` | `2048` envelopes / `8 MiB` | `Agent.StartOptions` | `AgentTraceLimitError` on `handle.events`; the submission, canonical history and durable delivery are unaffected |

STATUS.md keeps the history of how each was found; the JSDoc above is where a
user meets it.

## Defaults that weaken something when left out

A default whose absence means "no feature" is harmless. These are the ones
whose absence quietly means *less* -- less authorization, less durability, no
sandbox -- so leaving the option out is a decision, not an omission. Every
defaulted `Context.Reference` is of the harmless kind, and
`test/ReferenceInventory.test.ts` makes a new one prove it (item 110).

| Default | Where | What leaving it out means |
|---------|-------|---------------------------|
| `Permission.allowAll` | `Agent.make({ permission })`, `CodeMode` | every tool call runs; `Agent.describe()` reports `{ _tag: "AllowAll" }` |
| host authorization `allowAll()` | `cloudflare` `Options.authorization` | **network-facing**: any caller may act on any session |
| host principal = the `authorization` header, else `"anonymous"` | `cloudflare` `Options.principal` | callers are told apart only by the header's raw value -- a credential, used as the principal id |
| relay authorization `allowAll` | `RelayServer.layer({ authorization })` | **network-facing**: any authenticated peer may reach any peer |
| `InputChannel.memory` | `AgentSession.make` | queued input does not survive the process |
| A2A `InMemoryTaskStore` | `AgentA2A` (not an option) | A2A task records do not survive the process |
| OpenAI-compatible idempotency in memory | `OpenAiAgent` `idempotency.store` | a retried request after a restart runs again |
| `Shell.current` → host `bash` | `shell/Shell.ts` | commands run on the host, unsandboxed |

`AgentSessionHost` has no authorization default at all -- the shape the two
network-facing rows above should have, and do not yet (plan §22, Q8).

## Three bounds that are not each other

These get confused, and a fix for one is regularly cited as protection against
another. They are not the same thing:

* **Observer lag** (`maxObservationLag`, `AgentObservationLagError`) bounds how
  far *a reader may fall behind*. It disconnects that reader and leaves the run
  alone.
* **Tool progress production** (`toolProgress.maxBytes`,
  `AgentToolProgressLimitError`) bounds *how much there is to read*. A tool
  emitting progress in a loop costs network, storage and telemetry even when
  every observer is keeping up, and a replaying handle or a delivery log has to
  hold all of it. Observer lag does not help here: there is no lag.
* **A tool's terminal result** (truncation, `MAX_BYTES`) bounds *one answer*.
  Progress is a separate observational channel and is not truncated at all --
  a structured snapshot cut in half is usually a lie, and a consumer cannot
  tell it from a whole one.

The one-shot trace bound is a fourth thing again: it bounds what
`Agent.start`'s handle *retains* for replay, and failing it fails only
observation.
