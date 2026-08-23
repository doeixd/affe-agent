import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Ref, Schema } from "effect"
import { Headers, HttpIncomingMessage, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
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

  it.effect("the custom session resolver's returned id actually routes the run", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("first"), TestLanguageModel.text("second")])
      const prompts = yield* Effect.gen(function* () {
        // Two distinct conversations mapped to ONE session id: only if the
        // returned id is threaded through does the second run share the first's
        // history. (Under the default resolver these would be two sessions.)
        const channel = yield* Channels.make({
          host: Host,
          session: () => Effect.succeed(AgentProtocol.SessionId.make("shared")),
          reply: () => Effect.void
        })
        yield* channel.deliver(delivery({ conversation: "A", deliveryId: "a1", text: "hello from A" }))
        yield* channel.deliver(delivery({ conversation: "B", deliveryId: "b1", text: "hello from B" }))
        return yield* host.recorder.prompts
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      assert.strictEqual(prompts.length, 2)
      // The second model call saw the first exchange -> both ran on one session.
      assert.include(TestLanguageModel.userTexts(prompts[1]!), "hello from A")
    })
  )

  it.effect("a failing reply is surfaced by deliver, not swallowed", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("answer")])
      const error = yield* Effect.gen(function* () {
        const channel = yield* Channels.make({
          host: Host,
          reply: () => Effect.fail("platform post failed" as const)
        })
        return yield* Effect.flip(channel.deliver(delivery({})))
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      assert.strictEqual(error, "platform post failed")
    })
  )

  it.effect("the same delivery id with different text is a surfaced conflict, not a silent drop", () =>
    Effect.gen(function* () {
      const host = yield* hostFor([TestLanguageModel.text("first"), TestLanguageModel.text("second")])
      const out = yield* Effect.gen(function* () {
        const channel = yield* Channels.make({ host: Host, reply: () => Effect.void })
        const first = yield* channel.deliver(delivery({ deliveryId: "dup", text: "one" }))
        const conflict = yield* Effect.flip(channel.deliver(delivery({ deliveryId: "dup", text: "two" })))
        return { first, conflict }
      }).pipe(Effect.provide(host.layer), Effect.scoped)

      assert.strictEqual(out.first.text, "first")
      assert.strictEqual(out.conflict._tag, "AgentRequestConflictError")
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

describe("Channels.serverLayer", () => {
  const Body = Schema.Struct({
    kind: Schema.String,
    conversation: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    deliveryId: Schema.optional(Schema.String),
    challenge: Schema.optional(Schema.String)
  })

  it.effect("acks 200 fast, answers a challenge, ignores, and the forked delivery still runs and replies", () =>
    Effect.gen(function* () {
      // The reply resolves this once the backgrounded run finishes -- the proof
      // that the delivery survives the 200 ack (the fork lives in the layer
      // scope, not the request scope that closes when the response flushes).
      const replied = yield* Deferred.make<string>()
      const { layer: model } = yield* TestLanguageModel.script([TestLanguageModel.text("served answer")])
      const host = AgentSessionHost.layer(Host, {
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

      const app = Channels.serverLayer({
        host: Host,
        path: "/hook",
        decode: (request) =>
          HttpIncomingMessage.schemaBodyJson(Body)(request).pipe(
            Effect.map((body) =>
              body.kind === "challenge" && body.challenge !== undefined
                ? Channels.respondWith(HttpServerResponse.text(body.challenge))
                : body.kind === "ignore"
                ? Channels.ignored
                : Channels.delivered({
                  conversation: body.conversation ?? "C",
                  text: body.text ?? "",
                  deliveryId: body.deliveryId ?? "d",
                  headers: request.headers
                }))
          ),
        reply: (result) => Deferred.succeed(replied, result.text).pipe(Effect.asVoid)
      }).pipe(Layer.provide(host))

      const built = yield* Layer.build(
        HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true }))
        )
      )
      const address = HttpServer.formatAddress(
        (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(built))).address
      )
      const post = (payload: unknown) =>
        Effect.promise(() =>
          fetch(`${address}/hook`, {
            method: "POST",
            headers: { authorization: "user-a", "content-type": "application/json" },
            body: JSON.stringify(payload)
          }))

      // A challenge is answered directly.
      const challenge = yield* post({ kind: "challenge", challenge: "verify-me" })
      assert.strictEqual(yield* Effect.promise(() => challenge.text()), "verify-me")
      // An ignored event acks 200 and does nothing.
      assert.strictEqual((yield* post({ kind: "ignore" })).status, 200)
      // A real delivery acks 200 immediately...
      assert.strictEqual((yield* post({ kind: "deliver", conversation: "C1", text: "hi", deliveryId: "d1" })).status, 200)
      // ...and the backgrounded run completes and replies (None here would mean
      // the fork was interrupted at the ack -- the bug this guards against).
      const answered = yield* Deferred.await(replied).pipe(Effect.timeoutOption("3 seconds"))
      assert.deepStrictEqual(answered, Option.some("served answer"))
    }).pipe(Effect.scoped)
  )
})
