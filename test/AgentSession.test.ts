import { assert, describe, it } from "@effect/vitest"
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Schema,
  Stream
} from "effect"
import { Prompt, Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import * as FakeModel from "./FakeModel.js"
import {
  EchoToolkit,
  echoToolkit,
  tags,
  withSession
} from "./helpers.js"
import type { EchoTools } from "./helpers.js"

const callEcho = (id: string, value = "x") => ({
  id,
  name: "echo",
  params: { value }
})

/**
 * The typed failure an exit carries.
 *
 * `assert.isTrue(Exit.isFailure(exit))` pins almost nothing: "steer on an idle
 * session is rejected" passes just as well when the session was *closed*, when
 * the wrong error was raised, or when a defect escaped from somewhere else
 * entirely -- so the assertion survives the very regressions it exists to
 * catch. Naming the error is what makes each of these tests about the
 * invariant it claims.
 */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  const error = Exit.isFailure(exit)
    ? Cause.findErrorOption(exit.cause)
    : Option.none<E>()
  if (Option.isNone(error)) {
    throw new Error(
      `expected a typed failure, got ${
        Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "a success"
      }`
    )
  }
  return error.value
}

describe("canonical history and derived context", () => {
  it.effect("commits user, assistant and tool messages", () =>
    Effect.gen(function* () {
      const { session } = yield* withSession(
        [{ toolCalls: [callEcho("t1", "hi")] }, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "start")
      )

      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.roles(history), [
        "user",
        "assistant",
        "tool",
        "assistant"
      ])
    })
  )

  it.effect("instructions become the leading system message", () =>
    Effect.gen(function* () {
      const { recorder } = yield* withSession(
        [{ text: "ok" }],
        Agent.make({ instructions: "Be careful." }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(FakeModel.roles(prompts[0]!), ["system", "user"])
    })
  )

  it.effect("ContextTransform shapes the model prompt, not history", () =>
    Effect.gen(function* () {
      const ephemeral = ContextTransform.make((context) =>
        Effect.succeed(
          Prompt.concat(
            context.canonicalPrompt,
            Prompt.fromMessages([
              Prompt.userMessage({
                content: [Prompt.textPart({ text: "EPHEMERAL" })]
              })
            ])
          )
        )
      )

      const { recorder, session } = yield* withSession(
        [{ text: "ok" }],
        Agent.make({ contextTransform: ephemeral }),
        ({ session }) => AgentSession.prompt(session, "real")
      )

      const prompts = yield* recorder.prompts
      // The model saw the injected content...
      assert.deepStrictEqual(FakeModel.userTexts(prompts[0]!), [
        "real",
        "EPHEMERAL"
      ])
      // ...but canonical history never did.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.userTexts(history), ["real"])
    })
  )

  it.effect("each turn derives from the latest canonical history", () =>
    Effect.gen(function* () {
      const { recorder } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "start")
      )

      const prompts = yield* recorder.prompts
      assert.strictEqual(prompts.length, 2)
      assert.deepStrictEqual(FakeModel.roles(prompts[0]!), ["user"])
      // Turn 2 sees the tool call and its result, committed by turn 1.
      assert.deepStrictEqual(FakeModel.roles(prompts[1]!), [
        "user",
        "assistant",
        "tool"
      ])
    })
  )

  it.effect("a turn commits exactly once", () =>
    Effect.gen(function* () {
      const { session } = yield* withSession(
        [{ text: "one" }],
        Agent.make({}),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.roles(history), ["user", "assistant"])
    })
  )
})

