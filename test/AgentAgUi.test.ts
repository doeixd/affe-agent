import { HttpAgent } from "@ag-ui/client"
import { EventSchemas, type RunAgentInput as OfficialRunAgentInput } from "@ag-ui/core"
import { assert, describe, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"
import {
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentAgUi } from "../src/ag-ui/index.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"

type Assert<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false
type _OfficialInputAccepted = Assert<
  OfficialRunAgentInput extends typeof AgentAgUi.RunAgentInput.Encoded
    ? true
    : false
>

const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)
const sessionId = AgentEvent.SessionId.make("ag-ui-session")
const submissionId = AgentEvent.SubmissionId.make("ag-ui-submission")
const harnessRunId = AgentEvent.RunId.make("harness-run")

const envelope = (
  sequence: number,
  event: AgentEvent.AgentEvent
): AgentEvent.AgentEventEnvelope => ({
  sessionId,
  submissionId: Option.some(submissionId),
  runId: Option.some(harnessRunId),
  turn: Option.some(1),
  sequence,
  event
})

const mapAll = (
  mapper: AgentAgUi.EventMapper,
  events: ReadonlyArray<AgentEvent.AgentEvent>
) =>
  Effect.map(
    Effect.forEach(events, (event, index) =>
      mapper.map(envelope(index + 1, event))
    ),
    (groups) => {
      const projected = groups.flat()
      for (const event of projected) {
        const parsed = EventSchemas.safeParse(event)
        assert.isTrue(parsed.success)
      }
      return projected
    }
  )

describe("AgentAgUi event constructors", () => {
  it("preserves exact primitive and semantic tuple types", () => {
    const content = AgentAgUi.text.content({
      messageId: "message-1",
      delta: "hello"
    })
    type _Content = Assert<
      Equal<typeof content, AgentAgUi.TextMessageContentEvent>
    >

    const message = AgentAgUi.text.message({
      id: "message-1",
      role: "assistant",
      text: "hello"
    })
    type _Message = Assert<
      Equal<
        typeof message,
        readonly [
          AgentAgUi.TextMessageStartEvent,
          AgentAgUi.TextMessageContentEvent,
          AgentAgUi.TextMessageEndEvent
        ]
      >
    >

    const lifecycle = AgentAgUi.events(
      ...message,
      AgentAgUi.run.success({
        threadId: "thread-1",
        runId: "run-1",
        result: { text: "hello" }
      })
    )
    type _Lifecycle = Assert<
      Equal<
        typeof lifecycle,
        readonly [
          AgentAgUi.TextMessageStartEvent,
          AgentAgUi.TextMessageContentEvent,
          AgentAgUi.TextMessageEndEvent,
          AgentAgUi.RunFinishedEvent
        ]
      >
    >

    const scoped = AgentAgUi.run({ threadId: "thread-1", runId: "run-1" })
    assert.deepStrictEqual(
      AgentAgUi.events(
        ...scoped.text.message({
          id: "message-1",
          role: "assistant",
          text: "hello"
        }),
        scoped.success({ text: "hello" })
      ),
      lifecycle
    )

    if (false) {
      // @ts-expect-error TEXT_MESSAGE_START has no delta field.
      AgentAgUi.event("TEXT_MESSAGE_START", { messageId: "bad", delta: "bad" })
      // @ts-expect-error RUN_STARTED requires both correlation ids.
      AgentAgUi.run.started({ threadId: "missing-run-id" })
    }

    assert.deepStrictEqual(content, {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "message-1",
      delta: "hello"
    })
  })

  it("builds exact tool and interrupt macro sequences", () => {
    assert.deepStrictEqual(
      AgentAgUi.tool.call({
        id: "tool-1",
        name: "lookup",
        args: '{"query":"effect"}',
        parentMessageId: "message-1"
      }),
      [
        {
          type: "TOOL_CALL_START",
          toolCallId: "tool-1",
          toolCallName: "lookup",
          parentMessageId: "message-1"
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "tool-1",
          delta: '{"query":"effect"}'
        },
        { type: "TOOL_CALL_END", toolCallId: "tool-1" }
      ]
    )
    assert.deepStrictEqual(
      AgentAgUi.run.interrupt({
        threadId: "thread-1",
        runId: "run-1",
        interrupts: [{ id: "approval-1", reason: "approval" }]
      }),
      {
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "run-1",
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "approval-1", reason: "approval" }]
        }
      }
    )
  })
})

