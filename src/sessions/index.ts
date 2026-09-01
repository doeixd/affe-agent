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
 * `SessionProjection` is the query half's foundation and ships here. The
 * `SessionDirectory` that §26 specifies -- `list` / `active` / `stats` /
 * `rename` / `move` / `annotate`, paginated from day one -- is not built; it
 * needs a backing store, and this is the reducer it would keep per session to
 * answer `stats`.
 */
export * as SessionProjection from "./SessionProjection.js"