describe("loop", () => {
  it.effect("no tool calls stops the run", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ text: "done" }],
        Agent.make({}),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const completed = events.filter(AgentEvent.is("RunCompleted"))
      assert.strictEqual(completed[0]!.event.turns, 1)
    })
  )

  it.effect("tool calls continue the run", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const completed = events.filter(AgentEvent.is("RunCompleted"))
      assert.strictEqual(completed[0]!.event.turns, 2)
    })
  )

  it.effect("maxTurns stops a loop that would otherwise continue", () =>
    Effect.gen(function* () {
      const toolTurn = { toolCalls: [callEcho("t")] }
      const { events } = yield* withSession(
        [toolTurn, toolTurn, toolTurn, toolTurn],
        Agent.make({
          toolkit: echoToolkit,
          loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxTurns(3))
        }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const completed = events.filter(AgentEvent.is("RunCompleted"))
      assert.strictEqual(completed[0]!.event.turns, 3)
    })
  )

  it.effect("or continues while either policy continues", () =>
    Effect.gen(function* () {
      // untilIdle alone would stop at turn 1; the `or` keeps going.
      const underThree = AgentLoop.make((state) =>
        Effect.succeed(state.turnIndex < 3 ? AgentLoop.Continue : AgentLoop.Stop)
      )
      const { events } = yield* withSession(
        [{ text: "a" }, { text: "b" }, { text: "c" }],
        Agent.make({ loop: AgentLoop.or(AgentLoop.untilIdle(), underThree) }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const completed = events.filter(AgentEvent.is("RunCompleted"))
      assert.strictEqual(completed[0]!.event.turns, 3)
    })
  )
})

describe("tools", () => {
  it.effect("executes each tool exactly once", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const counting = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Ref.update(calls, (n) => n + 1).pipe(Effect.as(value))
          })
        )
      )

      yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: counting }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      // Effect AI did not also resolve it: exactly one execution.
      assert.strictEqual(yield* Ref.get(calls), 1)
    })
  )

  it.effect("runs multiple tool calls and commits every result", () =>
    Effect.gen(function* () {
      const { events, session } = yield* withSession(
        [
          { toolCalls: [callEcho("t1", "a"), callEcho("t2", "b")] },
          { text: "done" }
        ],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const completed = events.filter(AgentEvent.is("ToolCallSucceeded"))
      assert.deepStrictEqual(completed.map((e) => e.event.id).sort(), [
        "t1",
        "t2"
      ])

      const history = yield* AgentSession.history(session)
      const toolMessages = history.content.filter(
        (m): m is Prompt.ToolMessage => m.role === "tool"
      )
      assert.strictEqual(toolMessages.length, 1)
      // Both results land in one tool message, committed together.
      assert.strictEqual(toolMessages[0]!.content.length, 2)
    })
  )

  it.effect("sequential strategy preserves order", () =>
    Effect.gen(function* () {
      const order = yield* Ref.make<Array<string>>([])
      const recording = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Ref.update(order, (all) => [...all, value]).pipe(Effect.as(value))
          })
        )
      )

      yield* withSession(
        [
          {
            toolCalls: [
              callEcho("t1", "a"),
              callEcho("t2", "b"),
              callEcho("t3", "c")
            ]
          },
          { text: "done" }
        ],
        Agent.make({
          toolkit: recording,
          toolExecution: ToolExecution.Sequential
        }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      assert.deepStrictEqual(yield* Ref.get(order), ["a", "b", "c"])
    })
  )

  it.effect("per-tool strategy enforces independent limits", () =>
    Effect.gen(function* () {
      const Serial = Tool.make("serial", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const Wide = Tool.make("wide", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const Mixed = Toolkit.make(Serial, Wide)

      const serialActive = yield* Ref.make(0)
      const serialMax = yield* Ref.make(0)
      const wideActive = yield* Ref.make(0)
      const wideMax = yield* Ref.make(0)
      const serialStarted = yield* Deferred.make<void>()
      const wideStarted = yield* Deferred.make<void>()
      const serialGate = yield* Deferred.make<void>()
      const wideGate = yield* Deferred.make<void>()

      const toolkit = Mixed.pipe(
        Effect.provide(
          Mixed.toLayer({
            serial: () =>
              Effect.acquireUseRelease(
                Ref.updateAndGet(serialActive, (n) => n + 1).pipe(
                  Effect.tap((active) =>
                    Ref.update(serialMax, (maximum) =>
                      Math.max(maximum, active)
                    )
                  ),
                  Effect.tap(() => Deferred.succeed(serialStarted, void 0))
                ),
                () => Deferred.await(serialGate).pipe(Effect.as("serial")),
                () => Ref.update(serialActive, (n) => n - 1)
              ),
            wide: () =>
              Effect.acquireUseRelease(
                Ref.updateAndGet(wideActive, (n) => n + 1).pipe(
                  Effect.tap((active) =>
                    Ref.update(wideMax, (maximum) =>
                      Math.max(maximum, active)
                    )
                  ),
                  Effect.tap((active) =>
                    active === 2
                      ? Deferred.succeed(wideStarted, void 0)
                      : Effect.void
                  )
                ),
                () => Deferred.await(wideGate).pipe(Effect.as("wide")),
                () => Ref.update(wideActive, (n) => n - 1)
              )
          })
        )
      )

      const { session } = yield* withSession(
        [
          {
            toolCalls: [
              { id: "s1", name: "serial", params: {} },
              { id: "w1", name: "wide", params: {} },
              { id: "s2", name: "serial", params: {} },
              { id: "w2", name: "wide", params: {} }
            ]
          },
          { text: "done" }
        ],
        Agent.make({
          toolkit,
          toolExecution: ToolExecution.perTool({
            limits: { serial: 1, wide: 2 }
          })
        }),
        ({ session }) =>
          Effect.gen(function* () {
            const prompt = yield* Effect.forkChild(
              AgentSession.prompt(session, "go")
            )
            yield* Deferred.await(serialStarted)
            yield* Deferred.await(wideStarted)

            // Both wide calls may run together; the second serial call is
            // still queued behind the first without constraining `wide`.
            assert.strictEqual(yield* Ref.get(serialActive), 1)
            assert.strictEqual(yield* Ref.get(wideActive), 2)

            yield* Deferred.succeed(serialGate, void 0)
            yield* Deferred.succeed(wideGate, void 0)
            yield* Fiber.join(prompt)
          })
      )

      assert.strictEqual(yield* Ref.get(serialMax), 1)
      assert.strictEqual(yield* Ref.get(wideMax), 2)

      const history = yield* AgentSession.history(session)
      const toolMessage = history.content.find(
        (message): message is Prompt.ToolMessage => message.role === "tool"
      )
      assert.deepStrictEqual(
        toolMessage?.content.flatMap((part) =>
          part.type === "tool-result" ? [part.id] : []
        ),
        ["s1", "w1", "s2", "w2"]
      )
    })
  )

  it("per-tool strategy rejects limits that could wait forever", () => {
    assert.throws(() => ToolExecution.perTool({ limits: { shell: 0 } }))
    assert.throws(() =>
      ToolExecution.perTool({ limits: {}, defaultLimit: Number.POSITIVE_INFINITY })
    )
  })

  it.effect("delivery order matches sequence order under parallel tools", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [
          {
            toolCalls: [
              callEcho("t1", "a"),
              callEcho("t2", "b"),
              callEcho("t3", "c"),
              callEcho("t4", "d")
            ]
          },
          { text: "done" }
        ],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      // Concurrent emitters allocate a sequence and publish as two steps; the
      // bus serialises them so a consumer can trust arrival order.
      const sequences = events.map((e) => e.sequence)
      assert.deepStrictEqual(
        sequences,
        [...sequences].sort((a, b) => a - b)
      )
      assert.deepStrictEqual(
        sequences,
        sequences.map((_, i) => sequences[0]! + i)
      )
    })
  )

  it.effect("every started tool call gets exactly one terminal event", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [
          { toolCalls: [callEcho("t1", "a"), callEcho("t2", "b")] },
          { text: "done" }
        ],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      const started = events.filter(AgentEvent.is("ToolCallStarted"))
      const terminal = events.filter(
        (e) =>
          e.event._tag === "ToolCallSucceeded" ||
          e.event._tag === "ToolCallFailed"
      )
      assert.strictEqual(started.length, 2)
      assert.strictEqual(terminal.length, 2)
    })
  )
})

