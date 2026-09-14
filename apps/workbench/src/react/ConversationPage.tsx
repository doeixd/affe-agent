/**
 * The deliberately plain W0 page (plan-workbench.md, W0).
 *
 * Everything it shows is `ConversationView`; everything it does is a
 * `RemoteSession` method. There is no execution state here to drift from the
 * session's: "Send" is disabled because the session reports it is running,
 * not because the page remembers clicking.
 */
import { Effect, Option } from "effect"
import type { ManagedRuntime } from "effect"
import { useState } from "react"
import type { ConversationId } from "../domain/WorkbenchIds.js"
import type { ConversationSessions } from "../runtime/ConversationSessions.js"
import type { ActivityView, MessageView } from "../ui-core/ConversationProjection.js"
import { useConversation } from "./useConversation.js"

export interface ConversationPageProps {
  readonly runtime: ManagedRuntime.ManagedRuntime<ConversationSessions, never>
  readonly conversationId: ConversationId
}

const Message = ({ message }: { readonly message: MessageView }) => (
  <li data-role={message.role} data-state={message.state}>
    <strong>{message.role === "user" ? "You" : "Agent"}</strong>
    {message.reasoning === "" ? null : (
      <details>
        <summary>Reasoning</summary>
        <p>{message.reasoning}</p>
      </details>
    )}
    <p>{message.text}</p>
  </li>
)

const Activity = ({ activity }: { readonly activity: ActivityView }) =>
  activity._tag === "Tool"
    ? (
      <li>
        {activity.name}: {activity.state}
        {activity.progress.length === 0 ? null : ` (${activity.progress.map((step) => JSON.stringify(step)).join(", ")})`}
      </li>
    )
    : <li>unrecognized event {activity.originalTag}</li>

export const ConversationPage = ({ conversationId, runtime }: ConversationPageProps) => {
  const state = useConversation(runtime, conversationId)
  const [draft, setDraft] = useState("")
  const [commandError, setCommandError] = useState(Option.none<string>())

  if (state._tag === "Loading") return <p>Opening…</p>
  if (state._tag === "Failed") return <p role="alert">Could not open this conversation ({state.error._tag}).</p>

  const { conversation, session, view } = state
  // A run that fails is reported by the session and rendered from the view.
  // A command refused before it became a run -- a busy session, a dropped
  // connection -- is not, so its error is kept here to show.
  const run = (command: Effect.Effect<unknown, { readonly _tag: string }>) => {
    setCommandError(Option.none())
    void runtime.runPromise(
      command.pipe(Effect.catch((error) => Effect.sync(() => setCommandError(Option.some(error._tag)))))
    )
  }

  return (
    <main>
      <h1>{conversation.title}</h1>
      <ol aria-label="Messages">
        {view.messages.map((message, index) => <Message key={index} message={message} />)}
      </ol>
      <ul aria-label="Activity">
        {view.activity.map((activity, index) => <Activity key={index} activity={activity} />)}
      </ul>
      {view.pending.map((request) => (
        <section key={request.id} aria-label="Question">
          <p>The agent is asking: {request.kind}</p>
          <button type="button" onClick={() => run(session.respond({ id: request.id, granted: true }))}>
            Approve
          </button>
          <button type="button" onClick={() => run(session.respond({ id: request.id, granted: false }))}>
            Deny
          </button>
        </section>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const text = draft.trim()
          if (text === "") return
          setDraft("")
          run(session.prompt(text, { stream: true }))
        }}
      >
        <label>
          Message <input value={draft} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <button type="submit" disabled={view.status !== "idle"}>Send</button>
        <button type="button" disabled={view.status !== "running"} onClick={() => run(session.interrupt())}>
          Stop
        </button>
      </form>
      {Option.match(commandError, {
        onNone: () => null,
        onSome: (tag) => <p role="alert">The last command was refused ({tag}).</p>
      })}
      <p aria-label="Status">
        {view.status}
        {Option.match(view.outcome, { onNone: () => "", onSome: (outcome) => ` (last: ${outcome})` })}
      </p>
    </main>
  )
}
