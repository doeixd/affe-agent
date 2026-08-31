import { assert, describe, it } from "@effect/vitest"
import { Role, TaskState, type Message } from "@a2a-js/sdk"
import { Cause, Effect, Exit, Fiber, Ref, Schema, Scope, Stream } from "effect"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { AgentA2A, ClaudeCodeA2A } from "../src/a2a/index.js"

/**
 * The Claude Code bridge, against a scripted CLI.
 *
 * `docs/plan-a2a-layers-bridges.txt` step 1. There is no `claude` binary in
 * CI, and there should not need to be: the bridge reaches the CLI through
 * `Sandbox.execStream`, so a scripted provider *is* the CLI as far as this
 * module can tell. That is the same property that lets the bridge run against
 * a remote sandbox unchanged, tested rather than asserted.
 */

const encoder = new TextEncoder()

/** A scripted `claude` that emits the lines it is given, then exits. */
const scripted = (
  lines: ReadonlyArray<string>,
  recorded: Array<Sandbox.Command>,
  options?: { readonly exitCode?: number | undefined }
): Sandbox.Sandbox["execStream"] =>
(command) => {
  recorded.push(command)
  return Stream.fromArray([
    ...lines.map((line) => Sandbox.outputEvent("stdout", encoder.encode(`${line}\n`))),
    Sandbox.exitEvent(options?.exitCode ?? 0)
  ])
}

const bridge = (
  execStream: Sandbox.Sandbox["execStream"],
  options?: ClaudeCodeA2A.Options
): Effect.Effect<
  ClaudeCodeA2A.Bridge,
  Sandbox.ProviderError,
  Scope.Scope
> =>
  Effect.flatMap(
    Effect.provide(
      Sandbox.acquire(Sandbox.workspace("claude")),
      MemorySandbox.layer({ execStream })
    ),
    (sandbox) => ClaudeCodeA2A.remote(sandbox, options)
  )

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

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" })
const SAID = (text: string) =>
  JSON.stringify({
    type: "assistant",
    session_id: "sess-1",
    message: { content: [{ type: "text", text }] }
  })
const RESULT = (text: string, failed = false) =>
  JSON.stringify({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    result: text,
    session_id: "sess-1"
  })