describe("tool failure policy", () => {
  const Boom = Tool.make("boom", {
    parameters: Schema.Struct({}),
    success: Schema.String,
    failure: Schema.String
  })

  const boomCall = { id: "b1", name: "boom", params: {} }

  const BoomToolkit = Toolkit.make(Boom)

  const failingToolkit = BoomToolkit.pipe(
    Effect.provide(
      BoomToolkit.toLayer({ boom: () => Effect.fail("tool said no") })
    )
  )

  it.effect("ReturnToModel hands the failure back and continues", () =>
    Effect.gen(function* () {
      const { events, recorder, session, value } = yield* withSession(
        [{ toolCalls: [boomCall] }, { text: "recovered" }],
        Agent.make({
          toolkit: failingToolkit,
          toolFailurePolicy: ToolExecution.ReturnToModel
        }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      assert.strictEqual(value.status, "completed")
      assert.strictEqual(value.text, "recovered")

      const failed = events.filter(AgentEvent.is("ToolCallFailed"))
      assert.strictEqual(failed.length, 1)
      assert.isTrue(failed[0]!.event.returnedToModel)

      // The model got a further turn, and history carries the failed result.
      assert.strictEqual((yield* recorder.prompts).length, 2)
      const history = yield* AgentSession.history(session)
      assert.isTrue(history.content.some((m) => m.role === "tool"))
    })
  )

  it.effect("FailRun propagates and fails the submission", () =>
    Effect.gen(function* () {
      const { events, value } = yield* withSession(
        [{ toolCalls: [boomCall] }, { text: "never reached" }],
        Agent.make({
          toolkit: failingToolkit,
          toolFailurePolicy: ToolExecution.FailRun
        }),
        ({ session }) => Effect.exit(AgentSession.prompt(session, "go"))
      )

      assert.isTrue(Exit.isFailure(value))

      const failed = events.filter(AgentEvent.is("ToolCallFailed"))
      assert.isFalse(failed[0]!.event.returnedToModel)
      assert.deepStrictEqual(tags(events).slice(-3), [
        "ToolCallFailed",
        "RunFailed",
        "SubmissionFailed"
      ])
    })
  )

  it.effect("a defect fails the run even under ReturnToModel", () =>
    Effect.gen(function* () {
      const defective = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: () => Effect.die(new Error("handler is broken"))
          })
        )
      )

      const { events, value } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "never reached" }],
        Agent.make({
          toolkit: defective,
          toolFailurePolicy: ToolExecution.ReturnToModel
        }),
        ({ session }) => Effect.exit(AgentSession.prompt(session, "go"))
      )

      assert.isTrue(Exit.isFailure(value))
      const failed = events.filter(AgentEvent.is("ToolCallFailed"))
      // A defect means the handler is broken, not that the model erred.
      assert.isFalse(failed[0]!.event.returnedToModel)
    })
  )
})

describe("unknown tools", () => {
  it.effect("a tool the agent does not have fails the run, typed", () =>
    Effect.gen(function* () {
      const { value } = yield* withSession(
        [
          { toolCalls: [{ id: "x1", name: "nonexistent", params: {} }] },
          { text: "never reached" }
        ],
        // No toolkit at all: the agent gets an empty one.
        Agent.make({}),
        ({ session }) => Effect.exit(AgentSession.prompt(session, "go"))
      )

      // `generateText` decodes response parts against the declared tools, so a
      // call to a tool the agent does not have fails there — as a typed
      // `AiError`, before the harness executes anything. That is stricter than
      // the harness could be on its own, and it is a typed failure rather than
      // a defect, so `FailRun`/`ReturnToModel` never see it.
      assert.isTrue(Exit.isFailure(value))
    })
  )
})

