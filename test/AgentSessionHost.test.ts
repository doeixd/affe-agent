import { assert, describe, it } from "@effect/vitest"
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
  Tracer
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import * as AgentSessionHost from "../src/client/internal/sessionHost.js"

const spanNames = (span: Tracer.AnySpan): ReadonlyArray<string> => {
  const names: Array<string> = []
  let current: Option.Option<Tracer.AnySpan> = Option.some(span)
  while (Option.isSome(current)) {
    if (current.value._tag === "Span") {
      names.push(current.value.name)
      current = current.value.parent
    } else {
      current = Option.none()
    }
  }
  return names
}

const clientFixture = (options?: {
  readonly blockCreation?: boolean
  readonly blockPrompts?: boolean
}) =>
  Effect.gen(function* () {
    const opened = yield* Ref.make(0)
    const released = yield* Ref.make(0)
    const promptCalls = yield* Ref.make(0)
    const creationStarted = yield* Deferred.make<void>()
    const allowCreation = yield* Deferred.make<void>()
    const promptStarted = yield* Deferred.make<void>()
    const secondPromptStarted = yield* Deferred.make<void>()
    const promptSpans = yield* Deferred.make<ReadonlyArray<string>>()
    const allowPrompt = yield* Deferred.make<void>()
    const submissionId = yield* Schema.decodeEffect(AgentProtocol.SubmissionId)(
      "submission-1"
    )

    const layer = Layer.succeed(AgentClient.AgentClient, {
      createSession: (sessionOptions) =>
        Effect.gen(function* () {
          const number = yield* Ref.updateAndGet(opened, (n) => n + 1)
          yield* Deferred.succeed(creationStarted, void 0)
          if (options?.blockCreation === true) {
            yield* Deferred.await(allowCreation)
          }
          yield* Effect.addFinalizer(() =>
            Ref.update(released, (n) => n + 1)
          )

          return {
            id: sessionOptions?.sessionId ?? `session-${number}`,
            prompt: () =>
              Effect.gen(function* () {
                const call = yield* Ref.updateAndGet(promptCalls, (n) => n + 1)
                const currentSpan = yield* Effect.option(Effect.currentSpan)
                if (Option.isSome(currentSpan)) {
                  yield* Deferred.succeed(
                    promptSpans,
                    spanNames(currentSpan.value)
                  )
                }
                yield* Deferred.succeed(promptStarted, void 0)
                if (call === 2) {
                  yield* Deferred.succeed(secondPromptStarted, void 0)
                }
                if (options?.blockPrompts === true) {
                  yield* Deferred.await(allowPrompt)
                }
                const completed = "completed"
                return {
                  submissionId,
                  status: completed,
                  runs: 1,
                  turns: 1,
                  text: "ok",
                  content: []
                }
              }),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            interrupt: () => Effect.void,
            respond: () => Effect.succeed(false),
            pending: Effect.succeed([]),
            history: Effect.succeed(Prompt.make([])),
            status: Effect.succeed("idle"),
            events: () => Stream.empty
          }
        }),
      session: (sessionId) =>
        Effect.fail(
          new AgentClient.AgentTransportError({
            sessionId,
            detail: "not used by the host"
          })
        )
    })

    return {
      layer,
      opened,
      released,
      promptCalls,
      creationStarted,
      allowCreation,
      promptStarted,
      secondPromptStarted,
      promptSpans,
      allowPrompt
    }
  })

const requestId = (value: string) =>
  Schema.decodeEffect(AgentProtocol.RequestId)(value)

const sessionId = (value: string) =>
  Schema.decodeEffect(AgentProtocol.SessionId)(value)

const hostWith = <Principal>(
  authorization: AgentSessionHost.Authorization<Principal>,
  options?: {
    readonly maxSessions?: number
    readonly maxRequestsPerSession?: number
  }
) =>
  AgentSessionHost.make({
    authorization,
    maxSessions: options?.maxSessions ?? 4,
    maxRequestsPerSession: options?.maxRequestsPerSession ?? 8
  })

