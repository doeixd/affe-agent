/**
 * Scoped presentation state for one conversation (plan-workbench.md §14).
 *
 * Commands are not copied here. A frontend calls
 * `presenter.session.prompt/steer/interrupt/respond` directly; the presenter
 * only turns what the session reports into a `ConversationView`.
 */
import { Effect, Option, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import type { AgentClient } from "affe-agent/client"
import type * as Conversation from "../domain/Conversation.js"
import type { ConversationId } from "../domain/WorkbenchIds.js"
import { ConversationSessions } from "../runtime/ConversationSessions.js"
import type { OpenConversation, Service as SessionsService } from "../runtime/ConversationSessions.js"
import * as ConversationProjection from "./ConversationProjection.js"

export interface ConversationPresenter {
  readonly conversation: Conversation.Record
  readonly session: AgentClient.RemoteSession
  readonly state: SubscriptionRef.SubscriptionRef<ConversationProjection.ConversationView>
}

export type OpenError = Effect.Error<ReturnType<SessionsService["open"]>>

/**
 * Present a conversation already opened.
 *
 * The snapshot is read before the subscription attaches, and the gap between
 * them is closed differently by what the session can do:
 *
 * - a session with an event log is resumed from the log's latest sequence,
 *   so nothing between the snapshot and the subscription is lost;
 * - one without is followed live. The subscription is forked to start
 *   immediately, which attaches an in-process session before this returns;
 *   over a transport without resumption a submission already running when
 *   the presenter opened shows from its next event, and its messages arrive
 *   whole from history once it settles.
 *
 * After every submission settles, messages are rebuilt from canonical
 * history, which is also what makes a reopened presenter show the same
 * conversation a live one did.
 */
export const fromOpen = Effect.fn("ConversationPresenter.fromOpen")(function*(open: OpenConversation) {
  const { session } = open
  const [history, pending, status] = yield* Effect.all([session.history, session.pending, session.status])
  const after = session.eventLog === undefined
    ? Option.none<number>()
    : Option.some((yield* session.eventLog()).latest)
  const state = yield* SubscriptionRef.make(ConversationProjection.initial(history, pending, status))

  const events = Option.match(after, {
    onNone: () => session.events(),
    onSome: (sequence) => session.events({ after: sequence })
  })

  yield* events.pipe(
    Stream.runForEach((envelope) =>
      SubscriptionRef.update(state, (view) => ConversationProjection.transition(view, envelope)).pipe(
        Effect.andThen(
          ConversationProjection.settles(envelope)
            ? Effect.flatMap(session.history, (settled) =>
              SubscriptionRef.update(state, (view) => ConversationProjection.fromHistory(view, settled)))
            : Effect.void
        )
      )
    ),
    // A presenter whose stream failed must not keep showing a live
    // conversation as if it were still following it.
    Effect.tapCause((cause) => Effect.logWarning("conversation presenter stopped following its session", cause)),
    Effect.forkScoped({ startImmediately: true })
  )

  return { conversation: open.conversation, session, state } satisfies ConversationPresenter
})

export const make = Effect.fn("ConversationPresenter.make")(function*(
  id: ConversationId
): Effect.fn.Return<ConversationPresenter, OpenError | AgentClient.RemoteError, ConversationSessions | Scope.Scope> {
  const sessions = yield* ConversationSessions
  return yield* fromOpen(yield* sessions.open(id))
})