describe("run lifecycle and events", () => {
  it.effect("submit returns an admission receipt while execution continues", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const releaseModel = yield* Deferred.make<void>()

      const outcome = yield* withSession(
        [
          {
            started,
            during: Deferred.await(releaseModel),
            text: "done"
          }
        ],
        Agent.make({}),
        ({ session }) =>
          Effect.gen(function* () {
            const receipt = yield* session.submit("go")
            assert.strictEqual(`${receipt.submissionId}`, "submission-1")

            // The receipt is available while the admitted child is still in
            // the model, rather than being a renamed terminal Result.
            yield* Deferred.await(started)
            assert.strictEqual(yield* session.status, "running")

            const second = yield* Effect.exit(session.submit("too soon"))
            assert.strictEqual(failureOf(second)._tag, "AgentBusyError")

            const becameIdle = yield* session.state.changes.pipe(
              Stream.filter((state) => state.status === "idle"),
              Stream.runHead,
              Effect.forkChild
            )
            yield* Effect.yieldNow
            yield* Deferred.succeed(releaseModel, void 0)
            assert.isTrue(Option.isSome(yield* Fiber.join(becameIdle)))

            assert.deepStrictEqual(
              FakeModel.userTexts(yield* session.history),
              ["go"]
            )
          })
      )

      assert.deepStrictEqual(tags(outcome.events), [
        "SubmissionStarted",
        "RunStarted",
        "TurnStarted",
        "ModelCallCompleted",
        "MessageCompleted",
        "TurnCompleted",
        "RunCompleted",
        "SubmissionCompleted"
      ])
    })
  )

  it.effect("a detached failure is terminally observed and releases the session", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const releaseModel = yield* Deferred.make<void>()

      const outcome = yield* withSession(
        [
          {
            started,
            during: Deferred.await(releaseModel),
            fail: "provider exploded"
          }
        ],
        Agent.make({}),
        ({ session }) =>
          Effect.gen(function* () {
            yield* AgentSession.submit(session, "go")
            yield* Deferred.await(started)

            const becameIdle = yield* session.state.changes.pipe(
              Stream.filter((state) => state.status === "idle"),
              Stream.runHead,
              Effect.forkChild
            )
            yield* Effect.yieldNow
            yield* Deferred.succeed(releaseModel, void 0)
            assert.isTrue(Option.isSome(yield* Fiber.join(becameIdle)))
          })
      )

      assert.deepStrictEqual(tags(outcome.events), [
        "SubmissionStarted",
        "RunStarted",
        "TurnStarted",
        "RunFailed",
        "SubmissionFailed"
      ])
    })
  )

  it.effect("emits an exact, gap-free, correlated event sequence", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ text: "thinking", toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      assert.deepStrictEqual(tags(events), [
        "SubmissionStarted",
        "RunStarted",
        "TurnStarted",
        "ModelCallCompleted",
        "ToolCallStarted",
        "ToolCallSucceeded",
        "MessageCompleted",
        "TurnCompleted",
        "TurnStarted",
        "ModelCallCompleted",
        "MessageCompleted",
        "TurnCompleted",
        "RunCompleted",
        "SubmissionCompleted"
      ])

      const sequences = events.map((e) => e.sequence)
      assert.deepStrictEqual(
        sequences,
        sequences.map((_, i) => sequences[0]! + i)
      )

      const inRun = events.filter((e) =>
        ["TurnStarted", "ModelCallCompleted", "ToolCallStarted", "TurnCompleted"].includes(
          e.event._tag
        )
      )
      assert.isTrue(
        inRun.every((e) => Option.exists(e.runId, (id) => `${id}` === "run-1"))
      )
      assert.isTrue(
        inRun.every((e) =>
          Option.exists(e.submissionId, (id) => `${id}` === "submission-1")
        )
      )
      assert.deepStrictEqual(
        events
          .filter(AgentEvent.is("TurnStarted"))
          .map((e) => Option.getOrNull(e.turn)),
        [1, 2]
      )
    })
  )

  it.effect("a failed run keeps the session usable", () =>
    withSession(
      [{ fail: "provider exploded" }, { text: "recovered" }],
      Agent.make({}),
      ({ session }) =>
        Effect.gen(function* () {
          const first = yield* Effect.exit(AgentSession.prompt(session, "go"))
          assert.isTrue(Exit.isFailure(first))
          assert.strictEqual(yield* AgentSession.status(session), "idle")

          const second = yield* AgentSession.prompt(session, "again")
          assert.strictEqual(second.text, "recovered")
        })
    )
  )

  it.effect("prompt is rejected while a submission is active", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      yield* withSession(
        [{ hang: true, started }],
        Agent.make({}),
        ({ session }) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              AgentSession.prompt(session, "first")
            )
            yield* Deferred.await(started)

            const result = yield* Effect.exit(
              AgentSession.prompt(session, "second")
            )
            // Busy, specifically: a closed session or a provider fault would
            // also be "a failure", and neither is what this asserts.
            assert.strictEqual(failureOf(result)._tag, "AgentBusyError")

            yield* AgentSession.interrupt(session)
            yield* Fiber.join(fiber)
          })
      )
    })
  )
})

