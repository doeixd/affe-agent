/**
 * The same conversation in assistant-ui (plan-workbench.md W0, "a separate
 * adapter proof"; W2's shared fixtures).
 *
 * Nothing here holds execution state. It reads the view `useConversation`
 * derives -- the hook the plain page uses -- converts each message for
 * assistant-ui's external-store runtime, and turns assistant-ui's callbacks
 * back into `RemoteSession` calls: a new message is `prompt`, cancel is
 * `interrupt`. What the agent asks is rendered from `ui-core/Question`, so
 * both adapters say the same thing about the same request.
 *
 * Nothing outside this folder imports it (`test/Boundaries.test.ts`), so
 * deleting it leaves the plain client and every other test as they were.
 */
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime
} from "@assistant-ui/react"
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react"
import { Effect, Option } from "effect"
import type { ManagedRuntime } from "effect"
import { useState } from "react"
import type { ConversationId } from "../domain/WorkbenchIds.js"
import { useConversation } from "../react/useConversation.js"
import type { ConversationSessions } from "../runtime/ConversationSessions.js"
import type { MessageView } from "../ui-core/ConversationProjection.js"
import * as Commands from "../ui-core/Commands.js"
import * as Question from "../ui-core/Question.js"
import * as Starters from "../ui-core/Starters.js"

/** One message as assistant-ui reads it: text, reasoning, and a status assistant-ui knows. */
export const toThreadMessage = (message: MessageView, index: number): ThreadMessageLike => ({
  id: `m-${index}`,
  role: message.role,
  content: [
    ...(message.reasoning === "" ? [] : [{ type: "reasoning" as const, text: message.reasoning }]),
    { type: "text" as const, text: message.text }
  ],
  ...(message.role === "assistant"
    ? {
      status: message.state === "streaming"
        ? { type: "running" as const }
        : message.state === "complete"
        ? { type: "complete" as const, reason: "stop" as const }
        : message.state === "interrupted"
        ? { type: "incomplete" as const, reason: "cancelled" as const }
        : { type: "incomplete" as const, reason: "error" as const }
    }
    : {})
})

/** What a person typed, from assistant-ui's message: its text parts, joined. */
export const textOf = (message: Pick<AppendMessage, "content">): string =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

export interface AssistantThreadProps {
  readonly runtime: ManagedRuntime.ManagedRuntime<ConversationSessions, never>
  readonly conversationId: ConversationId
  /** The agent's starter prompts, offered as assistant-ui suggestions while the conversation is empty. */
  readonly starters?: ReadonlyArray<string> | undefined
}

const Bubble = ({ label }: { readonly label: string }) => (
  <MessagePrimitive.Root>
    <strong>{label}</strong>
    <MessagePrimitive.Content />
  </MessagePrimitive.Root>
)

export const AssistantThread = ({ conversationId, runtime, starters = [] }: AssistantThreadProps) => {
  const state = useConversation(runtime, conversationId)
  const [refused, setRefused] = useState(Option.none<string>())
  /** What the last command did, when it was not a message. */
  const [notice, setNotice] = useState(Option.none<string>())

  const run = (command: Effect.Effect<unknown, { readonly _tag: string }>) => {
    setRefused(Option.none())
    runtime.runFork(command.pipe(Effect.catch((error) => Effect.sync(() => setRefused(Option.some(error._tag))))))
  }

  const ready = state._tag === "Ready" ? state : undefined
  const assistant = useExternalStoreRuntime<MessageView>({
    messages: ready?.view.messages ?? [],
    isRunning: ready?.view.status === "running",
    isDisabled: ready === undefined,
    suggestions: ready === undefined ? [] : Starters.offered(ready.view, starters).map((prompt) => ({ prompt })),
    convertMessage: toThreadMessage,
    // The same commands as the plain page, through the same parser.
    onNew: async (message) => {
      const action = Commands.parse(textOf(message))
      if (ready === undefined || action === undefined) return
      setNotice(Option.none())
      switch (action._tag) {
        case "Send":
          return run(ready.session.prompt(action.text, { stream: true }))
        case "Stop":
          return ready.view.status === "running" ? run(ready.session.interrupt()) : setNotice(Option.some("Nothing is running."))
        case "Retry": {
          const last = ready.view.messages.filter((m) => m.role === "user").at(-1)
          return last === undefined
            ? setNotice(Option.some("There is no message to send again."))
            : run(ready.session.prompt(last.text, { stream: true }))
        }
        case "Help":
          return setNotice(Option.some(Commands.commands.map((command) => `${command.usage} -- ${command.description}`).join("\n")))
        case "ContinueOn":
          return setNotice(Option.some("Continuing on another model is not available on this page; use the workbench."))
        case "Refused":
          return setNotice(Option.some(action.reason))
      }
    },
    onCancel: async () => {
      if (ready !== undefined) run(ready.session.interrupt())
    }
  })

  if (state._tag === "Loading") return <p>Opening…</p>
  if (state._tag === "Failed") return <p role="alert">Could not open this conversation ({state.error._tag}).</p>
  const { conversation, session, view } = state

  return (
    <AssistantRuntimeProvider runtime={assistant}>
      <main aria-label="Assistant thread">
        <h1>{conversation.title}</h1>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Viewport>
            <ThreadPrimitive.Messages>
              {({ message }) => <Bubble label={message.role === "user" ? "You" : "Agent"} />}
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>
          <ThreadPrimitive.Suggestions>
            {({ suggestion }) => (
              <SuggestionPrimitive.Trigger send aria-label={`Suggested: ${suggestion.prompt}`}>
                {suggestion.prompt}
              </SuggestionPrimitive.Trigger>
            )}
          </ThreadPrimitive.Suggestions>
          {view.pending.map(Question.describe).map((question) => (
            <section key={question.id} aria-label="Question">
              <p>{Question.headline(question)}</p>
              <button type="button" onClick={() => run(session.respond({ id: question.id, granted: true }))}>Approve</button>
              <button type="button" onClick={() => run(session.respond({ id: question.id, granted: false }))}>Deny</button>
            </section>
          ))}
          <ComposerPrimitive.Root>
            <ComposerPrimitive.Input aria-label="Message" />
            <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
            <ComposerPrimitive.Cancel>Stop</ComposerPrimitive.Cancel>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
        {Option.isSome(refused) ? <p role="alert">The last command was refused ({refused.value}).</p> : null}
        {Option.isSome(notice) ? <pre role="note" aria-label="Command">{notice.value}</pre> : null}
        <p aria-label="Status" role="status">{view.status}</p>
      </main>
    </AssistantRuntimeProvider>
  )
}
