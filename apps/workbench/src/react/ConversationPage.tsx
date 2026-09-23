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
import { useEffect, useState } from "react"
import type React from "react"
import type { ConversationId } from "../domain/WorkbenchIds.js"
import { ConversationSessions } from "../runtime/ConversationSessions.js"
import type { ActivityView, MessageView } from "../ui-core/ConversationProjection.js"
import * as Attachments from "../ui-core/Attachments.js"
import * as Branch from "../ui-core/Branch.js"
import * as Question from "../ui-core/Question.js"
import { useConversation } from "./useConversation.js"

/** Ratings on replies; optional, so a page without a feedback store still renders. */
export interface FeedbackActions {
  readonly list: Effect.Effect<ReadonlyArray<{ readonly messageIndex: number; readonly rating: Rating }>, { readonly _tag: string }>
  readonly rate: (messageIndex: number, rating: Option.Option<Rating>) => Effect.Effect<void, { readonly _tag: string }>
}

export type Rating = "up" | "down"

export interface ConversationPageProps {
  readonly runtime: ManagedRuntime.ManagedRuntime<ConversationSessions, never>
  readonly conversationId: ConversationId
  readonly feedback?: FeedbackActions | undefined
  /**
   * Where to go once an edited message has been sent as a new branch. Without
   * it the page offers no Edit: a branch nobody navigates to is lost.
   */
  readonly onBranched?: ((id: ConversationId) => void) | undefined
  /**
   * The models this deployment offers. With `onBranched`, the page offers to
   * continue the conversation on another -- as a branch, since a
   * conversation's model is pinned like its revision.
   */
  readonly models?: ReadonlyArray<string> | undefined
}

