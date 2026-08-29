import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { Prompt } from "effect/unstable/ai"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import { AgentMcp } from "../src/mcp/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The MCP adapter is tested at its handler rather than through a protocol
 * transport. The transport is Effect's code; what belongs to this project is
 * the mapping from an MCP tool call onto a session — in particular whether
 * `sessionId` really continues a conversation, which is the part a client can
 * observe and the part that is easy to get subtly wrong.
 */
const withAgent = <A, E>(
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  use: (
    ask: (params: {
      readonly prompt: string
      readonly sessionId?: string
    }) => Effect.Effect<string, unknown>,
    recorder: TestLanguageModel.Recorder
  ) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const { layer: model, recorder } = yield* TestLanguageModel.script(turns)

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const bound = yield* AgentMcp.AgentToolkit.pipe(
          Effect.provide(Layer.unwrap(AgentMcp.handlers()))
        )

        // A tool handler returns a stream of results; the final one is the
        // answer, exactly as `ToolExecution` treats it.
        const ask = (params: {
          readonly prompt: string
          readonly sessionId?: string
        }) =>
          bound.handle("ask_agent", params).pipe(
            Effect.flatMap(Stream.runCollect),
            Effect.map((results) => String(results[results.length - 1]?.result))
          )

        return yield* use(ask, recorder)
      })
    ).pipe(
      Effect.provide(
        AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) })).pipe(
          Layer.provide(model)
        )
      )
    )
  })

describe("agent over MCP", () => {
  it.effect("answers a one-shot question", () =>
    withAgent([TestLanguageModel.text("the answer is 42")], (ask) =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* ask({ prompt: "what is the answer?" }),
          "the answer is 42"
        )
      })
    )
  )

  it.effect("continues a conversation when given the same session id", () =>
    withAgent(
      [TestLanguageModel.text("noted"), TestLanguageModel.text("you said 41")],
      (ask, recorder) =>
        Effect.gen(function* () {
          yield* ask({ prompt: "remember 41", sessionId: "chat-1" })
          yield* ask({ prompt: "what did I say?", sessionId: "chat-1" })

          // Asserting the *answer* proves nothing: a scripted model returns
          // turn 2's text whether or not the session was reused. What
          // discriminates is the prompt the model was given -- the second call
          // must have carried the first exchange.
          const second = (yield* recorder.prompts)[1]
          assert.isDefined(second)
          assert.deepStrictEqual(TestLanguageModel.userTexts(second), [
            "remember 41",
            "what did I say?"
          ])
        })
    )
  )

  it.effect("gives an unnamed call its own session", () =>
    withAgent(
      [TestLanguageModel.text("first"), TestLanguageModel.text("second")],
      (ask, recorder) =>
        Effect.gen(function* () {
          // Omitting `sessionId` is the one-shot case: two calls must not see
          // each other, or an MCP client asking unrelated questions would
          // accumulate a conversation it never asked for.
          yield* ask({ prompt: "unrelated one" })
          yield* ask({ prompt: "unrelated two" })

          const second = (yield* recorder.prompts)[1]
          assert.isDefined(second)
          assert.deepStrictEqual(TestLanguageModel.userTexts(second), [
            "unrelated two"
          ])
        })
    )
  )

  it.effect("concurrent calls for one session id reach one session", () =>
    withAgent(
      [TestLanguageModel.text("a"), TestLanguageModel.text("b")],
      (ask) =>
        Effect.gen(function* () {
          // Sharing is the claim, and the discriminator is precise: reaching
          // one session means the second call meets the
          // one-submission-per-session rule and is refused, whereas two
          // separate sessions would both have succeeded.
          //
          // This does not prove the serialisation in `handlers` -- forcing two
          // fibres to interleave inside session creation is not something a
          // test can arrange on demand, and unserialised code passes this too.
          // The lock is there for the window it closes, not for this test.
          const outcomes = yield* Effect.all(
            [
              Effect.exit(ask({ prompt: "one", sessionId: "shared" })),
              Effect.exit(ask({ prompt: "two", sessionId: "shared" }))
            ],
            { concurrency: "unbounded" }
          )

          const failures = outcomes.filter((outcome) => outcome._tag === "Failure")
          assert.strictEqual(
            failures.length,
            1,
            "concurrent calls did not reach the same session"
          )
        })
    )
  )

  it.effect("bounds the session registry, dropping the oldest", () =>
    Effect.gen(function* () {
      // Every distinct id a client sends used to open a session that lived for
      // the server's lifetime: unbounded memory driven by input from outside.
      const { layer: model, recorder } = yield* TestLanguageModel.script(
        Array.from({ length: 8 }, (_, i) => TestLanguageModel.text(`r${i}`))
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const bound = yield* AgentMcp.AgentToolkit.pipe(
            Effect.provide(Layer.unwrap(AgentMcp.handlers({ maxSessions: 2 })))
          )
          const ask = (sessionId: string, prompt: string) =>
            bound
              .handle("ask_agent", { prompt, sessionId })
              .pipe(Effect.flatMap(Stream.runCollect))

          yield* ask("one", "first")
          yield* ask("two", "second")
          // A third opens past the limit, evicting the oldest.
          yield* ask("three", "third")
          // Asking under the evicted id again must start over. If the registry
          // were unbounded, this would resume and carry "first" with it.
          yield* ask("one", "again")
        })
      ).pipe(
        Effect.provide(
          AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) })).pipe(
            Layer.provide(model)
          )
        )
      )

      const fourth = (yield* recorder.prompts)[3]
      assert.isDefined(fourth)
      assert.deepStrictEqual(
        TestLanguageModel.userTexts(fourth),
        ["again"],
        "the evicted session was resumed instead of dropped"
      )
    })
  )
})

