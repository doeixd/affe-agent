import { assert, describe, it } from "@effect/vitest"
import { Cron, Deferred, Effect, Layer, Option, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Agent from "../src/Agent.js"
import * as AgentInput from "../src/AgentInput.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { Scheduling } from "../src/scheduling/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Scheduling over Effect's own primitives, driven by TestClock so no real time
 * passes. Runs are synchronised through the scripted model's `started` Deferred
 * (fires when a turn begins), so every assertion is exact: a dispatched job runs
 * only after its delay, and a recurring run fires per interval and survives a
 * failing run.
 */

const Simple = Agent.make({ loop: AgentLoop.bounded(2) })

const TicketSchema = Schema.Struct({ customerId: Schema.String, body: Schema.String })
const Ticket = AgentInput.make(TicketSchema, ({ body }) => `A customer writes:\n\n${body}`)
const ticket = { customerId: "c-42", body: "my order is late" }
const rendering = "A customer writes:\n\nmy order is late"
const Support = Agent.make({ input: Ticket, loop: AgentLoop.bounded(1) })

/**
 * Typed input (issue #81): a dispatched job carries `AgentInput.typed(value)`,
 * whoever runs it decodes with the agent's schema, and the model sees the
 * rendering. A value the schema rejects fails that run, isolated like any
 * other failing run.
 */
describe("Scheduling with a typed agent", () => {
  it.effect("the local dispatcher decodes the value and the model sees the rendering", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model, recorder } = yield* TestLanguageModel.script([{ text: "done", started }])
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: AgentInput.typed(ticket) })
        yield* Deferred.await(started)
      }).pipe(
        Effect.provide(Layer.merge(Scheduling.local(Support).pipe(Layer.provide(model)), TestClock.layer())),
        Effect.scoped
      )
      const prompts = yield* recorder.prompts
      assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[0]!), [rendering])
      assert.notInclude(JSON.stringify(prompts[0]), "c-42")
    })
  )

  it.effect("a queued job persists the value, and a worker renders it", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model, recorder } = yield* TestLanguageModel.script([{ text: "done", started }])
      const store = yield* Scheduling.memoryStore
      yield* Scheduling.dispatch({ input: AgentInput.typed(ticket) }).pipe(Effect.provide(Scheduling.queued(store)))
      // The store holds the value, not a rendering: rendering is the worker's.
      const due = yield* store.claimDue(Number.MAX_SAFE_INTEGER)
      assert.deepStrictEqual(due.map((job) => job.input), [ticket])
      assert.deepStrictEqual(TestLanguageModel.userTexts(due[0]!.prompt), [])
      yield* Effect.forEach(due, (job) => store.enqueue(job))
      yield* Effect.gen(function* () {
        yield* Effect.forkScoped(Scheduling.worker(Support, store, { pollInterval: "1 millis" }))
        yield* Deferred.await(started)
      }).pipe(Effect.provide(model), Effect.scoped)
      assert.deepStrictEqual(TestLanguageModel.userTexts((yield* recorder.prompts)[0]!), [rendering])
    })
  )

  it.effect("a value the schema rejects fails its run and nothing else; a prompt to a typed agent likewise", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model, recorder } = yield* TestLanguageModel.script([{ text: "done", started }])
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: AgentInput.typed({ customerId: 42 }) })
        yield* Scheduling.dispatch({ input: "a prompt" })
        yield* Scheduling.dispatch({ input: AgentInput.typed(ticket) })
        yield* Deferred.await(started)
      }).pipe(
        Effect.provide(Layer.merge(Scheduling.local(Support).pipe(Layer.provide(model)), TestClock.layer())),
        Effect.scoped
      )
      // Only the well-formed job reached the model.
      assert.strictEqual(yield* recorder.calls, 1)
    })
  )

  it.effect("recurring takes the schema's type", () =>
    Effect.gen(function* () {
      const s1 = yield* Deferred.make<void>()
      const { layer: model, recorder } = yield* TestLanguageModel.script([{ text: "one", started: s1 }])
      yield* Effect.gen(function* () {
        yield* Effect.forkScoped(Scheduling.recurring(Support, ticket, Schedule.fixed("1 hour")))
        yield* Deferred.await(s1)
      }).pipe(Effect.provide(Layer.merge(model, TestClock.layer())), Effect.scoped)
      assert.deepStrictEqual(TestLanguageModel.userTexts((yield* recorder.prompts)[0]!), [rendering])
    })
  )
})

