import { assert, describe, it } from "@effect/vitest"
import { Role, TaskState, type Message } from "@a2a-js/sdk"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import { OpenCodeA2A } from "../src/a2a/index.js"

/**
 * The OpenCode bridge, against a stubbed server.
 *
 * `docs/plan-a2a-layers-bridges.txt` step 3. There is no `opencode serve` in
 * CI and there should not need to be: the bridge reaches it through
 * `HttpClient`, so a stub *is* the server as far as this module can tell --
 * the same property the Claude Code bridge gets from `Sandbox`.
 */

const BASE = "http://127.0.0.1:4096"

interface Call {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

const sse = (frames: ReadonlyArray<unknown>): string =>
  frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")

/** A stub server: records every call, answers from the handlers given. */
const server = (handlers: {
  readonly session?: unknown
  readonly prompt?: (calls: ReadonlyArray<Call>) => Effect.Effect<unknown>
  readonly events?: string | undefined
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([])
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body = request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined
        yield* Ref.update(calls, (all) => [
          ...all,
          { method: request.method, path: url.pathname, body }
        ])
        if (url.pathname === "/event") {
          return HttpClientResponse.fromWeb(
            request,
            new Response(handlers.events ?? "", {
              headers: { "content-type": "text/event-stream" }
            })
          )
        }
        if (url.pathname === "/session" && request.method === "POST") {
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(handlers.session ?? { id: "ses_1" }))
          )
        }
        if (url.pathname.endsWith("/message")) {
          const answer = handlers.prompt === undefined
            ? { info: { id: "msg_1" }, parts: [{ type: "text", text: "done" }] }
            : yield* handlers.prompt(yield* Ref.get(calls))
          return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(answer)))
        }
        return HttpClientResponse.fromWeb(request, new Response("true"))
      })
    )
    return { calls, layer: Layer.succeed(HttpClient.HttpClient)(client) }
  })

const ask = (text: string, options?: {
  readonly contextId?: string | undefined
  readonly taskId?: string | undefined
  readonly messageId?: string | undefined
}): Message => ({
  messageId: options?.messageId ?? "m1",
  contextId: options?.contextId ?? "ctx",
  taskId: options?.taskId ?? "t1",
  role: Role.ROLE_USER,
  parts: [{
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain"
  }],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
})

const asked = (overrides?: Record<string, unknown>) => ({
  type: "permission.asked",
  properties: {
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["git push*"],
    metadata: { command: "git push --force" },
    always: [],
    ...overrides
  }
})

describe("OpenCodeA2A.defaultProjection", () => {
  it("speaks the vocabulary /coding and the Claude bridge already use", () => {
    const request = (permission: string, extra?: Record<string, unknown>) => ({
      id: "per_1",
      sessionID: "ses_1",
      permission,
      ...extra
    })
    assert.deepStrictEqual(
      OpenCodeA2A.defaultProjection("bash", request("bash", { patterns: ["git push*"] })),
      { action: "shell", resource: "git push*" }
    )
    assert.deepStrictEqual(
      OpenCodeA2A.defaultProjection("edit", request("edit", { metadata: { filePath: "src/x.ts" } })),
      { action: "write", resource: "src/x.ts" }
    )
    // An unrecognised permission keeps its own name and is visible to a policy
    // rather than silently uncategorised.
    assert.deepStrictEqual(
      OpenCodeA2A.defaultProjection("plugin_thing", request("plugin_thing")),
      { action: "tool", resource: "plugin_thing" }
    )
  })
})

