/**
 * The workbench page in a browser (W1): conversations and agents live in the
 * server's product database, reached over `WorkbenchApi`; the agent is reached
 * over `AgentHttp`. Both on this origin -- the Vite dev server proxies them to
 * `npm run workbench:server` -- so a reload continues the same conversation.
 *
 * The bearer token is read from localStorage (`workbench/token`) and defaults
 * to the local server's `local`; who it belongs to is asked of the server. A
 * token the server does not know shows the sign-in form, and a password
 * earns a new one.
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
import * as HttpStores from "../store/http.js"

const readToken = (): string => {
  try {
    return window.localStorage.getItem("workbench/token") ?? "local"
  } catch {
    return "local"
  }
}

const server = { baseUrl: window.location.origin, token: readToken() }

const runtime = ManagedRuntime.make(
  ConversationSessions.layer.pipe(
    Layer.provideMerge(AgentDirectory.http(server)),
    Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore(server), HttpStores.agentRegistry(server))),
    Layer.provideMerge(FetchHttpClient.layer)
  )
)

const selectedFromHash = (): Option.Option<ConversationId> => {
  const id = decodeURIComponent(window.location.hash.slice(1))
  return id === "" ? Option.none() : Option.some(ConversationId.make(id))
}

interface Identity {
  readonly owner: UserId
  readonly agentId: AgentId
}

/** An unreachable server shows an empty list; opening a conversation reports its own failure. */
const listConversations = (owner: UserId) =>
  Effect.gen(function*() {
    const store = yield* ConversationStore.ConversationStore
    return yield* store.list({ ownerId: owner })
  }).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<Conversation.Record>>([])))

const App = ({ agentId, owner }: Identity) => {
  const [selected, setSelected] = useState(selectedFromHash)
  const [conversations, setConversations] = useState<ReadonlyArray<Conversation.Record>>([])

  const refresh = () => {
    void runtime.runPromise(listConversations(owner)).then(setConversations)
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
        <p>
          Signed in as {owner}{" "}
          <button
            type="button"
            onClick={() => {
              // A configured token cannot be ended server-side; forgetting it is enough either way.
              void runtime.runPromise(HttpStores.logout(server)).finally(() => {
                writeToken(null)
                window.location.reload()
              })
            }}
          >
            Sign out
          </button>
        </p>
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

const writeToken = (token: string | null) => {
  try {
    if (token === null) window.localStorage.removeItem("workbench/token")
    else window.localStorage.setItem("workbench/token", token)
  } catch {
    // Nothing to keep it in: the next load asks again.
  }
}

/** Shown when the server does not know this browser's token: a password earns one. */
const Login = () => {
  const [userId, setUserId] = useState("")
  const [password, setPassword] = useState("")
  const [failure, setFailure] = useState<string | null>(null)

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    void runtime.runPromise(HttpStores.login(server, UserId.make(userId), password)).then(
      (issued) => {
        writeToken(issued.token)
        window.location.reload()
      },
      (error: unknown) => setFailure(error instanceof Error ? error.message : String(error))
    )
  }

  return (
    <form onSubmit={submit} style={{ fontFamily: "system-ui", padding: "1rem", display: "grid", gap: "0.5rem", maxWidth: "20rem" }}>
      <h1>Sign in</h1>
      <label>
        User <input name="userId" value={userId} onChange={(event) => setUserId(event.target.value)} autoComplete="username" />
      </label>
      <label>
        Password{" "}
        <input
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
      </label>
      <button type="submit">Sign in</button>
      {failure === null ? null : <p role="alert">That user and password were not accepted.</p>}
    </form>
  )
}

const root = document.getElementById("root")
if (root !== null) {
  void runtime.runPromise(Effect.gen(function*() {
    const owner = yield* HttpStores.currentUser(server)
    const registry = yield* AgentRegistry.AgentRegistry
    const [agent] = yield* registry.list(owner)
    if (agent === undefined) return yield* Effect.die("the server has no agent registered for this person")
    return { owner, agentId: agent.id }
  })).then(
    (identity) => createRoot(root).render(<App {...identity} />),
    () => createRoot(root).render(<Login />)
  )
}
