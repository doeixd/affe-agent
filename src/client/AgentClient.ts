import { Context, Effect, Layer, Ref, Schema, Scope, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentSession from "../AgentSession.js"
import {
  AgentBusyError,
  AgentClosedError,
  AgentIdleError
} from "../Errors.js"

/**
 * Talking to a session that may not be in this process.
 *
 * `AgentSession` is a local handle: it carries the agent's tool types, hands
 * back a `GenerateTextResponse`, and fails with whatever the agent's tools and
 * transforms fail with. None of that survives a wire. A caller on the far side
 * of RPC or HTTP has no access to the tool definitions, and a provider response
 * is not a value a protocol can carry.
 *
 * So this is a deliberately narrower surface: the same five operations and the
 * same event stream, in terms that can cross a process boundary. It is the seam
 * adapters implement — RPC, HTTP/SSE, AG-UI, A2A — rather than each inventing
 * its own notion of what a session is.
 *
 * Everything is still an ordinary `Effect` or `Stream`. A remote session is not
 * a second runtime; it is the same vocabulary with a transport underneath.
 */

/**
 * A submission's outcome, in terms a protocol can carry.
 *
 * The local `Result` also holds the final `GenerateTextResponse`, which keeps
 * usage, finish reason and typed content parts. That is genuinely useful
 * locally and genuinely not transportable, so it is dropped here rather than
 * half-encoded: a caller who needs it is asking for a local session.
 */
export const RemoteResult = Schema.Struct({
  submissionId: Schema.String,
  status: Schema.Literals(["completed", "interrupted"]),
  runs: Schema.Number,
  turns: Schema.Number,
  text: Schema.String
})
export type RemoteResult = typeof RemoteResult.Type

/** Raised when the transport itself fails, as distinct from the session. */
export class AgentTransportError extends Schema.TaggedError<AgentTransportError>()(
  "AgentTransportError",
  { sessionId: Schema.String, detail: Schema.String }
) {
  override get message() {
    return "Transport failure for session " + this.sessionId + ": " + this.detail
  }
}

/**
 * What a remote call can fail with.
 *
 * Every member is a `Schema.TaggedError`, so the union survives the wire, and a
 * caller can tell "this session is busy" from "the transport broke" without
 * either being a defect.
 */
export type RemoteError =
  | AgentBusyError
  | AgentIdleError
  | AgentClosedError
  | AgentTransportError

const remoteTags = [
  "AgentBusyError",
  "AgentIdleError",
  "AgentClosedError",
  "AgentTransportError"
]

const isRemote = (error: unknown): error is RemoteError =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { _tag?: unknown })._tag === "string" &&
  remoteTags.includes((error as { _tag: string })._tag)

const describe = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const described = error as { _tag?: unknown; message?: unknown }
    const tag = typeof described._tag === "string" ? described._tag : "Error"
    const message =
      typeof described.message === "string" && described.message.length > 0
        ? described.message
        : JSON.stringify(error)
    return tag + ": " + message
  }
  return String(error)
}

/**
 * A session, addressed through a transport.
 *
 * The same shape as the local handle — actions as methods, observations as
 * values — so moving between them is a change of import rather than of style.
 */
export interface RemoteSession {
  readonly id: string
  readonly prompt: (
    input: Prompt.RawInput
  ) => Effect.Effect<RemoteResult, RemoteError>
  readonly steer: (input: Prompt.RawInput) => Effect.Effect<void, RemoteError>
  readonly followUp: (
    input: Prompt.RawInput
  ) => Effect.Effect<void, RemoteError>
  readonly interrupt: () => Effect.Effect<void, RemoteError>
  readonly history: Effect.Effect<Prompt.Prompt, RemoteError>
  readonly status: Effect.Effect<AgentSession.Status, RemoteError>
  readonly events: Stream.Stream<AgentEventEnvelope, RemoteError>
}

/** Opens and finds sessions. */
export interface Service {
  /**
   * Open a session. Scoped, so its lifetime is the caller's scope — the same
   * rule a local session follows.
   */
  readonly createSession: (options?: {
    readonly sessionId?: string | undefined
  }) => Effect.Effect<RemoteSession, RemoteError, Scope.Scope>
  /** Reach a session that is already open. */
  readonly session: (
    sessionId: string
  ) => Effect.Effect<RemoteSession, RemoteError>
}

export class AgentClient extends Context.Service<AgentClient, Service>()(
  "@doeixd/effect-agent/AgentClient"
) {}

/**
 * Adapt a local session to the remote surface.
 *
 * Exported because every in-process transport needs it: an RPC *server* holds
 * real sessions and answers with exactly these shapes, so the projection
 * belongs here rather than being rewritten by each adapter.
 *
 * The agent's own failures are not part of the protocol. A caller with no
 * access to the tool definitions cannot act on a tool's typed failure, so those
 * arrive described rather than typed — which is honest about what crossed the
 * boundary, instead of pretending a shape survived that did not.
 */
export const fromSession = (
  session: AgentSession.AgentSession<any, any>
): RemoteSession => ({
  id: session.id,
  prompt: (input) =>
    session.prompt(input).pipe(
      Effect.catchIf(
        (error): error is Exclude<typeof error, RemoteError> => !isRemote(error),
        (error) =>
          new AgentTransportError({
            sessionId: session.id,
            detail: describe(error)
          })
      ),
      Effect.map((result) => ({
        submissionId: result.submissionId,
        status: result.status,
        runs: result.runs,
        turns: result.turns,
        text: result.text
      }))
    ),
  steer: (input) => session.steer(input),
  followUp: (input) => session.followUp(input),
  interrupt: () => session.interrupt(),
  history: session.history,
  status: session.status,
  events: session.events
})

/**
 * The in-process transport: no transport at all.
 *
 * Useful on its own — an application that runs its agent locally today and
 * remotely tomorrow writes the same code either way — and useful as the
 * reference every other implementation is checked against.
 */
export const layer = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: AgentDefinition<Tools, E, R>
): Layer.Layer<AgentClient, never, LanguageModel.LanguageModel | R> =>
  Layer.effect(
    AgentClient,
    Effect.gen(function* () {
      const open = yield* Ref.make(new Map<string, RemoteSession>())
      const env = yield* Effect.context<LanguageModel.LanguageModel | R>()

      const createSession: Service["createSession"] = (options) =>
        Effect.gen(function* () {
          const session = yield* AgentSession.make(
            agent,
            options?.sessionId === undefined
              ? {}
              : { sessionId: options.sessionId }
          ).pipe(Effect.provide(env))

          const remote = fromSession(session)
          yield* Ref.update(open, (all) => new Map(all).set(remote.id, remote))
          // Forgotten when the caller's scope closes, so a client does not
          // accumulate handles to sessions that no longer exist.
          yield* Effect.addFinalizer(() =>
            Ref.update(open, (all) => {
              const next = new Map(all)
              next.delete(remote.id)
              return next
            })
          )
          return remote
        })

      return {
        createSession,
        session: (sessionId: string) =>
          Effect.flatMap(Ref.get(open), (all) => {
            const found = all.get(sessionId)
            return found === undefined
              ? Effect.fail(
                  new AgentTransportError({
                    sessionId,
                    detail: "no such session"
                  })
                )
              : Effect.succeed(found)
          })
      }
    })
  )
