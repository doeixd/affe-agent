/**
 * A React hook over `ConversationPresenter` (plan-workbench.md §14).
 *
 * Tiny on purpose: it opens a scoped presenter on the application's runtime,
 * mirrors `presenter.state` into React state, and closes the scope on
 * unmount. Commands are not here -- a component calls `session.prompt`,
 * `interrupt` and `respond` itself.
 */
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import type { ManagedRuntime } from "effect"
import { useEffect, useState } from "react"
import type { AgentClient } from "affe-agent/client"
import type * as Conversation from "../domain/Conversation.js"
import type { ConversationId } from "../domain/WorkbenchIds.js"
import type { ConversationSessions } from "../runtime/ConversationSessions.js"
import * as ConversationPresenter from "../ui-core/ConversationPresenter.js"
import type { ConversationView } from "../ui-core/ConversationProjection.js"

export type ConversationState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed"; readonly error: ConversationPresenter.OpenError | AgentClient.RemoteError }
  | {
    readonly _tag: "Ready"
    readonly conversation: Conversation.Record
    readonly session: AgentClient.RemoteSession
    readonly view: ConversationView
  }

export const useConversation = (
  runtime: ManagedRuntime.ManagedRuntime<ConversationSessions, never>,
  id: ConversationId
): ConversationState => {
  const [state, setState] = useState<ConversationState>({ _tag: "Loading" })

  useEffect(() => {
    setState({ _tag: "Loading" })
    const fiber = runtime.runFork(
      Effect.scoped(Effect.gen(function*() {
        const presenter = yield* ConversationPresenter.make(id)
        yield* SubscriptionRef.changes(presenter.state).pipe(
          Stream.runForEach((view) =>
            Effect.sync(() =>
              setState({ _tag: "Ready", conversation: presenter.conversation, session: presenter.session, view })
            )
          )
        )
      })).pipe(Effect.catch((error) => Effect.sync(() => setState({ _tag: "Failed", error }))))
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [runtime, id])

  return state
}