describe("AgentAgUi event projection", () => {
  it.effect("maps a batch response to one balanced official lifecycle", () =>
    Effect.gen(function* () {
      const mapper = yield* AgentAgUi.makeEventMapper({
        threadId: "thread-1",
        runId: "ag-ui-run-1"
      })
      const events = yield* mapAll(mapper, [
        { _tag: "SubmissionStarted" },
        { _tag: "TurnStarted" },
        { _tag: "MessageCompleted", text: "hello" },
        { _tag: "TurnCompleted" },
        { _tag: "SubmissionCompleted", runs: 1 }
      ])

      assert.deepStrictEqual(events, [
        {
          type: "RUN_STARTED",
          threadId: "thread-1",
          runId: "ag-ui-run-1"
        },
        { type: "STEP_STARTED", stepName: "harness-run:1:turn" },
        {
          type: "TEXT_MESSAGE_START",
          messageId: "harness-run:1:message",
          role: "assistant"
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "harness-run:1:message",
          delta: "hello"
        },
        {
          type: "TEXT_MESSAGE_END",
          messageId: "harness-run:1:message"
        },
        { type: "STEP_FINISHED", stepName: "harness-run:1:turn" },
        {
          type: "RUN_FINISHED",
          threadId: "thread-1",
          runId: "ag-ui-run-1",
          result: { runs: 1 },
          outcome: { type: "success" }
        }
      ])
      assert.isTrue(yield* mapper.terminal)
    })
  )

  it.effect("the projection is a pure Stream transformation with one implementation", () =>
    Effect.gen(function* () {
      // The same harness events, once through the Stream-shaped projection
      // and once through the mapper the request handler drives. They must
      // agree exactly: there is one lifecycle, expressed as `transition`.
      const options = { threadId: "thread-1", runId: "ag-ui-run-1" }
      const source: ReadonlyArray<AgentEvent.AgentEvent> = [
        { _tag: "SubmissionStarted" },
        { _tag: "TurnStarted" },
        { _tag: "MessageStarted" },
        { _tag: "MessageDelta", kind: "text", delta: "hel" },
        { _tag: "MessageDelta", kind: "text", delta: "lo" },
        { _tag: "MessageStreamCompleted" },
        { _tag: "MessageCompleted", text: "hello" },
        { _tag: "ToolCallStarted", id: "c1", name: "search", params: { q: "x" } },
        { _tag: "ToolCallSucceeded", id: "c1", name: "search", result: "r", encodedResult: "r" },
        { _tag: "TurnCompleted" },
        { _tag: "SubmissionCompleted", runs: 1 },
        // After the terminal frame nothing may follow, whatever arrives.
        { _tag: "TurnStarted" },
        { _tag: "MessageCompleted", text: "late" }
      ]
      const envelopes = source.map((event, index) => envelope(index + 1, event))

      const projected = AgentAgUi.project(options, Stream.fromIterable(envelopes))
      // Lazy and typed: the source's channels pass through, plus the one
      // failure projection itself can raise.
      type _Error = Assert<
        Equal<Stream.Error<typeof projected>, AgentProtocol.AgentProtocolCodecError>
      >
      type _Services = Assert<Equal<Stream.Services<typeof projected>, never>>
      const viaStream = yield* Stream.runCollect(projected)

      const mapper = yield* AgentAgUi.makeEventMapper(options)
      const viaMapper = yield* mapAll(mapper, source)

      assert.deepStrictEqual(viaStream, viaMapper)
      assert.strictEqual(viaStream[viaStream.length - 1]?.type, "RUN_FINISHED")
      assert.strictEqual(viaStream.filter((e) => e.type === "TEXT_MESSAGE_START").length, 1)
      assert.strictEqual(viaStream.filter((e) => e.type === "TEXT_MESSAGE_END").length, 1)
      for (const event of viaStream) {
        assert.isTrue(EventSchemas.safeParse(event).success)
      }

      // And `transition` is pure: the same state and input give the same
      // output, and it never mutates what it was given.
      const initial = AgentAgUi.initialState(options)
      const once = AgentAgUi.transition(options, initial, envelopes[0]!, Option.none())
      const twice = AgentAgUi.transition(options, initial, envelopes[0]!, Option.none())
      assert.deepStrictEqual(once, twice)
      assert.deepStrictEqual(initial, AgentAgUi.initialState(options))
    })
  )

  /**
   * An event this build has no case for is skipped, not fatal.
   *
   * The wire envelope decodes tolerantly, so a newer peer's event reaches the
   * projection as `UnknownEvent`. AG-UI already covers a subset of tags and
   * ignores the rest; tolerance is only worth having if the unknown one is
   * treated the same way -- carried through the switch with no frame, no
   * state change, and no premature terminal.
   */
  it.effect("skips an event from a newer peer without disturbing the projection", () =>
    Effect.gen(function* () {
      const options = { threadId: "thread-unknown", runId: "ag-ui-run-unknown" }
      const known: ReadonlyArray<AgentEvent.AgentEvent> = [
        { _tag: "SubmissionStarted" },
        { _tag: "MessageCompleted", text: "hello" },
        { _tag: "SubmissionCompleted", runs: 1 }
      ]
      const fromNewerPeer: AgentEvent.AgentEventEnvelope = {
        sessionId,
        submissionId: Option.some(submissionId),
        runId: Option.some(harnessRunId),
        turn: Option.some(1),
        sequence: 99,
        event: {
          _tag: "UnknownEvent",
          originalTag: "SomethingThisBuildHasNeverHeardOf",
          payload: { _tag: "SomethingThisBuildHasNeverHeardOf", detail: "x" }
        }
      }

      const baseline = yield* Stream.runCollect(
        AgentAgUi.project(
          options,
          Stream.fromIterable(known.map((event, index) => envelope(index + 1, event)))
        )
      )
      const withUnknown = yield* Stream.runCollect(
        AgentAgUi.project(
          options,
          Stream.fromIterable([
            envelope(1, known[0]!),
            fromNewerPeer,
            envelope(2, known[1]!),
            envelope(3, known[2]!)
          ])
        )
      )
      assert.deepStrictEqual(withUnknown, baseline)
      assert.strictEqual(withUnknown[withUnknown.length - 1]?.type, "RUN_FINISHED")
    })
  )

  it.effect("does not duplicate a streamed message and balances an interrupt", () =>
    Effect.gen(function* () {
      const mapper = yield* AgentAgUi.makeEventMapper({
        threadId: "thread-2",
        runId: "ag-ui-run-2"
      })
      const events = yield* mapAll(mapper, [
        { _tag: "SubmissionStarted" },
        { _tag: "TurnStarted" },
        { _tag: "MessageStarted" },
        { _tag: "MessageDelta", kind: "text", delta: "hel" },
        { _tag: "MessageDelta", kind: "text", delta: "lo" },
        { _tag: "MessageStreamCompleted" },
        { _tag: "MessageCompleted", text: "hello" },
        {
          _tag: "ElicitationRequested",
          id: "approval-1",
          kind: "approval",
          detail: { question: "Continue?" }
        },
        { _tag: "SubmissionCompleted", runs: 1 }
      ])

      assert.deepStrictEqual(events.map((event) => event.type), [
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_FINISHED"
      ])
      assert.deepStrictEqual(events[7], {
        type: "RUN_FINISHED",
        threadId: "thread-2",
        runId: "ag-ui-run-2",
        outcome: {
          type: "interrupt",
          interrupts: [{
            id: "approval-1",
            reason: "approval",
            message: '{"question":"Continue?"}'
          }]
        }
      })
      assert.strictEqual(
        events.filter((event) => event.type === "TEXT_MESSAGE_START").length,
        1
      )
    })
  )

  it.effect("projects tool arguments, results, failures and progress as JSON", () =>
    Effect.gen(function* () {
      const mapper = yield* AgentAgUi.makeEventMapper({
        threadId: "thread-3",
        runId: "ag-ui-run-3"
      })
      const events = yield* mapAll(mapper, [
        {
          _tag: "ToolCallStarted",
          id: "tool-1",
          name: "lookup",
          params: { query: "effect" }
        },
        {
          _tag: "ToolCallProgress",
          id: "tool-1",
          name: "lookup",
          result: "halfway",
          encodedResult: { progress: 0.5 }
        },
        {
          _tag: "ToolCallSucceeded",
          id: "tool-1",
          name: "lookup",
          result: "done",
          encodedResult: { answer: 42 }
        },
        {
          _tag: "ToolCallFailed",
          id: "tool-2",
          name: "lookup",
          failure: { tag: "LookupError", message: "missing", isDefect: false },
          returnedToModel: true
        }
      ])

      assert.deepStrictEqual(events, [
        {
          type: "TOOL_CALL_START",
          toolCallId: "tool-1",
          toolCallName: "lookup",
          parentMessageId: "harness-run:1:message"
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: "tool-1",
          delta: '{"query":"effect"}'
        },
        { type: "TOOL_CALL_END", toolCallId: "tool-1" },
        {
          type: "CUSTOM",
          name: "effect-harness/tool-progress",
          value: {
            toolCallId: "tool-1",
            toolCallName: "lookup",
            content: '{"progress":0.5}'
          }
        },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "tool-1:result",
          toolCallId: "tool-1",
          content: '{"answer":42}',
          role: "tool"
        },
        {
          type: "TOOL_CALL_RESULT",
          messageId: "tool-2:result",
          toolCallId: "tool-2",
          content:
            '{"error":{"tag":"LookupError","message":"missing","isDefect":false},"returnedToModel":true}',
          role: "tool"
        }
      ])
    })
  )

  it.effect("closes active frames before a failure or interruption", () =>
    Effect.gen(function* () {
      const failed = yield* AgentAgUi.makeEventMapper({
        threadId: "thread-failed",
        runId: "run-failed"
      })
      const failureEvents = yield* mapAll(failed, [
        { _tag: "SubmissionStarted" },
        { _tag: "TurnStarted" },
        { _tag: "MessageStarted" },
        { _tag: "MessageDelta", kind: "text", delta: "partial" },
        {
          _tag: "MessageFailed",
          failure: { tag: "ModelError", message: "offline", isDefect: false }
        },
        {
          _tag: "SubmissionFailed",
          failure: { tag: "ModelError", message: "offline", isDefect: false }
        }
      ])
      assert.deepStrictEqual(failureEvents.map((event) => event.type), [
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_ERROR"
      ])
      assert.deepStrictEqual(failureEvents[6], {
        type: "RUN_ERROR",
        message: "offline",
        code: "ModelError"
      })

      const interrupted = yield* AgentAgUi.makeEventMapper({
        threadId: "thread-interrupted",
        runId: "run-interrupted"
      })
      const interruptionEvents = yield* mapAll(interrupted, [
        { _tag: "SubmissionStarted" },
        { _tag: "TurnStarted" },
        { _tag: "MessageStarted" },
        { _tag: "SubmissionInterrupted" }
      ])
      assert.deepStrictEqual(interruptionEvents.map((event) => event.type), [
        "RUN_STARTED",
        "STEP_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_END",
        "STEP_FINISHED",
        "RUN_ERROR"
      ])
      assert.deepStrictEqual(interruptionEvents[5], {
        type: "RUN_ERROR",
        message: "The agent run was interrupted",
        code: "INTERRUPTED"
      })
    })
  )
})

