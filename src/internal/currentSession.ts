import { Context, Option } from "effect"
import type { SessionId } from "./ids.js"

/**
 * The id of the session a tool call is running in, visible to the tool.
 *
 * The fourth thing a tool can see of its session, beside the principal, the
 * input and the elicitor (`guide-sessions.md`, "What a tool can see of its
 * session"), and the one that is internal: a tool that needs the session's
 * *identity* rather than one of its facts is asking to look something up by
 * it, and the only such tool today is the compaction controller's
 * `contextRemaining`, which reads the last projection it recorded for this
 * session. Provided by the harness around each handler; `None` outside any
 * session's tool execution, so a handler called directly in a test reads
 * `None` and says so.
 *
 * Same shape and same rule as the others: a `Reference` with a `None`
 * default, set by the harness, never carried by a protocol.
 */
export const CurrentSessionId = Context.Reference<Option.Option<SessionId>>(
  "affe-agent/internal/CurrentSessionId",
  { defaultValue: () => Option.none() }
)
