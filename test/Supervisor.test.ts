import { assert, describe, it } from "@effect/vitest"
import { expectTypeOf } from "vitest"
import { Context, Deferred, Effect, Exit, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AiError } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import { DurableToolUnresolvedError } from "../src/durable/DurableToolkit.js"
import { Supervisor } from "../src/sessions/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `plan-supervision.md` §4. The properties worth pinning are OTP's -- who a
 * failure restarts, and when the supervisor gives up -- and the two the plan
 * adds for agents: the failure decides whether a restart is safe, and an
 * unknown tool outcome is never restarted whatever the classifier says.
 */

const retryable = AiError.make({ module: "Test", method: "generate", reason: new AiError.RateLimitError({}) })

class Broken extends Schema.TaggedError<Broken>()("Broken", {}) {}

/** Fails with `error` on the first `times` starts, then succeeds. Counts its starts. */
const flaky = (error: unknown, times: number) =>
  Effect.map(Ref.make(0), (starts) => ({
    starts: Ref.get(starts),
    run: Effect.flatMap(Ref.updateAndGet(starts, (n) => n + 1), (n) =>
      n <= times ? Effect.fail(error) : Effect.void)
  }))

const escalation = <A>(exit: Exit.Exit<A, Supervisor.SupervisorEscalatedError>) => {
  assert.isTrue(Exit.isFailure(exit), "the supervisor should have given up")
  if (Exit.isSuccess(exit)) throw new Error("unreachable")
  const reason = exit.cause.reasons[0]
  if (reason === undefined || reason._tag !== "Fail") throw new Error(`not a failure: ${String(reason?._tag)}`)
  return reason.error
}

