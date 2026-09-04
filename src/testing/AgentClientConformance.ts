import { Deferred, Duration, Effect, Fiber, Option, Ref, Schedule, Schema, Stream } from "effect"
import type { Layer } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentEvent from "../AgentEvent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentLoop from "../AgentLoop.js"
import * as AgentClient from "../client/AgentClient.js"
import * as Elicitation from "../Elicitation.js"
import * as ToolExecution from "../ToolExecution.js"
import { checks, report, type Report } from "./internal/conformance.js"
import * as TestLanguageModel from "./TestLanguageModel.js"

/**
 * The conformance suite every `AgentClient` implementation must pass.
 *
 * The client seam exists so an application writes the same code whether its
 * agent runs in this process or behind some interpreter -- durable workflow,
 * cluster entity, transport. A second implementation that passes its own
 * hand-written tests but fails these is not a weaker sibling; it is a
 * different, undocumented contract. The in-process, durable, HTTP and RPC
 * clients all run this; a client of your own is held to the same rows.
 *
 * Cases use only the client surface -- no `AgentSession` -- which is the
 * discipline the seam enforces. They run on the live clock: the durable
 * interpreter drives a real workflow engine whose timers do not advance
 * under a test clock, and nothing here depends on time -- synchronisation is
 * by `Deferred`.
 *
 * Framework-agnostic, as `SandboxConformance` is: a case is a named Effect,
 * a runner wires them with one line each (`it.live`, not `it.effect`), and
 * `run` reports.
 */

export class Failure extends Schema.TaggedError<Failure>()(
  "AgentClientConformanceFailure",
  { case: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `agent client conformance: ${this.case}: ${this.detail}`
  }
}

export interface Options {
  /**
   * Build a client layer over `agent`, driven by a scripted model.
   *
   * Each invocation must produce independent wiring -- fresh sessions, fresh
   * state -- because every case calls it afresh.
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
   * `true` when this client can resume `events({ after })` from a sequence.
   *
   * Not an opt-out: both answers are asserted. A client that says `false` must
   * *fail* when handed a cursor, because the one thing the seam forbids is
   * quietly returning a live stream to a caller who asked to resume -- they
   * would lose every event in between and have no way to find out. So
   * forgetting to set this on a client that can resume is caught too: the
   * failing branch is checked and will not fail.
   *
   * Resumption needs a delivery log, which is a real difference between
   * backings rather than an artefact of testing.
   */
  readonly resumesEvents?: boolean | undefined
  /**
   * Where settled outcomes live. `bounded` is the in-process table with the
   * eviction rule; `journal` is the durable engine, which keeps every
   * outcome. The eviction case runs only against `bounded`.
   */
  readonly outcomeRetention?: "bounded" | "journal" | undefined
}

/**
 * How long a cancelled request may take to unwind before the interruption row
 * calls it a hang.
 *
 * Exported because `ShippedConformance` falsifies that row with a client
 * deliberately slower than this, and a bound the falsification cannot see is a
 * bound someone raises until the proof silently stops proving anything.
 */
export const cancellationBound = Duration.seconds(5)

/** What a case can fail with: the suite's own failure, or the client's. */
export type CaseError = Failure | AgentClient.RemoteError

export interface Case {
  readonly name: string
  readonly run: Effect.Effect<void, CaseError>
}

const { equal, failureOf, that } = checks((name, detail) => new Failure({ case: name, detail }))

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const Boom = Tool.make("boom", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Schema.String
})

const Dangerous = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

