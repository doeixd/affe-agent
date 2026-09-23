/**
 * The conversation sidebar (plan-workbench.md W1 "sidebar", W2 "agent
 * pickers"): the person's conversations, newest first, each renamable,
 * archivable and deletable, and a new conversation on the agent they pick.
 *
 * Plain like the other pages: the list is whatever the store answered
 * last, re-read after every change. Deleting asks twice on the page itself
 * -- a browser `confirm` blocks everything, and a test cannot answer it.
 */
import { Effect, Option } from "effect"
import type { ManagedRuntime } from "effect"
import { useEffect, useState } from "react"
import type * as Conversation from "../domain/Conversation.js"
import type { AgentId, ConversationId, UserId } from "../domain/WorkbenchIds.js"
import { ConversationSessions } from "../runtime/ConversationSessions.js"
import { ConversationStore } from "../store/ConversationStore.js"

export interface ConversationListProps {
  readonly runtime: ManagedRuntime.ManagedRuntime<ConversationSessions | ConversationStore, never>
  readonly owner: UserId
  /** The agents a new conversation can run, by id and name; the first is the default. */
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>
  readonly selected: Option.Option<ConversationId>
  readonly onOpen: (id: ConversationId) => void
  /** The selected conversation was deleted. */
  readonly onClosed?: (() => void) | undefined
}

type Editing =
  | { readonly _tag: "None" }
  | { readonly _tag: "Renaming"; readonly id: ConversationId; readonly title: string }
  | { readonly _tag: "Deleting"; readonly id: ConversationId }

export const ConversationList = ({ agents, onClosed, onOpen, owner, runtime, selected }: ConversationListProps) => {
  const [conversations, setConversations] = useState<ReadonlyArray<Conversation.Record>>([])
  const [showArchived, setShowArchived] = useState(false)
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")
  const [editing, setEditing] = useState<Editing>({ _tag: "None" })
  const [failure, setFailure] = useState(Option.none<string>())

  const refresh = (includeArchived = showArchived) => {
    void runtime.runPromiseExit(Effect.flatMap(ConversationStore, (store) => store.list({ ownerId: owner, includeArchived })))
      .then((exit) => {
        if (exit._tag === "Success") setConversations(exit.value)
        else setFailure(Option.some("The conversation list could not be read."))
      })
  }

  useEffect(() => refresh(), [showArchived])

  /** Run a change, then re-read; a refusal is said and the list is re-read anyway. */
  const change = (effect: Effect.Effect<unknown, { readonly _tag: string }, ConversationStore | ConversationSessions>, done?: () => void) => {
    setFailure(Option.none())
    void runtime.runPromiseExit(effect).then((exit) => {
      if (exit._tag === "Failure") setFailure(Option.some("That change was not made."))
      else done?.()
      setEditing({ _tag: "None" })
      refresh()
    })
  }

  const create = () => {
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (agent === undefined) return
    setFailure(Option.none())
    void runtime.runPromiseExit(Effect.flatMap(ConversationSessions, (sessions) =>
      sessions.create({ ownerId: owner, agentId: agent.id, title: `${agent.name} ${new Date().toLocaleTimeString()}` })))
      .then((exit) => {
        if (exit._tag === "Success") {
          refresh()
          onOpen(exit.value.conversation.id)
        } else {
          setFailure(Option.some("The conversation could not be started."))
        }
      })
  }

  const rename = (id: ConversationId, title: string) =>
    change(Effect.flatMap(ConversationStore, (store) => store.update(id, { title })))
  const archive = (conversation: Conversation.Record) =>
    change(Effect.flatMap(ConversationStore, (store) => store.update(conversation.id, { archived: !conversation.archived })))
  const remove = (id: ConversationId) =>
    change(Effect.flatMap(ConversationStore, (store) => store.remove(id)), () => {
      if (Option.contains(selected, id)) onClosed?.()
    })

  return (
    <nav aria-label="Conversations">
      <div>
        <label>
          Agent{" "}
          <select name="agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>{" "}
        <button type="button" onClick={create} disabled={agentId === ""}>New conversation</button>
      </div>
      <label>
        <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />{" "}
        Show archived
      </label>
      {Option.isSome(failure) ? <p role="alert">{failure.value}</p> : null}
      <ul>
        {conversations.map((conversation) => (
          <li key={conversation.id} aria-current={Option.contains(selected, conversation.id) ? "page" : undefined}>
            {editing._tag === "Renaming" && editing.id === conversation.id
              ? (
                <form
                  aria-label={`Rename ${conversation.title}`}
                  onSubmit={(event) => {
                    event.preventDefault()
                    const title = editing.title.trim()
                    if (title !== "") rename(conversation.id, title)
                  }}
                >
                  <input
                    aria-label="Title"
                    value={editing.title}
                    onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                  />
                  <button type="submit">Save</button>
                  <button type="button" onClick={() => setEditing({ _tag: "None" })}>Cancel</button>
                </form>
              )
              : (
                <>
                  <a
                    href={`#${encodeURIComponent(conversation.id)}`}
                    onClick={(event) => {
                      event.preventDefault()
                      onOpen(conversation.id)
                    }}
                  >
                    {conversation.title}
                  </a>
                  {conversation.archived ? <em> (archived)</em> : null}{" "}
                  <button
                    type="button"
                    aria-label={`Rename ${conversation.title}`}
                    onClick={() => setEditing({ _tag: "Renaming", id: conversation.id, title: conversation.title })}
                  >
                    Rename
                  </button>
                  <button type="button" aria-label={`${conversation.archived ? "Unarchive" : "Archive"} ${conversation.title}`} onClick={() => archive(conversation)}>
                    {conversation.archived ? "Unarchive" : "Archive"}
                  </button>
                  {editing._tag === "Deleting" && editing.id === conversation.id
                    ? (
                      <>
                        <button type="button" aria-label={`Confirm delete ${conversation.title}`} onClick={() => remove(conversation.id)}>
                          Confirm delete
                        </button>
                        <button type="button" onClick={() => setEditing({ _tag: "None" })}>Keep</button>
                      </>
                    )
                    : (
                      <button
                        type="button"
                        aria-label={`Delete ${conversation.title}`}
                        onClick={() => setEditing({ _tag: "Deleting", id: conversation.id })}
                      >
                        Delete
                      </button>
                    )}
                </>
              )}
          </li>
        ))}
      </ul>
    </nav>
  )
}
