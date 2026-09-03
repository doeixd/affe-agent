import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import { PersistedQueue } from "effect/unstable/persistence"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import { AgentClient } from "../src/client/index.js"
import * as SessionInbox from "../src/sessions/SessionInbox.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `effect-plan-2.txt` §1–§5. The inbox is where background work reaches a
 * conversation, and the properties worth pinning are the two the plan argues
 * for: a completion observed twice pings once, and a completion never joins a
 * submission that happens to be running.
 */

const item = (overrides: Partial<SessionInbox.Item> = {}): SessionInbox.Item => ({
  id: "process:proc-1:exit",
  sessionId: "s1",
  input: Prompt.make("the build finished"),
  source: { kind: "process", id: "proc-1" },
  createdAt: 0,
  ...overrides
})

/** A client over one scripted agent, plus the in-memory queue store. */
const harness = (turns: ReadonlyArray<Parameters<typeof TestLanguageModel.script>[0][number]>) =>
  Effect.map(TestLanguageModel.script(turns), ({ layer: model }) =>
    Layer.mergeAll(
      AgentClient.layer(Agent.make({})).pipe(Layer.provide(model)),
      PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory))
    ))

describe("SessionInbox", () => {
  it.effect("a completion observed twice pings the session once", () =>
    Effect.gen(function* () {
      // The property the whole design rests on: a producer that can only
      // promise "at least once" -- which is every producer -- must be safe to
      // write. `PersistedQueue.offer` ignores an id already queued, so the
      // second observation of the same exit never becomes a second prompt.
      //
      // Asserted by what comes *next* rather than by waiting for nothing to:
      // enqueue the duplicate and then a different completion, and the second
      // delivery is the different one. If the duplicate had been queued it
      // would be sitting in front of it.
      const layer = yield* harness([
        TestLanguageModel.text("noted"),
        TestLanguageModel.text("noted again")
      ])
      yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        const inbox = yield* SessionInbox.make()
        yield* Effect.scoped(Effect.gen(function* () {
          yield* client.createSession({ sessionId: "s1" })
          yield* client.createSession({ sessionId: "s2" })

          yield* inbox.enqueue(item())
          yield* inbox.enqueue(item())
          yield* inbox.enqueue(item({ id: "monitor:deploy-health:healthy", sessionId: "s2" }))

          const first = yield* inbox.deliver
          const second = yield* inbox.deliver
          assert.deepStrictEqual(
            [
              first._tag === "Some" ? first.value.id : "",
              second._tag === "Some" ? second.value.id : ""
            ],
            ["process:proc-1:exit", "monitor:deploy-health:healthy"],
            "the duplicate was enqueued: it arrived instead of the next completion"
          )
        }))
      }).pipe(Effect.provide(layer))
    }))

  it.effect("waits for a running session rather than joining its submission", () =>
    Effect.gen(function* () {
      // Sec 5's rule, and the reason the module exists. If a completion
      // attached itself to whatever is running, background work would land in
      // an unrelated conversation and *timing* would decide meaning. So while
      // the session is busy the item stays in the queue.
      //
      // The first turn parks on `release`, so the session is genuinely
      // running while the delivery is attempted, and is let go afterwards so
      // the scope closes on a finished conversation rather than an
      // interrupted one.
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = yield* harness([
        { started, during: Deferred.await(release), text: "working" },
        TestLanguageModel.text("noted")
      ])
      yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        const inbox = yield* SessionInbox.make({ maxAttempts: 2 })
        yield* Effect.scoped(Effect.gen(function* () {
          const session = yield* client.createSession({ sessionId: "s1" })
          yield* session.submit("start something long")
          yield* Deferred.await(started)
          assert.strictEqual(yield* session.status, "running")

          yield* inbox.enqueue(item())
          const outcome = yield* Effect.exit(inbox.deliver)
          assert.isTrue(
            outcome._tag === "Failure",
            "the completion was delivered into a running session"
          )

          yield* Deferred.succeed(release, undefined)
        }))
      }).pipe(Effect.provide(layer))
    }))

  it.effect("delivers to an idle session as a new submission", () =>
    Effect.gen(function* () {
      const layer = yield* harness([TestLanguageModel.text("first"), TestLanguageModel.text("noted")])
      yield* Effect.gen(function* () {
        const client = yield* Effect.service(AgentClient.AgentClient)
        const inbox = yield* SessionInbox.make()
        yield* Effect.scoped(Effect.gen(function* () {
          const session = yield* client.createSession({ sessionId: "s1" })
          // A finished conversation, so the ping is demonstrably a *second*
          // submission rather than a continuation of the first.
          const first = yield* session.prompt("hello")
          assert.strictEqual(first.status, "completed")

          yield* inbox.enqueue(item())
          const delivered = yield* inbox.deliver
          assert.isTrue(delivered._tag === "Some")
          assert.strictEqual(
            delivered._tag === "Some" ? delivered.value.id : "",
            "process:proc-1:exit"
          )
        }))
      }).pipe(Effect.provide(layer))
    }))

  it.effect("an unknown session is reported once, not retried ten times", () =>
    Effect.gen(function* () {
      const layer = yield* harness([TestLanguageModel.text("noted")])
      yield* Effect.gen(function* () {
        const inbox = yield* SessionInbox.make({ maxAttempts: 2 })
        yield* inbox.enqueue(item({ sessionId: "never-created" }))
        const outcome = yield* Effect.exit(inbox.deliver)
        assert.isTrue(outcome._tag === "Failure", "delivering to an unknown session succeeded")
      }).pipe(Effect.provide(layer))
    }))
})
