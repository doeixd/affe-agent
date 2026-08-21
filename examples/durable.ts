/**
 * The same agent, interpreted durably — and then addressed across a cluster.
 *
 * This file exists to be type-checked. The README's durable snippets are
 * lifted from here, so a signature change breaks the build rather than
 * quietly leaving the documentation wrong.
 */
import { Duration, Effect, Exit, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, Entity } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as EntityClient from "../src/cluster/EntityClient.js"
import {
  AgentEntity,
  layer as entityLayer
} from "../src/cluster/AgentEntity.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"

const Refund = Tool.make("refund", {
  parameters: Schema.Struct({ orderId: Schema.String }),
  success: Schema.String
})

// An ordinary agent. Nothing here knows about durability.
const support = Effect.gen(function* () {
  const toolkit = yield* Agent.toolkit([Refund], {
    refund: ({ orderId }) => Effect.succeed(`refunded ${orderId}`)
  })
  return Agent.make({ toolkit, loop: AgentLoop.bounded(8) })
})

/** Submit, then collect the result — possibly in a different process. */
export const runDurably = Effect.gen(function* () {
  // `sqlStore` rather than `memoryStore`: out-of-band input has to be visible
  // to whichever node ends up running the submission.
  const store = yield* DurableChannels.sqlStoreWithTable()
  const durable = DurableAgent.workflow("Support", yield* support, { store })

  const executionId = yield* DurableAgent.submit(
    durable,
    store,
    "session-1",
    "refund order 42"
  )

  // Steering is applied at the next turn boundary. It is refused, with a typed
  // `AgentIdleError`, once the submission has reached quiescence.
  yield* DurableAgent.steer(store, "session-1", "be brief").pipe(
    Effect.catchTag("AgentIdleError", () => Effect.void)
  )

  // The process may end here; the submission survives and resumes elsewhere.
  const exit = yield* DurableAgent.result(durable, executionId, {
    interval: Duration.millis(50)
  })

  // A failed submission is still a *completed* workflow, and its failure is
  // typed rather than an opaque defect.
  return Exit.match(exit, {
    onFailure: (cause) => `failed: ${cause}`,
    onSuccess: (text) => text
  })
})

/** The same session, reached from anywhere in a cluster. */
export const runSharded = Effect.gen(function* () {
  const store = yield* DurableChannels.sqlStoreWithTable()
  const durable = DurableAgent.workflow("Support", yield* support, { store })

  const handlers = entityLayer(durable, store).pipe(
    Layer.provideMerge(
      durable.layer.pipe(Layer.provideMerge(ClusterWorkflowEngine.layer))
    )
  )

  // `EntityClient` wraps the generated entity client: it takes `RawInput`, and
  // it keeps the cluster's transport failures out of the error channel, so
  // `steer` fails only with the one error a caller can act on.
  const makeRaw = yield* Entity.makeTestClient(AgentEntity, handlers)
  const client = EntityClient.wrap(yield* makeRaw("session-1"))

  const executionId = yield* client.submit("refund order 42")
  yield* client.steer("be brief").pipe(
    Effect.catchTag("AgentIdleError", () => Effect.void)
  )
  return executionId
})
