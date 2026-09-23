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
import type { HttpClient } from "effect/unstable/http"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type * as Conversation from "../domain/Conversation.js"
import type * as InboxStore from "../store/InboxStore.js"
import type * as Task from "../domain/Task.js"
import { AgentId, ConversationId, UserId } from "../domain/WorkbenchIds.js"
import type { TaskId } from "../domain/WorkbenchIds.js"
import { AgentSettingsPage } from "../react/AgentSettingsPage.js"
import { ConversationPage } from "../react/ConversationPage.js"
import { TasksPage } from "../react/TasksPage.js"
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
    Layer.provideMerge(
      Layer.mergeAll(HttpStores.conversationStore(server), HttpStores.agentRegistry(server), HttpStores.catalog(server))
    ),
    Layer.provideMerge(FetchHttpClient.layer)
  )
)

/**
 * The hash is the page: `#<conversation>` opens one, `#agents/new` and
 * `#agents/<id>` are the settings for a new or an existing agent.
 */
type Route =
  | { readonly _tag: "Home" }
  | { readonly _tag: "Tasks" }
  | { readonly _tag: "Conversation"; readonly id: ConversationId }
  | { readonly _tag: "Agent"; readonly id: Option.Option<AgentId> }

const routeFromHash = (): Route => {
  const hash = decodeURIComponent(window.location.hash.slice(1))
  if (hash === "") return { _tag: "Home" }
  if (hash === "tasks") return { _tag: "Tasks" }
  if (hash === "agents/new") return { _tag: "Agent", id: Option.none() }
  if (hash.startsWith("agents/")) return { _tag: "Agent", id: Option.some(AgentId.make(hash.slice("agents/".length))) }
  return { _tag: "Conversation", id: ConversationId.make(hash) }
}

interface Identity {
  readonly owner: UserId
  readonly agentId: AgentId
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>
}

/** The board's server calls, over the page's runtime. */
const overHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.provide(effect, FetchHttpClient.layer)
const taskActions = {
  list: overHttp(HttpStores.tasks(server)),
  attempts: (id: TaskId) =>
    overHttp(Effect.map(HttpStores.task(server, id), (found) =>
      Option.match(found, { onNone: () => [], onSome: ({ attempts }) => attempts }))),
  create: (input: Task.New) => overHttp(HttpStores.createTask(server, input)),
  start: (id: TaskId) => overHttp(HttpStores.startTask(server, id)),
  queue: (id: TaskId) => overHttp(HttpStores.queueTask(server, id)),
  cancel: (id: TaskId) => overHttp(HttpStores.cancelTask(server, id))
}

/** An unreachable server shows an empty list; opening a conversation reports its own failure. */
const listConversations = (owner: UserId) =>
  Effect.gen(function*() {
    const store = yield* ConversationStore.ConversationStore
    return yield* store.list({ ownerId: owner })
  }).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<Conversation.Record>>([])))

/** Polled: the inbox is a read model the page has no stream for yet. */
const inboxPollMillis = 2_000

const App = ({ agentId, agents, owner }: Identity) => {
  const [route, setRoute] = useState(routeFromHash)
  const [conversations, setConversations] = useState<ReadonlyArray<Conversation.Record>>([])
  const [inbox, setInbox] = useState<ReadonlyArray<InboxStore.Item>>([])

  const refresh = () => {
    void runtime.runPromise(listConversations(owner)).then(setConversations)
  }

  useEffect(() => {
    refresh()
    const onHash = () => setRoute(routeFromHash())
    window.addEventListener("hashchange", onHash)
    const poll = () => {
      void runtime.runPromise(HttpStores.inbox(server).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<InboxStore.Item>>([]))))
        .then(setInbox)
    }
    poll()
    const timer = window.setInterval(poll, inboxPollMillis)
    return () => {
      window.removeEventListener("hashchange", onHash)
      window.clearInterval(timer)
    }
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
        <p>
          <a href="#tasks">Tasks</a> · <a href={`#agents/${encodeURIComponent(agentId)}`}>Agent settings</a> ·{" "}
          <a href="#agents/new">New agent</a>
        </p>
        {inbox.length === 0 ? null : (
          <section aria-label="Needs you">
            <h2>Needs you ({inbox.length})</h2>
            <ul>
              {inbox.map((item) => (
                <li key={`${item.sessionId}/${item.id}`}>
                  <a href={`#${encodeURIComponent(item.conversationId)}`}>{item.kind}</a>
                </li>
              ))}
            </ul>
          </section>
        )}
        <button type="button" onClick={create}>New conversation</button>
        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <a href={`#${encodeURIComponent(conversation.id)}`}>{conversation.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      {route._tag === "Home"
        ? <p>Start or pick a conversation.</p>
        : route._tag === "Tasks"
        ? (
          <TasksPage
            actions={taskActions}
            owner={owner}
            agents={agents}
            run={(effect) => runtime.runPromise(effect)}
          />
        )
        : route._tag === "Conversation"
        ? <ConversationPage key={route.id} runtime={runtime} conversationId={route.id} />
        : (
          <AgentSettingsPage
            key={Option.getOrElse(route.id, () => "new")}
            runtime={runtime}
            owner={owner}
            agentId={route.id}
            onSaved={(spec) => {
              window.location.hash = `agents/${encodeURIComponent(spec.id)}`
            }}
          />
        )}
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
  const [refused, setRefused] = useState(false)

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    void runtime.runPromise(HttpStores.login(server, UserId.make(userId), password)).then(
      (issued) => {
        writeToken(issued.token)
        window.location.reload()
      },
      () => setRefused(true)
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
      {refused ? <p role="alert">That user and password were not accepted.</p> : null}
    </form>
  )
}

const root = document.getElementById("root")
if (root !== null) {
  void runtime.runPromise(Effect.gen(function*() {
    const owner = yield* HttpStores.currentUser(server)
    const registry = yield* AgentRegistry.AgentRegistry
    const agents = yield* registry.list(owner)
    const [agent] = agents
    if (agent === undefined) return yield* Effect.die("the server has no agent registered for this person")
    return { owner, agentId: agent.id, agents: agents.map(({ id, name }) => ({ id, name })) }
  })).then(
    (identity) => createRoot(root).render(<App {...identity} />),
    () => createRoot(root).render(<Login />)
  )
}
