/**
 * Reference delegation — `plan-a2a-layers-bridges.txt`, from the public
 * surface only.
 *
 * The plan's claim is that an existing agent runtime should enter this system
 * as an **A2A agent**, not as a pretend model, and that once it does it costs
 * nothing extra: `AgentA2A.tool` already makes any `RemoteAgent` an ordinary
 * tool. Two runtimes are bridged here with nothing in common -- one is a CLI
 * spawned in a sandbox, the other an HTTP server -- and the manager below
 * cannot tell which is which.
 *
 * The second claim is **one policy, three runtimes**: the rule set in section 1
 * is written in `/coding`'s own vocabulary (`read` / `write` / `shell`), and it
 * governs a local toolkit, a delegated Claude Code, and a delegated OpenCode
 * without naming any of them.
 *
 * Both are asserted here rather than described. Built only from the published
 * entry points, no casts, and it runs in CI -- which is the point of a `ref-`
 * example: if a user cannot assemble this from what the package exports, this
 * file stops compiling.
 *
 * Neither backend is real: the CLI is a scripted `Sandbox`, the server is a
 * stubbed `HttpClient`. That is the same substitution the bridges' own tests
 * make, and the property that makes it legitimate -- a bridge that reaches its
 * runtime through a seam cannot tell a scripted one from the real thing.
 *
 * Run: `npx tsx examples/ref-delegation.ts`
 */

import { Console, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { Agent, AgentLoop, AgentSession, Elicitation, Permission } from "affe-agent"
import {
  AgentA2A,
  ClaudeCodeA2A,
  ClaudeCodePermissions,
  OpenCodeA2A
} from "affe-agent/a2a"
import { MemorySandbox, Sandbox } from "affe-agent/sandbox"
import { TestLanguageModel } from "affe-agent/testing"

// ---------------------------------------------------------------------------
// 1. One policy, written once, in nobody's dialect
// ---------------------------------------------------------------------------

/**
 * Note what this does *not* mention: Claude Code, OpenCode, or any tool name
 * belonging to either. It is written against `action` and `resource`, which is
 * what every bridge projects into and what `/coding` annotates its own tools
 * with -- so the same three rules govern all three runtimes.
 */
const policy = Permission.rules([
  { action: "read", decision: Permission.allow },
  { action: "shell", resource: /^git push/, decision: Permission.deny("pushing is a human's job") },
  { action: "write", decision: Permission.ask("writes are reviewed") }
], { otherwise: Permission.ask("unrecognised capability") })

// ---------------------------------------------------------------------------
// 2. A scripted Claude Code, reached through the sandbox seam
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** The CLI's `--output-format stream-json`, as a sandbox that runs no process. */
const claudeCli: Sandbox.Sandbox["execStream"] = () =>
  Stream.fromArray([
    Sandbox.outputEvent(
      "stdout",
      encoder.encode(
        JSON.stringify({ type: "system", subtype: "init", session_id: "sess-ref" }) + "\n" +
          JSON.stringify({
            type: "assistant",
            session_id: "sess-ref",
            message: { content: [{ type: "text", text: "Reading src/parse.ts" }] }
          }) + "\n" +
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "sess-ref",
            result: "Fixed the off-by-one in parse()."
          }) + "\n"
      )
    ),
    Sandbox.exitEvent(0)
  ])

// ---------------------------------------------------------------------------
// 3. A stubbed OpenCode server
// ---------------------------------------------------------------------------

interface Call {
  readonly path: string
  readonly body: unknown
}

const sse = (frames: ReadonlyArray<unknown>): string =>
  frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")

/**
 * Asks permission to edit a file, then answers the prompt. Records every call,
 * because what it was *told* about the permission is half of what this file
 * checks.
 */
const openCodeServer = (calls: Ref.Ref<ReadonlyArray<Call>>) =>
  HttpClient.make((request, url) =>
    Effect.gen(function*() {
      const body = request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined
      yield* Ref.update(calls, (all) => [...all, { path: url.pathname, body }])
      const json = (value: unknown) =>
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(value)))
      if (url.pathname === "/event") {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            sse([
              {
                type: "permission.asked",
                properties: {
                  id: "per_1",
                  sessionID: "ses_ref",
                  permission: "edit",
                  patterns: ["src/parse.ts"],
                  metadata: { filePath: "src/parse.ts" },
                  always: []
                }
              }
            ]),
            { headers: { "content-type": "text/event-stream" } }
          )
        )
      }
      if (url.pathname === "/session") return json({ id: "ses_ref" })
      if (url.pathname.endsWith("/message")) {
        return json({ info: { id: "msg_1" }, parts: [{ type: "text", text: "Renamed the helper." }] })
      }
      return json(true)
    })
  )

// ---------------------------------------------------------------------------
// 4. Two bridged runtimes, one manager that cannot tell them apart
// ---------------------------------------------------------------------------

