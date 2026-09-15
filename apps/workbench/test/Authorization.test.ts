/**
 * The host's authorization, as a policy: every operation the protocol can
 * name, against a conversation store, without a server in the way. The
 * end-to-end ownership test covers the routes; this covers the operations no
 * route exposes yet, which is where a fail-open default would hide.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import { Headers } from "effect/unstable/http"
import { AgentProtocol } from "affe-agent/client"
import { AgentId, AgentRevisionId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import { sessionIdOf } from "../src/runtime/ConversationSessions.js"
import { hostOptions } from "../src/server/Authentication.js"
import * as ConversationStore from "../src/store/ConversationStore.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")
const known = new Map([["ada-token", ada], ["grace-token", grace]])

const policy = Effect.gen(function*() {
  const context = yield* Layer.build(ConversationStore.memory)
  const store = Context.get(context, ConversationStore.ConversationStore)
  const adas = yield* store.create({
    id: ConversationId.make("adas"),
    ownerId: ada,
    agentId: AgentId.make("a"),
    agentRevisionId: AgentRevisionId.make("a@1"),
    sessionId: sessionIdOf(ConversationId.make("adas")),
    workspaceId: Option.none(),
    title: "Ada's"
  })
  const options = hostOptions(known, store)
  const decide = (principal: UserId, operation: AgentProtocol.Operation, sessionId?: string) =>
    options.authorization.authorize({
      principal,
      operation,
      sessionId: Option.map(Option.fromNullishOr(sessionId), AgentProtocol.SessionId.make)
    }).pipe(Effect.as("allowed"), Effect.catchTag("AgentForbiddenError", () => Effect.succeed("forbidden")))
  return { options, decide, adasSession: adas.sessionId }
})

describe("workbench host authorization", () => {
  it.effect("an operation addressed to the host, not a session, is refused", () =>
    Effect.scoped(Effect.gen(function*() {
      const { decide } = yield* policy
      assert.strictEqual(yield* decide(grace, "listSessions"), "forbidden")
      assert.strictEqual(yield* decide(grace, "createSession"), "forbidden")
    })))

  it.effect("making a session is the conversation owner's, so no one claims another's session id", () =>
    Effect.scoped(Effect.gen(function*() {
      const { adasSession, decide } = yield* policy
      assert.strictEqual(yield* decide(ada, "createSession", adasSession), "allowed")
      assert.strictEqual(yield* decide(grace, "createSession", adasSession), "forbidden")
      assert.strictEqual(yield* decide(grace, "createSession", "conversation-unrecorded"), "forbidden")
    })))

  it.effect("an operation on a session is the conversation owner's alone", () =>
    Effect.scoped(Effect.gen(function*() {
      const { adasSession, decide } = yield* policy
      for (const operation of ["prompt", "history", "events", "respond", "interrupt", "closeSession"] as const) {
        assert.strictEqual(yield* decide(ada, operation, adasSession), "allowed", `ada ${operation}`)
        assert.strictEqual(yield* decide(grace, operation, adasSession), "forbidden", `grace ${operation}`)
      }
      // A session no conversation names, or one named for a conversation that does not exist.
      assert.strictEqual(yield* decide(ada, "history", "session-1"), "forbidden")
      assert.strictEqual(yield* decide(ada, "history", "conversation-missing"), "forbidden")
    })))

  it.effect("the principal is the token's person, and no token is no one", () =>
    Effect.scoped(Effect.gen(function*() {
      const { options } = yield* policy
      const resolve = (headers: Record<string, string>) =>
        options.principal.resolve({ operation: "history", sessionId: Option.none(), headers: Headers.fromInput(headers) })

      assert.strictEqual(yield* resolve({ authorization: "Bearer grace-token" }), grace)
      for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "grace-token" }]) {
        const refused = yield* Effect.flip(resolve(headers))
        assert.strictEqual(refused._tag, "AgentUnauthorizedError")
      }
    })))
})
