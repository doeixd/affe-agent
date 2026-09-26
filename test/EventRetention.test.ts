import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Item 130: an in-process session keeps a bounded record of its recent
 * envelopes, so a cursor inside the window resumes with no gap and no repeat,
 * and a cursor behind it is refused rather than answered with a hole.
 */

const client = (turns: Parameters<typeof TestLanguageModel.script>[0], retainedEvents?: number) =>
  Effect.map(TestLanguageModel.script(turns), ({ layer: model }) =>
    AgentClient.layer(
      Agent.make({ loop: AgentLoop.bounded(2) }),
      retainedEvents === undefined ? {} : { retainedEvents }
    ).pipe(Layer.provide(model)))

describe("in-process event retention (item 130)", () => {
  /** Everything `events` delivers after `after`, up to the submission's end. */
  const after = (
    session: AgentClient.RemoteSession,
    cursor: number
  ) =>
    Stream.runCollect(
      Stream.takeUntil(session.events({ after: cursor }), (envelope) => envelope.event._tag === "SubmissionCompleted")
    ).pipe(Effect.map((all) => Array.from(all).map((envelope) => envelope.sequence)))

  it.effect("a cursor inside the window resumes with every sequence after it", () =>
    Effect.gen(function*() {
      const layer = yield* client([TestLanguageModel.text("done")])
      yield* Effect.gen(function*() {
        const session = yield* (yield* AgentClient.AgentClient).createSession()
        yield* session.prompt("go")
        const all = yield* after(session, 0)
        assert.deepStrictEqual(all, all.map((_, index) => index + 1))
        assert.deepStrictEqual(yield* after(session, 2), all.slice(2))
        // An in-process session leaves finite reads to the host's own tail.
        assert.isUndefined(session.eventLog)
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.effect("a cursor behind the window is refused, never answered with a hole", () =>
    Effect.gen(function*() {
      // A window of three: one submission emits more than that.
      const layer = yield* client([TestLanguageModel.text("done")], 3)
      yield* Effect.gen(function*() {
        const session = yield* (yield* AgentClient.AgentClient).createSession()
        yield* session.prompt("go")
        const behind = yield* Effect.exit(Stream.runCollect(session.events({ after: 1 })))
        assert.isTrue(Exit.isFailure(behind))
        if (Exit.isFailure(behind)) {
          const reason = behind.cause.reasons[0]
          assert.isTrue(reason?._tag === "Fail" && reason.error._tag === "AgentInvalidRequestError")
          assert.isTrue(reason?._tag === "Fail" && reason.error.message.includes("no longer retained"))
        }
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.live("a resumed stream replays the record, then continues live, with no gap and no repeat", () =>
    Effect.gen(function*() {
      const layer = yield* client([TestLanguageModel.text("first"), TestLanguageModel.text("second")])
      yield* Effect.gen(function*() {
        const session = yield* (yield* AgentClient.AgentClient).createSession()
        yield* session.prompt("one")
        const settled = (yield* after(session, 0)).at(-1)!
        const reader = yield* Effect.forkChild(
          Stream.runCollect(
            Stream.takeUntil(
              session.events({ after: 1 }),
              (envelope) => envelope.event._tag === "SubmissionCompleted" && envelope.sequence > settled
            )
          )
        )
        // The replay is under way; the second submission's events come live.
        yield* Effect.yieldNow
        yield* session.prompt("two")
        const seen = Array.from(yield* Fiber.join(reader)).map((envelope) => envelope.sequence)
        const expected = Array.from({ length: seen.length }, (_, index) => index + 2)
        assert.deepStrictEqual(seen, expected, "a sequence was skipped or delivered twice")
        assert.isTrue(seen[seen.length - 1]! > settled, "the live half never arrived")
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.effect("retainedEvents: 0 keeps nothing, and every cursor is refused", () =>
    Effect.gen(function*() {
      const layer = yield* client([TestLanguageModel.text("done")], 0)
      yield* Effect.gen(function*() {
        const session = yield* (yield* AgentClient.AgentClient).createSession()
        const exit = yield* Effect.exit(Stream.runCollect(session.events({ after: 0 })))
        assert.isTrue(Exit.isFailure(exit))
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.effect("a negative retainedEvents is refused", () =>
    Effect.gen(function*() {
      const layer = yield* client([], -1)
      const exit = yield* Effect.exit(
        Effect.scoped(Effect.flatMap(Effect.service(AgentClient.AgentClient), (c) => c.createSession())).pipe(
          Effect.provide(layer)
        )
      )
      assert.isTrue(Exit.isFailure(exit))
    }))
})
