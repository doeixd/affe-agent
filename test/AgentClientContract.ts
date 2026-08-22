import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schedule, Schema, Stream } from "effect"
import { Duration } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import type { AgentDefinition } from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentClient } from "../src/client/index.js"
import * as Elicitation from "../src/Elicitation.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The behaviour every `AgentClient` implementation is expected to have.
 *
 * Every test runs on the live clock: the durable interpreter drives a real
 * workflow engine, whose shard and poll timers do not advance under the test
 * clock, and nothing here depends on time — synchronisation is by `Deferred`.
 *
 * The client seam exists so an application writes the same code whether its
 * agent runs in this process or behind some interpreter — durable workflow,
 * cluster entity, transport. A second implementation that passes its own
 * hand-written tests but fails these is not a weaker sibling; it is a
 * different, undocumented contract.
 *
 * Tests here use only the client surface — no `AgentSession` — which is the
 * discipline the seam enforces. Implementation-specific tests stay in each
 * implementation's own file.
 */

export interface Harness {
  /** Shown in test names, so a failure names the interpreter that broke. */
  readonly name: string
  /**
   * Build a client layer over `agent`, driven by a scripted model.
   *
   * Each invocation must produce independent wiring — fresh sessions, fresh
   * state — because every contract test calls it afresh.
   */
  readonly layer: (options: {
    readonly agent: AgentDefinition<any, any, never>
    readonly turns: ReadonlyArray<TestLanguageModel.Turn>
    /** Where a paused run waits for an answer. Default: refuse everything. */
    readonly elicitation?: Elicitation.Factory | undefined
  }) => Effect.Effect<Layer.Layer<AgentClient.AgentClient>>
}

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const Boom = Tool.make("boom", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Schema.String
})

