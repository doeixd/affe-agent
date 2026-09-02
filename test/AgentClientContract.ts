import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { AgentBusyError, AgentClosedError, AgentIdleError } from "../src/Errors.js"
import { AgentClientConformance } from "../src/testing/index.js"

/**
 * The behaviour every `AgentClient` implementation is expected to have.
 *
 * Every test runs on the live clock: the durable interpreter drives a real
 * workflow engine, whose shard and poll timers do not advance under the test
 * clock, and nothing here depends on time — synchronisation is by `Deferred`.
 *
 * The client seam exists so an application writes the same code whether its
 * agent runs in this process or behind some interpreter — durable workflow,
 * cluster entity, transport. A second implementation that passes its own
 * hand-written tests but fails these is not a weaker sibling; it is a
 * different, undocumented contract.
 *
 * Tests here use only the client surface — no `AgentSession` — which is the
 * discipline the seam enforces. Implementation-specific tests stay in each
 * implementation's own file.
 */

/**
 * The behaviour every `AgentClient` implementation is expected to have.
 *
 * The cases live in `AgentClientConformance` (`/testing`) so a client this
 * repository does not have -- one over your own interpreter or transport --
 * is held to the same rows; what remains here is the vitest wiring, one
 * `it.live` per case, and the second contract below, which is about
 * transports rather than clients and stays a fixture of this test suite.
 */

export interface Harness extends AgentClientConformance.Options {
  /** Shown in test names, so a failure names the interpreter that broke. */
  readonly name: string
}

export const run = (harness: Harness): void => {
  describe(`AgentClient contract (${harness.name})`, () => {
    for (const entry of AgentClientConformance.cases(harness)) {
      it.live(entry.name, () => entry.run)
    }
  })
}

/**
 * The second contract: every protocol failure arrives as itself.
 *
 * `AgentClient.RemoteError` names fifteen errors and the HTTP `Api` declares
 * all fifteen, but the HTTP client used to decode six of them and fold the
 * rest into `AgentTransportError` -- the one tag whose documented meaning is
 * "retrying is reasonable". A caller with an ordinary retry policy therefore
 * retried a 403 for as long as it was willing to keep asking, and the contract
 * above could not see it, because it only ever provokes the six.
 *
 * RPC never collapsed anything: it exposes the protocol group's own error
 * union. So this exists to hold the two transports to the same answer rather
 * than to test one of them, and it is written against a host that fails on
 * purpose -- capacity, conflict and codec failures are otherwise reachable
 * only by arranging the exact internal state that produces them.
 */
export interface ProtocolErrorHarness {
  /** Shown in test names, so a failure names the transport that broke. */
  readonly name: string
  /**
   * Ask a host that always fails with `error` for a session, and report what
   * the client saw.
   *
   * `getSession` rather than `prompt` because it is one round trip and needs
   * no live session -- the question here is what the *transport* does with a
   * failure, not which operation produced it.
   */
  readonly failure: (
    error: AgentProtocol.RemoteError
  ) => Effect.Effect<AgentProtocol.RemoteError>
}

/**
 * A host whose every operation fails with one chosen error.
 *
 * Shared by both transports so neither can be held to a slightly different
 * fixture. `resolve` succeeds: authentication is not what is under test, and
 * failing it would make every case an `AgentUnauthorizedError`.
 */
export const failingHost = <Principal>(
  principal: Principal,
  error: AgentProtocol.RemoteError
): AgentSessionHost.Service<Principal> => {
  const fail = Effect.fail(error)
  return {
    resolve: () => Effect.succeed(principal),
    createSession: () => fail,
    closeSession: () => fail,
    session: () => fail,
    prompt: () => fail,
    submit: () => fail,
    awaitSubmission: () => fail,
    steer: () => fail,
    followUp: () => fail,
    interrupt: () => fail,
    respond: () => fail,
    pending: () => fail,
    history: () => fail,
    status: () => fail,
    events: () => fail,
    sessions: () => fail,
    eventLog: () => fail,
    hostEvents: () => fail,
    size: Effect.succeed(0),
    pumps: Effect.succeed(0),
    requestBuckets: Effect.succeed(0),
    maxSessions: 4,
    maxRequestsPerSession: 16
  }
}

