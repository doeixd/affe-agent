import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import * as AgentEvent from "../src/AgentEvent.js"
import { AgentBusyError, AgentClosedError, AgentIdleError } from "../src/Errors.js"
import { AgentClient, AgentProtocol } from "../src/client/index.js"
import { OpenAiAgent, OpenAiProjection } from "../src/openai/index.js"

/**
 * The pure half of the OpenAI adapter: a transition function from protocol
 * state and one agent event to the next state and the chunks on the wire.
 * Each case states a rule of the Chat Completions stream and checks the
 * machine keeps it, with no HTTP anywhere near.
 */

const sessionId = AgentEvent.SessionId.make("s")
const envelope = (
  sequence: number,
  event: AgentEvent.AgentEvent
): AgentEvent.AgentEventEnvelope => ({
  sessionId,
  submissionId: Option.some(AgentEvent.SubmissionId.make("sub")),
  runId: Option.none(),
  turn: Option.none(),
  sequence,
  event
})

const options: OpenAiProjection.Options = { id: "chatcmpl-1", created: 1, model: "m" }

const projectAll = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  Stream.runCollect(
    OpenAiProjection.project(
      options,
      Stream.fromIterable(events.map((event, i) => envelope(i + 1, event)))
    )
  )

const delta = (text: string): AgentEvent.AgentEvent => ({
  _tag: "MessageDelta",
  kind: "text",
  delta: text
})
const completed: AgentEvent.AgentEvent = { _tag: "SubmissionCompleted", runs: 1 }

/** The concatenated content, the role chunks, and the terminal frames. */
const summarize = (frames: ReadonlyArray<OpenAiProjection.Frame>) => {
  const chunks = frames.flatMap((f) => (f._tag === "Chunk" ? [f.chunk] : []))
  return {
    text: chunks.map((c) => c.choices[0]?.delta.content ?? "").join(""),
    roles: chunks.filter((c) => c.choices[0]?.delta.role === "assistant").length,
    finish: chunks.flatMap((c) => (c.choices[0]?.finish_reason ? [c.choices[0].finish_reason] : [])),
    tags: frames.map((f) => f._tag),
    errors: frames.flatMap((f) => (f._tag === "Error" ? [f.error] : []))
  }
}

describe("OpenAiProjection", () => {
  it.effect("text deltas become content chunks after exactly one role chunk, then finish and [DONE]", () =>
    Effect.gen(function* () {
      const frames = yield* projectAll([
        { _tag: "SubmissionStarted" },
        { _tag: "RunStarted" },
        { _tag: "MessageStarted" },
        delta("Hel"),
        delta("lo"),
        { _tag: "MessageStreamCompleted" },
        { _tag: "MessageCompleted", text: "Hello" },
        { _tag: "RunCompleted", turns: 1 },
        completed
      ])
      const s = summarize(frames)
      assert.strictEqual(s.text, "Hello")
      assert.strictEqual(s.roles, 1)
      assert.deepStrictEqual(s.finish, ["stop"])
      assert.strictEqual(s.tags[s.tags.length - 1], "Done")
      // The role goes out first and alone, as OpenAI's own stream does.
      const first = frames[0]
      assert.isTrue(first?._tag === "Chunk" && first.chunk.choices[0]?.delta.content === "")
      // Every chunk carries the completion identity.
      for (const f of frames) {
        if (f._tag === "Chunk") {
          assert.strictEqual(f.chunk.id, "chatcmpl-1")
          assert.strictEqual(f.chunk.model, "m")
          assert.strictEqual(f.chunk.object, "chat.completion.chunk")
        }
      }
    })
  )

  it.effect("reasoning deltas and empty deltas produce nothing", () =>
    Effect.gen(function* () {
      const frames = yield* projectAll([
        { _tag: "MessageStarted" },
        { _tag: "MessageDelta", kind: "reasoning", delta: "thinking" },
        delta(""),
        completed
      ])
      const s = summarize(frames)
      assert.strictEqual(s.text, "")
      // Nothing was said, but the stream is still a well-formed completion.
      assert.strictEqual(s.roles, 1)
      assert.deepStrictEqual(s.tags, ["Chunk", "Chunk", "Done"])
    })
  )

  it.effect("text from a later message is separated from the earlier one", () =>
    Effect.gen(function* () {
      const frames = yield* projectAll([
        { _tag: "MessageStarted" },
        delta("I will look."),
        { _tag: "MessageStreamCompleted" },
        { _tag: "ToolCallStarted", id: "t1", name: "search", params: {} },
        { _tag: "ToolCallSucceeded", id: "t1", name: "search", result: "x", encodedResult: "x" },
        { _tag: "MessageStarted" },
        delta("Found it."),
        completed
      ])
      assert.strictEqual(
        summarize(frames).text,
        `I will look.${OpenAiProjection.MESSAGE_SEPARATOR}Found it.`
      )
      // A message that said nothing (a pure tool-call turn) adds no separator.
      const quiet = yield* projectAll([
        { _tag: "MessageStarted" },
        { _tag: "MessageStreamCompleted" },
        { _tag: "MessageStarted" },
        delta("Only this."),
        completed
      ])
      assert.strictEqual(summarize(quiet).text, "Only this.")
    })
  )

  it.effect("a failed submission is an error frame then [DONE], never a finish chunk", () =>
    Effect.gen(function* () {
      const frames = yield* projectAll([
        { _tag: "MessageStarted" },
        delta("partial"),
        {
          _tag: "SubmissionFailed",
          failure: { tag: "ToolFailed", message: "boom", isDefect: false }
        }
      ])
      const s = summarize(frames)
      assert.deepStrictEqual(s.finish, [])
      assert.deepStrictEqual(s.tags.slice(-2), ["Error", "Done"])
      assert.deepStrictEqual(s.errors, [
        { message: "boom", type: "server_error", code: "ToolFailed", param: null }
      ])
    })
  )

  it.effect("an interrupted submission is reported, not passed off as a normal stop", () =>
    Effect.gen(function* () {
      const s = summarize(yield* projectAll([delta("a"), { _tag: "SubmissionInterrupted" }]))
      assert.deepStrictEqual(s.finish, [])
      assert.strictEqual(s.errors[0]?.code, "interrupted")
    })
  )

  it.effect("nothing follows the terminal frame", () =>
    Effect.gen(function* () {
      const [state, frames] = OpenAiProjection.transition(
        OpenAiProjection.initialState(options),
        envelope(1, completed)
      )
      assert.isTrue(state.finished)
      assert.strictEqual(frames[frames.length - 1]?._tag, "Done")
      const [, after] = OpenAiProjection.transition(state, envelope(2, delta("late")))
      assert.deepStrictEqual(after, [])
    })
  )

  it.effect("the non-streaming response carries the same identity and a stop reason", () => {
    const response = OpenAiProjection.response.success(options, "hi")
    assert.deepStrictEqual(response, {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }]
    })
    return Effect.void
  })
})