describe("OpenCodeA2A: what a real server actually sent", () => {
  /**
   * Captured from `opencode serve` 1.18.23 on 2026-09-01, asking about a write
   * it had been configured to gate. Kept verbatim: the schema said what these
   * fields are *called*, and one of them was called something else.
   */
  const REAL_ASKED = {
    id: "evt_05ce5595f001Rtc4Tu5SiV13xg",
    type: "permission.asked",
    properties: {
      id: "per_05ce5595f001Rtc4Tu5SiV13xg",
      sessionID: "ses_fa31ac732ffec9h0VMX2pkR9Md",
      permission: "edit",
      // Windows, drive letter stripped -- this is OpenCode's canonical scope
      // for the ask, and what an `always` reply would remember.
      patterns: ["Users\\Patrick\\scratch\\denied.txt"],
      metadata: {
        // Lowercase `filepath`. `filePath` was the guess; this is the fact.
        filepath: "C:\\Users\\Patrick\\scratch\\denied.txt"
      },
      always: ["*"],
      tool: { messageID: "msg_05ce5560a001A3ClIhY4kFqC1r", callID: "call_01a05ce5583f75c2" }
    }
  }

  it("decodes the frame and projects it into this application's vocabulary", () => {
    const read = OpenCodeA2A.readEvent(JSON.stringify(REAL_ASKED), REAL_ASKED.properties.sessionID)
    assert.isTrue(Option.isSome(read))
    if (!Option.isSome(read) || read.value._tag !== "Permission") return
    const asked = read.value.asked
    assert.strictEqual(asked.permission, "edit")
    // A live run took this exact path end to end: the policy denied and the
    // file was never written; allowed, it was written with the expected bytes.
    assert.deepStrictEqual(
      OpenCodeA2A.defaultProjection(asked.permission, asked),
      { action: "write", resource: "Users\\Patrick\\scratch\\denied.txt" }
    )
  })

  it("falls back to the metadata key the server really uses", () => {
    const { patterns: _dropped, ...withoutPatterns } = REAL_ASKED.properties
    const read = OpenCodeA2A.readEvent(
      JSON.stringify({ ...REAL_ASKED, properties: withoutPatterns }),
      REAL_ASKED.properties.sessionID
    )
    assert.isTrue(Option.isSome(read))
    if (!Option.isSome(read) || read.value._tag !== "Permission") return
    assert.deepStrictEqual(
      OpenCodeA2A.defaultProjection("edit", read.value.asked),
      { action: "write", resource: "C:\\Users\\Patrick\\scratch\\denied.txt" }
    )
  })
})

