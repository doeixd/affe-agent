import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schedule, Schema, Stream } from "effect"
import { Duration } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import type { AgentDefinition } from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentBusyError, AgentClosedError, AgentIdleError } from "../src/Errors.js"
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
    /** For the retention cases: how many outcomes a session keeps. */
    readonly maxRetainedSubmissions?: number | undefined
  }) => Effect.Effect<Layer.Layer<AgentClient.AgentClient>>
  /**
   * `false` when this transport cannot deliver `MessageDelta` to an observer
   * that subscribed one `yieldNow` before `prompt` — HTTP SSE needs the GET
   * to finish connecting, which that latch does not wait for. The rest of
   * the contract still runs.
   */
  readonly observesStreamDeltas?: boolean | undefined
  /**
   * Where settled outcomes live. `bounded` is the in-process table with the
   * eviction rule; `journal` is the durable engine, which keeps every
   * outcome. The eviction case runs only against `bounded`.
   */
  readonly outcomeRetention?: "bounded" | "journal" | undefined
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
    /** For the retention cases: how many outcomes a session keeps. */
    readonly maxRetainedSubmissions?: number | undefined
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

    it.live("the result carries the final message as prompt parts, files included", () =>
      withClient(
        harness,
        {
          agent: Agent.make({ loop: AgentLoop.bounded(2) }),
          turns: [
            {
              text: "here you go",
              files: [{ mediaType: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }]
            }
          ]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* client.createSession()
              const result = yield* session.prompt("draw it")
              assert.strictEqual(result.text, "here you go")
              // Text and file, in order, and the file crossed the transport
              // as bytes -- the wire codec's job, and the same answer from
              // every transport.
              assert.deepStrictEqual(result.content.map((part) => part.type), ["text", "file"])
              const file = result.content[1]
              if (file?.type === "file") {
                assert.strictEqual(file.mediaType, "image/png")
                assert.isTrue(file.data instanceof Uint8Array)
                assert.deepStrictEqual(
                  Array.from(file.data instanceof Uint8Array ? file.data : []),
                  [0x89, 0x50, 0x4e, 0x47]
                )
              } else {
                assert.fail("expected a file part")
              }
            })
          )
      )
    )

    describe("submit and awaitSubmission", () => {
      /** A model held at a gate, so a submission is observably in flight. */
      const gated = Effect.map(Deferred.make<void>(), (gate) => ({
        gate,
        turns: [{ text: "done", during: Deferred.await(gate) }] as const
      }))

      it.live("submit returns at admission; awaitSubmission returns what prompt would, and again", () =>
        Effect.gen(function* () {
          const { gate, turns } = yield* gated
          yield* withClient(
            harness,
            { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns },
            (client) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* client.createSession()
                  const receipt = yield* session.submit("go")
                  // Admitted, not finished: the model is still at the gate.
                  assert.strictEqual(yield* session.status, "running")
                  yield* Deferred.succeed(gate, void 0)
                  const result = yield* session.awaitSubmission(receipt.submissionId)
                  assert.strictEqual(result.submissionId, receipt.submissionId)
                  assert.strictEqual(result.text, "done")
                  assert.strictEqual(result.status, "completed")
                  assert.strictEqual((yield* session.history).content.length, 2)
                  // Retained: the same outcome again, and no second run.
                  const again = yield* session.awaitSubmission(receipt.submissionId)
                  assert.deepStrictEqual(again, result)
                  assert.strictEqual((yield* session.history).content.length, 2)
                })
              )
          )
        })
      )

      it.live("the same idempotency key and input is the same submission; a different input is a conflict", () =>
        Effect.gen(function* () {
          const { gate, turns } = yield* gated
          yield* withClient(
            harness,
            { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns },
            (client) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* client.createSession()
                  const first = yield* session.submit("go", { idempotencyKey: "k1" })
                  const retry = yield* session.submit("go", { idempotencyKey: "k1" })
                  assert.strictEqual(retry.submissionId, first.submissionId)
                  const conflict = yield* Effect.flip(session.submit("something else", { idempotencyKey: "k1" }))
                  assert.strictEqual(conflict._tag, "AgentRequestConflictError")
                  yield* Deferred.succeed(gate, void 0)
                  yield* session.awaitSubmission(first.submissionId)
                  // One execution: one exchange in history.
                  assert.strictEqual((yield* session.history).content.length, 2)
                })
              )
          )
        })
      )

      it.live("awaitSubmission on a submission the session never made is not-found", () =>
        withClient(
          harness,
          { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns: [TestLanguageModel.text("done")] },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const error = yield* Effect.flip(session.awaitSubmission("never-submitted"))
                assert.strictEqual(error._tag, "AgentSubmissionNotFoundError")
              })
            )
        )
      )

      it.live("an interrupted submission's outcome is retained as interrupted", () =>
        Effect.gen(function* () {
          const { turns } = yield* gated
          yield* withClient(
            harness,
            { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns },
            (client) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* client.createSession()
                  const receipt = yield* session.submit("go")
                  yield* session.interrupt()
                  const result = yield* session.awaitSubmission(receipt.submissionId)
                  assert.strictEqual(result.status, "interrupted")
                  assert.strictEqual((yield* session.awaitSubmission(receipt.submissionId)).status, "interrupted")
                })
              )
          )
        })
      )

      it.live("a failed submission's outcome is the typed failure, retained", () =>
        withClient(
          harness,
          { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns: [{ fail: "provider down" }] },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const receipt = yield* session.submit("go")
                const first = yield* Effect.flip(session.awaitSubmission(receipt.submissionId))
                assert.strictEqual(first._tag, "AgentExecutionError")
                const second = yield* Effect.flip(session.awaitSubmission(receipt.submissionId))
                assert.strictEqual(second._tag, "AgentExecutionError")
              })
            )
        )
      )

      if ((harness.outcomeRetention ?? "bounded") === "bounded") {
        it.live("an outcome is evicted only after enough newer submissions settle, and is then not-found rather than re-run", () =>
          withClient(
            harness,
            {
              agent: Agent.make({ loop: AgentLoop.bounded(1) }),
              turns: [TestLanguageModel.text("one"), TestLanguageModel.text("two"), TestLanguageModel.text("three")],
              maxRetainedSubmissions: 2
            },
            (client) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* client.createSession()
                  const first = yield* session.submit("a")
                  yield* session.awaitSubmission(first.submissionId)
                  // One newer settled submission: still retained.
                  yield* session.prompt("b")
                  assert.strictEqual((yield* session.awaitSubmission(first.submissionId)).text, "one")
                  // Two newer: the slot is needed, and the oldest goes.
                  yield* session.prompt("c")
                  const gone = yield* Effect.flip(session.awaitSubmission(first.submissionId))
                  assert.strictEqual(gone._tag, "AgentSubmissionNotFoundError")
                  // Nothing re-ran: three exchanges, no more.
                  assert.strictEqual((yield* session.history).content.length, 6)
                })
              )
          )
        )
      } else {
        it.live("the journal keeps every outcome: an early submission is still there after many newer ones", () =>
          withClient(
            harness,
            {
              agent: Agent.make({ loop: AgentLoop.bounded(1) }),
              turns: [TestLanguageModel.text("one"), TestLanguageModel.text("two"), TestLanguageModel.text("three")]
            },
            (client) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* client.createSession()
                  const first = yield* session.submit("a")
                  yield* session.awaitSubmission(first.submissionId)
                  yield* session.prompt("b")
                  yield* session.prompt("c")
                  assert.strictEqual((yield* session.awaitSubmission(first.submissionId)).text, "one")
                })
              )
          )
        )
      }
    })

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

    if (harness.observesStreamDeltas !== false) {
      it.live("streams deltas when asked, and not otherwise", () =>
        Effect.gen(function* () {
          const streamed = yield* deltasFor(harness, true)
          const batched = yield* deltasFor(harness, false)
          assert.strictEqual(streamed.join(""), "streamed")
          assert.isTrue(streamed.length > 0)
          assert.deepStrictEqual(batched, [])
        })
      )
    }

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
                Stream.runCollect(Stream.take(session.events(), 3))
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
            Stream.runForEach(session.events(), (entry) =>
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
/**
 * The second contract: every protocol failure arrives as itself.
 *
 * `AgentClient.RemoteError` names fifteen errors and the HTTP `Api` declares
 * all fifteen, but the HTTP client used to decode six of them and fold the
 * rest into `AgentTransportError` -- the one tag whose documented meaning is
 * "retrying is reasonable". A caller with an ordinary retry policy therefore
 * retried a 403 for as long as it was willing to keep asking, and the contract
 * above could not see it, because it only ever provokes the six.
 *
 * RPC never collapsed anything: it exposes the protocol group's own error
 * union. So this exists to hold the two transports to the same answer rather
 * than to test one of them, and it is written against a host that fails on
 * purpose -- capacity, conflict and codec failures are otherwise reachable
 * only by arranging the exact internal state that produces them.
 */
export interface ProtocolErrorHarness {
  /** Shown in test names, so a failure names the transport that broke. */
  readonly name: string
  /**
   * Ask a host that always fails with `error` for a session, and report what
   * the client saw.
   *
   * `getSession` rather than `prompt` because it is one round trip and needs
   * no live session -- the question here is what the *transport* does with a
   * failure, not which operation produced it.
   */
  readonly failure: (
    error: AgentProtocol.RemoteError
  ) => Effect.Effect<AgentProtocol.RemoteError>
}

/**
 * A host whose every operation fails with one chosen error.
 *
 * Shared by both transports so neither can be held to a slightly different
 * fixture. `resolve` succeeds: authentication is not what is under test, and
 * failing it would make every case an `AgentUnauthorizedError`.
 */
export const failingHost = <Principal>(
  principal: Principal,
  error: AgentProtocol.RemoteError
): AgentSessionHost.Service<Principal> => {
  const fail = Effect.fail(error)
  return {
    resolve: () => Effect.succeed(principal),
    createSession: () => fail,
    closeSession: () => fail,
    session: () => fail,
    prompt: () => fail,
    submit: () => fail,
    awaitSubmission: () => fail,
    steer: () => fail,
    followUp: () => fail,
    interrupt: () => fail,
    respond: () => fail,
    pending: () => fail,
    history: () => fail,
    status: () => fail,
    events: () => fail,
    sessions: () => fail,
    eventLog: () => fail,
    hostEvents: () => fail,
    size: Effect.succeed(0),
    pumps: Effect.succeed(0),
    requestBuckets: Effect.succeed(0),
    maxSessions: 4,
    maxRequestsPerSession: 16
  }
}

const contractSessionId = AgentProtocol.SessionId.make("protocol-errors")

/**
 * One instance of each of the fifteen, with fields worth checking survived.
 *
 * Listed rather than generated: a generated list would be derived from the
 * same union the code under test uses, so it would shrink silently along with
 * the bug. This one has to be edited by hand when the protocol grows a failure,
 * which is the point.
 */
export const protocolErrors: ReadonlyArray<AgentProtocol.RemoteError> = [
  new AgentBusyError({ sessionId: contractSessionId }),
  new AgentIdleError({ sessionId: contractSessionId, operation: "steer" }),
  new AgentClosedError({ sessionId: contractSessionId }),
  new AgentClient.AgentSessionNotFoundError({ sessionId: "protocol-errors" }),
  new AgentClient.AgentExecutionError({
    sessionId: "protocol-errors",
    tag: "ToolError",
    detail: "declined",
    isDefect: false
  }),
  new AgentClient.AgentTransportError({
    sessionId: "protocol-errors",
    detail: "socket closed"
  }),
  new AgentProtocol.AgentSessionAlreadyExistsError({
    sessionId: contractSessionId
  }),
  new AgentProtocol.AgentRequestConflictError({
    sessionId: Option.some(contractSessionId),
    requestId: AgentProtocol.RequestId.make("req-1")
  }),
  new AgentProtocol.AgentRequestCapacityExceededError({
    sessionId: Option.some(contractSessionId),
    capacity: 16
  }),
  new AgentProtocol.AgentUnauthorizedError({ operation: "getSession" }),
  new AgentProtocol.AgentForbiddenError({
    operation: "getSession",
    sessionId: Option.some(contractSessionId)
  }),
  new AgentProtocol.AgentCapacityExceededError({ capacity: 4 }),
  new AgentProtocol.AgentInvalidRequestError({
    operation: "getSession",
    detail: "malformed"
  }),
  new AgentProtocol.AgentProtocolCodecError({
    operation: "getSession",
    phase: "response",
    detail: "unencodable"
  }),
  new AgentProtocol.AgentSubmissionNotFoundError({
    sessionId: contractSessionId,
    submissionId: AgentProtocol.SubmissionId.make("sub-1")
  })
]

export const runProtocolErrors = (harness: ProtocolErrorHarness): void => {
  describe(`AgentClient protocol errors (${harness.name})`, () => {
    for (const expected of protocolErrors) {
      it.live(`${expected._tag} arrives as itself`, () =>
        Effect.gen(function* () {
          const seen = yield* harness.failure(expected)
          // Named, not `isFailure`: the bug was a failure of the *right*
          // shape wearing the wrong tag, which any weaker assertion passes.
          assert.strictEqual(seen._tag, expected._tag)
          // And the fields came with it. A tag that survives while its
          // payload is rebuilt from a string is not the error travelling.
          assert.deepStrictEqual(
            Schema.encodeUnknownSync(AgentProtocol.RemoteError)(seen),
            Schema.encodeUnknownSync(AgentProtocol.RemoteError)(expected)
          )
        })
      )
    }

    it.live("a forbidden request is not reported as retryable", () =>
      Effect.gen(function* () {
        const seen = yield* harness.failure(
          new AgentProtocol.AgentForbiddenError({
            operation: "getSession",
            sessionId: Option.some(contractSessionId)
          })
        )
        // The whole point, stated on its own so a regression names it:
        // `AgentTransportError` means "retrying is reasonable", and a 403 is
        // not. This is what retried forever.
        assert.notStrictEqual(seen._tag, "AgentTransportError")
        assert.strictEqual(seen._tag, "AgentForbiddenError")
      })
    )
  })
}