describe("Supervisor", () => {
  it.effect("a retryable failure is restarted, and the supervisor ends when every child has exited", () =>
    Effect.gen(function*() {
      const a = yield* flaky(retryable, 1)
      const report = yield* Supervisor.run({
        name: "top",
        children: [Supervisor.child("a", a.run), Supervisor.child("b", Effect.void)]
      })
      assert.deepStrictEqual(report.children, [{ id: "a", starts: 2 }, { id: "b", starts: 1 }])
    }))

  it.effect("an unretryable failure escalates by default, and stops the siblings", () =>
    Effect.gen(function*() {
      const stopped = yield* Deferred.make<void>()
      const exit = yield* Effect.exit(Supervisor.run({
        name: "top",
        children: [
          Supervisor.child("sibling", Effect.onInterrupt(Effect.never, () => Deferred.succeed(stopped, void 0))),
          Supervisor.child("a", Effect.fail(new Broken()))
        ]
      }))
      const error = escalation(exit)
      assert.strictEqual(error.reason, "failure")
      assert.strictEqual(error.child, "a")
      assert.isTrue(yield* Deferred.isDone(stopped), "the sibling was left running")
    }))

  it.effect("an unknown tool outcome escalates even when classify would restart it", () =>
    Effect.gen(function*() {
      const starts = yield* Ref.make(0)
      const exit = yield* Effect.exit(Supervisor.run({
        name: "top",
        classify: () => "restart",
        children: [
          Supervisor.child(
            "a",
            Effect.andThen(
              Ref.update(starts, (n) => n + 1),
              Effect.die(new DurableToolUnresolvedError({ toolName: "charge_card", toolCallId: "c1" }))
            )
          )
        ]
      }))
      assert.strictEqual(escalation(exit).reason, "unresolved")
      assert.strictEqual(yield* Ref.get(starts), 1, "a child with an unknown side effect was started again")
    }))

  it.effect("more than maxRestarts within the window escalates", () =>
    Effect.gen(function*() {
      const a = yield* flaky(retryable, 100)
      const exit = yield* Effect.exit(Supervisor.run({
        name: "top",
        intensity: { maxRestarts: 2, within: "1 minute" },
        children: [Supervisor.child("a", a.run)]
      }))
      assert.strictEqual(escalation(exit).reason, "intensity")
      assert.strictEqual(yield* a.starts, 3)
    }))

  it.effect("restarts older than the window do not count", () =>
    Effect.gen(function*() {
      // Each failure comes two minutes after the last, so a window of one
      // minute never holds more than one restart.
      const a = yield* flaky(retryable, 3)
      const report = yield* Supervisor.run({
        name: "top",
        intensity: { maxRestarts: 1, within: "1 minute" },
        children: [Supervisor.child("a", Effect.andThen(TestClock.adjust("2 minutes"), a.run))]
      })
      assert.deepStrictEqual(report.children, [{ id: "a", starts: 4 }])
    }))

  it.effect("one_for_all restarts every running sibling, but never a temporary one", () =>
    Effect.gen(function*() {
      const a = yield* flaky(retryable, 1)
      const b = yield* Ref.make(0)
      const c = yield* Ref.make(0)
      const report = yield* Supervisor.run({
        name: "top",
        strategy: "one_for_all",
        children: [
          // Started after `b` and `c`, so both are running when it fails.
          Supervisor.child(
            "b",
            Effect.flatMap(Ref.updateAndGet(b, (n) => n + 1), (n) => (n === 1 ? Effect.never : Effect.void))
          ),
          Supervisor.child("c", Effect.andThen(Ref.update(c, (n) => n + 1), Effect.never), { restart: "temporary" }),
          Supervisor.child("a", a.run)
        ]
      })
      assert.deepStrictEqual(report.children, [{ id: "b", starts: 2 }, { id: "c", starts: 1 }, { id: "a", starts: 2 }])
    }))

  it.effect("rest_for_one restarts the children after the one that failed, not before", () =>
    Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      const before = yield* Ref.make(0)
      const after = yield* Ref.make(0)
      const b = yield* flaky(retryable, 1)
      const report = yield* Supervisor.run({
        name: "top",
        strategy: "rest_for_one",
        children: [
          Supervisor.child("a", Effect.andThen(Ref.update(before, (n) => n + 1), Deferred.await(release))),
          Supervisor.child("b", b.run),
          // Its second start is the restart; it lets `a` finish.
          Supervisor.child(
            "c",
            Effect.flatMap(Ref.updateAndGet(after, (n) => n + 1), (n) =>
              n === 1 ? Effect.never : Deferred.succeed(release, void 0))
          )
        ]
      })
      assert.deepStrictEqual(report.children, [{ id: "a", starts: 1 }, { id: "b", starts: 2 }, { id: "c", starts: 2 }])
    }))

  it.effect("a permanent child is restarted after a normal exit, and counts toward intensity", () =>
    Effect.gen(function*() {
      const starts = yield* Ref.make(0)
      const exit = yield* Effect.exit(Supervisor.run({
        name: "top",
        intensity: { maxRestarts: 2, within: "1 minute" },
        children: [Supervisor.child("a", Ref.update(starts, (n) => n + 1), { restart: "permanent" })]
      }))
      assert.strictEqual(escalation(exit).reason, "intensity")
      assert.strictEqual(yield* Ref.get(starts), 3)
    }))

  it.effect("a temporary child that fails is neither restarted nor escalated", () =>
    Effect.gen(function*() {
      const report = yield* Supervisor.run({
        name: "top",
        children: [Supervisor.child("a", Effect.fail(new Broken()), { restart: "temporary" })]
      })
      assert.deepStrictEqual(report.children, [{ id: "a", starts: 1 }])
    }))

  it.effect("a nested supervisor's escalation is its parent's child failure, and escalates up", () =>
    Effect.gen(function*() {
      const inner = Supervisor.run({ name: "inner", children: [Supervisor.child("leaf", Effect.fail(new Broken()))] })
      const exit = yield* Effect.exit(Supervisor.run({ name: "outer", children: [Supervisor.child("inner", inner)] }))
      const error = escalation(exit)
      assert.strictEqual(error.supervisor, "outer")
      assert.strictEqual(error.child, "inner")
      assert.include(error.detail, "supervisor inner gave up: child leaf")
    }))

  it.effect("a duplicate child id is refused before anything starts", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Supervisor.run({
        name: "top",
        children: [Supervisor.child("a", Effect.void), Supervisor.child("a", Effect.void)]
      }))
      assert.isTrue(Exit.isFailure(exit))
    }))

  it.live("a task restarts on a retryable provider failure, in a fresh session", () =>
    Effect.gen(function*() {
      const { layer: model, recorder } = yield* TestLanguageModel.script([
        { failWith: "server error" },
        TestLanguageModel.text("done")
      ])
      const report = yield* Supervisor.run({
        name: "top",
        children: [Supervisor.task("research", Agent.make({}), { prompt: "look into it", provide: model })]
      })
      assert.deepStrictEqual(report.children, [{ id: "research", starts: 2 }])
      // A fresh session: the retry's prompt holds the task once, not twice.
      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[1]!), ["look into it"])
    }))

  it.live("a restart is refused once the children have spent maxTokens", () =>
    Effect.gen(function*() {
      const { layer: model } = yield* TestLanguageModel.script([
        { text: "first pass", usage: { input: 60, output: 40 } },
        TestLanguageModel.text("never reached")
      ])
      const exit = yield* Effect.exit(Supervisor.run({
        name: "top",
        maxTokens: 50,
        children: [
          Supervisor.task("research", Agent.make({}), { prompt: "look", provide: model, restart: "permanent" })
        ]
      }))
      const error = escalation(exit)
      assert.strictEqual(error.reason, "budget")
      assert.include(error.detail, "100 of 50 tokens spent")
    }))

  it("run requires exactly what its children require", () => {
    class Db extends Context.Service<Db, { readonly query: Effect.Effect<void> }>()("test/Db") {}
    const spec = {
      name: "top",
      children: [
        Supervisor.child("a", Effect.flatMap(Effect.service(Db), (db) => db.query)),
        Supervisor.child("b", Effect.void)
      ]
    } as const
    expectTypeOf(Supervisor.run(spec)).toEqualTypeOf<
      Effect.Effect<Supervisor.Report, Supervisor.SupervisorEscalatedError, Db>
    >()
  })
})
