import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { completion, errorBody, makeServer, post, readStream } from "./OpenAiHelpers.js"

/**
 * The endpoint as an OpenAI SDK sees it: plain `fetch` against a real
 * server, JSON in, JSON or SSE out. The agent behind it is the in-process
 * client; `OpenAiDurable.test.ts` runs the same layer over the durable one.
 */

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

const user = (content: string) => ({ role: "user", content })

describe("OpenAiAgent over the in-process client", () => {
  it.live("a non-streaming completion carries the agent's text, with tools kept inside", () =>
    Effect.gen(function* () {
      const { address, recorder } = yield* makeServer(
        Agent.make({
          toolkit: Agent.toolkit([Search], {
            search: ({ query }) => Effect.succeed(`hits for ${query}`)
          }),
          loop: AgentLoop.bounded(4)
        }),
        [
          { toolCalls: [{ id: "t1", name: "search", params: { query: "effect" } }] },
          TestLanguageModel.text("Effect is a TypeScript library.")
        ]
      )
      const response = yield* post(address, {
        model: "agent",
        messages: [{ role: "system", content: "be brief" }, user("what is effect?")],
        temperature: 0.2
      })
      assert.strictEqual(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /application\/json/)
      const body = yield* completion(response)
      assert.strictEqual(body.object, "chat.completion")
      assert.strictEqual(body.model, "agent")
      assert.match(body.id, /^chatcmpl-/)
      assert.deepStrictEqual(body.choices, [
        {
          index: 0,
          message: { role: "assistant", content: "Effect is a TypeScript library." },
          finish_reason: "stop"
        }
      ])
      // The tool ran inside the harness: two model calls, and the caller saw
      // only the final text. Unknown request fields were ignored.
      assert.strictEqual(yield* recorder.calls, 2)
    }).pipe(Effect.scoped)
  )

  it.live("a streaming completion is role, content deltas, finish, [DONE]", () =>
    Effect.gen(function* () {
      const { address } = yield* makeServer(Agent.make({ loop: AgentLoop.bounded(2) }), [
        { text: "streamed reply", chunks: ["stream", "ed ", "reply"] }
      ])
      const response = yield* post(address, {
        model: "agent",
        messages: [user("go")],
        stream: true
      })
      assert.strictEqual(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
      const stream = yield* readStream(response)
      assert.isTrue(stream.done)
      assert.deepStrictEqual(stream.errors, [])
      assert.strictEqual(stream.text, "streamed reply")
      assert.deepStrictEqual(stream.finish, ["stop"])
      assert.strictEqual(stream.chunks[0]?.choices[0]?.delta.role, "assistant")
      // More than one content chunk: the text was streamed, not sent whole.
      assert.isTrue(stream.chunks.length > 3, `only ${stream.chunks.length} chunks`)
      const ids = new Set(stream.chunks.map((c) => c.id))
      assert.strictEqual(ids.size, 1)
    }).pipe(Effect.scoped)
  )

  it.live("the strict mode request is the whole conversation", () =>
    Effect.gen(function* () {
      const { address, recorder } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        [TestLanguageModel.text("three")]
      )
      const response = yield* post(address, {
        model: "agent",
        messages: [user("one"), { role: "assistant", content: "1" }, user("two")]
      })
      assert.strictEqual(response.status, 200)
      assert.strictEqual((yield* completion(response)).choices[0]?.message.content, "three")
      // The model saw the caller's conversation: system-free, three messages.
      const seen = yield* recorder.prompts
      const roles = seen[0]?.content.map((m) => m.role)
      assert.deepStrictEqual(roles, ["user", "assistant", "user"])
    }).pipe(Effect.scoped)
  )

  it.live("the stateful extension keeps one session and submits only the new input", () =>
    Effect.gen(function* () {
      const { address, recorder } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        [TestLanguageModel.text("first answer"), TestLanguageModel.text("second answer")]
      )
      const headers = { "x-agent-session-id": "customer-1" }
      const first = yield* post(
        address,
        { model: "agent", messages: [{ role: "system", content: "ignored" }, user("hello")] },
        headers
      )
      assert.strictEqual(first.status, 200)
      assert.strictEqual((yield* completion(first)).choices[0]?.message.content, "first answer")
      // An OpenAI client resends everything. Only "next" is new.
      const second = yield* post(
        address,
        {
          model: "agent",
          messages: [
            { role: "system", content: "ignored" },
            user("hello"),
            { role: "assistant", content: "first answer" },
            user("next")
          ]
        },
        headers
      )
      assert.strictEqual(second.status, 200)
      assert.strictEqual((yield* completion(second)).choices[0]?.message.content, "second answer")
      const prompts = yield* recorder.prompts
      const userTexts = TestLanguageModel.userTexts(prompts[1]!)
      // The session's history, not the request's: hello, first answer, next --
      // with neither "hello" nor the system message duplicated.
      assert.deepStrictEqual(userTexts, ["hello", "next"])
      assert.strictEqual(prompts[1]!.content.filter((m) => m.role === "system").length, 0)
      // Nothing new to submit is a client error, not an empty run.
      const empty = yield* post(
        address,
        { model: "agent", messages: [user("hello"), { role: "assistant", content: "first answer" }] },
        headers
      )
      assert.strictEqual(empty.status, 400)
      assert.strictEqual((yield* errorBody(empty)).error.code, "empty_delta")
      assert.strictEqual(yield* recorder.calls, 2)
    }).pipe(Effect.scoped)
  )

  it.live("an unknown model, a malformed body and an empty conversation are OpenAI errors", () =>
    Effect.gen(function* () {
      const { address, recorder } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        [TestLanguageModel.text("never")]
      )
      const unknown = yield* post(address, { model: "gpt-4o", messages: [user("x")] })
      assert.strictEqual(unknown.status, 404)
      const unknownBody = yield* errorBody(unknown)
      assert.strictEqual(unknownBody.error.code, "model_not_found")
      assert.strictEqual(unknownBody.error.param, "model")
      assert.strictEqual(unknownBody.error.type, "not_found_error")

      const malformed = yield* post(address, { model: "agent", messages: "nope" })
      assert.strictEqual(malformed.status, 400)
      assert.strictEqual((yield* errorBody(malformed)).error.type, "invalid_request_error")

      const empty = yield* post(address, { model: "agent", messages: [] })
      assert.strictEqual(empty.status, 400)
      assert.strictEqual((yield* errorBody(empty)).error.code, "empty_messages")
      assert.strictEqual(yield* recorder.calls, 0)
    }).pipe(Effect.scoped)
  )

  it.live("an agent failure is 422 with the originating tag, not a transport failure", () =>
    Effect.gen(function* () {
      class Broken extends Schema.TaggedError<Broken>()("Broken", {}) {}
      const Fragile = Tool.make("search", {
        parameters: Schema.Struct({ query: Schema.String }),
        success: Schema.String,
        failure: Broken
      })
      const { address } = yield* makeServer(
        Agent.make({
          toolkit: Agent.toolkit([Fragile], {
            search: () => Effect.fail(new Broken())
          }),
          toolFailurePolicy: ToolExecution.FailRun,
          loop: AgentLoop.bounded(4)
        }),
        [
          { toolCalls: [{ id: "t1", name: "search", params: { query: "x" } }] },
          { toolCalls: [{ id: "t2", name: "search", params: { query: "x" } }] }
        ]
      )
      const response = yield* post(address, { model: "agent", messages: [user("go")] })
      assert.strictEqual(response.status, 422)
      const body = yield* errorBody(response)
      assert.strictEqual(body.error.type, "server_error")
      assert.strictEqual(body.error.code, "Broken")
      // Streaming: the same failure travels as an error frame before [DONE].
      const streamed = yield* post(address, { model: "agent", messages: [user("go")], stream: true })
      assert.strictEqual(streamed.status, 200)
      const stream = yield* readStream(streamed)
      assert.isTrue(stream.done)
      assert.deepStrictEqual(stream.finish, [])
      assert.strictEqual(stream.errors[0]?.code, "Broken")
    }).pipe(Effect.scoped)
  )

  it.live("a busy stateful session is 409 for a second caller, and the first completes", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const { address } = yield* makeServer(Agent.make({ loop: AgentLoop.bounded(2) }), [
        { text: "slow", started: entered, during: Deferred.await(release) }
      ])
      const headers = { "x-agent-session-id": "shared" }
      const first = yield* Effect.forkChild(
        post(address, { model: "agent", messages: [user("one")] }, headers)
      )
      yield* Deferred.await(entered)
      const second = yield* post(address, { model: "agent", messages: [user("two")] }, headers)
      assert.strictEqual(second.status, 409)
      assert.strictEqual((yield* errorBody(second)).error.code, "AgentBusyError")
      yield* Deferred.succeed(release, void 0)
      const done = yield* Fiber.join(first)
      assert.strictEqual(done.status, 200)
      assert.strictEqual((yield* completion(done)).choices[0]?.message.content, "slow")
    }).pipe(Effect.scoped)
  )

  it.live("an idempotency key joins in-flight work and replays a completed result", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const { address, recorder } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        [{ text: "once", during: Deferred.await(release) }, TestLanguageModel.text("never")]
      )
      const request = { model: "agent", messages: [user("do it")] }
      const headers = { "idempotency-key": "k-1" }
      const first = yield* Effect.forkChild(post(address, request, headers))
      const second = yield* Effect.forkChild(post(address, request, headers))
      yield* Deferred.succeed(release, void 0)
      const [a, b] = yield* Effect.all([
        Effect.flatMap(Fiber.join(first), completion),
        Effect.flatMap(Fiber.join(second), completion)
      ])
      assert.deepStrictEqual(a, b)
      assert.strictEqual(a.choices[0]?.message.content, "once")
      // After completion: replayed, in either shape, still one execution.
      const again = yield* post(address, request, headers)
      assert.deepStrictEqual(yield* completion(again), a)
      const streamed = yield* post(address, { ...request, stream: true }, headers)
      const stream = yield* readStream(streamed)
      assert.strictEqual(stream.text, "once")
      assert.isTrue(stream.done)
      assert.strictEqual(yield* recorder.calls, 1)
      // The same key with a different request is refused.
      const reused = yield* post(address, { model: "agent", messages: [user("other")] }, headers)
      assert.strictEqual(reused.status, 400)
      assert.strictEqual((yield* errorBody(reused)).error.code, "idempotency_key_reuse")
    }).pipe(Effect.scoped)
  )

  it.live("an idempotency key is scoped to the exact request: a different model is a mismatch, a different message too", () =>
    Effect.gen(function* () {
      const { address } = yield* makeServer(Agent.make({ loop: AgentLoop.bounded(2) }), [
        TestLanguageModel.text("done")
      ])
      const headers = { "idempotency-key": "scoped" }
      const first = yield* post(address, { model: "agent", messages: [user("one")] }, headers)
      assert.strictEqual(first.status, 200)
      // Same key, a model the fingerprint did not cover: refused, not silently
      // returning the first result. (The unknown model is caught first, but a
      // *known* different model would mismatch too -- there is only one here,
      // so vary the message, which the fingerprint also covers.)
      const differentMessage = yield* post(address, { model: "agent", messages: [user("two")] }, headers)
      assert.strictEqual(differentMessage.status, 400)
      assert.strictEqual((yield* errorBody(differentMessage)).error.code, "idempotency_key_reuse")
      // The original request under the key still replays.
      const same = yield* post(address, { model: "agent", messages: [user("one")] }, headers)
      assert.strictEqual((yield* completion(same)).choices[0]?.message.content, "done")
    }).pipe(Effect.scoped)
  )

  it.live("many concurrent requests with one idempotency key execute exactly once", () =>
    Effect.gen(function* () {
      // The begin() get-check-insert must be atomic: a non-atomic version lets
      // two concurrent requests both observe no entry and both execute. Fire a
      // burst at one key and assert a single execution.
      const release = yield* Deferred.make<void>()
      const { address, recorder } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        [{ text: "single", during: Deferred.await(release) }, TestLanguageModel.text("never")]
      )
      const request = { model: "agent", messages: [user("go")] }
      const headers = { "idempotency-key": "burst" }
      const fibers = yield* Effect.forkChild(
        Effect.all(
          Array.from({ length: 20 }, () => post(address, request, headers)),
          { concurrency: "unbounded" }
        )
      )
      yield* Deferred.succeed(release, void 0)
      const responses = yield* Fiber.join(fibers)
      const bodies = yield* Effect.forEach(responses, completion)
      // All twenty joined the one execution and got the one result.
      for (const body of bodies) {
        assert.strictEqual(body.choices[0]?.message.content, "single")
      }
      assert.strictEqual(yield* recorder.calls, 1)
    }).pipe(Effect.scoped)
  )

  it.live("a failed attempt releases its idempotency key so a retry executes again", () =>
    Effect.gen(function* () {
      let attempts = 0
      class Flaky extends Schema.TaggedError<Flaky>()("Flaky", {}) {}
      const FlakyTool = Tool.make("search", {
        parameters: Schema.Struct({ query: Schema.String }),
        success: Schema.String,
        failure: Flaky
      })
      const { address } = yield* makeServer(
        Agent.make({
          toolkit: Agent.toolkit([FlakyTool], {
            search: () => {
              attempts += 1
              return attempts === 1 ? Effect.fail(new Flaky()) : Effect.succeed("ok")
            }
          }),
          toolFailurePolicy: ToolExecution.FailRun,
          loop: AgentLoop.bounded(4)
        }),
        [
          { toolCalls: [{ id: "t1", name: "search", params: { query: "x" } }] },
          { toolCalls: [{ id: "t2", name: "search", params: { query: "x" } }] },
          TestLanguageModel.text("recovered")
        ]
      )
      const request = { model: "agent", messages: [user("go")] }
      const headers = { "idempotency-key": "k-flaky" }
      const first = yield* post(address, request, headers)
      assert.strictEqual(first.status, 422)
      const second = yield* post(address, request, headers)
      assert.strictEqual(second.status, 200)
      assert.strictEqual((yield* completion(second)).choices[0]?.message.content, "recovered")
    }).pipe(Effect.scoped)
  )

  it.live("a streaming client that disconnects does not stall the server", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const { address } = yield* makeServer(Agent.make({ loop: AgentLoop.bounded(2) }), [
        { text: "long", started: entered, during: Deferred.await(release) },
        TestLanguageModel.text("after")
      ])
      const controller = new AbortController()
      const aborted = yield* Effect.forkChild(
        Effect.promise(() =>
          fetch(`${address}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "agent", messages: [user("go")], stream: true }),
            signal: controller.signal
          })
            .then((r) => r.text())
            .catch(() => "aborted")
        )
      )
      /**
       * Abort once the attempt is genuinely under way, not after a fixed wait.
       *
       * These slept 50ms, which only ever meant "long enough for the request
       * to reach the model" -- the turn blocks on `during` before it emits
       * anything, so nothing has streamed yet either way. Under a loaded
       * parallel suite 50ms is not reliably long enough, and the abort then
       * lands before the attempt exists. The idempotency case below failed
       * exactly that way during a full run: the retry became the *first*
       * execution, the model was called once instead of twice, and the test
       * proved nothing about idempotency while looking like it had.
       *
       * `started` fires inside the turn, immediately before it blocks, so
       * waiting on it is the same instant the sleep was aiming at -- with no
       * clock involved.
       */
      yield* Deferred.await(entered)
      controller.abort()
      assert.strictEqual(yield* Fiber.join(aborted), "aborted")
      yield* Deferred.succeed(release, void 0)
      const next = yield* post(address, { model: "agent", messages: [user("again")] })
      assert.strictEqual(next.status, 200)
    }).pipe(Effect.scoped)
  )

  it.live("a stream interrupted mid-generation does not poison its idempotency key with a partial result", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const { address, recorder } = yield* makeServer(Agent.make({ loop: AgentLoop.bounded(2) }), [
        { text: "the full and complete answer", chunks: ["the full ", "and complete ", "answer"], started: entered, during: Deferred.await(release) },
        TestLanguageModel.text("re-executed")
      ])
      const headers = { "idempotency-key": "cut-short" }
      const controller = new AbortController()
      const aborted = yield* Effect.forkChild(
        Effect.promise(() =>
          fetch(`${address}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ model: "agent", messages: [user("go")], stream: true }),
            signal: controller.signal
          })
            .then((r) => r.text())
            .catch(() => "aborted")
        )
      )
      /**
       * Abort once the attempt is genuinely under way, not after a fixed wait.
       *
       * These slept 50ms, which only ever meant "long enough for the request
       * to reach the model" -- the turn blocks on `during` before it emits
       * anything, so nothing has streamed yet either way. Under a loaded
       * parallel suite 50ms is not reliably long enough, and the abort then
       * lands before the attempt exists. The idempotency case below failed
       * exactly that way during a full run: the retry became the *first*
       * execution, the model was called once instead of twice, and the test
       * proved nothing about idempotency while looking like it had.
       *
       * `started` fires inside the turn, immediately before it blocks, so
       * waiting on it is the same instant the sleep was aiming at -- with no
       * clock involved.
       */
      yield* Deferred.await(entered)
      controller.abort()
      assert.strictEqual(yield* Fiber.join(aborted), "aborted")
      // The interrupted attempt did not commit a result for the key. A retry
      // re-executes rather than replaying a truncated answer.
      yield* Deferred.succeed(release, void 0)
      const retry = yield* post(address, { model: "agent", messages: [user("go")] }, headers)
      assert.strictEqual(retry.status, 200)
      const body = yield* completion(retry)
      // The retry re-executed (the model advanced to its second turn), rather
      // than replaying the interrupted attempt's partial "the full ". Two
      // executions, and the answer is a complete one, never a truncated chunk.
      assert.strictEqual(body.choices[0]?.message.content, "re-executed")
      assert.strictEqual(yield* recorder.calls, 2)
    }).pipe(Effect.scoped)
  )

  /**
   * A request that never produces a result must release the key it claimed.
   *
   * The claim happens before the work is even resolvable, so a request that
   * fails on its way there -- a stateful call whose trailing input is empty,
   * a session the backend refuses -- left the key held by a promise nothing
   * would ever keep. The retry the key exists to serve then joined a deferred
   * that never completed and hung for as long as the client would wait, which
   * is a worse outcome than the double execution the key prevents.
   */
  it.live("a request that fails before executing releases its idempotency key", () =>
    Effect.gen(function* () {
      const { address } = yield* makeServer(Agent.make({ loop: AgentLoop.bounded(2) }), [
        TestLanguageModel.text("never reached")
      ])
      const headers = {
        "x-agent-session-id": "thread-release",
        "idempotency-key": "k-unresolvable"
      }
      // Stateful mode submits the user messages *after* the last assistant
      // message, and this request has none.
      const body = {
        model: "agent",
        messages: [user("hi"), { role: "assistant", content: "already answered" }]
      }
      const first = yield* post(address, body, headers)
      assert.strictEqual(first.status, 400)
      assert.strictEqual((yield* errorBody(first)).error.code, "empty_delta")

      // The retry gets the same answer rather than waiting on a result that
      // is never coming. The timeout is the assertion: without the release it
      // does not return at all.
      const retry = yield* post(address, body, headers).pipe(
        Effect.timeout("5 seconds")
      )
      assert.strictEqual(retry.status, 400)
      assert.strictEqual((yield* errorBody(retry)).error.code, "empty_delta")
    }).pipe(Effect.scoped)
  )

  it.live("a custom path and header names are honoured", () =>
    Effect.gen(function* () {
      const { address } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(2) }),
        [TestLanguageModel.text("custom")],
        { path: "/openai/chat", session: { header: "x-thread" } }
      )
      const response = yield* Effect.promise(() =>
        fetch(`${address}/openai/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-thread": "t-1" },
          body: JSON.stringify({ model: "agent", messages: [user("hi")] })
        })
      )
      assert.strictEqual(response.status, 200)
      const missing = yield* post(address, { model: "agent", messages: [user("hi")] })
      assert.strictEqual(missing.status, 404)
    }).pipe(Effect.scoped)
  )
})

describe("OpenAiAgent multimodal input", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const base64 = Buffer.from(png).toString("base64")

  it.live("image_url, input_audio and file parts reach the agent as file parts", () =>
    Effect.gen(function* () {
      const { address, recorder } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(1) }),
        [TestLanguageModel.text("a diagram")]
      )
      const response = yield* post(address, {
        model: "agent",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
            { type: "image_url", image_url: { url: "https://example.test/photo.jpg" } },
            { type: "input_audio", input_audio: { data: base64, format: "mp3" } },
            { type: "file", file: { file_data: `data:application/pdf;base64,${base64}`, filename: "report.pdf" } }
          ]
        }]
      })
      assert.strictEqual(response.status, 200)
      const seen = (yield* recorder.prompts)[0]!
      const user = seen.content.find((message) => message.role === "user")
      assert.isDefined(user)
      if (user?.role !== "user") return
      assert.deepStrictEqual(user.content.map((part) => part.type), ["text", "file", "file", "file", "file"])
      const files = user.content.flatMap((part) => (part.type === "file" ? [part] : []))
      // A data URL is decoded to the bytes it carries, with its own type.
      assert.strictEqual(files[0]?.mediaType, "image/png")
      assert.deepStrictEqual(Array.from(files[0]?.data instanceof Uint8Array ? files[0].data : []), Array.from(png))
      // A remote image stays a URL; its subtype is not ours to guess.
      assert.strictEqual(files[1]?.mediaType, "image/*")
      assert.isTrue(files[1]?.data instanceof URL)
      // Audio takes the format's media type.
      assert.strictEqual(files[2]?.mediaType, "audio/mpeg")
      // A file keeps its name.
      assert.strictEqual(files[3]?.mediaType, "application/pdf")
      assert.strictEqual(files[3]?.fileName, "report.pdf")
    }).pipe(Effect.scoped)
  )

  it.live("a file_id reference is refused as an invalid request, not silently dropped", () =>
    Effect.gen(function* () {
      const { address, recorder } = yield* makeServer(
        Agent.make({ loop: AgentLoop.bounded(1) }),
        [TestLanguageModel.text("never")]
      )
      const response = yield* post(address, {
        model: "agent",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "summarise the attached" },
            { type: "file", file: { file_id: "file-abc123" } }
          ]
        }]
      })
      assert.strictEqual(response.status, 400)
      const body = yield* errorBody(response)
      assert.strictEqual(body.error.code, "unsupported_file_id")
      assert.strictEqual(body.error.param, "messages")
      // The model was never asked: an answer to a prompt missing its document
      // is worse than a refusal.
      assert.strictEqual(yield* recorder.calls, 0)
    }).pipe(Effect.scoped)
  )
})
