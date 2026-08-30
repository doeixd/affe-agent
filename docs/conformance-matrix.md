# Cross-adapter conformance matrix

`test/HostConformance.ts` and `test/HostConformance.test.ts` (2026-08-30),
design-assessment recommendation 4. One shared `AgentSessionHost` over one
real client; one list of rows; one driver per adapter that drives each row
through *its own wire* -- the official MCP v2 client, raw A2A REST, raw AG-UI
SSE, `HttpApiClient`, `RpcClient` -- or declares, with a reason, that its
protocol has no vocabulary for it. A declaration is a row in this table, not a
skipped test: the point is that the five adapters answer the same questions,
including where the answer is "cannot be asked here".

The rows are phrased in the host's vocabulary. A driver translates a refusal
(capacity, forbidden, busy) out of whatever its protocol does -- an HTTP
status, a JSON-RPC error, a failed task, a tool result with `isError` -- into
the matrix's words, so the table compares *what happened*, not how it was
spelled.

| row | HTTP | RPC | MCP | A2A | AG-UI |
| --- | --- | --- | --- | --- | --- |
| creation | ✓ | ✓ | ✓ | ✓ | ✓ |
| continuation (the model sees the earlier exchange) | ✓ | ✓ | ✓ | ✓ | ✓ |
| capacity (`maxSessions` reached → refused as capacity) | ✓ | ✓ | ✓ ¹ | ✓ ² | ✓ |
| authorization (`Bearer forbidden` → refused as forbidden) | ✓ | ✓ | ✓ ¹ | ✓ ² | ✓ |
| interruption (a held run, interrupted, reports `interrupted`) | ✓ | ✓ | ✓ | ✓ (cancel) | declared ³ |
| idempotency (one request id twice → one run, same answer) | ✓ | ✓ | declared ⁴ | declared ⁵ | declared ⁶ |
| resumption (events after a cursor: exactly the rest, in order) | ✓ ⁷ | ✓ ⁷ | ✓ (`agent://session/{id}/events/after/{n}`) | declared ⁸ | declared ⁹ |

¹ **Found by the matrix, fixed the same day.** Every agent tool declared
`failure: Schema.String`, and Effect's `McpServer` renders a declared failure's
text only when the value is an `Error` -- so a capacity or authorization
refusal reached the client as "Tool execution failed due to an internal server
error", indistinguishable from a crash. `AgentMcp.ToolFailure` (a
`Schema.TaggedError` whose message is the reason) is now the declared failure
of all nine tools; the wire is unchanged (`isError: true`, the reason as text).

² A2A reports a host refusal as a **failed task** with the reason in
`status.message` -- the `message:send` request itself is 200. That is the
protocol's shape, not a defect; the driver classifies from the text.

³ AG-UI has no cancel. A client disconnect is the only signal, and it is not
an answer the run reports.

⁴ MCP request ids are minted by `agent_start`, not chosen by the caller; the
idempotent form is awaiting one ticket twice, covered by
`McpServerConformance`.

⁵ An A2A message id identifies a message, not a submission; a resent message
is a new task.

⁶ A `runId` names a run for the event stream; AG-UI defines no retry-safe
resubmission.

⁷ A cursor is a property of the backing: the in-process client has no journal
and refuses `after` outright, so this row runs on the durable client, where
the delivery log answers it. Every other row runs on the in-process client.

⁸ A2A streams are per task (`tasks/{id}:subscribe`); the session-wide event
cursor has no A2A form.

⁹ One AG-UI run is one SSE response; there is no session-wide cursor.

## Reading the table

- A ✓ is a test that ran the row through that adapter's wire and held.
- "declared" is a test that passed by declaration and printed the reason;
  the reason is the adapter's own limitation, stated where a reader will find
  it rather than a silently absent test.
- Two boundary properties fell out of writing the drivers and are now pinned:
  a server with a stream still open at teardown reports "All fibers
  interrupted" as the test's failure unless it drains rather than pre-empts
  (`disablePreemptiveShutdown`), and two prompts racing to open one session
  must treat `AgentSessionAlreadyExistsError` as success.