/** Type-level: the recurring input is the schema's type; a string is refused. */
export const _recurringIsTyped = () => ({
  // @ts-expect-error -- a string is not a Ticket
  wrong: Scheduling.recurring(Support, "tick", Schedule.fixed("1 hour")),
  // @ts-expect-error -- a Ticket is not Prompt.RawInput
  wrongForSimple: Scheduling.recurring(Simple, ticket, Schedule.fixed("1 hour"))
})

describe("Scheduling.local dispatcher", () => {
  it.effect("a job with no delay runs promptly", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done", started }])
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: "go" })
        // Reaching here means the forked run reached the model -> it ran.
        yield* Deferred.await(started)
      }).pipe(
        Effect.provide(Layer.merge(Scheduling.local(Simple).pipe(Layer.provide(model)), TestClock.layer())),
        Effect.scoped
      )
    })
  )

  it.effect("a delayed job runs only after its delay elapses", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done", started }])
      // One TestClock shared by the dispatcher's fibre (which sleeps on it) and
      // this test's `adjust` -- built once so both see the same virtual time.
      const clock = Layer.succeedContext(yield* Layer.build(TestClock.layer()))
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: "go", delay: "1 hour" })
        yield* Effect.yieldNow // let the job reach its delay
        // Half the delay in: still waiting.
        yield* TestClock.adjust("30 minutes")
        assert.isTrue(Option.isNone(yield* Deferred.poll(started)))
        // The delay elapses: the job wakes and runs.
        yield* TestClock.adjust("30 minutes")
        yield* Deferred.await(started)
      }).pipe(
        Effect.provide(Layer.merge(
          Scheduling.local(Simple).pipe(Layer.provide(Layer.merge(model, clock))),
          clock
        )),
        Effect.scoped
      )
    }).pipe(Effect.scoped)
  )

  it.effect("a failing job is isolated: it does not stop the dispatcher or sibling jobs", () =>
    Effect.gen(function* () {
      const s1 = yield* Deferred.make<void>()
      const s2 = yield* Deferred.make<void>()
      const s3 = yield* Deferred.make<void>()
      // Second dispatched run fails; the dispatcher must survive it and keep
      // serving further jobs (and the first job already ran independently).
      const { layer: model } = yield* TestLanguageModel.script([
        { text: "one", started: s1 },
        { fail: "boom", started: s2 },
        { text: "three", started: s3 }
      ])
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: "a" })
        yield* Deferred.await(s1)
        yield* Scheduling.dispatch({ input: "b" }) // this run fails
        yield* Deferred.await(s2)
        yield* Scheduling.dispatch({ input: "c" }) // dispatcher still works
        // Reaching s3 proves the failing run did not break the dispatcher.
        yield* Deferred.await(s3)
      }).pipe(
        Effect.provide(Layer.merge(Scheduling.local(Simple).pipe(Layer.provide(model)), TestClock.layer())),
        Effect.scoped
      )
    })
  )

  it.effect("a delayed job is interrupted when the layer scope closes, and never runs", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done", started }])
      // Dispatch with a long delay, then close the scope WITHOUT advancing the
      // clock: the forked job is still sleeping and is interrupted, never runs.
      yield* Effect.gen(function* () {
        yield* Scheduling.dispatch({ input: "go", delay: "1 hour" })
        yield* Effect.yieldNow // let the job reach its delay
      }).pipe(
        Effect.provide(Layer.merge(Scheduling.local(Simple).pipe(Layer.provide(model)), TestClock.layer())),
        Effect.scoped
      )
      // Scope closed while the job slept -> it was interrupted before the model.
      assert.isTrue(Option.isNone(yield* Deferred.poll(started)))
    })
  )
})

// Type-level assertion (CLAUDE.md: assert inference, do not trust that it compiled):
// `recurring` over `Schedule.cron` carries the schedule's `CronParseError` in its
// error channel. If it did not, `cronError` would not be assignable to `RecurringError`.
const _recurringCron = Scheduling.recurring(Simple, "x", Schedule.cron("0 9 * * *"))
type RecurringError = [typeof _recurringCron] extends [Effect.Effect<unknown, infer Err, unknown>] ? Err : never
// `true` only if the schedule's CronParseError is present in the error channel.
type _CronErrorInChannel = Cron.CronParseError extends RecurringError ? true : never
const _assertCronErrorInChannel: _CronErrorInChannel = true
void _assertCronErrorInChannel