const contractSessionId = AgentProtocol.SessionId.make("protocol-errors")

/**
 * One instance of each of the fifteen, with fields worth checking survived.
 *
 * Listed rather than generated: a generated list would be derived from the
 * same union the code under test uses, so it would shrink silently along with
 * the bug. This one has to be edited by hand when the protocol grows a failure,
 * which is the point.
 */
export const protocolErrors: ReadonlyArray<AgentProtocol.RemoteError> = [
  new AgentBusyError({ sessionId: contractSessionId }),
  new AgentIdleError({ sessionId: contractSessionId, operation: "steer" }),
  new AgentClosedError({ sessionId: contractSessionId }),
  new AgentClient.AgentSessionNotFoundError({ sessionId: "protocol-errors" }),
  new AgentClient.AgentExecutionError({
    sessionId: "protocol-errors",
    tag: "ToolError",
    detail: "declined",
    isDefect: false
  }),
  new AgentClient.AgentTransportError({
    sessionId: "protocol-errors",
    detail: "socket closed"
  }),
  new AgentProtocol.AgentSessionAlreadyExistsError({
    sessionId: contractSessionId
  }),
  new AgentProtocol.AgentRequestConflictError({
    sessionId: Option.some(contractSessionId),
    requestId: AgentProtocol.RequestId.make("req-1")
  }),
  new AgentProtocol.AgentRequestCapacityExceededError({
    sessionId: Option.some(contractSessionId),
    capacity: 16
  }),
  new AgentProtocol.AgentUnauthorizedError({ operation: "getSession" }),
  new AgentProtocol.AgentForbiddenError({
    operation: "getSession",
    sessionId: Option.some(contractSessionId)
  }),
  new AgentProtocol.AgentCapacityExceededError({ capacity: 4 }),
  new AgentProtocol.AgentInvalidRequestError({
    operation: "getSession",
    detail: "malformed"
  }),
  new AgentProtocol.AgentProtocolCodecError({
    operation: "getSession",
    phase: "response",
    detail: "unencodable"
  }),
  new AgentProtocol.AgentSubmissionNotFoundError({
    sessionId: contractSessionId,
    submissionId: AgentProtocol.SubmissionId.make("sub-1")
  })
]

export const runProtocolErrors = (harness: ProtocolErrorHarness): void => {
  describe(`AgentClient protocol errors (${harness.name})`, () => {
    for (const expected of protocolErrors) {
      it.live(`${expected._tag} arrives as itself`, () =>
        Effect.gen(function* () {
          const seen = yield* harness.failure(expected)
          // Named, not `isFailure`: the bug was a failure of the *right*
          // shape wearing the wrong tag, which any weaker assertion passes.
          assert.strictEqual(seen._tag, expected._tag)
          // And the fields came with it. A tag that survives while its
          // payload is rebuilt from a string is not the error travelling.
          assert.deepStrictEqual(
            Schema.encodeUnknownSync(AgentProtocol.RemoteError)(seen),
            Schema.encodeUnknownSync(AgentProtocol.RemoteError)(expected)
          )
        })
      )
    }

    it.live("a forbidden request is not reported as retryable", () =>
      Effect.gen(function* () {
        const seen = yield* harness.failure(
          new AgentProtocol.AgentForbiddenError({
            operation: "getSession",
            sessionId: Option.some(contractSessionId)
          })
        )
        // The whole point, stated on its own so a regression names it:
        // `AgentTransportError` means "retrying is reasonable", and a 403 is
        // not. This is what retried forever.
        assert.notStrictEqual(seen._tag, "AgentTransportError")
        assert.strictEqual(seen._tag, "AgentForbiddenError")
      })
    )
  })
}