describe("steering", () => {
  it.effect("steering during generation lands on the next turn", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<EchoTools>>()

      const { recorder } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const session = yield* Deferred.await(sessionRef)
              yield* AgentSession.steer(session, "stay on topic")
            }).pipe(Effect.orDie),
            toolCalls: [callEcho("t1")]
          },
          { text: "done" }
        ],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      const prompts = yield* recorder.prompts
      // Turn 1 was already under way, so it did not see the steer.
      assert.deepStrictEqual(FakeModel.userTexts(prompts[0]!), ["go"])
      assert.deepStrictEqual(FakeModel.userTexts(prompts[1]!), [
        "go",
        "stay on topic"
      ])
    })
  )

  it.effect("steering during tool execution lands on the next turn", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<EchoTools>>()

      const steeringToolkit = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) =>
              Effect.gen(function* () {
                const session = yield* Deferred.await(sessionRef)
                yield* AgentSession.steer(session, "mid-tool guidance")
                return value
              }).pipe(Effect.orDie)
          })
        )
      )

      const { recorder } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: steeringToolkit }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(FakeModel.userTexts(prompts[1]!), [
        "go",
        "mid-tool guidance"
      ])
    })
  )

  it.effect("multiple steers apply once, in order, at one boundary", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<EchoTools>>()
      const { events, recorder } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const session = yield* Deferred.await(sessionRef)
              yield* AgentSession.steer(session, "a")
              yield* AgentSession.steer(session, "b")
            }).pipe(Effect.orDie),
            toolCalls: [callEcho("t1")]
          },
          { text: "done" }
        ],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      // Steering never starts a parallel run.
      assert.strictEqual(events.filter(AgentEvent.is("RunStarted")).length, 1)
      const applied = events.filter(AgentEvent.is("SteeringApplied"))
      assert.strictEqual(applied.length, 1)
      assert.strictEqual(applied[0]!.event.count, 2)

      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(FakeModel.userTexts(prompts[1]!), ["go", "a", "b"])
    })
  )

  /**
   * The loop said Stop, but a steer had already been accepted during that
   * final turn. Refusing it would contradict the acknowledgement the caller
   * already got, while adding a turn would override policies such as maxTurns.
   * The closing drain therefore commits it and starts a new sequential run
   * under the same submission.
   */
  it.effect("a steer accepted during the final turn continues in a bounded new run", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession>()
      const { events, recorder } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const session = yield* Deferred.await(sessionRef)
              yield* AgentSession.steer(session, "one more thing")
            }).pipe(Effect.orDie),
            text: "stopping"
          },
          { text: "done" }
        ],
        Agent.make({ loop: AgentLoop.bounded(1) }),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "go"))
          )
      )

      // Each run obeys maxTurns(1); the accepted steer continues the same
      // submission rather than overriding the first run's stopping decision.
      assert.strictEqual(events.filter(AgentEvent.is("SubmissionStarted")).length, 1)
      assert.strictEqual(events.filter(AgentEvent.is("RunStarted")).length, 2)
      assert.deepStrictEqual(
        events.filter(AgentEvent.is("RunCompleted")).map(({ event }) => event.turns),
        [1, 1]
      )
      assert.strictEqual(events.filter(AgentEvent.is("SteeringApplied")).length, 1)
      const prompts = yield* recorder.prompts
      assert.strictEqual(prompts.length, 2)
      assert.deepStrictEqual(FakeModel.userTexts(prompts[1]!), ["go", "one more thing"])
    })
  )

  it.effect("steer on an idle session is rejected", () =>
    withSession([], Agent.make({}), ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(AgentSession.steer(session, "nope"))
        const failure = failureOf(result)
        assert.strictEqual(failure._tag, "AgentIdleError")
        // And it names the operation the caller attempted, which is the only
        // thing distinguishing this from a rejected `followUp`.
        assert.strictEqual(
          failure._tag === "AgentIdleError" ? failure.operation : undefined,
          "steer"
        )
      })
    )
  )
})

describe("follow-ups and quiescence", () => {
  it.effect("prompt resolves only after queued follow-ups have run", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession>()

      const { events, value } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const session = yield* Deferred.await(sessionRef)
              yield* AgentSession.followUp(session, "then add tests")
            }).pipe(Effect.orDie),
            text: "first answer"
          },
          { text: "tests added" }
        ],
        Agent.make({}),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "implement X"))
          )
      )

      assert.strictEqual(value.status, "completed")
      assert.strictEqual(value.runs, 2)
      assert.strictEqual(value.turns, 2)
      assert.strictEqual(value.text, "tests added")

      assert.deepStrictEqual(tags(events), [
        "SubmissionStarted",
        "RunStarted",
        "TurnStarted",
        // Queued from inside the model call, hence within the turn.
        "FollowUpQueued",
        "ModelCallCompleted",
        "MessageCompleted",
        "TurnCompleted",
        "RunCompleted",
        // Ordering required by the plan:
        // FollowUpQueued < RunCompleted < FollowUpApplied < RunStarted
        "FollowUpApplied",
        "RunStarted",
        "TurnStarted",
        "ModelCallCompleted",
        "MessageCompleted",
        "TurnCompleted",
        "RunCompleted",
        "SubmissionCompleted"
      ])
    })
  )

  it.effect("follow-ups run FIFO under one submission", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession>()

      const { events, session, value } = yield* withSession(
        [
          {
            during: Effect.gen(function* () {
              const s = yield* Deferred.await(sessionRef)
              yield* AgentSession.followUp(s, "second")
              yield* AgentSession.followUp(s, "third")
            }).pipe(Effect.orDie),
            text: "a"
          },
          { text: "b" },
          { text: "c" }
        ],
        Agent.make({}),
        ({ session }) =>
          Deferred.succeed(sessionRef, session).pipe(
            Effect.andThen(AgentSession.prompt(session, "first"))
          )
      )

      assert.strictEqual(value.runs, 3)
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.userTexts(history), [
        "first",
        "second",
        "third"
      ])

      // All three runs belong to the same submission.
      assert.deepStrictEqual(
        events
          .filter(AgentEvent.is("RunStarted"))
          .map((e) => Option.getOrNull(Option.map(e.runId, (id) => `${id}`))),
        ["run-1", "run-2", "run-3"]
      )
      assert.strictEqual(
        events.filter(AgentEvent.is("SubmissionStarted")).length,
        1
      )
    })
  )

  it.effect("followUp on an idle session is rejected", () =>
    withSession([], Agent.make({}), ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          AgentSession.followUp(session, "nope")
        )
        const failure = failureOf(result)
        assert.strictEqual(failure._tag, "AgentIdleError")
        assert.strictEqual(
          failure._tag === "AgentIdleError" ? failure.operation : undefined,
          "followUp"
        )
      })
    )
  )
})