describe("OpenAiAgent message rules", () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "one" },
    { role: "assistant", content: "1" },
    { role: "user", content: [{ type: "text", text: "two" }] },
    { role: "user", content: "three" }
  ] as const

  it.effect("strict mode keeps every message, roles intact", () => Effect.gen(function* () {
    const prompt = yield* OpenAiAgent.strictPrompt(messages)
    assert.deepStrictEqual(
      prompt.content.map((m) => m.role),
      ["system", "user", "assistant", "user", "user"]
    )
    const first = prompt.content[0]
    assert.isTrue(first?.role === "system" && first.content === "be brief")
  }))

  it.effect("stateful mode submits only the user messages after the last assistant message", () => Effect.gen(function* () {
    const delta = yield* OpenAiAgent.statefulDelta(messages)
    assert.isTrue(Option.isSome(delta))
    const texts = Option.isSome(delta)
      ? delta.value.content.map((m) =>
          m.role === "user"
            ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
            : m.role
        )
      : []
    assert.deepStrictEqual(texts, ["two", "three"])
    // "Last" assistant, not "an" assistant: with two assistant turns the
    // delta is only what follows the *second* one.
    const twoTurns = [
      { role: "user", content: "a" },
      { role: "assistant", content: "1" },
      { role: "user", content: "b" },
      { role: "assistant", content: "2" },
      { role: "user", content: "c" }
    ] as const
    const twoDelta = yield* OpenAiAgent.statefulDelta(twoTurns)
    assert.isTrue(
      Option.isSome(twoDelta) &&
        twoDelta.value.content.every((m) => m.role === "user") &&
        twoDelta.value.content.length === 1
    )
    // Nothing after the last assistant message: nothing to submit.
    assert.isTrue(Option.isNone(yield* OpenAiAgent.statefulDelta(messages.slice(0, 3))))
    // A trailing system message alone is not input either.
    assert.isTrue(
      Option.isNone(
        yield* OpenAiAgent.statefulDelta([...messages.slice(0, 3), { role: "system", content: "x" }])
      )
    )
  }))

  it.effect("every RemoteError has an honest OpenAI status and keeps its tag as the code", () => {
    const sessionId = AgentEvent.SessionId.make("s")
    const cases: ReadonlyArray<readonly [AgentProtocol.RemoteError, number, string]> = [
      [new AgentBusyError({ sessionId }), 409, "conflict_error"],
      [new AgentIdleError({ sessionId, operation: "steer" }), 409, "conflict_error"],
      [new AgentClosedError({ sessionId }), 409, "conflict_error"],
      [new AgentClient.AgentSessionNotFoundError({ sessionId }), 404, "not_found_error"],
      [
        new AgentClient.AgentExecutionError({ sessionId, tag: "ToolFailed", detail: "x", isDefect: false }),
        422,
        "server_error"
      ],
      [new AgentClient.AgentTransportError({ sessionId, detail: "down" }), 503, "server_error"],
      [new AgentProtocol.AgentUnauthorizedError({ operation: "prompt" }), 401, "authentication_error"],
      [new AgentProtocol.AgentCapacityExceededError({ capacity: 1 }), 429, "rate_limit_error"]
    ]
    for (const [error, status, type] of cases) {
      const mapped = OpenAiAgent.fromRemoteError(error)
      assert.strictEqual(mapped.status, status, error._tag)
      assert.strictEqual(mapped.error.type, type, error._tag)
      assert.strictEqual(
        mapped.error.code,
        error._tag === "AgentExecutionError" ? error.tag : error._tag
      )
    }
    return Effect.void
  })
})