describe("AgentSessionHost", () => {
  it.effect("owns child scopes and closes them explicitly and on shutdown", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture()
      const first = yield* sessionId("first")
      const second = yield* sessionId("second")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(AgentSessionHost.allowAll<void>())
          yield* host.createSession(undefined, {
            requestId: yield* requestId("create-first"),
            sessionId: first
          })
          yield* host.createSession(undefined, {
            requestId: yield* requestId("create-second"),
            sessionId: second
          })
          assert.strictEqual(yield* host.size, 2)

          yield* host.closeSession(undefined, {
            requestId: yield* requestId("close-first"),
            sessionId: first
          })
          assert.strictEqual(yield* Ref.get(fixture.released), 1)
          assert.strictEqual(yield* host.size, 1)
        }).pipe(Effect.provide(fixture.layer))
      )

      assert.strictEqual(yield* Ref.get(fixture.opened), 2)
      assert.strictEqual(yield* Ref.get(fixture.released), 2)
    })
  )

  it.effect("serializes creation and refuses a duplicate named session", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture({ blockCreation: true })
      const shared = yield* sessionId("shared")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(AgentSessionHost.allowAll<void>())
          const first = yield* Effect.forkChild(
            host.createSession(undefined, {
              requestId: yield* requestId("create-1"),
              sessionId: shared
            })
          )
          yield* Deferred.await(fixture.creationStarted)
          const second = yield* Effect.forkChild(
            host.createSession(undefined, {
              requestId: yield* requestId("create-2"),
              sessionId: shared
            })
          )

          yield* Deferred.succeed(fixture.allowCreation, void 0)
          const outcomes = yield* Effect.all(
            [Fiber.await(first), Fiber.await(second)],
            { concurrency: "unbounded" }
          )

          assert.strictEqual(
            outcomes.filter((outcome) => outcome._tag === "Success").length,
            1
          )
          assert.strictEqual(
            outcomes.filter((outcome) =>
              outcome._tag === "Failure" && (() => {
                const error = Cause.findErrorOption(outcome.cause)
                return (
                  error._tag === "Some" &&
                  Schema.is(AgentProtocol.AgentSessionAlreadyExistsError)(
                    error.value
                  )
                )
              })()
            ).length,
            1
          )
          assert.strictEqual(yield* Ref.get(fixture.opened), 1)
        }).pipe(Effect.provide(fixture.layer))
      )
    })
  )

  it.effect("refuses capacity instead of evicting a live session", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture()
      const first = yield* sessionId("first")
      const second = yield* sessionId("second")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(AgentSessionHost.allowAll<void>(), {
            maxSessions: 1
          })
          yield* host.createSession(undefined, {
            requestId: yield* requestId("create-first"),
            sessionId: first
          })
          const error = yield* Effect.flip(
            host.createSession(undefined, {
              requestId: yield* requestId("create-second"),
              sessionId: second
            })
          )

          assert.strictEqual(error._tag, "AgentCapacityExceededError")
          assert.strictEqual(yield* host.size, 1)
          assert.strictEqual(yield* Ref.get(fixture.released), 0)
        }).pipe(Effect.provide(fixture.layer))
      )
    })
  )

  it.effect("retains closed sessions' request buckets, bounded by maxSessions", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture()
      const maxSessions = 3
      const extra = 4

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(AgentSessionHost.allowAll<void>(), {
            maxSessions
          })

          // One session at a time, opened and closed, so capacity is never the
          // thing under test -- only what is left behind afterwards.
          for (let index = 0; index < maxSessions + extra; index += 1) {
            const id = yield* sessionId(`leak-${index}`)
            yield* host.createSession(undefined, {
              requestId: yield* requestId(`create-${index}`),
              sessionId: id
            })
            yield* host.closeSession(undefined, {
              requestId: yield* requestId(`close-${index}`),
              sessionId: id
            })
          }

          assert.strictEqual(yield* host.size, 0)
          // The bound, not "smaller than before": every closed session used to
          // leave a bucket that nothing ever removed, and the leak is only
          // visible as a count that keeps climbing.
          assert.isAtMost(yield* host.requestBuckets, maxSessions)

          // And retention is not an empty promise: a retry arriving right
          // after the close still joins the cached answer rather than being
          // told the session is gone. This is why the buckets are kept at all.
          const recent = yield* sessionId(`leak-${maxSessions + extra - 1}`)
          const retried = yield* host.closeSession(undefined, {
            requestId: yield* requestId(`close-${maxSessions + extra - 1}`),
            sessionId: recent
          })
          assert.isTrue(retried.closed)
          assert.strictEqual(yield* Ref.get(fixture.released), maxSessions + extra)
        }).pipe(Effect.provide(fixture.layer))
      )
    })
  )

  it.effect("joins duplicate prompts and rejects request-id payload conflicts", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture({ blockPrompts: true })
      const session = yield* sessionId("chat")
      const promptId = yield* requestId("prompt-1")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(AgentSessionHost.allowAll<void>())
          yield* host.createSession(undefined, {
            requestId: yield* requestId("create-chat"),
            sessionId: session
          })
          const request: AgentProtocol.PromptRequest = {
            requestId: promptId,
            sessionId: session,
            input: Prompt.make("hello")
          }

          const first = yield* Effect.forkChild(host.prompt(undefined, request))
          yield* Deferred.await(fixture.promptStarted)
          const second = yield* Effect.forkChild(host.prompt(undefined, request))
          yield* Deferred.succeed(fixture.allowPrompt, void 0)

          const [a, b] = yield* Effect.all(
            [Fiber.join(first), Fiber.join(second)],
            { concurrency: "unbounded" }
          )
          assert.deepStrictEqual(a, b)
          assert.strictEqual(yield* Ref.get(fixture.promptCalls), 1)
          assert.deepStrictEqual(
            (yield* Deferred.await(fixture.promptSpans)).filter((name) =>
              name.startsWith("AgentSessionHost.")
            ),
            ["AgentSessionHost.mutate", "AgentSessionHost.prompt"]
          )

          const conflict = yield* Effect.flip(
            host.prompt(undefined, {
              ...request,
              input: Prompt.make("different")
            })
          )
          assert.strictEqual(conflict._tag, "AgentRequestConflictError")
          assert.strictEqual(yield* Ref.get(fixture.promptCalls), 1)
        }).pipe(Effect.provide(fixture.layer))
      )
    })
  )

  it.effect("keeps a shared mutation alive when its first waiter is interrupted", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture({ blockPrompts: true })
      const session = yield* sessionId("chat")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(AgentSessionHost.allowAll<void>())
          yield* host.createSession(undefined, {
            requestId: yield* requestId("create-chat"),
            sessionId: session
          })
          const request: AgentProtocol.PromptRequest = {
            requestId: yield* requestId("prompt-1"),
            sessionId: session,
            input: Prompt.make("hello")
          }

          const first = yield* Effect.forkChild(host.prompt(undefined, request))
          yield* Deferred.await(fixture.promptStarted)
          const retry = yield* Effect.forkChild(host.prompt(undefined, request))
          yield* Fiber.interrupt(first)
          yield* Deferred.succeed(fixture.allowPrompt, void 0)

          const result = yield* Fiber.join(retry)
          assert.strictEqual(result.result.text, "ok")
          assert.strictEqual(yield* Ref.get(fixture.promptCalls), 1)
        }).pipe(Effect.provide(fixture.layer))
      )
    })
  )

  it.effect("bounds request retention without evicting in-flight work", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture({ blockPrompts: true })
      const session = yield* sessionId("chat")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(AgentSessionHost.allowAll<void>(), {
            maxRequestsPerSession: 2
          })
          yield* host.createSession(undefined, {
            requestId: yield* requestId("create-chat"),
            sessionId: session
          })
          const firstRequest: AgentProtocol.PromptRequest = {
            requestId: yield* requestId("prompt-1"),
            sessionId: session,
            input: Prompt.make("one")
          }
          const secondRequest: AgentProtocol.PromptRequest = {
            requestId: yield* requestId("prompt-2"),
            sessionId: session,
            input: Prompt.make("two")
          }
          const thirdRequest: AgentProtocol.PromptRequest = {
            requestId: yield* requestId("prompt-3"),
            sessionId: session,
            input: Prompt.make("three")
          }

          const first = yield* Effect.forkChild(
            host.prompt(undefined, firstRequest)
          )
          yield* Deferred.await(fixture.promptStarted)
          const second = yield* Effect.forkChild(
            host.prompt(undefined, secondRequest)
          )
          yield* Deferred.await(fixture.secondPromptStarted)
          const full = yield* Effect.flip(
            host.prompt(undefined, thirdRequest)
          )
          assert.strictEqual(
            full._tag,
            "AgentRequestCapacityExceededError"
          )

          yield* Deferred.succeed(fixture.allowPrompt, void 0)
          yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
            concurrency: "unbounded"
          })

          // A completed prompt is now evictable, so the third mutation can
          // reserve the bounded slot without dropping either while it ran.
          yield* host.prompt(undefined, thirdRequest)
          assert.strictEqual(yield* Ref.get(fixture.promptCalls), 3)
        }).pipe(Effect.provide(fixture.layer))
      )
    })
  )

  it.effect("authorizes every operation before reaching a session", () =>
    Effect.gen(function* () {
      const fixture = yield* clientFixture()
      const operations = yield* Ref.make<Array<AgentProtocol.Operation>>([])
      const authorization: AgentSessionHost.Authorization<string> = {
        authorize: ({ principal, operation }) =>
          principal === "anonymous"
            ? Effect.fail(
                new AgentProtocol.AgentUnauthorizedError({ operation })
              )
            : Ref.update(operations, (all) => [...all, operation])
      }
      const session = yield* sessionId("chat")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* hostWith(authorization)
          const denied = yield* Effect.flip(
            host.createSession("anonymous", {
              requestId: yield* requestId("denied"),
              sessionId: session
            })
          )
          assert.strictEqual(denied._tag, "AgentUnauthorizedError")
          assert.strictEqual(yield* Ref.get(fixture.opened), 0)

          yield* host.createSession("user", {
            requestId: yield* requestId("create"),
            sessionId: session
          })
          yield* host.session("user", { sessionId: session })
          yield* host.prompt("user", {
            requestId: yield* requestId("prompt"),
            sessionId: session,
            input: Prompt.make("hello")
          })
          yield* host.steer("user", {
            requestId: yield* requestId("steer"),
            sessionId: session,
            input: Prompt.make("steer")
          })
          yield* host.followUp("user", {
            requestId: yield* requestId("follow-up"),
            sessionId: session,
            input: Prompt.make("later")
          })
          yield* host.interrupt("user", {
            requestId: yield* requestId("interrupt"),
            sessionId: session
          })
          yield* host.respond("user", {
            requestId: yield* requestId("respond"),
            sessionId: session,
            response: { id: "elicit-1", granted: true }
          })
          yield* host.pending("user", { sessionId: session })
          yield* host.history("user", { sessionId: session })
          yield* host.status("user", { sessionId: session })
          const eventStream = yield* host.events("user", {
            sessionId: session
          })
          yield* Stream.runDrain(eventStream)
          yield* host.closeSession("user", {
            requestId: yield* requestId("close"),
            sessionId: session
          })

          assert.deepStrictEqual(yield* Ref.get(operations), [
            "createSession",
            "getSession",
            "prompt",
            "steer",
            "followUp",
            "interrupt",
            "respond",
            "pending",
            "history",
            "status",
            "events",
            "closeSession"
          ])
        }).pipe(Effect.provide(fixture.layer))
      )
    })
  )
})