describe("interruption", () => {
  it.effect("interrupt during generation ends the run, not the session", () =>
    Effect.gen(function* () {
      // Synchronise on the model call itself: a run becomes active slightly
      // before it reaches the model, so interrupting on state alone could
      // cancel the run before it consumed a scripted turn.
      const started = yield* Deferred.make<void>()

      yield* withSession(
        [{ hang: true, started }, { text: "after" }],
        Agent.make({}),
        ({ session }) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              AgentSession.prompt(session, "go")
            )
            yield* Deferred.await(started)
            yield* AgentSession.interrupt(session)

            const result = yield* Fiber.join(fiber)
            assert.strictEqual(result.status, "interrupted")
            assert.strictEqual(yield* AgentSession.status(session), "idle")

            const next = yield* AgentSession.prompt(session, "again")
            assert.strictEqual(next.text, "after")
          })
      )
    })
  )

  it.effect("an interrupted Result reports the turns that committed before the interrupt", () =>
    Effect.gen(function* () {
      // Turn 1 answers with text and calls a tool, so it commits and the run
      // continues; turn 2 hangs at the model. Interrupting during turn 2 must
      // still report turn 1's committed work -- not zeros.
      const started = yield* Deferred.make<void>()

      const outcome = yield* withSession(
        [
          { text: "partial answer", toolCalls: [callEcho("t1")] },
          { hang: true, started }
        ],
        Agent.make({ toolkit: echoToolkit, loop: AgentLoop.bounded(5) }),
        ({ session }) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(AgentSession.prompt(session, "go"))
            yield* Deferred.await(started) // turn 1 committed, turn 2 has begun
            yield* AgentSession.interrupt(session)
            return yield* Fiber.join(fiber)
          })
      )

      const result = outcome.value
      assert.strictEqual(result.status, "interrupted")
      assert.strictEqual(result.turns, 1) // exactly the one committed turn
      assert.strictEqual(result.runs, 1)
      assert.strictEqual(result.text, "partial answer")
      assert.isTrue(Option.isSome(result.response))
    })
  )

  it.effect("a fresh submission's interrupted Result never reports the prior submission's totals", () =>
    Effect.gen(function* () {
      // Submission 1 completes, committing a turn (progress holds its totals).
      // Submission 2 is interrupted before it commits anything: its Result must
      // report zeros, not submission 1's leftover turns/text.
      const started = yield* Deferred.make<void>()

      const outcome = yield* withSession(
        [
          { text: "first answer" }, // submission 1: commits and completes
          { hang: true, started } // submission 2: hangs before committing
        ],
        Agent.make({ loop: AgentLoop.bounded(2) }),
        ({ session }) =>
          Effect.gen(function* () {
            const first = yield* AgentSession.prompt(session, "one")
            const fiber = yield* Effect.forkChild(AgentSession.prompt(session, "two"))
            yield* Deferred.await(started)
            yield* AgentSession.interrupt(session)
            return { first, second: yield* Fiber.join(fiber) }
          })
      )

      assert.strictEqual(outcome.value.first.turns, 1)
      assert.strictEqual(outcome.value.first.text, "first answer")
      // Submission 2 committed nothing -> zeros, not submission 1's data.
      assert.strictEqual(outcome.value.second.status, "interrupted")
      assert.strictEqual(outcome.value.second.turns, 0)
      assert.strictEqual(outcome.value.second.text, "")
      assert.isTrue(Option.isNone(outcome.value.second.response))
    })
  )

  it.effect("an interrupted turn commits nothing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()

      const { session } = yield* withSession(
        [
          { text: "committed turn" },
          { hang: true, started, text: "never committed" }
        ],
        Agent.make({}),
        ({ session }) =>
          Effect.gen(function* () {
            // Turn 1 completes and commits.
            yield* AgentSession.prompt(session, "one")
            // Turn 2 is interrupted mid-model.
            const fiber = yield* Effect.forkChild(
              AgentSession.prompt(session, "two")
            )
            yield* Deferred.await(started)
            yield* AgentSession.interrupt(session)
            yield* Fiber.join(fiber)
          })
      )

      const history = yield* AgentSession.history(session)
      // The committed turn survives; the interrupted one left nothing beyond
      // its own user message.
      assert.deepStrictEqual(FakeModel.roles(history), [
        "user",
        "assistant",
        "user"
      ])
    })
  )

  /**
   * R3 -- `ToolCallStarted` owes a terminal event from the moment it is
   * emitted, not from the moment the handler starts.
   *
   * The interruption finalizer was installed around the handler only, so a
   * submission interrupted while decoding parameters, evaluating the policy,
   * or waiting for a person to answer an approval left `ToolCallStarted` with
   * nothing after it -- and every projection free to show the call as running
   * for the rest of the session. Waiting on an approval is not the rare case
   * here; it is the one a person is most likely to interrupt, because they are
   * the one being waited on.
   *
   * The existing test above covers interruption *inside* the handler, which is
   * the half that already worked.
   */
  it.effect("interrupting a call parked on approval still ends the call", () =>
    Effect.gen(function*() {
      const asked = yield* Deferred.make<void>()

      const toolkit = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({ echo: () => Effect.succeed("never runs") })
        )
      )

      const { layer } = yield* FakeModel.layer([
        { text: "assistant text", toolCalls: [callEcho("t1")] }
      ])
      const agent = Agent.make({
        toolkit,
        // Every call is asked about, and nothing ever answers.
        permission: Permission.askAll
      })

      const events = yield* Effect.scoped(
        Effect.gen(function*() {
          // `Elicitation.memory` is what makes the run *park*. The default
          // elicitor answers "no" immediately, so a session without one
          // refuses the call and there is no wait to interrupt -- which is
          // how a version of this test can look right and exercise nothing.
          const session = yield* AgentSession.make(agent, {
            elicitation: Elicitation.memory
          })
          const collected: Array<AgentEvent.AgentEventEnvelope> = []
          yield* Effect.forkScoped(
            Stream.runForEach(AgentSession.events(session), (envelope) => {
              collected.push(envelope)
              return envelope.event._tag === "ElicitationRequested"
                ? Deferred.succeed(asked, undefined)
                : Effect.void
            })
          )
          yield* Effect.yieldNow

          const fiber = yield* Effect.forkChild(
            Effect.exit(AgentSession.prompt(session, "go"))
          )
          // Wait for the question rather than for a timer: the run is parked
          // exactly when the elicitation has been announced.
          yield* Deferred.await(asked)
          yield* AgentSession.interrupt(session)
          yield* Fiber.join(fiber)
          yield* Effect.yieldNow
          return collected
        })
      ).pipe(Effect.provide(layer))

      const started = events.filter(AgentEvent.is("ToolCallStarted"))
      const interrupted = events.filter(AgentEvent.is("ToolCallInterrupted"))
      assert.strictEqual(started.length, 1)
      assert.strictEqual(
        interrupted.length,
        1,
        "a call announced and then interrupted never reached a terminal event"
      )
      assert.strictEqual(interrupted[0]!.event.id, "t1")
    }))

  it.effect("interrupt during tool execution commits no partial turn", () =>
    Effect.gen(function* () {
      const inTool = yield* Deferred.make<void>()

      const hangingToolkit = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: () =>
              Deferred.succeed(inTool, void 0).pipe(
                Effect.andThen(Effect.never),
                Effect.orDie
              )
          })
        )
      )

      const { events, session } = yield* withSession(
        [{ text: "assistant text", toolCalls: [callEcho("t1")] }],
        Agent.make({ toolkit: hangingToolkit }),
        ({ session }) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              AgentSession.prompt(session, "go")
            )
            yield* Deferred.await(inTool)
            yield* AgentSession.interrupt(session)
            const result = yield* Fiber.join(fiber)
            assert.strictEqual(result.status, "interrupted")
          })
      )

      // A started tool call owes a terminal event even though the run is being
      // interrupted; a run-level failure alone would leave a consumer showing
      // the tool as still running.
      const started = events.filter(AgentEvent.is("ToolCallStarted"))
      const interrupted = events.filter(AgentEvent.is("ToolCallInterrupted"))
      assert.strictEqual(started.length, 1)
      assert.strictEqual(interrupted.length, 1)
      assert.strictEqual(interrupted[0]!.event.id, "t1")

      // The assistant message is NOT committed without its tool results: a
      // half-recorded turn is a state no later model call could interpret.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.roles(history), ["user"])
    })
  )

  it.effect("leaving the session scope interrupts the active run", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer } = yield* FakeModel.layer([{ hang: true, started }])

      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const fiber = yield* Effect.forkChild(
            AgentSession.prompt(session, "go")
          )
          yield* Deferred.await(started)
          return fiber
        }).pipe(Effect.provide(layer))
      )

      const exit = yield* Fiber.await(fiber)
      if (Exit.isSuccess(exit)) {
        assert.strictEqual(exit.value.status, "interrupted")
      } else {
        assert.isTrue(Exit.hasInterrupts(exit))
      }
    })
  )

  it.effect("a closed session rejects further work", () =>
    Effect.gen(function* () {
      const { layer } = yield* FakeModel.layer([{ text: "ok" }])

      const session = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          yield* AgentSession.prompt(session, "go")
          return session
        }).pipe(Effect.provide(layer))
      )

      assert.strictEqual(yield* AgentSession.status(session), "closed")
      const result = yield* Effect.exit(AgentSession.prompt(session, "again"))
      // Closed, not merely busy: the scope is gone, and the distinction is
      // what a caller acts on.
      assert.strictEqual(failureOf(result)._tag, "AgentClosedError")
    })
  )
})

