import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { AgentProtocol } from "../src/client/index.js"

type IsAny<A> = 0 extends 1 & A ? true : false
type IsUnknown<A> = unknown extends A
  ? [keyof A] extends [never]
    ? true
    : false
  : false
type Assert<A extends true> = A
type Not<A extends boolean> = A extends true ? false : true
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

type PromptInputIsNotAny = Assert<Not<IsAny<AgentProtocol.PromptRequest["input"]>>>
type PromptInputIsNotUnknown = Assert<
  Not<IsUnknown<AgentProtocol.PromptRequest["input"]>>
>
type RemoteErrorsAreNotAny = Assert<Not<IsAny<AgentProtocol.RemoteError>>>
type RemoteErrorsAreNotUnknown = Assert<Not<IsUnknown<AgentProtocol.RemoteError>>>
type SubmissionIdStaysBranded = Assert<
  Equal<AgentProtocol.RemoteResult["submissionId"], AgentProtocol.SubmissionId>
>

const inferenceProof: readonly [
  PromptInputIsNotAny,
  PromptInputIsNotUnknown,
  RemoteErrorsAreNotAny,
  RemoteErrorsAreNotUnknown,
  SubmissionIdStaysBranded
] = [true, true, true, true, true]

describe("AgentProtocol", () => {
  it.effect("round-trips a normalized prompt request", () =>
    Effect.gen(function* () {
      const requestId = yield* Schema.decodeEffect(AgentProtocol.RequestId)(
        "request-1"
      )
      const sessionId = yield* Schema.decodeEffect(AgentProtocol.SessionId)(
        "session-1"
      )
      const request: AgentProtocol.PromptRequest = {
        requestId,
        sessionId,
        input: Prompt.make("hello"),
        options: { stream: true }
      }

      const encoded = yield* Schema.encodeEffect(AgentProtocol.PromptRequest)(
        request
      )
      const decoded = yield* Schema.decodeEffect(AgentProtocol.PromptRequest)(
        encoded
      )

      assert.deepStrictEqual(decoded, request)
      assert.deepStrictEqual(inferenceProof, [true, true, true, true, true])
    })
  )

  it.effect("keeps request and session identifiers distinct", () =>
    Effect.gen(function* () {
      const requestId = yield* Schema.decodeEffect(AgentProtocol.RequestId)(
        "request-1"
      )
      // @ts-expect-error a request id must not satisfy a session id
      const sessionId: AgentProtocol.SessionId = requestId
      assert.strictEqual(sessionId, "request-1")
    })
  )

  it.effect("round-trips every protocol-specific error with derived messages", () =>
    Effect.gen(function* () {
      const requestId = yield* Schema.decodeEffect(AgentProtocol.RequestId)(
        "request-1"
      )
      const sessionId = yield* Schema.decodeEffect(AgentProtocol.SessionId)(
        "session-1"
      )
      const errors: ReadonlyArray<AgentProtocol.RemoteError> = [
        new AgentProtocol.AgentSessionNotFoundError({ sessionId }),
        new AgentProtocol.AgentSessionAlreadyExistsError({ sessionId }),
        new AgentProtocol.AgentRequestConflictError({
          sessionId: Option.some(sessionId),
          requestId
        }),
        new AgentProtocol.AgentRequestCapacityExceededError({
          sessionId: Option.some(sessionId),
          capacity: 16
        }),
        new AgentProtocol.AgentUnauthorizedError({ operation: "createSession" }),
        new AgentProtocol.AgentForbiddenError({
          operation: "prompt",
          sessionId: Option.some(sessionId)
        }),
        new AgentProtocol.AgentCapacityExceededError({ capacity: 32 }),
        new AgentProtocol.AgentInvalidRequestError({
          operation: "respond",
          detail: "missing elicitation id"
        }),
        new AgentProtocol.AgentProtocolCodecError({
          operation: "prompt",
          phase: "response",
          detail: "invalid prompt result"
        })
      ]

      for (const error of errors) {
        const encoded = yield* Schema.encodeEffect(AgentProtocol.RemoteError)(
          error
        )
        assert.notProperty(encoded, "message")
        const decoded = yield* Schema.decodeEffect(AgentProtocol.RemoteError)(
          encoded
        )
        assert.strictEqual(decoded._tag, error._tag)
        assert.isAbove(decoded.message.length, 0)
      }
    })
  )
})