/** Copy a reply's text; says "Copied" until the text is copied again or the page moves on. */
const CopyButton = ({ text }: { readonly text: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy reply"
      onClick={() => {
        // No clipboard (an insecure origin, a test without one): nothing to say "copied" about.
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
        if (clipboard === undefined) return
        void clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

const RateButtons = ({ onRate, rating }: {
  readonly rating: Option.Option<Rating>
  readonly onRate: (rating: Option.Option<Rating>) => void
}) => (
  <span role="group" aria-label="Rate this reply">
    {(["up", "down"] as const).map((value) => {
      const pressed = Option.contains(rating, value)
      return (
        <button
          key={value}
          type="button"
          aria-pressed={pressed}
          aria-label={value === "up" ? "Good reply" : "Bad reply"}
          onClick={() => onRate(pressed ? Option.none() : Option.some(value))}
        >
          {value === "up" ? "👍" : "👎"}
        </button>
      )
    })}
  </span>
)

const Message = ({ children, message }: { readonly message: MessageView; readonly children?: React.ReactNode }) => (
  <li data-role={message.role} data-state={message.state}>
    <strong>{message.role === "user" ? "You" : "Agent"}</strong>
    {message.reasoning === "" ? null : (
      <details>
        <summary>Reasoning</summary>
        <p>{message.reasoning}</p>
      </details>
    )}
    <p>{message.text}</p>
    {message.files.length === 0 ? null : (
      <ul aria-label="Attached files">
        {message.files.map((name, index) => <li key={index}>📎 {name}</li>)}
      </ul>
    )}
    {children}
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

export const ConversationPage = ({ conversationId, feedback, models = [], onBranched, runtime }: ConversationPageProps) => {
  const state = useConversation(runtime, conversationId)
  const [ratings, setRatings] = useState<ReadonlyMap<number, Rating>>(new Map())
  const [editing, setEditing] = useState(Option.none<{ readonly index: number; readonly text: string }>())
  const [otherModel, setOtherModel] = useState("")
  const [attachments, setAttachments] = useState<ReadonlyArray<Attachments.Attachment>>([])
  const [refusals, setRefusals] = useState<ReadonlyArray<string>>([])
  /** What this page last sent, files included: what Retry sends, when there is one. */
  const [lastInput, setLastInput] = useState(Option.none<ReturnType<typeof Attachments.promptOf>>())
  useEffect(() => {
    if (feedback === undefined) return
    void Effect.runPromiseExit(feedback.list).then((exit) => {
      if (exit._tag === "Success") setRatings(new Map(exit.value.map((entry) => [entry.messageIndex, entry.rating])))
    })
  }, [conversationId])
  const rate = (index: number, rating: Option.Option<Rating>) => {
    if (feedback === undefined) return
    void Effect.runPromiseExit(feedback.rate(index, rating)).then((exit) => {
      if (exit._tag === "Failure") return
      setRatings((current) => {
        const next = new Map(current)
        Option.match(rating, { onNone: () => next.delete(index), onSome: (value) => next.set(index, value) })
        return next
      })
    })
  }
  const [draft, setDraft] = useState("")
  const [commandError, setCommandError] = useState(Option.none<string>())

  if (state._tag === "Loading") return <p>Opening…</p>
  if (state._tag === "Failed") return <p role="alert">Could not open this conversation ({state.error._tag}).</p>

  const { conversation, session, view } = state
  const send = () => {
    const text = draft.trim()
    const files = attachments
    if (text === "" && files.length === 0) return
    const input = Attachments.promptOf(text, files)
    setDraft("")
    setAttachments([])
    setLastInput(Option.some(input))
    // Refused before it became a run -- busy, disconnected: the text and files come back.
    run(session.prompt(input, { stream: true }), () => {
      setDraft((current) => (current === "" ? text : current))
      setAttachments((current) => (current.length === 0 ? files : current))
    })
  }
  /** Everything so far, on another model, as a new conversation. This one is untouched. */
  const continueOn = (modelProfile: string) => {
    if (onBranched === undefined) return
    setCommandError(Option.none())
    void runtime.runPromiseExit(Effect.gen(function*() {
      const sessions = yield* ConversationSessions
      const branched = yield* sessions.branch({
        from: conversationId,
        ordinal: Branch.userCount(view.messages),
        modelProfile,
        title: `${conversation.title} (${modelProfile})`
      })
      return branched.conversation.id
    })).then((exit) => {
      if (exit._tag === "Success") onBranched(exit.value)
      else setCommandError(Option.some("the conversation could not be continued on that model"))
    })
  }
  /** Branch before this message, send the edit there, and go to it. The original is untouched. */
  const branchWith = (index: number, text: string) => {
    const ordinal = Branch.userOrdinal(view.messages, index)
    if (Option.isNone(ordinal) || onBranched === undefined) return
    setCommandError(Option.none())
    void runtime.runPromiseExit(Effect.gen(function*() {
      const sessions = yield* ConversationSessions
      const branched = yield* sessions.branch({ from: conversationId, ordinal: ordinal.value })
      yield* branched.session.submit(text.trim())
      return branched.conversation.id
    })).then((exit) => {
      if (exit._tag === "Success") {
        setEditing(Option.none())
        onBranched(exit.value)
      } else {
        setCommandError(Option.some("the branch could not be made"))
      }
    })
  }
  const attach = (list: FileList | null) => {
    if (list === null) return
    const chosen = [...list]
    void Promise.all(chosen.map(async (file): Promise<Attachments.Attachment> => ({
      fileName: file.name,
      mediaType: Attachments.mediaTypeOf(file.type),
      data: new Uint8Array(await file.arrayBuffer())
    }))).then((incoming) => {
      const { attached, refused } = Attachments.add(attachments, incoming)
      setAttachments(attached)
      setRefusals(refused.map(Attachments.describeRefusal))
    })
  }
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
    <main style={{ flex: "3 1 24rem", minWidth: 0 }}>
      <h1>{conversation.title}</h1>
      <p aria-label="Model">
        {Option.match(conversation.modelProfile, { onNone: () => "The agent's own model", onSome: (name) => `Model: ${name}` })}
        {onBranched === undefined || models.length === 0 ? null : (
          <>
            {" "}
            <label>
              Continue on{" "}
              <select name="other-model" value={otherModel} onChange={(event) => setOtherModel(event.target.value)}>
                <option value="">another model…</option>
                {models
                  .filter((name) => !Option.contains(conversation.modelProfile, name))
                  .map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>{" "}
            <button type="button" disabled={otherModel === "" || view.status !== "idle"} onClick={() => continueOn(otherModel)}>
              Continue
            </button>
          </>
        )}
      </p>
      {/* Busy while a reply streams, so a screen reader waits for it rather than reading every delta. */}
      <ol aria-label="Messages" aria-live="polite" aria-busy={view.status === "running"}>
        {view.messages.map((message, index) => (
          <Message key={index} message={message}>
            {onBranched !== undefined && view.status === "idle" && message.role === "user"
              ? Option.match(Option.filter(editing, (e) => e.index === index), {
                onNone: () => (
                  <button type="button" aria-label="Edit message" onClick={() => setEditing(Option.some({ index, text: message.text }))}>
                    Edit
                  </button>
                ),
                onSome: (edit) => (
                  <form
                    aria-label="Edit message"
                    onSubmit={(event) => {
                      event.preventDefault()
                      branchWith(index, edit.text)
                    }}
                  >
                    <textarea
                      aria-label="Edited message"
                      value={edit.text}
                      onChange={(event) => setEditing(Option.some({ index, text: event.target.value }))}
                    />
                    <button type="submit" disabled={edit.text.trim() === ""}>Send as a new branch</button>
                    <button type="button" onClick={() => setEditing(Option.none())}>Cancel</button>
                  </form>
                )
              })
              : null}
            {/* Only once settled: indices are history's, and history is re-read when a run ends. */}
            {message.role === "assistant" && message.state === "complete" ? <CopyButton text={message.text} /> : null}
            {feedback !== undefined && view.status === "idle" && message.role === "assistant" && message.state === "complete"
              ? <RateButtons rating={Option.fromNullishOr(ratings.get(index))} onRate={(rating) => rate(index, rating)} />
              : null}
          </Message>
        ))}
      </ol>
      <ul aria-label="Activity">
        {view.activity.map((activity, index) => <Activity key={index} activity={activity} />)}
      </ul>
      {view.pending.map(Question.describe).map((question, questionIndex) => (
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
          <button
            type="button"
            // A question stops the run until it is answered: the answer is where the focus goes.
            autoFocus={questionIndex === 0}
            onClick={() => run(session.respond({ id: question.id, granted: true }))}
          >
            Approve
          </button>
          <button type="button" onClick={() => run(session.respond({ id: question.id, granted: false }))}>
            Deny
          </button>
        </section>
      ))}
      <form
        aria-label="Compose"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <label>
          Message{" "}
          <textarea
            rows={3}
            value={draft}
            aria-describedby="compose-keys"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a new line; an IME composing text keeps its Enter.
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (view.status === "idle") send()
              } else if (event.key === "Escape" && view.status === "running") {
                event.preventDefault()
                run(session.interrupt())
              }
            }}
          />
        </label>
        <label>
          Attach{" "}
          <input
            type="file"
            multiple
            onChange={(event) => {
              attach(event.target.files)
              event.target.value = ""
            }}
          />
        </label>
        {attachments.length === 0 ? null : (
          <ul aria-label="To send">
            {attachments.map((file, index) => (
              <li key={`${file.fileName}-${index}`}>
                📎 {file.fileName}{" "}
                <button
                  type="button"
                  aria-label={`Remove ${file.fileName}`}
                  onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {refusals.length === 0 ? null : (
          <ul role="alert" aria-label="Not attached">
            {refusals.map((reason, index) => <li key={index}>{reason}</li>)}
          </ul>
        )}
        <span id="compose-keys" hidden>Enter sends, Shift+Enter starts a new line, Escape stops a running reply.</span>
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
            {Option.match(Option.orElse(lastInput, () => lastPrompt), {
              onNone: () => null,
              onSome: (input) => (
                <button type="button" disabled={view.status !== "idle"} onClick={() => run(session.prompt(input, { stream: true }))}>
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
      <p aria-label="Status" role="status">
        {view.status}
        {Option.match(view.outcome, { onNone: () => "", onSome: (outcome) => ` (last: ${outcome})` })}
      </p>
    </main>
  )
}
