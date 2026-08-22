import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Ref, Scope, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as InputChannel from "../src/InputChannel.js"
import * as FakeModel from "./FakeModel.js"
import { EchoToolkit, echoToolkit, withSession } from "./helpers.js"

const callEcho = (id: string, value = "x") => ({
  id,
  name: "echo",
  params: { value }
})

describe("edge cases", () => {
  it.effect("an empty prompt still produces a well-formed submission", () =>
    Effect.gen(function* () {
      const { events, session, value } = yield* withSession(
        [{ text: "ok" }],
        Agent.make({}),
        ({ session }) => AgentSession.prompt(session, "")
      )
      assert.strictEqual(value.status, "completed")
      // An empty user message is still a message: history must not skip it.
      assert.deepStrictEqual(
        FakeModel.roles(yield* AgentSession.history(session)),
        ["user", "assistant"]
      )
      assert.strictEqual(events.filter(AgentEvent.is("RunStarted")).length, 1)
    })
  )

  it.effect("a tool-only response emits no MessageCompleted", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      // Turn 1 produced no text; a blank message event would be noise.
      assert.strictEqual(
        events.filter(AgentEvent.is("MessageCompleted")).length,
        1
      )
    })
  )

  it.effect("maxTurns(1) stops after exactly one turn", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ toolCalls: [callEcho("t1")] }, { text: "unreachable" }],
        Agent.make({
          toolkit: echoToolkit,
          loop: AgentLoop.and(AgentLoop.untilIdle(), AgentLoop.maxTurns(1))
        }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      assert.strictEqual(
        events.filter(AgentEvent.is("RunCompleted"))[0]!.event.turns,
        1
      )
    })
  )

  it.effect("a failed context transform leaves no stray TurnStarted", () =>
    Effect.gen(function* () {
      const failing = ContextTransform.make(() =>
        Effect.fail(new Error("no context") as never)
      )
      const { events, value } = yield* withSession(
        [{ text: "never" }],
        Agent.make({ contextTransform: failing }),
        ({ session }) => Effect.exit(AgentSession.prompt(session, "go"))
      )
      assert.isTrue(Exit.isFailure(value))
      // PLAN §14: derivation precedes TurnStarted precisely so a failed
      // transform cannot leave a TurnStarted with no TurnCompleted.
      assert.strictEqual(events.filter(AgentEvent.is("TurnStarted")).length, 0)
      assert.strictEqual(events.filter(AgentEvent.is("RunFailed")).length, 1)
    })
  )

  it.effect("steering after quiescence is rejected, not held for the next run", () =>
    Effect.gen(function* () {
      const { session } = yield* withSession(
        [{ text: "one" }, { text: "two" }],
        Agent.make({}),
        ({ session }) =>
          Effect.gen(function* () {
            yield* AgentSession.prompt(session, "first")
            const rejected = yield* Effect.exit(
              AgentSession.steer(session, "orphan")
            )
            assert.isTrue(Exit.isFailure(rejected))
            yield* AgentSession.prompt(session, "second")
          })
      )
      // The orphaned steer must not surface inside the later submission.
      const history = yield* AgentSession.history(session)
      assert.deepStrictEqual(FakeModel.userTexts(history), ["first", "second"])
    })
  )

  it.effect("a fixed session id does not make two sessions share state", () =>
    Effect.gen(function* () {
      const { layer } = yield* FakeModel.layer([{ text: "a" }, { text: "b" }])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const one = yield* AgentSession.make(Agent.make({}), {
            sessionId: "fixed"
          })
          const two = yield* AgentSession.make(Agent.make({}), {
            sessionId: "fixed"
          })
          // Sharing an id is legal and independent, so a durable runtime that
          // keys on the id must not assume uniqueness.
          yield* AgentSession.prompt(one, "x")
          assert.strictEqual(yield* AgentSession.status(two), "idle")
          const history = yield* AgentSession.history(two)
          assert.deepStrictEqual(FakeModel.userTexts(history), [])
        }).pipe(Effect.provide(layer))
      )
    })
  )

  it.effect("channels are created per session and per name", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<string>>([])
      const recording: InputChannel.Factory = {
        make: (sessionId, name) =>
          Effect.tap(InputChannel.memory.make(sessionId, name), () =>
            Ref.update(seen, (all) => [...all, sessionId + ":" + name])
          )
      }
      const { layer } = yield* FakeModel.layer([])
      yield* Effect.scoped(
        AgentSession.make(Agent.make({}), {
          sessionId: "s1",
          channels: recording
        }).pipe(Effect.provide(layer))
      )
      assert.deepStrictEqual(yield* Ref.get(seen), [
        "s1:steering",
        "s1:followUps"
      ])
    })
  )

  it.effect("repeated interrupts do not wedge the session", () =>
    Effect.gen(function* () {
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
            // A second interrupt races the release; either outcome is fine so
            // long as the session ends up usable.
            yield* Effect.exit(AgentSession.interrupt(session))
            yield* Fiber.join(fiber)

            assert.strictEqual(yield* AgentSession.status(session), "idle")
            const next = yield* AgentSession.prompt(session, "again")
            assert.strictEqual(next.text, "after")
          })
      )
    })
  )

  it.effect("event sequences are unique and ordered under parallel work", () =>
    Effect.gen(function* () {
      const toolTurn = { toolCalls: [callEcho("t1"), callEcho("t2")] }
      const { events } = yield* withSession(
        [toolTurn, toolTurn, { text: "done" }],
        Agent.make({ toolkit: echoToolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const sequences = events.map((e) => e.sequence)
      assert.strictEqual(new Set(sequences).size, sequences.length)
      assert.deepStrictEqual(
        sequences,
        [...sequences].sort((a, b) => a - b)
      )
    })
  )

  it.effect("correlation is present only from the level that owns it", () =>
    Effect.gen(function* () {
      const { events } = yield* withSession(
        [{ text: "ok" }],
        Agent.make({}),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      // A submission knows its own id but belongs to no run or turn.
      const submission = events.find(AgentEvent.is("SubmissionStarted"))!
      assert.isTrue(Option.isSome(submission.submissionId))
      assert.isTrue(Option.isNone(submission.runId))
      assert.isTrue(Option.isNone(submission.turn))

      // A run knows its submission and itself, but not a turn.
      const run = events.find(AgentEvent.is("RunStarted"))!
      assert.isTrue(Option.isSome(run.runId))
      assert.isTrue(Option.isNone(run.turn))

      // A turn knows all three.
      const turn = events.find(AgentEvent.is("TurnStarted"))!
      assert.deepStrictEqual(Option.getOrNull(turn.turn), 1)
      assert.isTrue(Option.isSome(turn.runId))
      assert.isTrue(Option.isSome(turn.submissionId))
    })
  )

  it.effect("a tool returning the final result commits exactly that", () =>
    Effect.gen(function* () {
      const streaming = EchoToolkit.pipe(
        Effect.provide(
          EchoToolkit.toLayer({
            echo: ({ value }) => Effect.succeed("final-" + value)
          })
        )
      )
      const { events } = yield* withSession(
        [{ toolCalls: [callEcho("t1", "v")] }, { text: "done" }],
        Agent.make({ toolkit: streaming }),
        ({ session }) => AgentSession.prompt(session, "go")
      )
      const succeeded = events.filter(AgentEvent.is("ToolCallSucceeded"))
      assert.strictEqual(succeeded.length, 1)
      assert.strictEqual(succeeded[0]!.event.result, "final-v")
    })
  )

  it.effect("state is observable but not writable", () =>
    Effect.gen(function* () {
      const { layer } = yield* FakeModel.layer([{ text: "ok" }])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Agent.make({}))
          const view = AgentSession.state(session)

          // Observation works.
          const before = yield* view.get
          assert.strictEqual(before.status, "idle")

          // @ts-expect-error the view exposes no way to write to session state
          view.set

          yield* AgentSession.prompt(session, "go")
          const after = yield* view.get
          assert.strictEqual(after.status, "idle")

          // History is deliberately NOT in the runtime state view: it is read
          // through its own accessor, so a status subscriber is not handed the
          // whole transcript on every turn.
          assert.notProperty(after, "history")
          assert.deepStrictEqual(
            FakeModel.userTexts(yield* AgentSession.history(session)),
            ["go"]
          )
        }).pipe(Effect.provide(layer))
      )
    })
  )

  it.effect("status subscribers are not woken by history growth", () =>
    Effect.gen(function* () {
      // The reason history lives in its own Ref: a UI watching progress should
      // not receive an ever-growing transcript on every turn.
      const observed = yield* Ref.make<Array<string>>([])
      const { layer } = yield* FakeModel.layer([
        { text: "one" },
        { text: "two" }
      ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            Agent.make({
              loop: (state) =>
                Effect.succeed(
                  state.turnIndex < 2
                    ? { _tag: "Continue" }
                    : { _tag: "Stop" }
                )
            })
          )

          yield* Effect.forkScoped(
            Stream.runForEach(
              AgentSession.state(session).changes,
              (state) =>
                Ref.update(observed, (all) => [
                  ...all,
                  `${state.status}:${state.turn}`
                ])
            )
          )
          yield* Effect.yieldNow

          yield* AgentSession.prompt(session, "go")
        }).pipe(Effect.provide(layer))
      )

      // Every emission describes runtime progress only; none carries history.
      const seen = yield* Ref.get(observed)
      assert.isAbove(seen.length, 0)
      assert.isTrue(seen.every((entry) => /^(idle|running|closed):\d+$/.test(entry)))
    })
  )
})

