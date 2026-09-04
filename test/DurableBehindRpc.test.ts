import { Effect, Layer } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { AgentSessionHost } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { AgentRpc } from "../src/rpc/index.js"
import * as FakeModel from "./FakeModel.js"
import * as Contract from "./AgentClientContract.js"

/**
 * A durable agent *behind* a wire.
 *
 * The contract already runs against the durable client, and against RPC and
 * the relay. In every one of those the other half is in-process: the durable
 * rows talk to a workflow engine with no transport, and the transport rows
 * talk to an `AgentClient.layer` with no journal. This composition -- the
 * arrangement an actual deployment has, a durable host reached over a wire --
 * was tested nowhere, which is the shape of every real bug found today.
 *
 * There are specific reasons to expect trouble rather than a formality. A
 * durable prompt can outlast a request; `events` resumption is answered from a
 * delivery log at one end and asked for through a stream request at the other;
 * settled outcomes come from the journal rather than a bounded table, so the
 * retention rows mean something different; and the values that now cross --
 * a declared output, a typed input -- are encoded by the journal and decoded
 * by the caller with a transport in between.
 */

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const harness: Contract.Harness = {
  name: "durable-behind-rpc",
  // The journal keeps every outcome, as it does when the durable client is
  // reached directly; nothing about a wire changes that.
  outcomeRetention: "journal",
  // And the delivery log is still what answers a cursor, through the RPC
  // adapter, which passes `after` to the host rather than refusing it.
  resumesEvents: true,
  layer: ({ agent, turns, elicitation, maxRetainedSubmissions }) =>
    Effect.gen(function* () {
      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const { layer: model } = yield* FakeModel.script(turns)

      // The host's backing is the durable client, not an in-process session.
      const durable = DurableAgentClient.layer("DurableBehindRpc", agent, {
        store,
        sessionStore,
        delivery,
        ...(elicitation ? { elicitation } : {}),
        ...(maxRetainedSubmissions === undefined ? {} : { maxRetainedSubmissions })
      }).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))

      const Host = AgentSessionHost.Tag<string>(
        `test/DurableBehindRpc/${globalThis.crypto.randomUUID()}`
      )
      const host = AgentSessionHost.layer(Host, {
        principal: { resolve: () => Effect.succeed("durable-behind-rpc") },
        authorization: AgentSessionHost.allowAll(),
        maxSessions: 32,
        maxRequestsPerSession: 256
      }).pipe(Layer.provide(durable))

      const client = Layer.effect(AgentRpc.Client, RpcTest.makeClient(AgentRpc.Protocol)).pipe(
        Layer.provide(AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host)))
      )
      return AgentRpc.agentClientLayer().pipe(Layer.provide(client))
    })
}

Contract.run(harness)