describe("OpenCodeA2A: v2", () => {
  const frame = (type: string, data: unknown) => ({ id: "evt_1", type, data })

  it("reads v2's frames, which say `data` where v1 says `properties`", () => {
    const started = OpenCodeA2A.readEventV2(
      JSON.stringify(frame("session.next.step.started", { sessionID: "ses_1" })),
      "ses_1"
    )
    assert.isTrue(Option.isSome(started))
    if (Option.isSome(started)) assert.strictEqual(started.value._tag, "Started")

    const text = OpenCodeA2A.readEventV2(
      JSON.stringify(frame("session.next.text.ended", { sessionID: "ses_1", text: "V2 OK" })),
      "ses_1"
    )
    assert.isTrue(Option.isSome(text))
    if (Option.isSome(text) && text.value._tag === "Text") {
      assert.strictEqual(text.value.text, "V2 OK")
    }

    // The deltas are ignored: `text.ended` carries the whole block, so
    // reassembling from deltas would only be a way to get it wrong.
    assert.isTrue(
      Option.isNone(OpenCodeA2A.readEventV2(
        JSON.stringify(frame("session.next.text.delta", { sessionID: "ses_1", delta: "V" })),
        "ses_1"
      ))
    )

    const failed = OpenCodeA2A.readEventV2(
      JSON.stringify(frame("session.next.step.failed", {
        sessionID: "ses_1",
        error: { type: "unknown", message: "Provider request failed with HTTP 503" }
      })),
      "ses_1"
    )
    assert.isTrue(Option.isSome(failed))
    if (Option.isSome(failed) && failed.value._tag === "Failed") {
      assert.include(failed.value.reason, "503")
    }

    // Another session's frames are not ours.
    assert.isTrue(
      Option.isNone(OpenCodeA2A.readEventV2(
        JSON.stringify(frame("session.next.text.ended", { sessionID: "ses_2", text: "x" })),
        "ses_1"
      ))
    )
  })

  it("normalises a v2 permission into v1's shape, so one projection serves both", () => {
    // v2 says `action` and `resources`; v1 says `permission` and `patterns`.
    // A policy must not be able to tell which protocol answered it.
    const asked = OpenCodeA2A.readEventV2(
      JSON.stringify(frame("permission.v2.asked", {
        id: "per_1",
        sessionID: "ses_1",
        action: "edit",
        resources: ["src/parse.ts"]
      })),
      "ses_1"
    )
    assert.isTrue(Option.isSome(asked))
    if (!Option.isSome(asked) || asked.value._tag !== "Permission") return
    assert.strictEqual(asked.value.asked.permission, "edit")
    assert.deepStrictEqual(
      OpenCodeA2A.defaultProjection(asked.value.asked.permission, asked.value.asked),
      { action: "write", resource: "src/parse.ts" }
    )
  })

  it("prompts, waits for the loop to start, then reads the answer from projected state", () =>
    Effect.runPromise(Effect.gen(function*() {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const client = HttpClient.make((request, url) =>
        Effect.gen(function*() {
          yield* Ref.update(calls, (all) => [...all, `${request.method} ${url.pathname}`])
          const json = (value: unknown) =>
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify(value)))
          if (url.pathname === "/api/event") {
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                `data: ${JSON.stringify(frame("session.next.step.started", { sessionID: "ses_1" }))}\n\n`,
                { headers: { "content-type": "text/event-stream" } }
              )
            )
          }
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname.endsWith("/prompt")) {
            return json({ data: { id: "msg_1", timeCreated: 100 } })
          }
          if (url.pathname.endsWith("/message")) {
            return json({
              data: [
                // The previous run's answer, which must not be mistaken for
                // this one's: it is older than our prompt.
                {
                  id: "msg_0",
                  type: "assistant",
                  time: { created: 50, completed: 60 },
                  content: [{ type: "text", text: "an older answer" }]
                },
                {
                  id: "msg_2",
                  type: "assistant",
                  time: { created: 120, completed: 130 },
                  content: [{ type: "text", text: "V2 OK" }]
                }
              ],
              cursor: {}
            })
          }
          return json({ data: true })
        })
      )

      const opencode = yield* OpenCodeA2A.remote({
        baseUrl: BASE,
        api: "v2",
        startTimeout: "1 second"
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))

      const task = yield* opencode.delegate(ask("go"))
      assert.strictEqual(task.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.deepStrictEqual(
        task.artifacts.flatMap((artifact) =>
          artifact.parts.map((part) => part.content?.$case === "text" ? part.content.value : "")
        ),
        ["V2 OK"]
      )
      const seen = yield* Ref.get(calls)
      assert.include(seen, "POST /api/session/ses_1/prompt")
      // The answer comes from the projection, not from the bus and not from
      // `wait` -- which is documented and returns 503 on every build that
      // serves v2 at all.
      assert.isTrue(seen.some((call) => call.includes("/message")))
      assert.isFalse(seen.some((call) => call.includes("/wait")))
    }).pipe(Effect.scoped)))

  it("a non-2xx answer is a failure, not a result", () =>
    Effect.runPromise(Effect.gen(function*() {
      // The bug this prevents: `POST .../wait` answered 503 with a JSON body,
      // the body decoded, and the bridge read it as "the run is over" and
      // completed the task with an empty answer.
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ _tag: "ServiceUnavailableError" }), { status: 503 })
          )
        )
      )
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE, api: "v2" }).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient)(client))
      )
      const exit = yield* Effect.exit(opencode.delegate(ask("go")))
      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.scoped)))
})

describe("OpenCodeA2A.readEvent", () => {
  it("reads the two frames that matter and ignores the rest", () => {
    const permission = OpenCodeA2A.readEvent(JSON.stringify(asked()), "ses_1")
    assert.isTrue(Option.isSome(permission))
    if (Option.isSome(permission) && permission.value._tag === "Permission") {
      assert.strictEqual(permission.value.asked.permission, "bash")
    }
    // Another session's permission is not ours to answer.
    assert.isTrue(Option.isNone(OpenCodeA2A.readEvent(JSON.stringify(asked()), "ses_2")))
    // Noise on a shared bus is ignored, never fatal.
    assert.isTrue(Option.isNone(OpenCodeA2A.readEvent("not json", "ses_1")))
    assert.isTrue(
      Option.isNone(OpenCodeA2A.readEvent(JSON.stringify({ type: "file.edited" }), "ses_1"))
    )
    const text = OpenCodeA2A.readEvent(
      JSON.stringify({
        type: "message.part.updated",
        properties: { sessionID: "ses_1", part: { type: "text", text: "reading src" } }
      }),
      "ses_1"
    )
    assert.isTrue(Option.isSome(text))
    if (Option.isSome(text) && text.value._tag === "Text") {
      assert.strictEqual(text.value.text, "reading src")
    }
  })
})

