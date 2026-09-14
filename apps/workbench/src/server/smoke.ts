/**
 * `npm run smoke:workbench`: the page's transport, end to end over a real socket.
 *
 * Serves the workbench agent and drives it through `AgentHttp.agentClientLayer`
 * on `FetchHttpClient` -- the client the browser page builds -- through a
 * tool with progress and an approval answered over HTTP. A failure exits
 * non-zero.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AgentClient } from "affe-agent/client"
import { AgentHttp } from "affe-agent/http"
import { approvedReply, buildReply, serve } from "./app.js"

const port = 8797

const waitForQuestion = (session: AgentClient.RemoteSession): Effect.Effect<string, AgentClient.RemoteError> =>
  Effect.flatMap(session.pending, (pending) => {
    const [request] = pending
    return request === undefined
      ? Effect.andThen(Effect.sleep("50 millis"), waitForQuestion(session))
      : Effect.succeed(request.id)
  })

const program = Effect.gen(function*() {
  const agents = yield* AgentClient.AgentClient
  const session = yield* agents.createSession()

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
}).pipe(Effect.scoped)

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(
      Layer.mergeAll(
        AgentHttp.agentClientLayer({ baseUrl: `http://localhost:${port}` }).pipe(Layer.provide(FetchHttpClient.layer)),
        serve({ port, database: ":memory:" })
      )
    )
  )
)
