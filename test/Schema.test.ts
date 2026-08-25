import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentBusyError, AgentIdleError } from "../src/Errors.js"
import {
  RunId,
  SessionId,
  runId,
  sessionId,
  submissionId
} from "../src/internal/ids.js"

describe("schema-defined ids", () => {
  it.effect("decodes and rejects, rather than only tagging at compile time", () =>
    Effect.gen(function* () {
      const id = yield* Schema.decodeEffect(SessionId)("session-1")
      assert.strictEqual(id, "session-1")

      // A branded alias could not do this: the check is a real validator.
      // `decodeUnknownOption` takes `unknown`, so the invalid input needs no
      // cast to express.
      const bad = Schema.decodeUnknownOption(SessionId)(42)
      assert.isTrue(Option.isNone(bad))
    })
  )

  it.effect("ids of different kinds are not interchangeable", () =>
    Effect.gen(function* () {
      const run = yield* Schema.decodeEffect(RunId)("run-1")
      // @ts-expect-error a RunId must not satisfy SessionId
      const _: SessionId = run
      assert.strictEqual(run, "run-1")
    })
  )
})

describe("schema-defined errors", () => {
  it.effect("round-trip through their codec", () =>
    Effect.gen(function* () {
      const error = new AgentBusyError({
        sessionId: sessionId("session-1")
      })

      // The point of the change: an error can cross a serialization boundary
      // without a parallel set of wire types.
      const encoded = yield* Schema.encodeEffect(AgentBusyError)(error)
      assert.deepStrictEqual(encoded, {
        _tag: "AgentBusyError",
        sessionId: "session-1"
      })

      const decoded = yield* Schema.decodeEffect(AgentBusyError)(encoded)
      assert.strictEqual(decoded._tag, "AgentBusyError")
      assert.strictEqual(decoded.sessionId, "session-1")

      // `message` is a getter, not a Schema field: absent from the wire format,
      // yet present again after decoding because it is derived.
      assert.notProperty(encoded, "message")
      assert.strictEqual(
        decoded.message,
        "Session session-1 is already running a submission"
      )
    })
  )

  it.effect("remain ordinary yieldable Effect errors", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        new AgentIdleError({
          sessionId: sessionId("session-1"),
          operation: "steer"
        })
      )
      assert.isTrue(Exit.isFailure(result))

      // Still catchable by tag, and `message` is available on the caught value.
      const handled = yield* new AgentIdleError({
        sessionId: sessionId("session-1"),
        operation: "steer"
      }).pipe(Effect.catchTag("AgentIdleError", (e) => Effect.succeed(e.message)))
      assert.strictEqual(handled, "Cannot steer on idle session session-1")
    })
  )
})