const serverFixture = (fixtureOptions?: {
  readonly blocked?: boolean
  readonly elicitation?: boolean
}) =>
  Effect.gen(function* () {
  const eventQueue = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope>()
  const sequence = yield* Ref.make(0)
  const approval = yield* Deferred.make<void>()
  const allowPrompt = yield* Deferred.make<void>()
  const promptStarted = yield* Deferred.make<void>()
  const promptCalls = yield* Ref.make(0)

  const emit = (event: AgentEvent.AgentEvent) =>
    Ref.updateAndGet(sequence, (value) => value + 1).pipe(
      Effect.flatMap((next) => Queue.offer(eventQueue, envelope(next, event))),
      Effect.asVoid
    )

  const agentClient = Layer.succeed(AgentClient.AgentClient, {
    createSession: (options) =>
      Effect.succeed({
        id: options?.sessionId ?? sessionId,
        prompt: () =>
          Effect.gen(function* () {
            yield* Ref.update(promptCalls, (count) => count + 1)
            yield* Deferred.succeed(promptStarted, void 0)
            if (fixtureOptions?.elicitation === true) {
              yield* Effect.forEach(
                [
                  { _tag: "SubmissionStarted" },
                  { _tag: "TurnStarted" },
                  {
                    _tag: "ElicitationRequested",
                    id: "approval-1",
                    kind: "approval",
                    detail: "Continue?"
                  }
                ] satisfies ReadonlyArray<AgentEvent.AgentEvent>,
                emit,
                { discard: true }
              )
              yield* Deferred.await(approval)
              yield* Effect.forEach(
                [
                  { _tag: "MessageCompleted", text: "approved answer" },
                  { _tag: "TurnCompleted" },
                  { _tag: "SubmissionCompleted", runs: 1 }
                ] satisfies ReadonlyArray<AgentEvent.AgentEvent>,
                emit,
                { discard: true }
              )
              return {
                submissionId,
                status: "completed" as const,
                runs: 1,
                turns: 1,
                text: "approved answer"
              }
            }
            if (fixtureOptions?.blocked === true) {
              yield* Deferred.await(allowPrompt)
            }
            yield* Effect.forEach(
              [
                { _tag: "SubmissionStarted" },
                { _tag: "TurnStarted" },
                { _tag: "MessageStarted" },
                { _tag: "MessageDelta", kind: "text", delta: "official " },
                { _tag: "MessageDelta", kind: "text", delta: "answer" },
                { _tag: "MessageStreamCompleted" },
                { _tag: "MessageCompleted", text: "official answer" },
                { _tag: "TurnCompleted" },
                { _tag: "SubmissionCompleted", runs: 1 }
              ] satisfies ReadonlyArray<AgentEvent.AgentEvent>,
              emit,
              { discard: true }
            )
            return {
              submissionId,
              status: "completed" as const,
              runs: 1,
              turns: 1,
              text: "official answer"
            }
          }),
        steer: () => Effect.void,
        followUp: () => Effect.void,
        interrupt: () => Effect.void,
        respond: (response) =>
          fixtureOptions?.elicitation === true && response.id === "approval-1"
            ? Effect.gen(function* () {
                yield* emit({
                  _tag: "ElicitationResolved",
                  id: response.id,
                  kind: "approval",
                  granted: response.granted
                })
                yield* Deferred.succeed(approval, void 0)
                return true
              })
            : Effect.succeed(false),
        pending: Effect.succeed([]),
        history: Effect.succeed(Prompt.make("")),
        status: Effect.succeed("idle" as const),
        events: () => Stream.fromQueue(eventQueue)
      }),
    session: (id) =>
      Effect.fail(
        new AgentClient.AgentSessionNotFoundError({ sessionId: id })
      )
  })

  const Host = AgentSessionHost.Tag<string>("test/AgentAgUi/host")
  const host = AgentSessionHost.layer(Host, {
    authorization: { authorize: () => Effect.void },
    principal: {
      resolve: ({ headers, operation }) =>
        headers.authorization === undefined
          ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
          : Effect.succeed(headers.authorization)
    },
    maxSessions: 4,
    maxRequestsPerSession: 16
  }).pipe(Layer.provide(agentClient))
  const routes = AgentAgUi.serverLayer({
    host: Host,
    session: {
      resolve: ({ input }) =>
        Effect.succeed(AgentProtocol.SessionId.make(`ag-ui:${input.threadId}`))
    }
  }).pipe(Layer.provide(host))

  const server = HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: true
  }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(createServer, {
        port: 0,
        gracefulShutdownTimeout: 100
      })
    )
  )

  return { server, allowPrompt, promptCalls, promptStarted }
  })

