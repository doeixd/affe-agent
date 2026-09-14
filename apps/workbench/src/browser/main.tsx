/**
 * The W0 page in a browser: conversations kept in localStorage, the agent
 * reached over `AgentHttp` on this origin (the Vite dev server proxies
 * `/sessions` to `npm run workbench:server`).
 */
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type * as Conversation from "../domain/Conversation.js"
import { ConversationId, UserId } from "../domain/WorkbenchIds.js"
import type { AgentId } from "../domain/WorkbenchIds.js"
import { ConversationPage } from "../react/ConversationPage.js"
import * as AgentDirectory from "../runtime/AgentDirectory.js"
import * as ConversationSessions from "../runtime/ConversationSessions.js"
import * as AgentRegistry from "../store/AgentRegistry.js"
import * as ConversationStore from "../store/ConversationStore.js"

const owner = UserId.make("local")

const runtime = ManagedRuntime.make(
  ConversationSessions.layer.pipe(
    Layer.provideMerge(AgentDirectory.http({ baseUrl: window.location.origin })),
    Layer.provideMerge(Layer.mergeAll(ConversationStore.fromStorage(window.localStorage), AgentRegistry.memory)),
    Layer.provide(FetchHttpClient.layer)
  )
)

/**
 * The agent's configuration lives on the server that runs it; this entry
 * only names it, so a new conversation has an agent to record.
 */
const serverAgent = runtime.runPromise(Effect.gen(function*() {
  const registry = yield* AgentRegistry.AgentRegistry
  const { spec } = yield* registry.create({
    ownerId: owner,
    name: "Server agent",
    revision: {
      instructions: "Configured on the server.",
      modelPolicy: { profile: "server" },
      capabilities: [],
      skills: [],
      permission: { recorded: "{\"_tag\":\"AllowAll\"}" },
      maxTurns: 8
    }
  })
  return spec.id
}))

const selectedFromHash = (): Option.Option<ConversationId> => {
  const id = decodeURIComponent(window.location.hash.slice(1))
  return id === "" ? Option.none() : Option.some(ConversationId.make(id))
}

const App = ({ agentId }: { readonly agentId: AgentId }) => {
  const [selected, setSelected] = useState(selectedFromHash)
  const [conversations, setConversations] = useState<ReadonlyArray<Conversation.Record>>([])

  const refresh = () => {
    void runtime.runPromise(
      Effect.gen(function*() {
        const store = yield* ConversationStore.ConversationStore
        return yield* store.list({ ownerId: owner })
      }).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<Conversation.Record>>([])))
    ).then(setConversations)
  }

  useEffect(() => {
    refresh()
    const onHash = () => setSelected(selectedFromHash())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const create = () => {
    void runtime.runPromise(Effect.gen(function*() {
      const sessions = yield* ConversationSessions.ConversationSessions
      const { conversation } = yield* sessions.create({
        ownerId: owner,
        agentId,
        title: `Conversation ${new Date().toLocaleTimeString()}`
      })
      return conversation.id
    })).then((id) => {
      window.location.hash = encodeURIComponent(id)
      refresh()
    })
  }

  return (
    <div style={{ display: "flex", gap: "2rem", fontFamily: "system-ui", padding: "1rem" }}>
      <nav aria-label="Conversations">
        <button type="button" onClick={create}>New conversation</button>
        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <a href={`#${encodeURIComponent(conversation.id)}`}>{conversation.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      {Option.match(selected, {
        onNone: () => <p>Start or pick a conversation.</p>,
        onSome: (id) => <ConversationPage key={id} runtime={runtime} conversationId={id} />
      })}
    </div>
  )
}

const root = document.getElementById("root")
if (root !== null) {
  void serverAgent.then((agentId) => createRoot(root).render(<App agentId={agentId} />))
}