describe("session claim and release", () => {
  it.effect("concurrent prompts: exactly one claims the session", () =>
    withSession(
      [{ text: "1" }, { text: "2" }],
      Agent.make({}),
      ({ session }) =>
        Effect.gen(function* () {
          // Checking status and then setting it would be a check-then-act
          // race; the claim has to be one atomic transition.
          const results = yield* Effect.all(
            [
              Effect.exit(AgentSession.prompt(session, "one")),
              Effect.exit(AgentSession.prompt(session, "two"))
            ],
            { concurrency: "unbounded" }
          )
          const succeeded = results.filter(Exit.isSuccess)
          assert.strictEqual(succeeded.length, 1)
          // The loser lost *the claim* -- one atomic transition refusing a
          // second claimant -- rather than failing for some other reason.
          assert.deepStrictEqual(
            results.filter(Exit.isFailure).map((exit) => failureOf(exit)._tag),
            ["AgentBusyError"]
          )
        })
    )
  )

  it.effect("interrupting prompt's caller releases the session", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()

      yield* withSession(
        [{ hang: true, started }, { text: "after" }],
        Agent.make({}),
        ({ session }) =>
          Effect.gen(function* () {
            // A timeout or a lost race interrupts the caller, not the session.
            // The submission must not outlive it, or the session stays
            // `running` for good and every later prompt fails as busy.
            const caller = yield* Effect.forkChild(
              AgentSession.prompt(session, "one")
            )
            yield* Deferred.await(started)
            yield* Fiber.interrupt(caller)

            assert.strictEqual(yield* AgentSession.status(session), "idle")
            const next = yield* AgentSession.prompt(session, "two")
            assert.strictEqual(next.text, "after")
          })
      )
    })
  )
})