/** Runs `use` with a client built by `harness` over `agent` and `turns`. */
const withClient = <A, E>(
  harness: Harness,
  options: {
    readonly agent: AgentDefinition<any, any, never>
    readonly turns: ReadonlyArray<TestLanguageModel.Turn>
    readonly elicitation?: Elicitation.Factory | undefined
  },
  use: (client: AgentClient.Service) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.flatMap(harness.layer(options), (layer) =>
    Effect.flatMap(Effect.service(AgentClient.AgentClient), use).pipe(
      Effect.provide(layer)
    )
  )

export const run = (harness: Harness): void => {
  describe(`AgentClient contract (${harness.name})`, () => {
    it.live("opens a session and reaches it again by id", () =>
      withClient(
        harness,
        {
          agent: Agent.make({ loop: AgentLoop.bounded(4) }),
          turns: [TestLanguageModel.text("done")]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession({
                sessionId: "contract-1"
              })
              assert.strictEqual(session.id, "contract-1")

              yield* session.prompt("go")

              // Reachable by id while open, and it is the same conversation.
              const again = yield* client.session("contract-1")
              assert.strictEqual(again.id, session.id)
            })
          )
      )
    )

    it.live("runs a tool-calling prompt and exposes observations", () =>
      withClient(
        harness,
        {
          agent: Agent.make({
            toolkit: Agent.toolkit([Search], {
              search: ({ query }) => Effect.succeed(`hits for ${query}`)
            }),
            loop: AgentLoop.bounded(4)
          }),
          turns: [
            TestLanguageModel.toolCall("search", { query: "effect" }),
            TestLanguageModel.text("found it")
          ]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()

              const result = yield* session.prompt("find effect")
              assert.strictEqual(result.text, "found it")
              assert.strictEqual(result.status, "completed")
              assert.strictEqual(result.runs, 1)

              assert.deepStrictEqual(
                (yield* session.history).content.map((m) => m.role),
                ["user", "assistant", "tool", "assistant"]
              )
              assert.strictEqual(yield* session.status, "idle")
            })
          )
      )
    )

    it.live("a sequential prompt continues the same conversation", () =>
      withClient(
        harness,
        {
          agent: Agent.make({ loop: AgentLoop.bounded(4) }),
          turns: [
            TestLanguageModel.text("first"),
            TestLanguageModel.text("second")
          ]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()
              yield* session.prompt("remember this")

              const result = yield* session.prompt("what did I say?")
              assert.strictEqual(result.text, "second")
              assert.deepStrictEqual(
                (yield* session.history).content.map((m) => m.role),
                ["user", "assistant", "user", "assistant"]
              )
            })
          )
      )
    )

    it.live("rejects a concurrent prompt with AgentBusyError", () =>
      withClient(
        harness,
        {
          agent: Agent.make({ loop: AgentLoop.bounded(4) }),
          turns: [{ text: "slow", hang: true }]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()
              const running = yield* Effect.forkChild(session.prompt("go"))
              // Let the fork claim the session before racing it.
              yield* Effect.yieldNow
              yield* Effect.yieldNow

              const busy = yield* Effect.flip(session.prompt("again"))
              assert.strictEqual(busy._tag, "AgentBusyError")

              yield* Fiber.interrupt(running)
            })
          )
      )
    )

    it.live("steer offered mid-run is applied at the turn boundary", () =>
      Effect.gen(function* () {
        // Held open until the test has queued its steering, so the timing is
        // deterministic rather than raced: the model call is genuinely in
        // flight when `steer` lands.
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        yield* withClient(
          harness,
          {
            agent: Agent.make({
              toolkit: Agent.toolkit([Search], {
                search: ({ query }) => Effect.succeed(`hits for ${query}`)
              }),
              loop: AgentLoop.bounded(4)
            }),
            turns: [
              {
                toolCalls: [{ id: "s1", name: "search", params: { query: "a" } }],
                started: entered,
                during: Deferred.await(release)
              },
              TestLanguageModel.text("second")
            ]
          },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const running = yield* Effect.forkChild(session.prompt("go"))
                yield* Deferred.await(entered)
                yield* session.steer("go left")
                yield* Deferred.succeed(release, void 0)

                const result = yield* Fiber.join(running)
                // The turn already under way finishes untouched; the steering
                // is folded in at the next boundary and drives another turn.
                assert.strictEqual(result.turns, 2)
                assert.deepStrictEqual(
                  TestLanguageModel.userTexts(yield* session.history),
                  ["go", "go left"]
                )
              })
            )
        )
      })
    )

    it.live("follow-up offered mid-run becomes a second run", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        yield* withClient(
          harness,
          {
            agent: Agent.make({ loop: AgentLoop.bounded(4) }),
            turns: [
              { text: "first", started: entered, during: Deferred.await(release) },
              TestLanguageModel.text("second")
            ]
          },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const running = yield* Effect.forkChild(session.prompt("go"))
                yield* Deferred.await(entered)
                yield* session.followUp("do this too")
                yield* Deferred.succeed(release, void 0)

                // `prompt` resolves at quiescence, which includes the
                // follow-up's run.
                const result = yield* Fiber.join(running)
                assert.strictEqual(result.runs, 2)
                assert.strictEqual(result.text, "second")
              })
            )
        )
      })
    )

    it.live("rejects steer and follow-up on an idle session", () =>
      withClient(
        harness,
        {
          agent: Agent.make({}),
          turns: []
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()

              const steered = yield* Effect.flip(session.steer("x"))
              assert.strictEqual(steered._tag, "AgentIdleError")
              const followed = yield* Effect.flip(session.followUp("y"))
              assert.strictEqual(followed._tag, "AgentIdleError")
            })
          )
      )
    )

    it.live("interrupt ends the submission and leaves the session reusable", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()

        yield* withClient(
          harness,
          {
            agent: Agent.make({ loop: AgentLoop.bounded(4) }),
            turns: [{ text: "unused", hang: true, started: entered }, TestLanguageModel.text("after")]
          },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const running = yield* Effect.forkChild(session.prompt("go"))
                yield* Deferred.await(entered)
                yield* session.interrupt()

                const result = yield* Fiber.join(running)
                assert.strictEqual(result.status, "interrupted")

                // Interruption is terminal for the submission, not the
                // session.
                assert.strictEqual(yield* session.status, "idle")
                const next = yield* session.prompt("try again")
                assert.strictEqual(next.text, "after")
              })
            )
        )
      })
    )

    it.live("describes an agent failure instead of hiding it", () =>
      withClient(
        harness,
        {
          agent: Agent.make({
            toolkit: Agent.toolkit([Boom], {
              boom: () => Effect.fail("declined")
            }),
            toolFailurePolicy: ToolExecution.FailRun,
            loop: AgentLoop.bounded(2)
          }),
          turns: [
            TestLanguageModel.toolCall("boom", {}, { id: "b1" }),
            { text: "unused", hang: true }
          ]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()

              const described = yield* Effect.flip(session.prompt("go"))
              // An execution failure, not a transport one. An agent failure is
              // a property of the request and will recur; wearing the transport
              // tag would turn a caller's retry policy into a loop.
              assert.strictEqual(described._tag, "AgentExecutionError")
              if (described._tag === "AgentExecutionError") {
                // The tool's own reason survives, even though its type did not.
                assert.include(described.detail, "declined")
              }

              // And the failed submission did not wedge the session.
              assert.strictEqual(yield* session.status, "idle")
            })
          )
      )
    )

    it.live("unpauses a run waiting on an answer", () =>
      withClient(
        harness,
        {
          agent: Agent.make({
            toolkit: Agent.toolkit([Dangerous], {
              wipe: () => Effect.succeed("wiped")
            }),
            loop: AgentLoop.bounded(4)
          }),
          turns: [
            { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
            TestLanguageModel.text("done")
          ],
          elicitation: Elicitation.memory
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()
              const running = yield* Effect.forkChild(session.prompt("go"))

              // Poll the remote surface rather than reaching for anything
              // underneath: a transport has nothing else.
              const request = yield* Effect.retry(
                Effect.flatMap(session.pending, (waiting) =>
                  waiting.length > 0
                    ? Effect.succeed(waiting[0]!)
                    : Effect.fail("none" as const)
                ),
                { times: 200, schedule: Schedule.spaced(Duration.millis(5)) }
              )

              assert.strictEqual(request.kind, "tool-approval")
              assert.isTrue(yield* session.respond({ id: request.id, granted: true }))
              const result = yield* Fiber.join(running)
              assert.strictEqual(result.text, "done")
            })
          )
      )
    )

    it.live("streams deltas when asked, and not otherwise", () =>
      Effect.gen(function* () {
        const streamed = yield* deltasFor(harness, true)
        const batched = yield* deltasFor(harness, false)
        assert.strictEqual(streamed.join(""), "streamed")
        assert.isTrue(streamed.length > 0)
        assert.deepStrictEqual(batched, [])
      })
    )

    it.live("emits lifecycle events in order", () =>
      withClient(
        harness,
        {
          agent: Agent.make({ loop: AgentLoop.bounded(4) }),
          turns: [TestLanguageModel.text("done")]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()

              const collected = yield* Effect.forkChild(
                Stream.runCollect(Stream.take(session.events, 3))
              )
              yield* Effect.yieldNow
              yield* session.prompt("go")
              const events = yield* Fiber.join(collected)

              assert.deepStrictEqual(
                events.map((entry) => entry.event._tag),
                ["SubmissionStarted", "RunStarted", "TurnStarted"]
              )
            })
          )
      )
    )
  })
}

const Dangerous = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

/** Deltas observed through `events` for one prompt, asked-streaming or not. */
const deltasFor = (
  harness: Harness,
  stream: boolean
): Effect.Effect<Array<string>, AgentClient.RemoteError> =>
  withClient(
    harness,
    {
      agent: Agent.make({ loop: AgentLoop.bounded(4) }),
      turns: [{ text: "streamed", chunks: ["str", "eamed"] }]
    },
    (client) =>
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* client.createSession()
          const seen = yield* Ref.make<Array<string>>([])
          const watcher = yield* Effect.forkChild(
            Stream.runForEach(session.events, (entry) =>
              AgentEvent.is("MessageDelta")(entry)
                ? Ref.update(seen, (all) => [...all, entry.event.delta])
                : Effect.void
            )
          )
          yield* Effect.yieldNow
          yield* session.prompt("go", stream ? { stream: true } : {})
          yield* Fiber.interrupt(watcher)
          return yield* Ref.get(seen)
        })
      )
  )

/**
 * Deltas are asserted joined, not chunk-by-chunk: how finely a provider's
 * stream is cut is a property of the provider connection, and the durable
 * interpreter legitimately delivers them whole. What the contract owes every
 * caller is that streamed generation reaches `events` intact.
 */