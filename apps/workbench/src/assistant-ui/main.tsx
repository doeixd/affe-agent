/**
 * The assistant-ui page (`assistant-ui.html`): one conversation, named by the
 * hash, through the adapter. Its own entry, so the plain page never imports
 * the adapter and deleting this folder deletes the page with it.
 *
 * The same stack the plain page builds -- the server's stores over
 * `WorkbenchApi`, the agent over `AgentHttp` -- with the same token.
 */
import { Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createRoot } from "react-dom/client"
import { ConversationId } from "../domain/WorkbenchIds.js"
import * as AgentDirectory from "../runtime/AgentDirectory.js"
import * as ConversationSessions from "../runtime/ConversationSessions.js"
import * as HttpStores from "../store/http.js"
import { AssistantThread } from "./AssistantThread.js"

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

const root = document.getElementById("root")
if (root !== null) {
  const id = decodeURIComponent(window.location.hash.slice(1))
  createRoot(root).render(
    id === ""
      ? <p>Open a conversation from the workbench, then add its id after <code>#</code> here.</p>
      : <AssistantThread key={id} runtime={runtime} conversationId={ConversationId.make(id)} />
  )
}