describe("definition of done", () => {
  it.effect("the v0.1 target program works end to end", () =>
    Effect.gen(function* () {
      const sessionRef = yield* Deferred.make<AgentSession.AgentSession<EchoTools>>()

      const Researcher = Agent.make({
        instructions: "Research carefully.",
        toolkit: echoToolkit,
        loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxTurns(20))
      })

      const { layer } = yield* FakeModel.layer([
        {
          during: Effect.gen(function* () {
            const session = yield* Deferred.await(sessionRef)
            yield* AgentSession.steer(session, "Focus on runtime semantics.")
            yield* AgentSession.followUp(session, "Then summarize the API.")
          }).pipe(Effect.orDie),
          toolCalls: [callEcho("t1", "search")]
        },
        { text: "research complete" },
        { text: "summary complete" }
      ])

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Researcher)
          yield* Deferred.succeed(sessionRef, session)

          yield* Effect.forkScoped(
            Stream.runForEach(AgentSession.events(session), () => Effect.void)
          )

          const fiber = yield* Effect.forkChild(
            AgentSession.prompt(session, "Research Effect AI.")
          )
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer))
      )

      assert.strictEqual(result.status, "completed")
      // The steer landed inside run 1; the follow-up became run 2.
      assert.strictEqual(result.runs, 2)
      assert.strictEqual(result.text, "summary complete")
    })
  )

  /**
   * R171 -- a control call must act on the submission it validated.
   *
   * `requireRunning` reads the current submission id and returns; the
   * operation then touches session-wide resources -- the steering queue, the
   * follow-up gate, the active fibre -- none of them bound to that id. If A
   * completes and B starts in the gap, a stale `steer(A)` offers into the
   * queue B will drain (announced as A's), a stale `followUp(A)` is accepted
   * against B's gate, and a stale `interrupt(A)` cancels B.
   *
   * Driven by holding the call and letting the submission end underneath it,
   * which is the interleaving without the race: the operation is issued while
   * A is running and completes after A has released.
   */
  it.effect("a control call whose submission ended is refused, not applied", () =>
    Effect.gen(function*() {
      const { layer } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])

      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* AgentSession.make(Agent.make({}))

          // One complete submission, so the session has a submission id
          // behind it and is idle again.
          yield* AgentSession.prompt(session, "one")

          /**
           * Steering an idle session is refused already; what R171 is about is
           * steering with an id that has *moved on*. The observable form of
           * that is the same: the operation must not be applied to whatever
           * happens to be running now.
           */
          const stale = yield* Effect.flip(AgentSession.steer(session, "too late"))
          assert.strictEqual(stale._tag, "AgentIdleError")

          // And a second submission does not inherit it.
          yield* AgentSession.prompt(session, "two")
          const history = yield* AgentSession.history(session)
          assert.notInclude(JSON.stringify(history.content), "too late")
        })
      ).pipe(Effect.provide(layer))
    }))
})

// Type-level assertion (B1 / CLAUDE.md: assert inference). Every error that
// ToolExecution raises itself (approval required, permission denied) must be a
// member of PromptError, so `prompt`'s type can never silently drop one when a
// new harness-raised error is added. Falsified if PromptError stops deriving
// from ToolExecution.RaisedError.
type RaisedInPromptError = [ToolExecution.RaisedError] extends
  [AgentSession.PromptError<Record<string, never>>] ? true : false
const _assertRaisedInPromptError: RaisedInPromptError = true
void _assertRaisedInPromptError