/** Runs `use` with a client built by `options` over `agent` and `turns`. */
const withClient = <A, E>(
  options: Options,
  wiring: Parameters<Options["layer"]>[0],
  use: (client: AgentClient.Service) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.flatMap(options.layer(wiring), (layer) =>
    Effect.flatMap(Effect.service(AgentClient.AgentClient), use).pipe(Effect.provide(layer))
  )

/** A model held at a gate, so a submission is observably in flight. */
const gated = Effect.map(Deferred.make<void>(), (gate) => ({
  gate,
  turns: [{ text: "done", during: Deferred.await(gate) }] as const
}))

/** Deltas observed through `events` for one prompt, asked-streaming or not. */
const deltasFor = (
  options: Options,
  stream: boolean
): Effect.Effect<ReadonlyArray<string>, AgentClient.RemoteError> =>
  withClient(
    options,
    {
      agent: Agent.make({ loop: AgentLoop.bounded(4) }),
      turns: [{ text: "streamed", chunks: ["str", "eamed"] }]
    },
    (client) =>
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* client.createSession()
          // Collect until the submission's own terminal event, rather than
          // stopping when `prompt` returns.
          //
          // Stopping on the return is an in-process assumption: locally the
          // deltas are published on the same bus before the prompt's effect
          // completes, so they are already in hand. Over a wire they travel on
          // a *separate* response, and the prompt returning says nothing about
          // whether they have arrived -- so interrupting there raced them and
          // read an empty list, which looks exactly like a transport that
          // cannot stream. Per-session order is guaranteed, so
          // `SubmissionCompleted` is the marker that every delta which was
          // going to arrive already has.
          const collected = yield* Effect.forkChild(
            Stream.runFold(
              Stream.takeUntil(
                session.events(),
                (entry) => entry.event._tag === "SubmissionCompleted"
              ),
              (): ReadonlyArray<string> => [],
              (all, entry) =>
                AgentEvent.is("MessageDelta")(entry) ? [...all, entry.event.delta] : all
            )
          )
          yield* Effect.yieldNow
          yield* session.prompt("go", stream ? { stream: true } : {})
          return yield* Fiber.join(collected)
        })
      )
  )