describe("schema-defined events", () => {
  it.effect("an envelope round-trips through its codec", () =>
    Effect.gen(function* () {
      const envelope: AgentEvent.AgentEventEnvelope = {
        sessionId: sessionId("session-1"),
        submissionId: Option.some(submissionId("submission-1")),
        runId: Option.some(runId("run-1")),
        turn: Option.some(2),
        sequence: 7,
        // Both the decoded result and the JSON the model was given: the
        // second is what a wire projection can rely on.
        event: {
          _tag: "ToolCallSucceeded",
          id: "t1",
          name: "echo",
          result: "x",
          encodedResult: "x"
        }
      }

      // This is what a remote subscriber or a store needs, and what the
      // pre-Schema ADT could not provide.
      const encoded = yield* Schema.encodeEffect(AgentEvent.AgentEventEnvelope)(
        envelope
      )
      const decoded = yield* Schema.decodeEffect(AgentEvent.AgentEventEnvelope)(
        encoded
      )
      assert.deepStrictEqual(decoded, envelope)
    })
  )

  it.effect("a failure event carries a wire-safe projection, not a Cause", () =>
    Effect.gen(function* () {
      const failure = AgentEvent.failureFromCause(
        Cause.fail(new AgentBusyError({ sessionId: sessionId("session-1") }))
      )
      assert.strictEqual(failure.tag, "AgentBusyError")
      assert.isFalse(failure.isDefect)

      // A defect is distinguishable, which is what a consumer actually needs.
      const defect = AgentEvent.failureFromCause(
        Cause.die(new Error("handler is broken"))
      )
      assert.isTrue(defect.isDefect)
      assert.strictEqual(defect.message, "handler is broken")

      const envelope: AgentEvent.AgentEventEnvelope = {
        sessionId: sessionId("session-1"),
        submissionId: Option.none(),
        runId: Option.none(),
        turn: Option.none(),
        sequence: 1,
        event: { _tag: "RunFailed", failure }
      }
      const encoded = yield* Schema.encodeEffect(AgentEvent.AgentEventEnvelope)(
        envelope
      )
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(AgentEvent.AgentEventEnvelope)(encoded),
        envelope
      )
    })
  )

  /**
   * R166 -- the projection is what turns a failure into a *terminal* event,
   * and a terminal event is what durability and every UI use to stop waiting.
   * If describing the failure throws, the original is replaced by that throw
   * and the terminal event is never published -- so a run that failed looks,
   * to everything downstream, like a run still going.
   *
   * Nothing here is exotic on purpose. A `bigint` field is ordinary and
   * `JSON.stringify` throws on it; a `Symbol` throws on `String()`; a tagged
   * error is free to compute its own `message`. None of these is required to
   * be a well-behaved `Error`, because they come from tools, providers,
   * storage adapters and user code.
   */
  it("describes any failure at all, without throwing", () => {
    const hostile: ReadonlyArray<readonly [string, unknown]> = [
      ["a bigint field", Object.assign(new Error(""), { _tag: "Big", size: 10n })],
      ["a throwing message getter", {
        _tag: "Nasty",
        get message(): string {
          throw new Error("no message for you")
        }
      }],
      ["a throwing field getter", {
        _tag: "Sneaky",
        get detail(): string {
          throw new Error("no detail either")
        }
      }],
      /**
       * A throwing `toString` on the *prototype*, so the object has no own
       * enumerable property to describe instead.
       *
       * Written as a class deliberately: the obvious object-literal version
       * puts `toString` in the object's own keys, so the field walk describes
       * it and the coercion is never reached -- an assertion that looks like
       * it covers the coercion guard and does not.
       */
      ["a throwing toString", new (class {
        toString(): string {
          throw new Error("not printable")
        }
      })()],
      ["a symbol", Symbol("secretive")],
      ["a cyclic object", (() => {
        const cyclic: Record<string, unknown> = { _tag: "Loop" }
        cyclic["self"] = cyclic
        return cyclic
      })()],
      ["a proxy that refuses enumeration", new Proxy({}, {
        ownKeys() {
          throw new Error("no keys")
        }
      })],
      ["undefined", undefined],
      ["null", null]
    ]

    for (const [what, value] of hostile) {
      const failed = AgentEvent.failureFromCause(Cause.fail(value))
      assert.isString(failed.tag, `${what}: no tag`)
      assert.isString(failed.message, `${what}: no message`)
      assert.isFalse(failed.isDefect, `${what}: a failure is not a defect`)

      // And as a defect, which is the path a broken handler takes.
      const died = AgentEvent.failureFromCause(Cause.die(value))
      assert.isString(died.message, `${what}: no message as a defect`)
      assert.isTrue(died.isDefect, `${what}: a defect is not a failure`)
    }
  })

  it("still says something useful about an ordinary tagged error", () => {
    // The guards must not cost the common case its detail: a tagged error
    // carrying named fields and no message is the usual shape.
    const described = AgentEvent.failureFromCause(
      Cause.fail(Object.assign(new Error(""), { _tag: "Storage", operation: "write", id: "n1" }))
    )
    assert.strictEqual(described.tag, "Storage")
    assert.include(described.message, "operation=write")
    assert.include(described.message, "id=n1")
  })
})
