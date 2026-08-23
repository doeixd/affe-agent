import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { Headers } from "effect/unstable/http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { Channels } from "../src/channels/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A channel is a thin adapter over the shared AgentSessionHost seam. Tested
 * against a real host (in-process client + scripted model), through the public
 * `deliver`: it authenticates, get-or-creates the session, prompts and replies;
 * a redelivery with the same id is deduped by the host; distinct conversations
 * get distinct sessions; and a bad principal is refused before anything runs.
 */

const Host = AgentSessionHost.Tag<string>("test/Channels/host")

// A host over an in-process client and a scripted model. The principal is the
// `authorization` header; absent, the request is unauthorized. Built with the
// concrete scripted model so its requirements discharge cleanly.
const hostFor = (turns: ReadonlyArray<TestLanguageModel.Turn>) =>
  Effect.map(TestLanguageModel.script(turns), ({ layer: model, recorder }) => ({
    recorder,
    layer: AgentSessionHost.layer(Host, {
      authorization: { authorize: () => Effect.void },
      principal: {
        resolve: ({ headers, operation }) =>
          headers.authorization === undefined
            ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
            : Effect.succeed(headers.authorization)
      },
      maxSessions: 10,
      maxRequestsPerSession: 16
    }).pipe(
      Layer.provide(AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) }))),
      Layer.provide(model)
    )
  }))

const auth = Headers.fromInput({ authorization: "user-a" })
const delivery = (over: Partial<Channels.Delivery>): Channels.Delivery => ({
  conversation: "C1",
  text: "hello",
  deliveryId: "d1",
  headers: auth,
  ...over
})

describe("Channels", () => {
  it.effect("deliver authenticates, runs the agent, and replies with the result", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("the answer")])
      const out = yield* Effect.gen(function* () {
        const replies = yield* Ref.make<ReadonlyArray<{ conversation: string; text: string }>>([])
        const channel = yield* Channels.make({
          host: Host,
          reply: (result, { delivery }) =>
            Ref.update(replies, (all) => [...all, { conversation: delivery.conversation, text: result.text }])
        })
        const result = yield* channel.deliver(delivery({ text: "hi there" }))
        return { result, replies: yield* Ref.get(replies) }
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      assert.strictEqual(out.result.text, "the answer")
      assert.deepStrictEqual(out.replies, [{ conversation: "C1", text: "the answer" }])
    })
  )

  it.effect("a redelivery with the same id is deduped by the host: the agent runs once", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("first"), TestLanguageModel.text("second")])
      const out = yield* Effect.gen(function* () {
        const channel = yield* Channels.make({ host: Host, reply: () => Effect.void })
        const a = yield* channel.deliver(delivery({ deliveryId: "same" }))
        const b = yield* channel.deliver(delivery({ deliveryId: "same" }))
        return { a, b, calls: yield* host.recorder.calls }
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      // Same delivery id -> same request id -> the host joined the first run.
      assert.strictEqual(out.calls, 1)
      assert.strictEqual(out.a.text, "first")
      assert.strictEqual(out.b.text, "first")
    })
  )

  it.effect("distinct conversations get distinct sessions", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("one"), TestLanguageModel.text("two")])
      const calls = yield* Effect.gen(function* () {
        const channel = yield* Channels.make({ host: Host, reply: () => Effect.void })
        yield* channel.deliver(delivery({ conversation: "A", deliveryId: "a1" }))
        yield* channel.deliver(delivery({ conversation: "B", deliveryId: "b1" }))
        return yield* host.recorder.calls
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      // Two conversations -> two sessions -> two runs.
      assert.strictEqual(calls, 2)
    })
  )

  it.effect("a custom session resolver maps deliveries to a chosen session id", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("x"), TestLanguageModel.text("y")])
      const seen = yield* Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        const channel = yield* Channels.make({
          host: Host,
          session: (delivery) => {
            const id = AgentProtocol.SessionId.make(`team:${delivery.conversation}`)
            return Ref.update(seen, (all) => [...all, id]).pipe(Effect.as(id))
          },
          reply: () => Effect.void
        })
        yield* channel.deliver(delivery({ conversation: "A", deliveryId: "a1" }))
        yield* channel.deliver(delivery({ conversation: "B", deliveryId: "b1" }))
        return yield* Ref.get(seen)
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      assert.deepStrictEqual([...seen], ["team:A", "team:B"])
    })
  )

  it.effect("an unauthenticated delivery is refused before the agent runs", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("never")])
      const outcome = yield* Effect.gen(function* () {
        const channel = yield* Channels.make({ host: Host, reply: () => Effect.void })
        const error = yield* Effect.flip(channel.deliver(delivery({ headers: Headers.empty })))
        return { error, calls: yield* host.recorder.calls }
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      assert.strictEqual(outcome.error._tag, "AgentUnauthorizedError")
      assert.strictEqual(outcome.calls, 0)
    })
  )
})