describe("closing a session with work in flight", () => {
  it.effect("the submission's terminal event precedes SessionClosed", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const { layer } = yield* FakeModel.layer([
        { text: "unused", hang: true, started: entered }
      ])
      const seen = yield* Ref.make<Array<string>>([])

      const tags = yield* Effect.scoped(
        Effect.gen(function* () {
          const inner = yield* Scope.make()
          const session = yield* AgentSession.make(Agent.make({})).pipe(
            Scope.provide(inner)
          )
          // The observer outlives the session: it is in this scope, the
          // session in `inner`.
          const observer = yield* Effect.forkScoped(
            Stream.runForEach(AgentSession.events(session), (event) =>
              Ref.update(seen, (all) => [...all, event.event._tag])
            )
          )
          yield* Effect.yieldNow
          // The caller goes away first — a timed-out request, a lost race —
          // so nobody is around to report the outcome but the submission
          // fibre itself.
          const caller = yield* Effect.forkDetach(AgentSession.prompt(session, "go"))
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(caller)
          yield* Scope.close(inner, Exit.void)
          yield* Fiber.interrupt(observer)
          return yield* Ref.get(seen)
        }).pipe(Effect.provide(layer))
      )

      const interrupted = tags.indexOf("SubmissionInterrupted")
      const closed = tags.indexOf("SessionClosed")
      assert.isTrue(interrupted >= 0, `no SubmissionInterrupted in ${tags}`)
      assert.isTrue(
        interrupted < closed,
        `SessionClosed must come last: ${tags}`
      )
    })
  )
})
