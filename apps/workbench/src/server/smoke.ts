/**
 * `npm run smoke:workbench`: the page's transport, end to end over a real socket.
 *
 * Serves the workbench and drives its agent through `AgentHttp.agentClientLayer`
 * on `FetchHttpClient` -- the client the browser page builds -- with the local
 * person's token, inside a conversation the product API recorded, through a
 * tool with progress and an approval answered over HTTP. A failure exits
 * non-zero.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { AgentClient } from "affe-agent/client"
import { UserId } from "../domain/WorkbenchIds.js"
import * as AgentDirectory from "../runtime/AgentDirectory.js"
import * as ConversationSessions from "../runtime/ConversationSessions.js"
import * as AgentRegistry from "../store/AgentRegistry.js"
import * as HttpStores from "../store/http.js"
import { approvedReply, buildReply, serve } from "./app.js"
import { tokens } from "./Authentication.js"

const port = 8797
const page = { baseUrl: `http://localhost:${port}`, token: "local" }
const local = UserId.make("local")

const waitForQuestion = (session: AgentClient.RemoteSession): Effect.Effect<string, AgentClient.RemoteError> =>
  Effect.flatMap(session.pending, (pending) => {
    const [request] = pending
    return request === undefined
      ? Effect.andThen(Effect.sleep("50 millis"), waitForQuestion(session))
      : Effect.succeed(request.id)
  })

const program = Effect.gen(function*() {
  const registry = yield* AgentRegistry.AgentRegistry
  const sessions = yield* ConversationSessions.ConversationSessions
  const [agent] = yield* registry.list(local)
  if (agent === undefined) return yield* Effect.die("the server seeded no agent")
  const { session } = yield* sessions.create({ ownerId: local, agentId: agent.id, title: "Smoke" })

  const built = yield* session.prompt("build it")
  if (built.text !== buildReply) {
    return yield* Effect.die(`expected the build reply, got ${JSON.stringify(built.text)}`)
  }

  const running = yield* Effect.forkChild(session.prompt("clean up"))
  const question = yield* waitForQuestion(session).pipe(Effect.timeout("10 seconds"))
  if (!(yield* session.respond({ id: question, granted: true }))) {
    return yield* Effect.die("the approval found nothing waiting")
  }
  const approved = yield* Fiber.join(running)
  if (approved.text !== approvedReply) {
    return yield* Effect.die(`expected the approved reply, got ${JSON.stringify(approved.text)}`)
  }
  yield* Console.log("smoke: OK")
})

const browser = ConversationSessions.layer.pipe(
  Layer.provideMerge(AgentDirectory.http(page)),
  Layer.provideMerge(Layer.mergeAll(HttpStores.conversationStore(page), HttpStores.agentRegistry(page))),
  Layer.provide(FetchHttpClient.layer)
)

NodeRuntime.runMain(
  Effect.scoped(Effect.gen(function*() {
    yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(tokens({ local: "local" }))))
    yield* Effect.provide(program, browser)
  }))
)