const main = Effect.gen(function*() {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([])
  const http = Layer.succeed(HttpClient.HttpClient)(openCodeServer(calls))

  /**
   * A person, standing in for one: grants every question, and asks not to be
   * asked again. The second half is the interesting one -- see check 4.
   */
  const elicitor = yield* Elicitation.memory.make("ref-delegation")
  yield* Effect.forkScoped(
    Effect.forever(Effect.flatMap(elicitor.pending, (pending) =>
      Effect.forEach(pending, (request) =>
        elicitor.respond({ id: request.id, granted: true, value: { remember: true } }), {
        discard: true
      })))
  )

  const sandbox = yield* Effect.provide(
    Sandbox.acquire(Sandbox.workspace("ref-delegation")),
    MemorySandbox.layer({ execStream: claudeCli })
  )

  const claude = yield* ClaudeCodeA2A.remote(sandbox, {
    // The flags that would point a real CLI's permission prompts at our policy.
    // Nothing here is hand-written: the tool name in the flag and the tool the
    // server publishes come from the same place, so they cannot disagree.
    extraArgs: ClaudeCodePermissions.args({ url: "http://127.0.0.1:4599/permission" })
  })

  const opencode = yield* Effect.provide(
    OpenCodeA2A.remote({
      baseUrl: "http://127.0.0.1:4096",
      // The same policy value as the Claude side, and the same elicitor.
      permissions: { policy, elicitor }
    }),
    http
  )

  /**
   * Delegation needs no new concept: an A2A peer is a tool.
   *
   * Two of them, built the same way from two runtimes that share no code.
   */
  const Manager = Agent.make({
    instructions: "Delegate implementation work, then report what was done.",
    loop: AgentLoop.untilIdle(),
    tools: [
      AgentA2A.tool("claude_coder", {
        description: "Delegate a coding task to Claude Code.",
        request: Schema.String,
        result: Schema.String,
        agent: claude,
        contextId: "coding"
      }),
      AgentA2A.tool("opencode_coder", {
        description: "Delegate a coding task to OpenCode.",
        request: Schema.String,
        result: Schema.String,
        agent: opencode,
        contextId: "coding"
      })
    ]
  })

  const { layer: model } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "d1", name: "claude_coder", params: "fix the parser" }] },
    { toolCalls: [{ id: "d2", name: "opencode_coder", params: "rename the helper" }] },
    { text: "Both changes are in." }
  ])

  const answer = yield* Effect.provide(
    Effect.flatMap(AgentSession.make(Manager), (session) =>
      AgentSession.prompt(session, "Fix the parser, then rename the helper.")),
    model
  )

  // A second question for the same policy, in the *other* runtime's shape:
  // this is what the CLI's `--permission-prompt-tool` sends, and `decide` is
  // what its MCP server answers with.
  const refused = yield* ClaudeCodePermissions.decide({ policy, elicitor })({
    toolName: Option.some("Bash"),
    input: { command: "git push --force" },
    toolUseId: Option.some("toolu_ref")
  })

  return { answer, refused, calls: yield* Ref.get(calls) }
}).pipe(Effect.scoped)

// ---------------------------------------------------------------------------
// 5. What this file claims, checked
// ---------------------------------------------------------------------------

const program = Effect.gen(function*() {
  const { answer, calls, refused } = yield* main

  const expect = (claim: string, held: boolean) =>
    held ? Console.log(`  ok  ${claim}`) : Effect.die(new Error(`ref-delegation: ${claim}`))

  yield* expect(
    "a bridged CLI and a bridged server are both ordinary tools of one agent",
    answer.status === "completed" && answer.text.includes("Both changes are in.")
  )
  // Two delegations, two turns of tool calls, and a third to report.
  yield* expect(
    "both peers were actually called, not one of them twice",
    answer.turns === 3
  )

  const reply = calls.find((call) => call.path.includes("/permissions/"))
  yield* expect(
    "the same policy answered OpenCode's own permission request, mid-run",
    reply !== undefined
  )
  yield* expect(
    "an approved write reached the delegated runtime as `always`, so it stops asking",
    JSON.stringify(reply?.body) === JSON.stringify({ response: "always" })
  )

  yield* expect(
    "the same policy refused `git push` in Claude Code's dialect, without a rule about Claude Code",
    refused.behavior === "deny" && (refused.message ?? "").includes("human's job")
  )

  yield* expect(
    "one A2A context is one conversation per runtime, not one per message",
    calls.filter((call) => call.path === "/session").length === 1
  )

  return answer.text
})

void Effect.runPromise(program).then(
  (text) => Console.log(`\nmanager: ${text}`).pipe(Effect.runPromise),
  (error) => {
    console.error(error)
    process.exitCode = 1
  }
)

// ---------------------------------------------------------------------------
// Compile-time assertions — break once to confirm enforcement, then restore.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

/**
 * Both bridges narrow A2A's `Message | Task` to `Task`.
 *
 * A2A's `send` may answer either way, and neither of these peers ever answers
 * with a bare message. Delete `delegate` from a bridge and the caller is back
 * to narrowing a union that can only go one way -- which is the ergonomics
 * claim, stated so the compiler can refuse it.
 */
type ClaudeBridge = Effect.Success<ReturnType<typeof ClaudeCodeA2A.remote>>
type OpenCodeBridge = Effect.Success<ReturnType<typeof OpenCodeA2A.remote>>

type ClaudeAnswer = Effect.Success<ReturnType<ClaudeBridge["delegate"]>>
type OpenCodeAnswer = Effect.Success<ReturnType<OpenCodeBridge["delegate"]>>

export type _ClaudeAnswerIsATask = Assert<
  ClaudeAnswer extends { readonly artifacts: ReadonlyArray<unknown> } ? true : false
>
export type _OpenCodeAnswerIsATask = Assert<
  OpenCodeAnswer extends { readonly artifacts: ReadonlyArray<unknown> } ? true : false
>

/**
 * The two bridges are interchangeable where a peer is wanted.
 *
 * This is the plan's payoff as a type: whatever the runtime is, it enters as a
 * `RemoteAgent`, and `AgentA2A.tool` takes it without knowing which.
 */
type Peer = Parameters<typeof AgentA2A.tool<string, string>>[1]["agent"]
export type _ClaudeIsAPeer = Assert<ClaudeBridge extends Peer ? true : false>
export type _OpenCodeIsAPeer = Assert<OpenCodeBridge extends Peer ? true : false>

/** The policy is one value, used by both, with nothing runtime-specific in it. */
export type _PolicyIsNotAny = Assert<IsAny<typeof policy> extends true ? false : true>
