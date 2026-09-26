/**
 * Reading a session, as opposed to running one.
 *
 * `AgentClient` does the work; this answers questions about it. The split is
 * deliberate: the durable session store holds the minimal state execution
 * needs to be *correct*, and a management/query model is a different thing
 * with different costs. Merging them makes every dashboard query a risk to a
 * running conversation.
 *
 * `SessionProjection` is the query half's foundation: the pure reducer. The
 * `SessionDirectory` -- `list` / `active` / `stats` / `rename` / `move` /
 * `annotate`, paginated from day one -- keeps that reducer's counts per
 * session in a store (memory or SQL) and is fed from the host-wide event
 * stream by `SessionDirectory.follow`.
 *
 * `SessionInbox` and `Messaging` are the one way in rather than out: work
 * that reaches a session from outside any submission, as a background report
 * or as another session's message, delivered only when the session is idle.
 */
export * as SessionProjection from "./SessionProjection.js"
export * as SessionDirectory from "./SessionDirectory.js"
export * as SessionInbox from "./SessionInbox.js"
export * as Messaging from "./Messaging.js"
