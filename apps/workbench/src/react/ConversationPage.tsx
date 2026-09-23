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
import * as Question from "../ui-core/Question.js"
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
  /** What a retry sends: the person's last message, as they wrote it. */
  const lastPrompt = Option.fromNullishOr(view.messages.filter((message) => message.role === "user").at(-1)?.text)
  // A run that fails is reported by the session and rendered from the view.
  // A command refused before it became a run -- a busy session, a dropped
  // connection -- is not, so its error is kept here to show.
  const run = (command: Effect.Effect<unknown, { readonly _tag: string }>, onRefused?: () => void) => {
    setCommandError(Option.none())
    // Forked, not awaited: a command interrupted by Stop or by the runtime
    // closing is not an error to report, and a promise would reject with it.
    runtime.runFork(
      command.pipe(Effect.catch((error) =>
        Effect.sync(() => {
          setCommandError(Option.some(error._tag))
          onRefused?.()
        })))
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
      {view.pending.map(Question.describe).map((question) => (
        <section key={question.id} aria-label="Question">
          {question._tag === "ToolApproval"
            ? (
              <>
                <p>
                  <strong>{question.tool}</strong> wants to {question.action}: <code>{question.target}</code>
                </p>
                {Option.match(question.reason, { onNone: () => null, onSome: (reason) => <p>{reason}</p> })}
                {question.via.length === 0 ? null : <p>On behalf of {question.via.join(" → ")}</p>}
              </>
            )
            : <p>{Question.headline(question)}</p>}
          <button type="button" onClick={() => run(session.respond({ id: question.id, granted: true }))}>
            Approve
          </button>
          <button type="button" onClick={() => run(session.respond({ id: question.id, granted: false }))}>
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
          // Refused before it became a run -- busy, disconnected: the text comes back to the box.
          run(session.prompt(text, { stream: true }), () => setDraft((current) => (current === "" ? text : current)))
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
      {Option.match(view.failure, {
        onNone: () => null,
        onSome: (failure) => (
          <section role="alert" aria-label="Failure">
            <p>The last run failed: {failure.message === "" ? failure.tag : failure.message}</p>
            {Option.match(lastPrompt, {
              onNone: () => null,
              onSome: (text) => (
                <button type="button" disabled={view.status !== "idle"} onClick={() => run(session.prompt(text, { stream: true }))}>
                  Retry
                </button>
              )
            })}
          </section>
        )
      })}
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