describe("eviction and in-flight calls", () => {
  it.effect("never evicts a session with a call in flight", () =>
    Effect.gen(function* () {
      // Session "one" is mid-prompt when "two" arrives past the limit of 1.
      // Evicting "one" would close its scope under the running call, which
      // then fails for its caller with an interruption. The bound holds by
      // refusing "two" instead, and "one" finishes.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([
        { text: "one done", started: entered, during: Deferred.await(release) },
        TestLanguageModel.text("two done")
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const bound = yield* AgentMcp.AgentToolkit.pipe(
            Effect.provide(Layer.unwrap(AgentMcp.handlers({ maxSessions: 1 })))
          )
          const ask = (sessionId: string, prompt: string) =>
            bound
              .handle("ask_agent", { prompt, sessionId })
              .pipe(
                Effect.flatMap(Stream.runCollect),
                Effect.map((results) => String(results[results.length - 1]?.result))
              )

          const first = yield* Effect.forkChild(ask("one", "first"))
          yield* Deferred.await(entered)
          const refused = yield* Effect.flip(ask("two", "second"))
          assert.include(String(refused), "capacity")

          yield* Deferred.succeed(release, void 0)
          assert.strictEqual(yield* Fiber.join(first), "one done")
          // Idle now: the newcomer evicts it and runs.
          assert.strictEqual(yield* ask("two", "second"), "two done")
        })
      ).pipe(
        Effect.provide(
          AgentClient.layer(Agent.make({ loop: AgentLoop.bounded(2) })).pipe(
            Layer.provide(model)
          )
        )
      )
    })
  )
})

describe("session lifetime", () => {
  const submissionId = Schema.decodeSync(AgentProtocol.SubmissionId)("s")

  /** A client that counts how many sessions are opened and released. */
  const countingClient = (
    opened: Ref.Ref<number>,
    released: Ref.Ref<number>
  ) =>
    Layer.succeed(AgentClient.AgentClient, {
      createSession: (options) =>
        Effect.gen(function* () {
          yield* Ref.update(opened, (n) => n + 1)
          yield* Effect.addFinalizer(() =>
            Ref.update(released, (n) => n + 1)
          )
          return {
            id: options?.sessionId ?? "anon",
            prompt: () =>
              Effect.succeed({
                submissionId,
                status: "completed" as const,
                runs: 1,
                turns: 1,
                text: "ok",
                content: []
              }),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            interrupt: () => Effect.void,
            respond: () => Effect.succeed(false),
            pending: Effect.succeed([]),
            history: Effect.succeed(Prompt.make([])),
            status: Effect.succeed("idle" as const),
            events: () => Stream.empty
          }
        }),
      session: () =>
        Effect.fail(
          new AgentClient.AgentTransportError({
            sessionId: "?",
            detail: "not used"
          })
        )
    })

  const withCounts = <A, E>(
    use: (
      ask: (
        sessionId: string | undefined
      ) => Effect.Effect<unknown, unknown>,
      counts: {
        readonly opened: Ref.Ref<number>
        readonly released: Ref.Ref<number>
      }
    ) => Effect.Effect<A, E>
  ) =>
    Effect.gen(function* () {
      const opened = yield* Ref.make(0)
      const released = yield* Ref.make(0)

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const bound = yield* AgentMcp.AgentToolkit
          const ask = (sessionId: string | undefined) =>
            bound
              .handle("ask_agent", {
                prompt: "hello",
                ...(sessionId === undefined ? {} : { sessionId })
              })
              .pipe(Effect.flatMap(Stream.runCollect))
          return yield* use(ask, { opened, released })
        }).pipe(
          // Provided around the *whole* block, so the handler layer's scope
          // stays open across calls -- which is the shape a running server
          // has. Providing it only to the toolkit construction closes that
          // scope immediately, and a session parked in it is released at once:
          // the leak becomes unobservable and the test proves nothing.
          Effect.provide(Layer.unwrap(AgentMcp.handlers()))
        )
      ).pipe(Effect.provide(countingClient(opened, released)))
    })

  it.effect("an anonymous call releases its session when it returns", () =>
    withCounts((ask, counts) =>
      Effect.gen(function* () {
        // "One-shot" has to mean lifetime, not just reachability. These
        // sessions were created in the *server's* scope, so every anonymous
        // call left one alive until the server shut down -- and in the
        // client's registry too, since that finalizer hangs off the same
        // scope. Unbounded growth driven entirely by input from outside.
        yield* ask(undefined)
        yield* ask(undefined)

        assert.strictEqual(yield* Ref.get(counts.opened), 2)
        assert.strictEqual(
          yield* Ref.get(counts.released),
          2,
          "an anonymous session outlived the call that created it"
        )
      })
    )
  )

  it.effect("a named call keeps its session alive between calls", () =>
    withCounts((ask, counts) =>
      Effect.gen(function* () {
        // The other half: a named session outlives the call on purpose, which
        // is what makes `sessionId` mean anything.
        yield* ask("chat-1")
        yield* ask("chat-1")

        assert.strictEqual(yield* Ref.get(counts.opened), 1)
        assert.strictEqual(yield* Ref.get(counts.released), 0)
      })
    )
  )
})
