/**
 * Execution strength is a Layer choice; transport is a different Layer choice.
 * Neither leaks into the agent, and neither leaks into the program.
 *
 * This file exists to be type-checked. The README's durable-client snippets
 * are lifted from here, so a signature change breaks the build rather than
 * quietly leaving the documentation wrong.
 */
import { Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import {
  DeliveryLog,
  DurableAgentClient,
  DurableChannels,
  DurableSessionStore
} from "../src/durable/index.js"

const Refund = Tool.make("refund", {
  parameters: Schema.Struct({ orderId: Schema.String }),
  success: Schema.String
}).setNeedsApproval(true)

// An ordinary agent. Nothing here knows whether it runs locally or durably.
const Support = Agent.make({
  instructions: "Handle refunds carefully.",
  toolkit: Agent.toolkit([Refund], {
    refund: ({ orderId }) => Effect.succeed(`refunded ${orderId}`)
  }),
  loop: AgentLoop.bounded(8)
})

// The program speaks only `AgentClient`. It is byte-for-byte the same under
// both layers below.
export const program = Effect.gen(function* () {
  const client = yield* AgentClient.AgentClient
  const session = yield* client.createSession({ sessionId: "customer-123" })
  return yield* session.prompt("Investigate this refund")
})

/** Local: the agent runs in this process, for the caller's scope. */
export const local = program.pipe(
  Effect.scoped,
  Effect.provide(AgentClient.layer(Support))
)

/** Durable: the same program over a workflow engine and shared SQL stores. */
export const durable = Effect.gen(function* () {
  // Every process that serves this agent builds the same layer over the same
  // database. The stores are what the processes have in common; the engine
  // is what executes; the client is the ordinary `AgentClient` service.
  const store = yield* DurableChannels.sqlStoreWithTable()
  const sessionStore = yield* DurableSessionStore.sqlStoreWithTables()
  const delivery = yield* DeliveryLog.sqlLogWithTable()

  const DurableSupport = DurableAgentClient.layer("Support", Support, {
    store,
    sessionStore,
    delivery
  }).pipe(Layer.provide(ClusterWorkflowEngine.layer))

  return yield* program.pipe(Effect.scoped, Effect.provide(DurableSupport))
})

/**
 * Three clients, one logical session.
 *
 * A web request starts the work; the browser closes. Minutes later the agent
 * asks whether to refund $480, and a Slack integration — a different process
 * with a different `AgentClient` instance — answers. An admin CLI queues a
 * follow-up. None of them hold a fiber; all of them address the session by id.
 */
export const threeClients = Effect.gen(function* () {
  const client = yield* AgentClient.AgentClient

  // Web: start the work, then go away. The handle's scope closing ends the
  // handle, never the durable session.
  yield* Effect.scoped(
    Effect.flatMap(client.createSession({ sessionId: "customer-123" }), (web) =>
      Effect.forkDetach(web.prompt("Investigate this refund"))
    )
  )

  // Slack: reacquire the session and answer whatever it is waiting on.
  const slack = yield* client.session("customer-123")
  for (const request of yield* slack.pending) {
    yield* slack.respond({ id: request.id, granted: true })
  }

  // CLI: extend the running submission from a third place.
  const cli = yield* client.session("customer-123")
  yield* cli.followUp("Also check the previous order")

  return yield* cli.status
})
