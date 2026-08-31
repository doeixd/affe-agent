import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { CurrentPrincipal } from "../src/Principal.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `docs/plan-principal-on-tool-fibre.md`, decided 2026-08-31: the
 * acceptance criteria of the decision, pinned.
 *
 * The mechanism under test is deliberately not a kernel change: a
 * submission forks from the caller's fibre, so a `CurrentPrincipal` the
 * host provides around the mutation reaches every tool handler, and the
 * session's captured environment cannot clobber a key it never held. The
 * durable path cannot inherit a fibre, so there the subject rides the
 * persisted claim and payload.
 */

const WhoAmI = Tool.make("who_am_i", {
  parameters: Schema.Struct({}),
  success: Schema.String
})

/** A tool that answers with the subject on its own fibre. */
const whoToolkit = Effect.gen(function*() {
  const seen = yield* Ref.make<ReadonlyArray<string>>([])
  const toolkit = yield* Agent.toolkit([WhoAmI], {
    who_am_i: () =>
      Effect.gen(function*() {
        const principal = yield* CurrentPrincipal
        const answer = Option.getOrElse(principal, () => "nobody")
        yield* Ref.update(seen, (all) => [...all, answer])
        return answer
      })
  })
  return { toolkit, seen }
})

const callTurn = { toolCalls: [{ id: "w1", name: "who_am_i", params: {} }] }

const requestId = Schema.decodeSync(AgentProtocol.RequestId)

describe("CurrentPrincipal", () => {
  it.effect("a bare session's tools read the default: None", () =>
    Effect.gen(function*() {
      const { seen, toolkit } = yield* whoToolkit
      const { layer } = yield* TestLanguageModel.script([
        callTurn,
        { text: "done" }
      ])
      yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(
          Agent.make({ toolkit, loop: AgentLoop.bounded(2) })
        )
        yield* session.prompt("who am I?")
      }).pipe(Effect.provide(layer), Effect.scoped)
      assert.deepStrictEqual(yield* Ref.get(seen), ["nobody"])
    })
  )

  it.effect("the host sets the submitter's subject, and each submission sees its own", () =>
    Effect.gen(function*() {
      const { seen, toolkit } = yield* whoToolkit
      const { layer } = yield* TestLanguageModel.script([
        callTurn,
        { text: "first done" },
        { ...callTurn, toolCalls: [{ ...callTurn.toolCalls[0]!, id: "w2" }] },
        { text: "second done" }
      ])
      const Host = AgentSessionHost.Tag<string>("test/PrincipalHost")
      const hostLayer = AgentSessionHost.layer(Host, {
        principal: {
          resolve: ({ headers }) => Effect.succeed(headers["x-user"] ?? "anonymous")
        },
        subject: (user) => `user:${user}`,
        authorization: AgentSessionHost.allowAll(),
        maxSessions: 4,
        maxRequestsPerSession: 16
      }).pipe(
        Layer.provide(AgentClient.layer(Agent.make({ toolkit, loop: AgentLoop.bounded(2) }))),
        Layer.provideMerge(layer)
      )

      yield* Effect.gen(function*() {
        const host = yield* Host
        const created = yield* host.createSession("alice", {
          requestId: requestId("r-create")
        })
        const sessionId = created.session.sessionId
        // Two principals prompting one hosted session: each submission's
        // tools see the submitter's subject, not the other's.
        yield* host.prompt("alice", {
          requestId: requestId("r-1"),
          sessionId,
          input: Prompt.make("first")
        })
        yield* host.prompt("bob", {
          requestId: requestId("r-2"),
          sessionId,
          input: Prompt.make("second")
        })
      }).pipe(Effect.provide(hostLayer), Effect.scoped)

      assert.deepStrictEqual(yield* Ref.get(seen), ["user:alice", "user:bob"])
    })
  )

  it.live("the durable path persists the subject on the claim and the run reads it", () =>
    Effect.gen(function*() {
      const { seen, toolkit } = yield* whoToolkit
      const store = yield* DurableChannels.memoryStore
      const sessionStore = yield* DurableSessionStore.memoryStore
      const delivery = yield* DeliveryLog.memoryLog
      const { layer: model } = yield* FakeModel.layer([
        { toolCalls: [{ id: "w1", name: "who_am_i", params: {} }] },
        { text: "done" }
      ])
      const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

      const runtime = yield* Layer.build(
        DurableAgentClient.layer(
          "PrincipalDurable",
          Agent.make({ toolkit, loop: AgentLoop.bounded(3) }),
          { store, sessionStore, delivery }
        ).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))
      )

      yield* Effect.service(AgentClient.AgentClient).pipe(
        Effect.flatMap((client) =>
          Effect.scoped(
            Effect.flatMap(client.createSession({ sessionId: "principal-1" }), (session) =>
              // What the host would do: the subject on the fibre that
              // claims. The claim persists it; the engine's fibres inherit
              // nothing, so anything the tool sees came through the store.
              session.prompt("who am I?").pipe(
                Effect.provideService(CurrentPrincipal, Option.some("user:carol"))
              ))
          )),
        Effect.provide(runtime)
      )

      assert.deepStrictEqual(yield* Ref.get(seen), ["user:carol"])
    })
  )
})
