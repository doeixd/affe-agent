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
| Truncation | `MAX_BYTES` / `MAX_LINES` | `50 KB` / `2000 lines` | `PiToolkit.MAX_BYTES`, `coding/internal/truncate.ts` | tail kept, banner names `50.0KB` or `2000 lines` limit and spills full output to `.effect-agent/tool-output/` |
| Read | window | `2000 lines`, `50 KB`, `2000 chars/line` | `coding/internal/readFormat.ts` — `DEFAULT_LIMIT`, `MAX_BYTES`, `MAX_LINE_LENGTH` | slice capped, footer with `offset=` to continue |
| Search | `SEARCH_LIMIT` | `100` | `coding/internal/searchFormat.ts` | `Found N matches (more matches available)` |
| Pi list | `LS_LIMIT` | `500` | `PiToolkit.LS_LIMIT` | truncated notice to narrow path or use search |
| Pi grep | `GREP_MAX_LINE_LENGTH` | `500 chars` | `PiToolkit.GREP_MAX_LINE_LENGTH` | `... (line truncated to 500 chars)` |
| Web search | `DEFAULT_LIMIT` / `MAX_LIMIT` / `MAX_RESPONSE_BYTES` / `TIMEOUT_MILLIS` / `MAX_CONCURRENT` | `8` / `10` / `1 MiB` / `15 s` / `4` | `web/brave.ts` | `WebSearchResponseTooLargeError` / `WebSearchTimeoutError` / semaphore queue |
| Web fetch | `MAX_RESPONSE_BYTES` / `MAX_REDIRECTS` / `TIMEOUT_MILLIS` / `MAX_CONCURRENT` | `1 MiB` / `5` / `20 s` / `4` | `web/http.ts` | `WebFetchResponseTooLargeError` / `RedirectLimitError` / `TimeoutError`; cross-origin redirects refused |
| Slack | `toleranceSeconds` | `300 s` | `Connectors.Slack.Options` | replay window guard |
| Durable polling | `clientOutcome` / `deliveryLog` / `workflowInterrupt` / `result` | `10 ms` / `250 ms` / `25 ms` / `10 ms` | `DurablePolling.defaults` / `EFFECT_AGENT_*_POLL_INTERVAL` | validated positive `Duration` via `Config`; also `DeliveryLog.live` fans out only in-process, cross-node via `read({ after })` |
| Interrupt | poll | `25 ms` | `DurablePolling.workflowInterrupt` | signal polled while submission runs |

STATUS.md keeps the history of how each was found; the JSDoc above is where a
user meets it.

