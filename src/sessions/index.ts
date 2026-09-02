/**
 * Reading a session, as opposed to running one.
 *
 * `AgentClient` does the work; this answers questions about it.
 * `docs/effect-plan-2.txt` §26–27 draws that line and insists on it: the
 * durable session store holds the minimal state execution needs to be
 * *correct*, and a management/query model is a different thing with different
 * costs. Merging them makes every dashboard query a risk to a running
 * conversation.
 *
 * `SessionProjection` is the query half's foundation: the pure reducer. The
 * `SessionDirectory` that §26 specifies -- `list` / `active` / `stats` /
 * `rename` / `move` / `annotate`, paginated from day one -- keeps that
 * reducer's counts per session in a store (memory or SQL) and is fed from
 * the host-wide event stream by `SessionDirectory.follow`.
 */
export * as SessionProjection from "./SessionProjection.js"
export * as SessionDirectory from "./SessionDirectory.js"
