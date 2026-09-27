import { assert, describe, it } from "@effect/vitest"
import { expectTypeOf } from "vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AiError, Prompt, Tool } from "effect/unstable/ai"
import { PersistedQueue } from "effect/unstable/persistence"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Budget from "../src/budget/Budget.js"
import { DurableToolUnresolvedError } from "../src/durable/DurableToolkit.js"
import { Messaging, SessionInbox, Supervisor } from "../src/sessions/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * `plan-supervision.md` §4.1: an agent consulted where the supervisor would
 * give up. The properties worth pinning are that the supervisor waits and
 * then does what the agent decided, that the limits the plan calls hard
 * survive the conversation, and that an agent which never answers cannot
 * leave the tree stuck.
 */

class Broken extends Schema.TaggedError<Broken>()("Broken", {}) {}

const retryable = AiError.make({ module: "Test", method: "generate", reason: new AiError.RateLimitError({}) })

/** Fails with `error` on the first `times` starts, then succeeds. Counts its starts. */
const flaky = (error: unknown, times: number) =>
  Effect.map(Ref.make(0), (starts) => ({
    starts: Ref.get(starts),
    run: Effect.flatMap(Ref.updateAndGet(starts, (n) => n + 1), (n) => n <= times ? Effect.fail(error) : Effect.void)
  }))

/** A control whose `notify` hands each situation to the test, which decides through its operations. */
const consulted = Effect.gen(function*() {
  const control = yield* Supervisor.control()
  const situations = yield* Ref.make<ReadonlyArray<string>>([])
  const told = yield* Ref.make(yield* Deferred.make<string>())
  return {
    control,
    notify: (message: string) =>
      Effect.gen(function*() {
        yield* Ref.update(situations, (all) => [...all, message])
        yield* Deferred.succeed(yield* Ref.get(told), message)
      }),
    /** The next situation the supervisor reports. */
    next: Effect.gen(function*() {
      const situation = yield* Deferred.await(yield* Ref.get(told))
      yield* Ref.set(told, yield* Deferred.make<string>())
      return situation
    }),
    list: control.list,
    inspect: control.inspect,
    restart: control.restart,
    stop: control.stop,
    steer: control.steer,
    start: control.start,
    resume: control.resume,
    giveUp: control.giveUp
  }
})

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons[0]
  if (reason === undefined || reason._tag !== "Fail") throw new Error(`not a failure: ${String(reason?._tag)}`)
  return reason.error
}

