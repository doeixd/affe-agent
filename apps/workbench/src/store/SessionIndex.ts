/**
 * The product's view of its sessions (plan-agent-product-control-plane.md §10).
 *
 * The kernel's `SessionDirectory` is the read model: which sessions exist,
 * which are running work now, what each has done. This module is the
 * product's mapping onto it, in three decisions and nothing more:
 *
 * - a session's directory *namespace* is its conversation's owner, so "this
 *   person's running sessions" is one directory query and another person's
 *   sessions never share a page with it;
 * - the agent and revision a session runs are directory *attributes*, so a
 *   summary can say what is running without a join;
 * - the conversation a session is comes from its session id, the way the host
 *   authorizes it (`ConversationSessions.conversationIdOf`).
 *
 * It is an index, never an execution authority: losing it loses a listing.
 * "Blocked on an approval" is a running submission here -- the stats do not
 * carry the pending question, which the session itself answers.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { AgentProtocol } from "affe-agent/client"
import { SessionDirectory } from "affe-agent/sessions"
import type * as Conversation from "../domain/Conversation.js"
import { AgentId, AgentRevisionId, ConversationId } from "../domain/WorkbenchIds.js"
import type { UserId } from "../domain/WorkbenchIds.js"
import { conversationIdOf } from "../runtime/ConversationSessions.js"
import { failedAs } from "./WorkbenchStorageError.js"
import type { WorkbenchStorageError } from "./WorkbenchStorageError.js"

export class SessionIndex
  extends Context.Service<SessionIndex, SessionDirectory.SessionDirectory>()("workbench/SessionIndex")
{}

export const memory: Layer.Layer<SessionIndex> = Layer.effect(SessionIndex, SessionDirectory.memory)

/** Its own table, beside the kernel's default name, so a deployment can also run a kernel directory. */
export const sqlTable = "workbench_session_directory"

export const layerSql: Layer.Layer<SessionIndex, never, SqlClient.SqlClient> = Layer.effect(
  SessionIndex,
  SessionDirectory.sqlWithTable({ table: sqlTable })
)

// -- What the product reads -----------------------------------------------------------

export const Summary = Schema.Struct({
  conversationId: ConversationId,
  sessionId: Schema.String,
  agentId: Schema.Option(AgentId),
  agentRevisionId: Schema.Option(AgentRevisionId),
  /** Running a submission now, which includes waiting on an approval. */
  active: Schema.Boolean,
  stats: SessionDirectory.Stats,
  /** Epoch milliseconds, from the directory's clock. */
  updatedAt: Schema.Number
})
export type Summary = typeof Summary.Type

const agentAttribute = "workbench/agentId"
const revisionAttribute = "workbench/agentRevisionId"

/** A directory entry as the product reads it; `None` for a session that is not a conversation. */
export const summaryOf = (entry: SessionDirectory.Entry): Option.Option<Summary> =>
  Option.map(conversationIdOf(entry.sessionId), (conversationId) => ({
    conversationId,
    sessionId: entry.sessionId,
    agentId: Option.map(Option.fromNullishOr(entry.attributes[agentAttribute]), AgentId.make),
    agentRevisionId: Option.map(Option.fromNullishOr(entry.attributes[revisionAttribute]), AgentRevisionId.make),
    active: SessionDirectory.isActive(entry.stats),
    stats: entry.stats,
    updatedAt: entry.updatedAt
  }))

// -- What the product writes ----------------------------------------------------------

/**
 * Index a conversation's session under its owner, naming the agent it runs.
 * Idempotent, and safe before or after the session's first event: `observe`
 * creates the entry only if `follow` has not already, and the stats are
 * untouched either way.
 */
export const index = (
  directory: SessionDirectory.SessionDirectory,
  conversation: Conversation.Record
): Effect.Effect<void, WorkbenchStorageError> =>
  Effect.gen(function*() {
    const sessionId = AgentProtocol.SessionId.make(conversation.sessionId)
    yield* directory.observe(sessionId)
    yield* directory.move(sessionId, conversation.ownerId)
    yield* directory.annotate(sessionId, {
      [agentAttribute]: Option.some(conversation.agentId),
      [revisionAttribute]: Option.some(conversation.agentRevisionId)
    })
  }).pipe(Effect.mapError(failedAs("SessionIndex.index")))

/** One conversation's session, if it has been indexed. */
export const summary = (
  directory: SessionDirectory.SessionDirectory,
  conversation: Conversation.Record
): Effect.Effect<Option.Option<Summary>, WorkbenchStorageError> =>
  directory.get(AgentProtocol.SessionId.make(conversation.sessionId)).pipe(
    Effect.map(Option.flatMap(summaryOf)),
    Effect.mapError(failedAs("SessionIndex.summary"))
  )

/** Every session of this person's that is running work now, in session-id order. */
export const active = (
  directory: SessionDirectory.SessionDirectory,
  owner: UserId
): Effect.Effect<ReadonlyArray<Summary>, WorkbenchStorageError> =>
  Effect.gen(function*() {
    const found: Array<Summary> = []
    let after: Option.Option<AgentProtocol.SessionId> = Option.none()
    do {
      const page = yield* directory.active({
        namespace: owner,
        limit: SessionDirectory.maxLimit,
        ...(Option.isSome(after) ? { after: after.value } : {})
      })
      for (const entry of page.entries) {
        const one = summaryOf(entry)
        if (Option.isSome(one)) found.push(one.value)
      }
      after = page.next
    } while (Option.isSome(after))
    return found
  }).pipe(Effect.mapError(failedAs("SessionIndex.active")))