describe("ClaudeCodeA2A", () => {
  it.effect("a delegated task completes, and the CLI's own answer is the artifact", () =>
    Effect.gen(function* () {
      const recorded: Array<Sandbox.Command> = []
      const claude = yield* bridge(scripted([
        INIT,
        SAID("Looking at the file."),
        RESULT("Fixed the off-by-one in parse().")
      ], recorded))

      const result = yield* claude.delegate(ask("Fix the parser"))
      assert.strictEqual(result.id, "t1")
      assert.strictEqual(result.status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.deepStrictEqual(
        result.artifacts.flatMap((artifact) =>
          artifact.parts.map((part) => part.content?.$case === "text" ? part.content.value : "")
        ),
        ["Fixed the off-by-one in parse()."]
      )
      // The session id is the one thing a caller cannot reconstruct, and it is
      // what `--resume` takes.
      assert.deepStrictEqual(result.metadata, { claudeSessionId: "sess-1" })

      // The prompt is argv, never a shell string, and the run is bare by
      // default: what a delegated task does must not depend on the machine.
      const command = recorded[0]
      assert.strictEqual(command?.executable, "claude")
      assert.include(command?.args ?? [], "Fix the parser")
      assert.include(command?.args ?? [], "--bare")
      assert.include(command?.args ?? [], "stream-json")
      assert.notInclude(command?.args ?? [], "--resume")
    }).pipe(Effect.scoped)
  )

  it.effect("the second message in a context resumes the CLI's session", () =>
    Effect.gen(function* () {
      const recorded: Array<Sandbox.Command> = []
      const claude = yield* bridge(scripted([INIT, RESULT("done")], recorded))

      yield* claude.delegate(ask("first", { taskId: "t1", messageId: "m1" }))
      yield* claude.delegate(ask("second", { taskId: "t2", messageId: "m2" }))

      // One conversation with the peer, not two: the context id maps to the
      // session id the first run reported.
      const second = recorded[1]?.args ?? []
      const resumeAt = second.indexOf("--resume")
      assert.isAbove(resumeAt, -1, "the second run did not resume")
      assert.strictEqual(second[resumeAt + 1], "sess-1")

      // A different context is a different conversation.
      yield* claude.delegate(ask("elsewhere", { contextId: "other", taskId: "t3", messageId: "m3" }))
      assert.notInclude(recorded[2]?.args ?? [], "--resume")
    }).pipe(Effect.scoped)
  )

  it.effect("a failed run is a failed task, not a completed one carrying bad news", () =>
    Effect.gen(function* () {
      const claude = yield* bridge(scripted([INIT, RESULT("could not authenticate", true)], []))
      const result = yield* claude.delegate(ask("do something"))
      assert.strictEqual(result.status?.state, TaskState.TASK_STATE_FAILED)
      // The text still arrives: a failure with no explanation is worse.
      assert.include(
        result.artifacts[0]?.parts[0]?.content?.$case === "text"
          ? result.artifacts[0].parts[0].content.value
          : "",
        "could not authenticate"
      )
    }).pipe(Effect.scoped)
  )

  it.effect("a run that ends without a result is cancelled, never completed", () =>
    Effect.gen(function* () {
      // The process died, or was killed, after saying something and before
      // reporting. Reading "it worked" from that would be the worst possible
      // guess.
      const claude = yield* bridge(scripted([INIT, SAID("working on it")], []))
      const result = yield* claude.delegate(ask("do something"))
      assert.strictEqual(result.status?.state, TaskState.TASK_STATE_CANCELED)
      assert.deepStrictEqual(result.artifacts, [])
    }).pipe(Effect.scoped)
  )

  it.effect("noise on the stream is ignored, not fatal", () =>
    Effect.gen(function* () {
      const claude = yield* bridge(scripted([
        "Warning: 1 MCP server skipped due to invalid config:",
        "{not json at all",
        INIT,
        RESULT("still fine")
      ], []))
      const result = yield* claude.delegate(ask("do something"))
      assert.strictEqual(result.status?.state, TaskState.TASK_STATE_COMPLETED)
    }).pipe(Effect.scoped)
  )

  it.effect("streaming reports progress before the answer, and the answer once", () =>
    Effect.gen(function* () {
      const claude = yield* bridge(scripted([
        INIT,
        SAID("Reading src/parse.ts"),
        SAID("Editing src/parse.ts"),
        RESULT("Fixed.")
      ], []))
      const responses = yield* Stream.runCollect(claude.stream(ask("Fix the parser")))
      const kinds = responses.map((response) => response.payload?.$case)
      assert.deepStrictEqual(kinds, [
        "statusUpdate",
        "statusUpdate",
        "artifactUpdate",
        "statusUpdate"
      ])
      const texts = responses.flatMap((response) =>
        response.payload?.$case === "statusUpdate"
          ? (response.payload.value.status?.message?.parts ?? []).map((part) =>
            part.content?.$case === "text" ? part.content.value : ""
          )
          : []
      )
      assert.deepStrictEqual(texts, ["Reading src/parse.ts", "Editing src/parse.ts"])
      const last = responses[responses.length - 1]
      assert.strictEqual(
        last?.payload?.$case === "statusUpdate" ? last.payload.value.status?.state : undefined,
        TaskState.TASK_STATE_COMPLETED
      )
    }).pipe(Effect.scoped)
  )

  it.effect("a finished task can be fetched by id, and an unknown one is refused", () =>
    Effect.gen(function* () {
      const claude = yield* bridge(scripted([INIT, RESULT("done")], []))
      yield* claude.delegate(ask("do something"))
      const found = yield* claude.task("t1")
      assert.strictEqual(found.status?.state, TaskState.TASK_STATE_COMPLETED)

      const missing = yield* Effect.exit(claude.task("nope"))
      assert.isTrue(Exit.isFailure(missing))
      const error = Cause.findErrorOption(
        Exit.isFailure(missing) ? missing.cause : Cause.fail(new Error("unreachable"))
      )
      assert.strictEqual(
        error._tag === "Some" && "code" in error.value ? error.value.code : undefined,
        "TASK_NOT_FOUND"
      )
    }).pipe(Effect.scoped)
  )

  it.effect("cancel stops a run in flight and reports what it became", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(false)
      // A CLI that says one thing and then never finishes: exactly the case a
      // supervisor holding a task id and no fiber has to be able to stop.
      const claude = yield* bridge(() =>
        Stream.concat(
          Stream.fromArray([
            Sandbox.outputEvent("stdout", encoder.encode(`${INIT}\n`)),
            Sandbox.outputEvent("stdout", encoder.encode(`${SAID("thinking")}\n`))
          ]),
          Stream.fromEffect(Effect.as(
            Effect.andThen(Ref.set(started, true), Effect.never),
            Sandbox.exitEvent(0)
          ))
        ))

      const running = yield* Effect.forkChild(Effect.exit(claude.delegate(ask("go"))))
      // Wait until the scripted process is actually blocked, so the test is
      // pinning cancellation rather than a race it happened to win.
      yield* Effect.repeat(Ref.get(started), { until: (value) => value })

      const cancelled = yield* claude.cancel("t1")
      assert.strictEqual(cancelled.status?.state, TaskState.TASK_STATE_CANCELED)

      const result = yield* Fiber.join(running)
      assert.isTrue(Exit.isSuccess(result))
      if (Exit.isSuccess(result)) {
        assert.strictEqual(result.value.status?.state, TaskState.TASK_STATE_CANCELED)
      }
    }).pipe(Effect.scoped)
  )

  it.effect("two runs cannot share one task id, because cancel could only reach one", () =>
    Effect.gen(function* () {
      const claude = yield* bridge(() =>
        Stream.concat(
          Stream.fromArray([Sandbox.outputEvent("stdout", encoder.encode(`${INIT}\n`))]),
          Stream.fromEffect(Effect.as(Effect.never, Sandbox.exitEvent(0)))
        ))
      const first = yield* Effect.forkChild(Effect.exit(claude.delegate(ask("go"))))
      // Let the first run register before the second asks for the same id;
      // without the guard the second would silently take it over.
      yield* Effect.yieldNow
      const second = yield* Effect.exit(claude.delegate(ask("also go")))
      assert.isTrue(Exit.isFailure(second))
      const error = Cause.findErrorOption(
        Exit.isFailure(second) ? second.cause : Cause.fail(new Error("unreachable"))
      )
      assert.strictEqual(
        error._tag === "Some" && "code" in error.value ? error.value.code : undefined,
        "TASK_ALREADY_RUNNING"
      )
      yield* Fiber.interrupt(first)
    }).pipe(Effect.scoped)
  )

  it.effect("the task history is bounded, because a bridge is meant to be long-lived", () =>
    Effect.gen(function* () {
      const claude = yield* bridge(scripted([INIT, RESULT("done")], []), { historyLimit: 2 })
      for (const id of ["a", "b", "c"]) {
        yield* claude.delegate(ask("go", { taskId: id, messageId: id }))
      }
      // The two most recent are still there; the oldest was dropped rather
      // than held forever with the whole of the CLI's answer attached.
      assert.strictEqual((yield* claude.task("c")).id, "c")
      assert.strictEqual((yield* claude.task("b")).id, "b")
      assert.isTrue(Exit.isFailure(yield* Effect.exit(claude.task("a"))))
    }).pipe(Effect.scoped)
  )

  it.effect("an empty message is refused rather than sent as an empty prompt", () =>
    Effect.gen(function* () {
      const recorded: Array<Sandbox.Command> = []
      const claude = yield* bridge(scripted([RESULT("unreachable")], recorded))
      const exit = yield* Effect.exit(claude.delegate({ ...ask(""), parts: [] }))
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(recorded, [], "the CLI was run with nothing to do")
    }).pipe(Effect.scoped)
  )

  it.effect("the bridged CLI is an ordinary tool of this agent's", () =>
    Effect.gen(function* () {
      const claude = yield* bridge(scripted([INIT, RESULT("I renamed the function.")], []))
      // The payoff the plan names: no new concept, no proprietary subagent
      // protocol -- `AgentA2A.tool` already takes any `RemoteAgent`.
      const delegate = AgentA2A.tool("claude_coder", {
        description: "Delegate a coding task to Claude Code.",
        request: Schema.String,
        result: Schema.String,
        agent: claude,
        contextId: "coding"
      })
      assert.strictEqual(delegate.tool.name, "claude_coder")
    }).pipe(Effect.scoped)
  )
})