describe("Scheduling.recurring", () => {
  it.effect("fires once per interval and a failing run does not stop the schedule", () =>
    Effect.gen(function* () {
      const s1 = yield* Deferred.make<void>()
      const s2 = yield* Deferred.make<void>()
      const s3 = yield* Deferred.make<void>()
      // The first run starts, then dies; recurring must catch it and keep going.
      const { layer: model } = yield* TestLanguageModel.script([
        { fail: "boom", started: s1 },
        { text: "two", started: s2 },
        { text: "three", started: s3 }
      ])
      yield* Effect.gen(function* () {
        yield* Effect.forkScoped(Scheduling.recurring(Simple, "tick", Schedule.fixed("1 hour")))
        // Run 1 (the failing one) fires immediately.
        yield* Deferred.await(s1)
        yield* Effect.yieldNow // let the fibre reach the next scheduled sleep
        // The schedule continued despite the failure: run 2, then run 3.
        yield* TestClock.adjust("1 hour")
        yield* Deferred.await(s2)
        yield* Effect.yieldNow
        yield* TestClock.adjust("1 hour")
        yield* Deferred.await(s3)
      }).pipe(
        Effect.provide(Layer.merge(model, TestClock.layer())),
        Effect.scoped
      )
    })
  )
})

describe("Scheduling.queued (queue-backed, durable when the store is)", () => {
  it.effect("dispatch persists a job with the right due time; a worker is what runs it", () =>
    Effect.gen(function* () {
      const store = yield* Scheduling.memoryStore
      yield* Scheduling.dispatch({ input: "later", delay: "1 hour" }).pipe(
        Effect.provide(Scheduling.queued(store))
      )
      // now = 0 under TestClock, so the job is due at 3_600_000ms.
      assert.deepStrictEqual(yield* store.claimDue(0), [])
      const due = yield* store.claimDue(3_600_000)
      assert.strictEqual(due.length, 1)
      assert.deepStrictEqual(TestLanguageModel.userTexts(due[0]!.prompt), ["later"])
      // claimDue is claim-and-take: a second claim finds nothing left.
      assert.deepStrictEqual(yield* store.claimDue(3_600_000), [])
    }).pipe(Effect.provide(TestClock.layer()))
  )

  it.effect("a dispatched job outlives the dispatcher's scope (survives 'restart')", () =>
    Effect.gen(function* () {
      const store = yield* Scheduling.memoryStore
      // The dispatcher layer is built and torn down entirely...
      yield* Effect.scoped(
        Scheduling.dispatch({ input: "go" }).pipe(Effect.provide(Scheduling.queued(store)))
      )
      // ...yet the job is still in the store, claimable by a fresh worker.
      const due = yield* store.claimDue(0)
      assert.strictEqual(due.length, 1)
    }).pipe(Effect.provide(TestClock.layer()))
  )

  it.effect("a worker over the shared store runs a job the dispatcher queued", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { layer: model } = yield* TestLanguageModel.script([{ text: "done", started }])
      const store = yield* Scheduling.memoryStore

      yield* Effect.gen(function* () {
        // "Process A": dispatch, then vanish (no worker of its own).
        yield* Scheduling.dispatch({ input: "go" }).pipe(Effect.provide(Scheduling.queued(store)))
        // "Process B": a worker over the same store claims and runs it.
        yield* Effect.forkScoped(Scheduling.worker(Simple, store, { pollInterval: "1 millis" }))
        // Reaching here means the worker ran the job and reached the model.
        yield* Deferred.await(started)
      }).pipe(Effect.provide(model), Effect.scoped)
    })
  )
})

describe("Scheduling.worker resilience", () => {
  // `it.live`: the worker polls on a real interval, so the loop must actually
  // advance between claims -- which is the whole point being tested.
  it.live("a hung job does not stall the worker from claiming and running later jobs", () =>
    Effect.gen(function* () {
      const startedA = yield* Deferred.make<void>()
      const startedB = yield* Deferred.make<void>()
      // Job A hangs at the model forever; job B answers. If the worker awaited
      // its batch (rather than forking each run), A would wedge it and B would
      // never run. Forking keeps the loop draining.
      const { layer: model } = yield* TestLanguageModel.script([
        { hang: true, started: startedA },
        { text: "second", started: startedB }
      ])
      const store = yield* Scheduling.memoryStore

      yield* Effect.gen(function* () {
        yield* Effect.forkScoped(Scheduling.worker(Simple, store, { pollInterval: "1 millis" }))
        yield* Scheduling.dispatch({ input: "a" }).pipe(Effect.provide(Scheduling.queued(store)))
        yield* Deferred.await(startedA) // A is claimed, running, and now hung
        yield* Scheduling.dispatch({ input: "b" }).pipe(Effect.provide(Scheduling.queued(store)))
        // Reaching here means the worker claimed and ran B despite A hanging.
        yield* Deferred.await(startedB)
      }).pipe(Effect.provide(model), Effect.scoped)
    })
  )
})
