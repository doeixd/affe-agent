import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Layer, Option, Queue, Schedule, Schema } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import * as Agent from "../src/Agent.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import { envelope } from "./DeliveryLogContract.js"
import * as FakeModel from "./FakeModel.js"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))
const SoakGate = DurableDeferred.make("DurabilitySoakGate", {
  success: Schema.String
})

type GateSignal = {
  readonly sessionId: string
  readonly token: DurableDeferred.Token
}

/**
 * H9 is intentionally bounded enough for CI and large enough to exercise the
 * interactions that scenario tests miss: many workflow identities sharing one
 * engine, a backlog of parked executions, terminal interrupts, and a consumer
 * that never assumes its connection stays up.
 */
describe("H9 durability soak", () => {
  it.live("keeps D1-D6 true across load, resumptions, interrupts, and reconnects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resumptions = 24
        const interruptions = 8
        const ordinary = 176
        const successful = resumptions + ordinary
        const ready = yield* Queue.unbounded<GateSignal>()

        const pauseFirstTurn = ContextTransform.make((context) =>
          Effect.gen(function* () {
            const shouldGate = context.sessionId.startsWith("resume-") ||
              context.sessionId.startsWith("interrupt-")
            if (shouldGate && context.turnIndex === 1) {
              const token = yield* DurableDeferred.token(SoakGate)
              yield* Queue.offer(ready, { sessionId: context.sessionId, token })
              yield* DurableDeferred.await(SoakGate)
            }
            return context.canonicalPrompt
          })
        )

        const store = yield* DurableChannels.memoryStore
        const agent = Agent.make({ contextTransform: pauseFirstTurn })
        const durable = DurableAgent.workflow("DurabilitySoak", agent, { store })
        const model = yield* FakeModel.layer(
          Array.from({ length: successful }, () => ({ text: "done" }))
        )
        const runtime = yield* Layer.build(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model.layer)
          )
        )

        const sessionIds = [
          ...Array.from({ length: resumptions }, (_, index) => `resume-${index}`),
          ...Array.from({ length: interruptions }, (_, index) => `interrupt-${index}`),
          ...Array.from({ length: ordinary }, (_, index) => `ordinary-${index}`)
        ]
        const executions = yield* Effect.forEach(
          sessionIds,
          (sessionId) =>
            Effect.map(
              DurableAgent.submit(durable, store, sessionId, "go").pipe(
                Effect.provide(runtime)
              ),
              (executionId) => ({ sessionId, executionId })
            ),
          { concurrency: 32 }
        )
        const bySession = new Map(
          executions.map(({ executionId, sessionId }) => [sessionId, executionId])
        )

        const waiting = yield* Effect.forEach(
          Array.from({ length: resumptions + interruptions }),
          () => Queue.take(ready)
        )
        yield* Effect.forEach(
          waiting,
          (signal) => {
            const executionId = bySession.get(signal.sessionId)
            if (executionId === undefined) {
              return Effect.die(`missing execution for ${signal.sessionId}`)
            }
            return Effect.repeat(durable.definition.poll(executionId), {
              until: (result) =>
                Option.isSome(result) && result.value._tag === "Suspended",
              schedule: Schedule.spaced(Duration.millis(5))
            })
          },
          { concurrency: 16 }
        ).pipe(Effect.provide(runtime))
        yield* Effect.forEach(
          waiting,
          (signal) => {
            const executionId = bySession.get(signal.sessionId)
            if (executionId === undefined) {
              return Effect.die(`missing execution for ${signal.sessionId}`)
            }
            return signal.sessionId.startsWith("resume-")
              ? DurableDeferred.succeed(SoakGate, {
                  token: signal.token,
                  value: "continue"
                })
              : durable.definition.interrupt(executionId)
          },
          { concurrency: 16 }
        ).pipe(Effect.provide(runtime))

        for (const { executionId, sessionId } of executions) {
          if (!sessionId.startsWith("interrupt-")) continue
          const interrupted = yield* durable.definition.poll(executionId).pipe(
            Effect.provide(runtime)
          )
          assert.isFalse(
            Option.isSome(interrupted) &&
              interrupted.value._tag === "Complete" &&
              Exit.isSuccess(interrupted.value.exit)
          )
        }

        const results = yield* Effect.forEach(
          executions,
          ({ executionId, sessionId }) =>
            Effect.map(
              DurableAgent.result(durable, executionId).pipe(
                Effect.provide(runtime)
              ),
              (result) => ({ result, sessionId })
            ),
          { concurrency: 32 }
        )
        assert.strictEqual(
          results.filter(({ result }) => Exit.isSuccess(result)).length,
          successful
        )
        assert.strictEqual(
          results.filter(({ result }) => Exit.isFailure(result)).length,
          interruptions
        )
        assert.strictEqual(yield* model.recorder.calls, successful)

        // D4: terminal interruption is not changed into crash recovery by a
        // later resume request.
        for (const { executionId, sessionId } of executions) {
          if (!sessionId.startsWith("interrupt-")) continue
          yield* durable.definition.resume(executionId).pipe(Effect.provide(runtime))
          const result = yield* DurableAgent.result(durable, executionId).pipe(
            Effect.provide(runtime)
          )
          assert.isTrue(Exit.isFailure(result))
        }

        // D5-D6 under a repeatedly disconnected consumer. Production appends
        // ten events while the consumer keeps only three per connection; its
        // cursor must eventually close the backlog with no gap or duplicate.
        const log = yield* DeliveryLog.memoryLog
        const eventCount = 300
        let cursor = 0
        const observed: Array<number> = []
        for (let batch = 0; batch < eventCount / 10; batch++) {
          for (let offset = 1; offset <= 10; offset++) {
            const ordinal = batch * 10 + offset
            const key = `event-${ordinal}`
            const appended = yield* log.append(
              "s",
              key,
              envelope(ordinal, { _tag: "TurnStarted" })
            )
            assert.deepStrictEqual(appended, {
              _tag: "Appended",
              sequence: ordinal
            })
            if (ordinal % 17 === 0) {
              assert.deepStrictEqual(
                yield* log.append(
                  "s",
                  key,
                  envelope(ordinal + 10_000, { _tag: "TurnStarted" })
                ),
                { _tag: "Duplicate" }
              )
            }
            if (ordinal % 50 === 0) {
              assert.deepStrictEqual(
                yield* log.append(
                  "s",
                  key,
                  envelope(ordinal, { _tag: "RunStarted" })
                ),
                { _tag: "Conflict" }
              )
            }
          }
          const connection = (yield* log.read("s", { after: cursor })).slice(0, 3)
          observed.push(...connection.map((entry) => entry.sequence))
          cursor = connection.at(-1)?.sequence ?? cursor
        }
        while (cursor < eventCount) {
          const connection = (yield* log.read("s", { after: cursor })).slice(0, 7)
          observed.push(...connection.map((entry) => entry.sequence))
          cursor = connection.at(-1)?.sequence ?? cursor
        }
        assert.deepStrictEqual(
          observed,
          Array.from({ length: eventCount }, (_, index) => index + 1)
        )
      })
    ),
    120_000
  )
})