export const cases = (options: Options): ReadonlyArray<Case> => {
  const make = (name: string, run: Effect.Effect<void, CaseError>): Case => ({ name, run })
  const retention = options.outcomeRetention ?? "bounded"

  return [
    make("opens a session and reaches it again by id", withClient(
      options,
      { agent: Agent.make({ loop: AgentLoop.bounded(4) }), turns: [TestLanguageModel.text("done")] },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "opens a session and reaches it again by id"
            const session = yield* client.createSession({ sessionId: "contract-1" })
            yield* equal(name)(session.id, "contract-1", "the id asked for")
            yield* session.prompt("go")
            // Reachable by id while open, and it is the same conversation.
            const again = yield* client.session("contract-1")
            yield* equal(name)(again.id, session.id, "the id reached again")
          })
        )
    )),

    make("the result carries the final message as prompt parts, files included", withClient(
      options,
      {
        agent: Agent.make({ loop: AgentLoop.bounded(2) }),
        turns: [{
          text: "here you go",
          files: [{ mediaType: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }]
        }]
      },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "the result carries the final message as prompt parts, files included"
            const session = yield* client.createSession()
            const result = yield* session.prompt("draw it")
            yield* equal(name)(result.text, "here you go", "text")
            // Text and file, in order, and the file crossed the transport as
            // bytes -- the wire codec's job, and the same answer from every
            // transport.
            yield* equal(name)(result.content.map((part) => part.type), ["text", "file"], "part types")
            const file = result.content[1]
            yield* that(name)(file?.type === "file", "expected a file part second")
            if (file?.type === "file") {
              yield* equal(name)(file.mediaType, "image/png", "media type")
              yield* that(name)(file.data instanceof Uint8Array, "the file did not cross as bytes")
              yield* equal(name)(
                Array.from(file.data instanceof Uint8Array ? file.data : []),
                [0x89, 0x50, 0x4e, 0x47],
                "bytes"
              )
            }
          })
        )
    )),

    make("submit returns at admission; awaitSubmission returns what prompt would, and again",
      Effect.gen(function* () {
        const name = "submit returns at admission; awaitSubmission returns what prompt would, and again"
        const { gate, turns } = yield* gated
        yield* withClient(
          options,
          { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const receipt = yield* session.submit("go")
                // Admitted, not finished: the model is still at the gate.
                yield* equal(name)(yield* session.status, "running", "status at admission")
                yield* Deferred.succeed(gate, void 0)
                const result = yield* session.awaitSubmission(receipt.submissionId)
                yield* equal(name)(result.submissionId, receipt.submissionId, "submission id")
                yield* equal(name)(result.text, "done", "text")
                yield* equal(name)(result.status, "completed", "status")
                yield* equal(name)((yield* session.history).content.length, 2, "history length")
                // Retained: the same outcome again, and no second run.
                const again = yield* session.awaitSubmission(receipt.submissionId)
                yield* equal(name)(again, result, "the retained outcome")
                yield* equal(name)((yield* session.history).content.length, 2, "history length after the second await")
              })
            )
        )
      })),

    make("the same idempotency key and input is the same submission; a different input is a conflict",
      Effect.gen(function* () {
        const name = "the same idempotency key and input is the same submission; a different input is a conflict"
        const { gate, turns } = yield* gated
        yield* withClient(
          options,
          { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const first = yield* session.submit("go", { idempotencyKey: "k1" })
                const retry = yield* session.submit("go", { idempotencyKey: "k1" })
                yield* equal(name)(retry.submissionId, first.submissionId, "a retry's submission id")
                const conflict = yield* failureOf(name)(session.submit("something else", { idempotencyKey: "k1" }))
                yield* equal(name)(conflict._tag, "AgentRequestConflictError", "a different request under the key")
                yield* Deferred.succeed(gate, void 0)
                yield* session.awaitSubmission(first.submissionId)
                // One execution: one exchange in history.
                yield* equal(name)((yield* session.history).content.length, 2, "history length")
              })
            )
        )
      })),

    make("awaitSubmission on a submission the session never made is not-found", withClient(
      options,
      { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns: [TestLanguageModel.text("done")] },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "awaitSubmission on a submission the session never made is not-found"
            const session = yield* client.createSession()
            const error = yield* failureOf(name)(session.awaitSubmission("never-submitted"))
            yield* equal(name)(error._tag, "AgentSubmissionNotFoundError", "the error")
          })
        )
    )),

    make("an interrupted submission's outcome is retained as interrupted",
      Effect.gen(function* () {
        const name = "an interrupted submission's outcome is retained as interrupted"
        const { turns } = yield* gated
        yield* withClient(
          options,
          { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns },
          (client) =>
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* client.createSession()
                const receipt = yield* session.submit("go")
                yield* session.interrupt()
                const result = yield* session.awaitSubmission(receipt.submissionId)
                yield* equal(name)(result.status, "interrupted", "status")
                yield* equal(name)((yield* session.awaitSubmission(receipt.submissionId)).status, "interrupted", "status, again")
              })
            )
        )
      })),

    make("a failed submission's outcome is the typed failure, retained", withClient(
      options,
      { agent: Agent.make({ loop: AgentLoop.bounded(1) }), turns: [{ fail: "provider down" }] },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "a failed submission's outcome is the typed failure, retained"
            const session = yield* client.createSession()
            const receipt = yield* session.submit("go")
            const first = yield* failureOf(name)(session.awaitSubmission(receipt.submissionId))
            yield* equal(name)(first._tag, "AgentExecutionError", "the first await")
            const second = yield* failureOf(name)(session.awaitSubmission(receipt.submissionId))
            yield* equal(name)(second._tag, "AgentExecutionError", "the second await")
          })
        )
    )),

    retention === "bounded"
      ? make("an outcome is evicted only after enough newer submissions settle, and is then not-found rather than re-run", withClient(
        options,
        {
          agent: Agent.make({ loop: AgentLoop.bounded(1) }),
          turns: [TestLanguageModel.text("one"), TestLanguageModel.text("two"), TestLanguageModel.text("three")],
          maxRetainedSubmissions: 2
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const name = "an outcome is evicted only after enough newer submissions settle, and is then not-found rather than re-run"
              const session = yield* client.createSession()
              const first = yield* session.submit("a")
              yield* session.awaitSubmission(first.submissionId)
              // One newer settled submission: still retained.
              yield* session.prompt("b")
              yield* equal(name)((yield* session.awaitSubmission(first.submissionId)).text, "one", "retained after one newer")
              // Two newer: the slot is needed, and the oldest goes.
              yield* session.prompt("c")
              const gone = yield* failureOf(name)(session.awaitSubmission(first.submissionId))
              yield* equal(name)(gone._tag, "AgentSubmissionNotFoundError", "after eviction")
              // Nothing re-ran: three exchanges, no more.
              yield* equal(name)((yield* session.history).content.length, 6, "history length")
            })
          )
      ))
      : make("the journal keeps every outcome: an early submission is still there after many newer ones", withClient(
        options,
        {
          agent: Agent.make({ loop: AgentLoop.bounded(1) }),
          turns: [TestLanguageModel.text("one"), TestLanguageModel.text("two"), TestLanguageModel.text("three")]
        },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const name = "the journal keeps every outcome: an early submission is still there after many newer ones"
              const session = yield* client.createSession()
              const first = yield* session.submit("a")
              yield* session.awaitSubmission(first.submissionId)
              yield* session.prompt("b")
              yield* session.prompt("c")
              yield* equal(name)((yield* session.awaitSubmission(first.submissionId)).text, "one", "the early outcome")
            })
          )
      )),

    make("runs a tool-calling prompt and exposes observations", withClient(
      options,
      {
        agent: Agent.make({
          toolkit: Agent.toolkit([Search], { search: ({ query }) => Effect.succeed(`hits for ${query}`) }),
          loop: AgentLoop.bounded(4)
        }),
        turns: [TestLanguageModel.toolCall("search", { query: "effect" }), TestLanguageModel.text("found it")]
      },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "runs a tool-calling prompt and exposes observations"
            const session = yield* client.createSession()
            const result = yield* session.prompt("find effect")
            yield* equal(name)(result.text, "found it", "text")
            yield* equal(name)(result.status, "completed", "status")
            yield* equal(name)(result.runs, 1, "runs")
            yield* equal(name)(
              (yield* session.history).content.map((m) => m.role),
              ["user", "assistant", "tool", "assistant"],
              "history roles"
            )
            yield* equal(name)(yield* session.status, "idle", "status afterwards")
          })
        )
    )),

    make("a sequential prompt continues the same conversation", withClient(
      options,
      {
        agent: Agent.make({ loop: AgentLoop.bounded(4) }),
        turns: [TestLanguageModel.text("first"), TestLanguageModel.text("second")]
      },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "a sequential prompt continues the same conversation"
            const session = yield* client.createSession()
            yield* session.prompt("remember this")
            const result = yield* session.prompt("what did I say?")
            yield* equal(name)(result.text, "second", "text")
            yield* equal(name)(
              (yield* session.history).content.map((m) => m.role),
              ["user", "assistant", "user", "assistant"],
              "history roles"
            )
          })
        )
    )),

    make("rejects a concurrent prompt with AgentBusyError", withClient(
      options,
      { agent: Agent.make({ loop: AgentLoop.bounded(4) }), turns: [{ text: "slow", hang: true }] },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "rejects a concurrent prompt with AgentBusyError"
            const session = yield* client.createSession()
            const running = yield* Effect.forkChild(session.prompt("go"))
            // Let the fork claim the session before racing it.
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            const busy = yield* failureOf(name)(session.prompt("again"))
            yield* equal(name)(busy._tag, "AgentBusyError", "the second prompt's error")
            yield* Fiber.interrupt(running)
          })
        )
    )),

    make("steer offered mid-run is applied at the turn boundary",
      Effect.gen(function* () {
        const name = "steer offered mid-run is applied at the turn boundary"
        // Held open until the case has queued its steering, so the timing
        // is deterministic rather than raced: the model call is genuinely
        // in flight when `steer` lands.
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* withClient(
          options,
          {
            agent: Agent.make({
              toolkit: Agent.toolkit([Search], { search: ({ query }) => Effect.succeed(`hits for ${query}`) }),
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
                // The turn already under way finishes untouched; the
                // steering is folded in at the next boundary and drives
                // another turn.
                yield* equal(name)(result.turns, 2, "turns")
                yield* equal(name)(TestLanguageModel.userTexts(yield* session.history), ["go", "go left"], "user texts")
              })
            )
        )
      })),

    make("follow-up offered mid-run becomes a second run",
      Effect.gen(function* () {
        const name = "follow-up offered mid-run becomes a second run"
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* withClient(
          options,
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
                yield* equal(name)(result.runs, 2, "runs")
                yield* equal(name)(result.text, "second", "text")
              })
            )
        )
      })),

    make("rejects steer and follow-up on an idle session", withClient(
      options,
      { agent: Agent.make({}), turns: [] },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "rejects steer and follow-up on an idle session"
            const session = yield* client.createSession()
            const steered = yield* failureOf(name)(session.steer("x"))
            yield* equal(name)(steered._tag, "AgentIdleError", "steer")
            const followed = yield* failureOf(name)(session.followUp("y"))
            yield* equal(name)(followed._tag, "AgentIdleError", "followUp")
          })
        )
    )),

    make("interrupt ends the submission and leaves the session reusable",
      Effect.gen(function* () {
        const name = "interrupt ends the submission and leaves the session reusable"
        const entered = yield* Deferred.make<void>()
        yield* withClient(
          options,
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
                yield* equal(name)(result.status, "interrupted", "status")
                // Interruption is terminal for the submission, not the session.
                yield* equal(name)(yield* session.status, "idle", "session status")
                const next = yield* session.prompt("try again")
                yield* equal(name)(next.text, "after", "the next prompt's text")
              })
            )
        )
      })),

    make("describes an agent failure instead of hiding it", withClient(
      options,
      {
        agent: Agent.make({
          toolkit: Agent.toolkit([Boom], { boom: () => Effect.fail("declined") }),
          toolFailurePolicy: ToolExecution.FailRun,
          loop: AgentLoop.bounded(2)
        }),
        turns: [TestLanguageModel.toolCall("boom", {}, { id: "b1" }), { text: "unused", hang: true }]
      },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "describes an agent failure instead of hiding it"
            const session = yield* client.createSession()
            const described = yield* failureOf(name)(session.prompt("go"))
            // An execution failure, not a transport one. An agent failure is
            // a property of the request and will recur; wearing the
            // transport tag would turn a caller's retry policy into a loop.
            yield* equal(name)(described._tag, "AgentExecutionError", "the error")
            if (described._tag === "AgentExecutionError") {
              // The tool's own reason survives, even though its type did not.
              yield* that(name)(described.detail.includes("declined"), `detail does not carry the tool's reason: ${described.detail}`)
            }
            // And the failed submission did not wedge the session.
            yield* equal(name)(yield* session.status, "idle", "session status")
          })
        )
    )),

    make("unpauses a run waiting on an answer", withClient(
      options,
      {
        agent: Agent.make({
          toolkit: Agent.toolkit([Dangerous], { wipe: () => Effect.succeed("wiped") }),
          loop: AgentLoop.bounded(4)
        }),
        turns: [{ toolCalls: [{ id: "w1", name: "wipe", params: {} }] }, TestLanguageModel.text("done")],
        elicitation: Elicitation.memory
      },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "unpauses a run waiting on an answer"
            const session = yield* client.createSession()
            const running = yield* Effect.forkChild(session.prompt("go"))
            // Poll the remote surface rather than reaching for anything
            // underneath: a transport has nothing else.
            const request = yield* Effect.retry(
              Effect.flatMap(session.pending, (waiting) =>
                waiting.length > 0 ? Effect.succeed(waiting[0]!) : Effect.fail("none" as const)
              ),
              { times: 200, schedule: Schedule.spaced(Duration.millis(5)) }
            ).pipe(Effect.mapError(() => new Failure({ case: name, detail: "no elicitation request became pending" })))
            yield* equal(name)(request.kind, "tool-approval", "the request's kind")
            yield* that(name)(yield* session.respond({ id: request.id, granted: true }), "respond reported nothing waiting")
            const result = yield* Fiber.join(running)
            yield* equal(name)(result.text, "done", "text")
          })
        )
    )),

    /**
     * Resumption, and the silent failure it exists to prevent.
     *
     * The seam is emphatic about this and nothing was checking it: a caller
     * reconnecting from sequence 41 and quietly handed events from 60 onward
     * has lost eighteen and has no way to find out. So an implementation that
     * cannot resume owes a *failure*, which is the branch below; one that can
     * owes exactly the events above the cursor, which is the branch after it.
     */
    options.resumesEvents === true
      ? make("resumes events from a sequence, with no gap and no repeat", withClient(
        options,
        { agent: Agent.make({ loop: AgentLoop.bounded(2) }), turns: [TestLanguageModel.text("done")] },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const name = "resumes events from a sequence, with no gap and no repeat"
              const session = yield* client.createSession()
              yield* session.prompt("go")

              /**
               * A cursored read, bounded.
               *
               * The submission has already settled, so a correct resumption
               * replays what was recorded and reaches the end immediately. A
               * client that ignored the cursor hands back a *live* stream on a
               * finished session, which produces nothing and would otherwise
               * hang here until the runner killed the case -- reporting a
               * timeout where the real answer is "the cursor was ignored".
               */
              const read = (after: number) =>
                Stream.runCollect(
                  Stream.takeUntil(
                    session.events({ after }),
                    (entry) => entry.event._tag === "SubmissionCompleted"
                  )
                ).pipe(
                  Effect.map(Option.some),
                  Effect.timeout(Duration.seconds(5)),
                  Effect.catchTag("TimeoutError", () => Effect.succeedNone)
                )

              const fromStart = yield* read(0)
              yield* that(name)(
                Option.isSome(fromStart),
                "reading from the beginning never reached the submission's end: the cursor was ignored and a live stream returned"
              )
              const all = Option.getOrElse(fromStart, (): ReadonlyArray<AgentEventEnvelope> => [])
              yield* that(name)(all.length >= 3, `a settled submission recorded ${all.length} events`)
              yield* equal(name)(
                all.map((entry) => entry.sequence),
                all.map((_, index) => index + 1),
                "sequences from the beginning"
              )

              // Resuming from the second one must deliver the third onward:
              // nothing skipped, and nothing delivered twice.
              const cursor = all[1]!.sequence
              const fromCursor = yield* read(cursor)
              yield* that(name)(
                Option.isSome(fromCursor),
                "resuming from a cursor never reached the submission's end: the cursor was ignored and a live stream returned"
              )
              const resumed = Option.getOrElse(fromCursor, (): ReadonlyArray<AgentEventEnvelope> => [])
              yield* equal(name)(
                resumed.map((entry) => entry.sequence),
                all.slice(2).map((entry) => entry.sequence),
                "sequences after the cursor"
              )
              yield* equal(name)(
                resumed.map((entry) => entry.event._tag),
                all.slice(2).map((entry) => entry.event._tag),
                "events after the cursor"
              )
            })
          )
      ))
      : make("refuses to resume events rather than quietly returning a live stream", withClient(
        options,
        { agent: Agent.make({ loop: AgentLoop.bounded(2) }), turns: [TestLanguageModel.text("done")] },
        (client) =>
          Effect.scoped(
            Effect.gen(function* () {
              const name = "refuses to resume events rather than quietly returning a live stream"
              const session = yield* client.createSession()
              // Three outcomes are distinguishable, and only one is allowed.
              //
              // Blocking counts as wrong, not as inconclusive: a client that
              // hands back a live stream and waits has already failed to
              // refuse, and reporting that as a hang would leave the reader to
              // guess. A correct client fails immediately, so the bound costs
              // nothing unless something is broken.
              const outcome = yield* Stream.runCollect(
                Stream.take(session.events({ after: 0 }), 1)
              ).pipe(
                Effect.as("delivered a live event" as const),
                Effect.catchCause(() => Effect.succeed("refused" as const)),
                Effect.timeout(Duration.seconds(5)),
                Effect.catchTag("TimeoutError", () => Effect.succeed("returned a stream that never produced" as const))
              )
              yield* equal(
                name
              )(
                outcome,
                "refused",
                "resuming from a cursor this client cannot honour: it must fail, because silently starting from now loses every event in between"
              )
            })
          )
      )),

    make("streams deltas when asked, and not otherwise",
      Effect.gen(function* () {
        const name = "streams deltas when asked, and not otherwise"
        const streamed = yield* deltasFor(options, true)
        const batched = yield* deltasFor(options, false)
        // Deltas are asserted joined, not chunk-by-chunk: how finely a
        // provider's stream is cut is a property of the provider
        // connection, and the durable interpreter legitimately delivers
        // them whole. What the contract owes every caller is that
        // streamed generation reaches `events` intact.
        yield* equal(name)(streamed.join(""), "streamed", "streamed text")
        yield* that(name)(streamed.length > 0, "no deltas were observed")
        yield* equal(name)(batched, [], "deltas without stream: true")
      })),

    /**
     * Interruption must reach the caller, and why it is a row here rather
     * than a note in one transport's own tests.
     *
     * The relay got this wrong in a way worth stating as a rule. Its caller
     * waited for the far end to acknowledge an interrupted request; the
     * acknowledgement arrived after the channel had been torn down, so it was
     * dropped; and the request then waited forever for something that no
     * longer had anywhere to land. The symptom was the worst kind: an
     * *uninterruptible* hang, where an outer timeout fires, interrupts the
     * request, and then waits on the same acknowledgement.
     *
     * So the rule is not about the run, which may well take a while to stop.
     * It is that a transport must not make a caller's cancellation depend on
     * a remote answer it might never receive. Every implementation owes it,
     * and no implementation's own tests were asking.
     */
    make("interrupting a request in flight settles it rather than hanging",
      Effect.gen(function* () {
        const name = "interrupting a request in flight settles it rather than hanging"
        const entered = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        const layer = yield* options.layer({
          agent: Agent.make({ loop: AgentLoop.bounded(1) }),
          // Held open and never released, so the request is genuinely in
          // flight when it is interrupted rather than merely sent.
          turns: [{ text: "done", started: entered, during: Deferred.await(held) }]
        })

        const settled = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* Effect.service(AgentClient.AgentClient)
            const session = yield* client.createSession()
            const running = yield* Effect.forkChild(session.prompt("go"))
            // Not a yield or a sleep: the model has actually been entered.
            yield* Deferred.await(entered)
            // `Fiber.interrupt` waits for the fiber to finish unwinding, so a
            // transport that parks its caller on an acknowledgement that will
            // never come does not come back here.
            return yield* Fiber.interrupt(running).pipe(
              Effect.as(true),
              Effect.timeout(cancellationBound),
              Effect.catchTag("TimeoutError", () => Effect.succeed(false))
            )
          }).pipe(Effect.provide(layer))
        )

        yield* that(name)(
          settled,
          "interrupting an in-flight request never returned; a transport must not make cancellation wait on a remote acknowledgement it may never receive"
        )
      })),

    make("emits lifecycle events in order", withClient(
      options,
      { agent: Agent.make({ loop: AgentLoop.bounded(4) }), turns: [TestLanguageModel.text("done")] },
      (client) =>
        Effect.scoped(
          Effect.gen(function* () {
            const name = "emits lifecycle events in order"
            const session = yield* client.createSession()
            const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(session.events(), 3)))
            yield* Effect.yieldNow
            yield* session.prompt("go")
            const events = yield* Fiber.join(collected)
            yield* equal(name)(
              events.map((entry) => entry.event._tag),
              ["SubmissionStarted", "RunStarted", "TurnStarted"],
              "the first three events"
            )
          })
        )
    ))
  ]
}

/** Every case against a client, reported. Never fails. */
export const run = (options: Options): Effect.Effect<Report> => report(cases(options))