describe("Supervisor with an agent (§4.1)", () => {
  it.effect("where it would give up, it asks; the agent restarts the child and the supervisor carries on", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const a = yield* flaky(new Broken(), 1)
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [Supervisor.child("a", a.run)]
      }))
      const situation = yield* agent.next
      assert.include(situation, "Supervisor team needs a decision.")
      assert.include(situation, "Child a failed in a way its classifier would not restart")
      assert.include(yield* agent.list, "a: failed, 1 start(s)")
      assert.strictEqual(yield* agent.restart("a"), "restart a")
      yield* agent.resume("one more try")
      const report = yield* Fiber.join(fiber)
      assert.deepStrictEqual(report.children, [{ id: "a", starts: 2 }])
      assert.deepStrictEqual(report.decisions, [
        { child: "a", reason: "failure", actions: ["restart a"], outcome: "resumed", note: Option.some("one more try") }
      ])
    }))

  it.effect("a restart the agent asks for runs in the supervisor's context, not the caller's", () =>
    Effect.gen(function*() {
      class Db extends Context.Service<Db, { readonly name: string }>()("test/Db") {}
      const agent = yield* consulted
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const a = yield* flaky(new Broken(), 1)
      // `Db` is the supervisor's; the fibre that calls `restart` below does
      // not have it, as an agent's tool fibre would not.
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [
          Supervisor.child("a", Effect.gen(function*() {
            yield* Ref.update(seen, (all) => [...all, "started"])
            const db = yield* Effect.service(Db)
            yield* Ref.update(seen, (all) => [...all, db.name])
            yield* a.run
          }))
        ]
      }).pipe(Effect.provideService(Db, { name: "the supervisor's db" })))
      yield* agent.next
      yield* agent.restart("a")
      yield* agent.resume()
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(yield* Ref.get(seen), ["started", "the supervisor's db", "started", "the supervisor's db"])
    }))

  it.effect("give_up escalates, with the agent's reason", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* agent.next
      yield* agent.giveUp("the input is malformed")
      const error = failureOf(yield* Fiber.await(fiber))
      assert.strictEqual(error.reason, "failure")
      assert.include(error.detail, "the supervising agent gave up: the input is malformed")
    }))

  it.effect("an agent that never decides cannot stall the tree: the timeout gives up", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "5 minutes" }),
        children: [Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* agent.next
      yield* TestClock.adjust("5 minutes")
      const error = failureOf(yield* Fiber.await(fiber))
      assert.include(error.detail, "the supervising agent did not decide within 5m")
      // The control is released when the supervisor ends.
      assert.include(yield* Effect.flip(agent.list), "no supervisor is attached")
    }))

  it.effect("an unknown tool outcome cannot be restarted by the agent either", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const starts = yield* Ref.make(0)
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute", grant: { restarts: 5 } }),
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
      assert.include(yield* agent.next, "left a tool outcome unknown")
      assert.include(yield* Effect.flip(agent.restart("a")), "could repeat that side effect")
      yield* agent.giveUp("a person has to check the card")
      assert.strictEqual(failureOf(yield* Fiber.await(fiber)).reason, "unresolved")
      assert.strictEqual(yield* Ref.get(starts), 1)
    }))

  it.effect("past the restart limit the agent restarts only within its allowance", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const a = yield* flaky(retryable, 100)
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        intensity: { maxRestarts: 1, within: "1 minute" },
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute", grant: { restarts: 1 } }),
        children: [Supervisor.child("a", a.run)]
      }))
      // Start, one automatic restart, then the limit.
      assert.include(yield* agent.next, "exceeded the restart intensity")
      assert.strictEqual(yield* agent.restart("a"), "restart a")
      yield* agent.resume()
      assert.include(yield* agent.next, "exceeded the restart intensity")
      assert.include(yield* Effect.flip(agent.restart("a")), "no allowance is left")
      yield* agent.giveUp("it keeps being rate limited")
      yield* Fiber.await(fiber)
      assert.strictEqual(yield* a.starts, 3)
    }))

  it.effect("the tools that change anything act only while a decision is pending", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      assert.include(yield* Effect.flip(agent.restart("a")), "no supervisor is attached")
      const release = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [Supervisor.child("a", Deferred.await(release))]
      }))
      yield* Effect.yieldNow
      assert.include(yield* agent.list, "a: running")
      for (const change of [agent.restart("a"), agent.stop("a"), agent.resume()]) {
        assert.include(yield* Effect.flip(change), "is not waiting for a decision")
      }
      yield* Deferred.succeed(release, void 0)
      assert.deepStrictEqual((yield* Fiber.join(fiber)).decisions, [])
    }))

  it.effect("one control serves one running supervisor", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const release = yield* Deferred.make<void>()
      const ask = Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" })
      const first = yield* Effect.forkChild(
        Supervisor.run({ name: "first", onGiveUp: ask, children: [Supervisor.child("a", Deferred.await(release))] })
      )
      yield* Effect.yieldNow
      const second = yield* Effect.exit(Supervisor.run({ name: "second", onGiveUp: ask, children: [] }))
      assert.isTrue(Exit.isFailure(second))
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(first)
    }))

  it.effect("instructions are refused for a child that cannot take them", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* agent.next
      assert.include(yield* Effect.flip(agent.restart("a", "be careful")), "takes no instructions")
      yield* agent.giveUp("done")
      yield* Fiber.await(fiber)
    }))

  it.live("a task can be inspected, and a fresh restart starts from the agent's note", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const { layer: model, recorder } = yield* TestLanguageModel.script([
        { failWith: "server error" },
        TestLanguageModel.text("done")
      ])
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        classify: () => "escalate",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [
          Supervisor.task("research", Agent.make({ instructions: "You research." }), { prompt: "look", provide: model })
        ]
      }))
      yield* agent.next
      const seen = yield* agent.inspect("research")
      assert.include(seen, "research: failed, 1 start(s)")
      assert.include(seen, "user: look")
      yield* agent.restart("research", "search one source at a time")
      yield* agent.resume()
      const report = yield* Fiber.join(fiber)
      assert.deepStrictEqual(report.children, [{ id: "research", starts: 2 }])
      const retry = (yield* recorder.prompts)[1]!
      const system = retry.content.flatMap((message) =>
        message.role === "system" && typeof message.content === "string" ? [message.content] : [])
      assert.deepStrictEqual(system, [
        "You research.",
        "A note from your supervisor, for this attempt: search one source at a time"
      ])
    }))

  it.live("a resubmit task asks the same session again, so a retry sees the failed attempt", () =>
    Effect.gen(function*() {
      const { layer: model, recorder } = yield* TestLanguageModel.script([
        { failWith: "server error" },
        TestLanguageModel.text("done")
      ])
      const report = yield* Supervisor.run({
        name: "team",
        children: [Supervisor.task("research", Agent.make({}), { prompt: "look", provide: model, mode: "resubmit" })]
      })
      assert.deepStrictEqual(report.children, [{ id: "research", starts: 2 }])
      assert.deepStrictEqual(TestLanguageModel.userTexts((yield* recorder.prompts)[1]!), ["look", "look"])
    }))

  it.live("end to end: a scripted supervising agent decides through its tools", () =>
    Effect.gen(function*() {
      const control = yield* Supervisor.control()
      const { layer: leadModel } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("restart_child", { id: "a" }),
        TestLanguageModel.toolCall("resume", { note: "retrying once" }),
        TestLanguageModel.text("handled")
      ])
      const a = yield* flaky(new Broken(), 1)
      const report = yield* Effect.scoped(Effect.gen(function*() {
        const lead = yield* AgentSession.make(Agent.make({ tools: control.tools })).pipe(Effect.provide(leadModel))
        return yield* Supervisor.run({
          name: "team",
          onGiveUp: Supervisor.ask({
            control,
            // The lead is idle whenever the supervisor asks, here.
            notify: (message) =>
              AgentSession.framework(lead, Prompt.fromMessages([Prompt.systemMessage({ content: message })])).pipe(
                Effect.orDie,
                Effect.asVoid
              ),
            timeout: "1 minute"
          }),
          children: [Supervisor.child("a", a.run)]
        })
      }))
      assert.deepStrictEqual(report.decisions, [
        { child: "a", reason: "failure", actions: ["restart a"], outcome: "resumed", note: Option.some("retrying once") }
      ])
      assert.strictEqual(yield* a.starts, 2)
    }))

  it.effect("toInbox puts the situation in the agent's inbox as a framework system message", () =>
    Effect.gen(function*() {
      const notify = yield* Supervisor.toInbox("lead")
      yield* notify("decide, please")
      const queue = yield* PersistedQueue.make({ name: Messaging.defaultName, schema: SessionInbox.Item })
      const item = yield* queue.take((taken) => Effect.succeed(taken))
      assert.strictEqual(item.sessionId, "lead")
      assert.strictEqual(item.kind, "framework")
      assert.deepStrictEqual(item.source, { kind: "supervisor" })
      const message = item.input.content[0]
      assert.isTrue(message?.role === "system" && message.content === "decide, please")
    }).pipe(Effect.provide(PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory)))))

  it.live("steer_child reaches a running task at its next turn, framed as the supervisor's", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const inTool = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const Wait = Tool.make("wait", { parameters: Schema.Struct({}), success: Schema.String })
      const writer = Agent.make({
        tools: [Agent.tool(Wait, () => Effect.andThen(Deferred.succeed(inTool, void 0), Effect.as(Deferred.await(gate), "waited")))]
      })
      const { layer: model, recorder } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("wait", {}),
        TestLanguageModel.text("written")
      ])
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [
          Supervisor.task("writer", writer, { prompt: "write it", provide: model }),
          Supervisor.child("a", Effect.fail(new Broken()))
        ]
      }))
      yield* Deferred.await(inTool)
      yield* agent.next
      assert.strictEqual(yield* agent.steer("writer", "focus on the introduction"), "steer writer")
      yield* Deferred.succeed(gate, void 0)
      yield* agent.resume()
      const report = yield* Fiber.join(fiber)
      assert.deepStrictEqual(report.decisions[0]!.actions, ["steer writer"])
      const second = (yield* recorder.prompts)[1]!
      assert.include(TestLanguageModel.userTexts(second), "A note from your supervisor: focus on the introduction")
    }))

  it.effect("steer_child is refused for a child that is not a running task", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const release = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [Supervisor.child("plain", Deferred.await(release)), Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* agent.next
      assert.include(yield* Effect.flip(agent.steer("plain", "hi")), "not an agent task")
      assert.include(yield* Effect.flip(agent.steer("a", "hi")), "is not running")
      yield* Deferred.succeed(release, void 0)
      yield* agent.resume()
      yield* Fiber.join(fiber)
    }))

  it.effect("start_child starts a child from a template, named by the supervisor", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const inputs = yield* Ref.make<ReadonlyArray<string>>([])
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        templates: {
          helper: {
            description: "Looks one thing up.",
            make: ({ id, input }) => Supervisor.child(id, Ref.update(inputs, (all) => [...all, input]))
          }
        },
        // A spec child already named as the first helper would be.
        children: [Supervisor.child("helper-1", Effect.void), Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* agent.next
      assert.include(yield* agent.list, "- helper: Looks one thing up.")
      assert.strictEqual(yield* agent.start("helper", "the release date"), "helper-2")
      yield* agent.resume()
      const report = yield* Fiber.join(fiber)
      assert.deepStrictEqual(report.children.map((entry) => entry.id), ["helper-1", "a", "helper-2"])
      assert.deepStrictEqual(report.decisions[0]!.actions, ["start helper-2"])
      assert.deepStrictEqual(yield* Ref.get(inputs), ["the release date"])
    }))

  it.effect("start_child refuses an unknown template, past its cap, and once the budget is spent", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        maxTemplateStarts: 1,
        templates: { helper: { description: "Helps.", make: ({ id }) => Supervisor.child(id, Effect.never) } },
        children: [Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* agent.next
      assert.include(yield* Effect.flip(agent.start("wizard", "x")), "there is no template wizard; the templates are helper")
      yield* agent.start("helper", "x")
      assert.include(yield* Effect.flip(agent.start("helper", "y")), "no more may be")
      yield* agent.giveUp("done")
      yield* Fiber.await(fiber)

      const spent = yield* consulted
      const second = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        maxTokens: 0,
        onGiveUp: Supervisor.ask({ control: spent.control, notify: spent.notify, timeout: "1 minute" }),
        templates: { helper: { description: "Helps.", make: ({ id }) => Supervisor.child(id, Effect.void) } },
        children: [Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* spent.next
      assert.include(yield* Effect.flip(spent.start("helper", "x")), "spent their token budget")
      yield* spent.giveUp("done")
      yield* Fiber.await(second)
    }))

  it.effect("classify can ask: the agent decides an exit the rules would have restarted", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const a = yield* flaky(retryable, 1)
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        classify: () => "ask",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [Supervisor.child("a", a.run)]
      }))
      assert.include(yield* agent.next, "(the classifier asked for a decision)")
      yield* agent.restart("a")
      yield* agent.resume()
      assert.deepStrictEqual((yield* Fiber.join(fiber)).decisions.map((decision) => decision.outcome), ["resumed"])

      // With nobody to ask, asking is escalating.
      const alone = yield* Effect.exit(Supervisor.run({
        name: "alone",
        classify: () => "ask",
        children: [Supervisor.child("a", Effect.fail(retryable))]
      }))
      assert.strictEqual(failureOf(alone).reason, "failure")
    }))

  it.effect("the allowance lifts the restart limit, never the budget", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const starts = yield* Ref.make(0)
      // The second start spends past the ceiling, then fails: the restart
      // limit is what the supervisor gives up on, and the budget is spent too.
      const run = Effect.gen(function*() {
        const n = yield* Ref.updateAndGet(starts, (count) => count + 1)
        if (n === 2) yield* (yield* Effect.service(Budget.Budget)).spend(100, "second-start")
        return yield* retryable
      })
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        maxTokens: 50,
        intensity: { maxRestarts: 1, within: "1 minute" },
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute", grant: { restarts: 3 } }),
        children: [Supervisor.child("a", run)]
      }).pipe(Effect.provide(Budget.fresh())))
      assert.include(yield* agent.next, "exceeded the restart intensity")
      assert.include(yield* Effect.flip(agent.restart("a")), "spent their token budget")
      yield* agent.giveUp("out of budget")
      yield* Fiber.await(fiber)
      assert.strictEqual(yield* Ref.get(starts), 2)
    }))

  it.effect("a decision is made once: a second answer is refused, not reported as taken", () =>
    Effect.gen(function*() {
      const agent = yield* consulted
      const fiber = yield* Effect.forkChild(Supervisor.run({
        name: "team",
        onGiveUp: Supervisor.ask({ control: agent.control, notify: agent.notify, timeout: "1 minute" }),
        children: [Supervisor.child("a", Effect.fail(new Broken()))]
      }))
      yield* agent.next
      // Both in one batch, as a model might call them.
      const [first, second, late] = yield* Effect.all([
        Effect.result(agent.resume()),
        Effect.result(agent.giveUp("no")),
        Effect.result(agent.restart("a"))
      ])
      assert.strictEqual(first._tag, "Success")
      assert.strictEqual(second._tag, "Failure")
      if (second._tag === "Failure") assert.include(second.failure, "already made")
      // A change after the answer is refused too: it would act on a decision
      // the supervisor has already taken.
      assert.strictEqual(late._tag, "Failure")
      assert.deepStrictEqual((yield* Fiber.join(fiber)).decisions.map((decision) => decision.outcome), ["resumed"])
    }))

  it("the tools need nothing from context", () => {
    const control = Effect.runSync(Supervisor.control())
    expectTypeOf<Agent.ServicesOf<typeof control.tools>>().toEqualTypeOf<never>()
  })
})