describe("AgentAgUi HTTP server", () => {
  it.effect("runs through the official 0.0.58 HttpAgent", () =>
    Effect.gen(function* () {
      const test = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const seen: Array<string> = []
          const agent = new HttpAgent({
            url: `${HttpServer.formatAddress(httpServer.address)}/ag-ui`,
            headers: { authorization: "Bearer test" },
            threadId: "official-thread",
            initialMessages: [{
              id: "user-1",
              role: "user",
              content: "hello"
            }]
          })

          const result = yield* promise(() =>
            agent.runAgent(
              { runId: "official-run" },
              { onEvent: ({ event }) => void seen.push(event.type) }
            )
          )

          assert.deepStrictEqual(seen, [
            "RUN_STARTED",
            "STEP_STARTED",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
            "STEP_FINISHED",
            "RUN_FINISHED"
          ])
          assert.strictEqual(result.newMessages.length, 1)
          assert.strictEqual(result.newMessages[0]?.role, "assistant")
          assert.strictEqual(result.newMessages[0]?.content, "official answer")
        }).pipe(Effect.provide(test.server))
      )
    })
  )

  it.effect("rejects unsupported client-owned capabilities before streaming", () =>
    Effect.gen(function* () {
      const test = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const response = yield* promise(() =>
            fetch(`${HttpServer.formatAddress(httpServer.address)}/ag-ui`, {
              method: "POST",
              headers: {
                authorization: "Bearer test",
                "content-type": "application/json"
              },
              body: JSON.stringify({
                threadId: "unsupported-thread",
                runId: "unsupported-run",
                state: { client: true },
                messages: [{ id: "user-1", role: "user", content: "hello" }],
                tools: [],
                context: [],
                forwardedProps: {}
              })
            })
          )

          assert.strictEqual(response.status, 400)
          const body = yield* promise(() => response.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.toCodecJson(AgentAgUi.Error))
            )
          )
          assert.strictEqual(
            body._tag,
            "AgentAgUiUnsupportedError"
          )
        }).pipe(Effect.provide(test.server))
      )
    })
  )

  it.effect("resumes a harness elicitation through official interrupt input", () =>
    Effect.gen(function* () {
      const test = yield* serverFixture({ elicitation: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const agent = new HttpAgent({
            url: `${HttpServer.formatAddress(httpServer.address)}/ag-ui`,
            headers: { authorization: "Bearer test" },
            threadId: "interrupt-thread",
            initialMessages: [{
              id: "user-approval",
              role: "user",
              content: "do the protected thing"
            }]
          })

          const interrupted = yield* promise(() =>
            agent.runAgent({ runId: "interrupt-run" })
          )
          assert.strictEqual(interrupted.newMessages.length, 0)
          assert.deepStrictEqual(agent.pendingInterrupts, [{
            id: "approval-1",
            reason: "approval",
            message: "Continue?"
          }])

          const resumed = yield* promise(() =>
            agent.runAgent({
              runId: "resume-run",
              resume: [{
                interruptId: "approval-1",
                status: "resolved",
                payload: { approvedBy: "test" }
              }]
            })
          )
          assert.strictEqual(resumed.newMessages.length, 1)
          assert.strictEqual(resumed.newMessages[0]?.content, "approved answer")
          assert.deepStrictEqual(agent.pendingInterrupts, [])
          assert.strictEqual(yield* Ref.get(test.promptCalls), 1)
        }).pipe(Effect.provide(test.server))
      )
    })
  )

  it.effect("a request with no user message consumes no session slot", () =>
    Effect.gen(function* () {
      const test = yield* serverFixture()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const url = `${HttpServer.formatAddress(httpServer.address)}/ag-ui`
          const post = (threadId: string, messages: ReadonlyArray<unknown>) =>
            promise(() =>
              fetch(url, {
                method: "POST",
                headers: {
                  authorization: "Bearer test",
                  "content-type": "application/json"
                },
                body: JSON.stringify({
                  threadId,
                  runId: `${threadId}-run`,
                  state: {},
                  messages,
                  tools: [],
                  context: [],
                  forwardedProps: {}
                })
              })
            )

          // More bad requests than the host has session slots (4). Each is
          // rejected on its input; none may occupy a slot on the way out, or
          // the fifth would be refused for capacity instead and a later
          // valid request on a new thread would find the host full.
          for (let i = 0; i < 6; i++) {
            const response = yield* post(`empty-${i}`, [])
            assert.strictEqual(response.status, 400)
            const body = yield* promise(() => response.json()).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.toCodecJson(AgentAgUi.Error))
              )
            )
            assert.strictEqual(body._tag, "AgentAgUiInvalidInputError")
          }
          const valid = yield* post("valid-thread", [
            { id: "u1", role: "user", content: "hello" }
          ])
          assert.strictEqual(valid.status, 200)
          yield* promise(() => valid.text())
        }).pipe(Effect.provide(test.server))
      )
    })
  )

  it.effect("keeps one prompt alive when its first AG-UI observer disconnects", () =>
    Effect.gen(function* () {
      const test = yield* serverFixture({ blocked: true })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpServer = yield* HttpServer.HttpServer
          const url = `${HttpServer.formatAddress(httpServer.address)}/ag-ui`
          const input = {
            threadId: "disconnect-thread",
            runId: "disconnect-run",
            state: {},
            messages: [{ id: "disconnect-user", role: "user", content: "wait" }],
            tools: [],
            context: [],
            forwardedProps: {}
          }
          const request = (signal?: AbortSignal) =>
            fetch(url, {
              method: "POST",
              headers: {
                authorization: "Bearer test",
                "content-type": "application/json"
              },
              body: JSON.stringify(input),
              ...(signal === undefined ? {} : { signal })
            })

          const controller = new AbortController()
          const first = yield* promise(() => request(controller.signal))
          yield* Deferred.await(test.promptStarted)
          const firstBody = first.body
          if (firstBody === null) {
            return yield* Effect.die(new Error("AG-UI response had no body"))
          }
          yield* promise(() => firstBody.cancel())
          controller.abort()

          const retry = yield* promise(() => request())
          yield* Deferred.succeed(test.allowPrompt, void 0)
          const encoded = yield* promise(() => retry.text())
          const events = yield* Effect.forEach(
            encoded
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice("data:".length).trim()),
            (data) =>
              Schema.decodeUnknownEffect(
                Schema.toCodecJson(AgentAgUi.Event)
              )(JSON.parse(data))
          )

          assert.deepStrictEqual(events.map((event) => event.type), [
            "RUN_STARTED",
            "STEP_STARTED",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
            "STEP_FINISHED",
            "RUN_FINISHED"
          ])
          for (const event of events) {
            assert.isTrue(EventSchemas.safeParse(event).success)
          }
          assert.strictEqual(yield* Ref.get(test.promptCalls), 1)
        }).pipe(Effect.provide(test.server))
      )
    })
  )
})