describe("OpenCodeA2A", () => {
  it.effect("the caller's own prompt is not reported back as the agent's progress", () =>
    Effect.gen(function*() {
      // A real server echoes the message it was sent onto the bus as a text
      // part. Without telling the two apart, the bridge reported the question
      // as the first thing the agent said. Found by watching a live bus.
      const stub = yield* server({ events: "" })
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      yield* opencode.delegate(ask("Fix the parser"))
      const prompt = (yield* Ref.get(stub.calls)).find((call) => call.path.endsWith("/message"))
      const ownId = (prompt?.body as { messageID?: string }).messageID
      assert.isString(ownId, "the bridge did not mint a message id it could recognise")

      const echo = JSON.stringify({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { type: "text", text: "Fix the parser", messageID: ownId }
        }
      })
      assert.isTrue(
        Option.isNone(OpenCodeA2A.readEvent(echo, "ses_1", ownId)),
        "the caller's own message was read as progress"
      )
      // The agent's own parts still are progress.
      const said = JSON.stringify({
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: { type: "text", text: "reading src", messageID: "msg_assistant" }
        }
      })
      assert.isTrue(Option.isSome(OpenCodeA2A.readEvent(said, "ses_1", ownId)))
    })
  )

  it.effect("a secured server can be reached, on every request", () =>
    Effect.gen(function*() {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const client = HttpClient.make((request, url) =>
        Effect.as(
          Ref.update(seen, (all) => [
            ...all,
            `${url.pathname}:${request.headers["authorization"] ?? "none"}`
          ]),
          HttpClientResponse.fromWeb(
            request,
            new Response(
              url.pathname === "/event"
                ? ""
                : JSON.stringify(
                  url.pathname === "/session"
                    ? { id: "ses_1" }
                    : { info: {}, parts: [{ type: "text", text: "done" }] }
                )
            )
          )
        )
      )
      const opencode = yield* OpenCodeA2A.remote({
        baseUrl: BASE,
        headers: { authorization: "Bearer secret" }
      }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(client)))
      yield* opencode.delegate(ask("go"))
      const calls = yield* Ref.get(seen)
      // Including the event subscription: a secured server rejects that too.
      assert.isTrue(calls.length > 0)
      assert.isTrue(
        calls.every((call) => call.endsWith("Bearer secret")),
        `some requests went unauthenticated: ${JSON.stringify(calls)}`
      )
    })
  )

  it.effect("a delegated task completes, and the server's answer is the artifact", () =>
    Effect.gen(function* () {
      const stub = yield* server({})
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      const task = yield* opencode.delegate(ask("Fix the parser")).pipe(
        Effect.provide(stub.layer)
      )
      assert.strictEqual(task.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.deepStrictEqual(
        task.artifacts.flatMap((artifact) =>
          artifact.parts.map((part) => part.content?.$case === "text" ? part.content.value : "")
        ),
        ["done"]
      )
      // The one thing a caller cannot reconstruct: which server session this is.
      assert.deepStrictEqual(task.metadata, { openCodeSessionId: "ses_1" })

      const calls = yield* Ref.get(stub.calls)
      const prompt = calls.find((call) => call.path.endsWith("/message"))
      assert.deepStrictEqual((prompt?.body as { parts: unknown }).parts, [
        { type: "text", text: "Fix the parser" }
      ])
    })
  )

  it.effect("one A2A context is one server session, not one per message", () =>
    Effect.gen(function* () {
      const stub = yield* server({})
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      yield* opencode.delegate(ask("first", { taskId: "t1", messageId: "m1" }))
      yield* opencode.delegate(ask("second", { taskId: "t2", messageId: "m2" }))
      yield* opencode.delegate(
        ask("elsewhere", { contextId: "other", taskId: "t3", messageId: "m3" })
      )

      const created = (yield* Ref.get(stub.calls)).filter(
        (call) => call.path === "/session" && call.method === "POST"
      )
      // Two contexts, two sessions -- the second message continued the first
      // conversation instead of starting a new one.
      assert.strictEqual(created.length, 2)
    })
  )

  it.effect("a permission asked mid-run is answered by our policy", () =>
    Effect.gen(function* () {
      // The prompt does not return until the permission has been answered,
      // which is the ordering a real run has: the server is blocked on us.
      const answered = yield* Deferred.make<void>()
      const stub = yield* server({
        events: sse([asked()]),
        prompt: () =>
          Effect.as(
            Deferred.await(answered),
            { info: { id: "msg_1" }, parts: [{ type: "text", text: "pushed" }] }
          )
      })
      const opencode = yield* OpenCodeA2A.remote({
        baseUrl: BASE,
        permissions: {
          // An ordinary rule set, in the vocabulary this repository's own
          // coding tools use -- not one written for OpenCode.
          policy: Permission.rules(
            [{ action: "shell", resource: /^git push/, decision: Permission.deny("no pushing") }],
            { otherwise: Permission.allow }
          )
        }
      }).pipe(Effect.provide(stub.layer))

      const running = yield* Effect.forkChild(opencode.delegate(ask("push it")))
      const replies = yield* Effect.repeat(
        Effect.map(Ref.get(stub.calls), (calls) =>
          calls.filter((call) => call.path.includes("/permissions/"))),
        { until: (found) => found.length > 0 }
      )
      assert.strictEqual(replies[0]?.path, "/session/ses_1/permissions/per_1")
      assert.deepStrictEqual(replies[0]?.body, { response: "reject" })

      yield* Deferred.succeed(answered, undefined)
      const task = yield* Fiber.join(running)
      assert.strictEqual(task.status?.state, TaskState.TASK_STATE_COMPLETED)
    }).pipe(Effect.scoped)
  )

  it.effect("allow always is answered as always, so the server stops asking", () =>
    Effect.gen(function* () {
      // The half Claude Code's prompt tool cannot express: an approval the
      // delegated runtime itself remembers.
      const elicitor = yield* Elicitation.memory.make("bridge")
      const answered = yield* Deferred.make<void>()
      const stub = yield* server({
        events: sse([asked()]),
        prompt: () => Effect.as(Deferred.await(answered), { info: {}, parts: [] })
      })
      const opencode = yield* OpenCodeA2A.remote({
        baseUrl: BASE,
        permissions: { policy: Permission.askAll, elicitor }
      }).pipe(Effect.provide(stub.layer))

      const running = yield* Effect.forkChild(opencode.delegate(ask("push it")))
      const pending = yield* Effect.repeat(elicitor.pending, {
        until: (requests) => requests.length > 0
      })
      yield* elicitor.respond({ id: pending[0]!.id, granted: true, value: { remember: true } })

      const replies = yield* Effect.repeat(
        Effect.map(Ref.get(stub.calls), (calls) =>
          calls.filter((call) => call.path.includes("/permissions/"))),
        { until: (found) => found.length > 0 }
      )
      assert.deepStrictEqual(replies[0]?.body, { response: "always" })
      yield* Deferred.succeed(answered, undefined)
      yield* Fiber.join(running)
    }).pipe(Effect.scoped)
  )

  it.effect("without a permissions policy the bridge answers nothing", () =>
    Effect.gen(function* () {
      // Honest rather than helpful: a bridge that half-answers permissions is
      // worse than one that visibly leaves them to the server.
      const stub = yield* server({ events: sse([asked()]) })
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      yield* opencode.delegate(ask("go"))
      const calls = yield* Ref.get(stub.calls)
      assert.isFalse(calls.some((call) => call.path.includes("/permissions/")))
    })
  )

  it.effect("cancel goes through the server's abort, because there is no process to kill", () =>
    Effect.gen(function* () {
      const answered = yield* Deferred.make<void>()
      const stub = yield* server({
        prompt: () => Effect.as(Deferred.await(answered), { info: {}, parts: [] })
      })
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      const running = yield* Effect.forkChild(opencode.delegate(ask("go")))
      yield* Effect.repeat(
        Effect.map(Ref.get(stub.calls), (calls) =>
          calls.some((call) => call.path.endsWith("/message"))),
        { until: (found) => found }
      )
      const cancelled = yield* opencode.cancel("t1")
      assert.strictEqual(cancelled.status?.state, TaskState.TASK_STATE_CANCELED)
      const calls = yield* Ref.get(stub.calls)
      assert.isTrue(calls.some((call) => call.path === "/session/ses_1/abort"))
      yield* Deferred.succeed(answered, undefined)
      yield* Fiber.join(running)
    }).pipe(Effect.scoped)
  )

  it.effect("a cancelled run is not completed by the answer that races back", () =>
    Effect.gen(function* () {
      // Aborting makes the *server* return, so the prompt request completes
      // moments later with an interrupted run. Reading that as "completed"
      // would be the worst possible outcome of asking to stop.
      const answered = yield* Deferred.make<void>()
      const stub = yield* server({
        prompt: () =>
          Effect.as(
            Deferred.await(answered),
            { info: {}, parts: [{ type: "text", text: "half a change" }] }
          )
      })
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      const running = yield* Effect.forkChild(opencode.delegate(ask("go")))
      yield* Effect.repeat(
        Effect.map(Ref.get(stub.calls), (calls) =>
          calls.some((call) => call.path.endsWith("/message"))),
        { until: (found) => found }
      )
      yield* opencode.cancel("t1")
      yield* Deferred.succeed(answered, undefined)

      const task = yield* Fiber.join(running)
      assert.strictEqual(task.status?.state, TaskState.TASK_STATE_CANCELED)
      assert.deepStrictEqual(task.artifacts, [], "a cancelled run kept its half-answer")
      // And the stored task stays cancelled rather than being overwritten.
      assert.strictEqual(
        (yield* opencode.task("t1")).status?.state,
        TaskState.TASK_STATE_CANCELED
      )
    }).pipe(Effect.scoped)
  )

  it.effect("one conversation runs one task at a time", () =>
    Effect.gen(function* () {
      // Two prompts against one OpenCode session is SessionBusyError on its
      // side; on this side both runs would watch the same session and answer
      // each other's permission questions.
      const answered = yield* Deferred.make<void>()
      const stub = yield* server({
        prompt: () => Effect.as(Deferred.await(answered), { info: {}, parts: [] })
      })
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      const first = yield* Effect.forkChild(opencode.delegate(ask("go", { taskId: "t1" })))
      yield* Effect.repeat(
        Effect.map(Ref.get(stub.calls), (calls) =>
          calls.some((call) => call.path.endsWith("/message"))),
        { until: (found) => found }
      )
      const second = yield* Effect.exit(
        opencode.delegate(ask("also go", { taskId: "t2", messageId: "m2" }))
      )
      assert.isTrue(Exit.isFailure(second))
      yield* Deferred.succeed(answered, undefined)
      yield* Fiber.join(first)
    }).pipe(Effect.scoped)
  )

  it.effect("a finished task is fetchable, an unknown one is refused", () =>
    Effect.gen(function* () {
      const stub = yield* server({})
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      yield* opencode.delegate(ask("go"))
      assert.strictEqual((yield* opencode.task("t1")).id, "t1")
      assert.isTrue(Exit.isFailure(yield* Effect.exit(opencode.task("nope"))))
    })
  )

  it.effect("an empty message is refused rather than sent as an empty prompt", () =>
    Effect.gen(function* () {
      const stub = yield* server({})
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      const exit = yield* Effect.exit(opencode.delegate({ ...ask(""), parts: [] }))
      assert.isTrue(Exit.isFailure(exit))
      const calls = yield* Ref.get(stub.calls)
      assert.isFalse(calls.some((call) => call.path.endsWith("/message")))
    })
  )

  it.effect("streaming reports the server's progress, then the answer once", () =>
    Effect.gen(function* () {
      const stub = yield* server({
        events: sse([
          {
            type: "message.part.updated",
            properties: { sessionID: "ses_1", part: { type: "text", text: "reading src" } }
          }
        ])
      })
      const opencode = yield* OpenCodeA2A.remote({ baseUrl: BASE }).pipe(
        Effect.provide(stub.layer)
      )
      const responses = yield* Stream.runCollect(opencode.stream(ask("go")))
      const kinds = responses.map((response) => response.payload?.$case)
      // However many progress updates arrive, the answer arrives once and last.
      assert.strictEqual(kinds[kinds.length - 2], "artifactUpdate")
      assert.strictEqual(kinds[kinds.length - 1], "statusUpdate")
      const last = responses[responses.length - 1]
      assert.strictEqual(
        last?.payload?.$case === "statusUpdate" ? last.payload.value.status?.state : undefined,
        TaskState.TASK_STATE_COMPLETED
      )
    })
  )
})
