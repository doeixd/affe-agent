import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Ref, Schema } from "effect"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import { ClaudeCodePermissions } from "../src/a2a/index.js"

/**
 * The permission bridge: a delegated Claude Code run, governed by this
 * application's policy.
 *
 * `docs/plan-a2a-layers-bridges.txt` step 2. The decision is `decide`, which
 * needs no server to exercise -- the MCP tool is that function with a schema on
 * each side, and testing the function is testing the behaviour.
 */

const prompt = (toolName: string, input: unknown) => ({
  toolName: Option.some(toolName),
  input,
  toolUseId: Option.some(`call-${toolName}`)
})

describe("ClaudeCodePermissions.defaultProjection", () => {
  it("speaks the same vocabulary /coding annotates its own tools with", () => {
    // This is the "one policy, two runtimes" claim, and it is only true if the
    // action strings match exactly. `CodingToolkit` uses read / write / shell.
    assert.deepStrictEqual(
      ClaudeCodePermissions.defaultProjection("Bash", { command: "git push" }),
      { action: "shell", resource: "git push" }
    )
    assert.deepStrictEqual(
      ClaudeCodePermissions.defaultProjection("Edit", { file_path: "src/auth.ts" }),
      { action: "write", resource: "src/auth.ts" }
    )
    assert.deepStrictEqual(
      ClaudeCodePermissions.defaultProjection("Read", { file_path: "README.md" }),
      { action: "read", resource: "README.md" }
    )
    // An unrecognised tool is visible to a policy rather than silently
    // uncategorised, exactly as an unannotated tool of ours is.
    assert.deepStrictEqual(
      ClaudeCodePermissions.defaultProjection("mcp__github__create_issue", { title: "x" }),
      { action: "tool", resource: "mcp__github__create_issue" }
    )
    // A tool whose input is not the shape we expect still projects.
    assert.deepStrictEqual(
      ClaudeCodePermissions.defaultProjection("Bash", null),
      { action: "shell", resource: "Bash" }
    )
  })
})

describe("ClaudeCodePermissions.decide", () => {
  it.effect("a policy written once governs the delegated runtime too", () =>
    Effect.gen(function* () {
      // Not a policy written for Claude Code: an ordinary rule set, in the
      // vocabulary this repository's own coding tools already use.
      const policy = Permission.rules([
        { action: "read", decision: Permission.allow },
        { action: "shell", resource: /^git push/, decision: Permission.deny("no pushing") },
        { action: "write", decision: Permission.ask("writes are reviewed") }
      ], { otherwise: Permission.deny("not covered by policy") })

      const decide = ClaudeCodePermissions.decide({ policy })

      const read = yield* decide(prompt("Read", { file_path: "README.md" }))
      assert.strictEqual(read.behavior, "allow")
      // The input is echoed back: an allow that omits it was rejected as a
      // validation failure by older CLIs.
      assert.deepStrictEqual(read.updatedInput, { file_path: "README.md" })

      const push = yield* decide(prompt("Bash", { command: "git push --force" }))
      assert.strictEqual(push.behavior, "deny")
      assert.include(push.message ?? "", "no pushing")

      // No elicitor: an Ask is a denial, which is the harness's own default.
      const write = yield* decide(prompt("Write", { file_path: "src/x.ts", content: "" }))
      assert.strictEqual(write.behavior, "deny")
      assert.include(write.message ?? "", "reviewed")

      const other = yield* decide(prompt("WebFetch", { url: "https://example.com" }))
      assert.strictEqual(other.behavior, "deny")
    })
  )

  it.effect("an Ask becomes a real question, and the answer decides", () =>
    Effect.gen(function* () {
      const elicitor = yield* Elicitation.memory.make("bridge")
      const decide = ClaudeCodePermissions.decide({
        policy: Permission.askAll,
        elicitor
      })

      const asking = yield* Effect.forkChild(
        decide(prompt("Write", { file_path: "src/x.ts" }))
      )
      // The question is the same `kind` the harness asks for its own tools, so
      // an application that renders one already renders this.
      const pending = yield* Effect.repeat(elicitor.pending, {
        until: (requests) => requests.length > 0
      })
      const question = pending[0]
      assert.strictEqual(question?.kind, "tool-approval")
      assert.deepStrictEqual(question?.detail, {
        toolName: "Write",
        toolCallId: "call-Write",
        action: "write",
        resource: "src/x.ts"
      })

      yield* elicitor.respond({ id: question!.id, granted: true })
      const answered = yield* Fiber.join(asking)
      assert.strictEqual(answered.behavior, "allow")
    })
  )

  it.effect("a refused question is a denial the delegated agent can read", () =>
    Effect.gen(function* () {
      const elicitor = yield* Elicitation.memory.make("bridge")
      const decide = ClaudeCodePermissions.decide({ policy: Permission.askAll, elicitor })
      const asking = yield* Effect.forkChild(decide(prompt("Bash", { command: "rm -rf /" })))
      const pending = yield* Effect.repeat(elicitor.pending, {
        until: (requests) => requests.length > 0
      })
      yield* elicitor.respond({ id: pending[0]!.id, granted: false })
      const answered = yield* Fiber.join(asking)
      assert.strictEqual(answered.behavior, "deny")
      assert.isDefined(answered.message)
    })
  )

  it.effect("allow always reaches the policy, not just this call", () =>
    Effect.gen(function* () {
      const remembered = yield* Ref.make<ReadonlyArray<string>>([])
      const policy: Permission.Policy = {
        evaluate: () => Effect.succeed(Permission.ask()),
        remember: (request) =>
          Ref.update(remembered, (all) => [...all, `${request.action}:${request.resource}`])
      }
      const elicitor = yield* Elicitation.memory.make("bridge")
      const decide = ClaudeCodePermissions.decide({ policy, elicitor })

      const asking = yield* Effect.forkChild(decide(prompt("Edit", { file_path: "src/x.ts" })))
      const pending = yield* Effect.repeat(elicitor.pending, {
        until: (requests) => requests.length > 0
      })
      yield* elicitor.respond({ id: pending[0]!.id, granted: true, value: { remember: true } })
      yield* Fiber.join(asking)
      assert.deepStrictEqual(yield* Ref.get(remembered), ["write:src/x.ts"])
    })
  )

  it.effect("a request that names no tool is denied, not guessed at", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make(0)
      const policy = Permission.make(() =>
        Effect.as(Ref.update(seen, (n) => n + 1), Permission.allow)
      )
      const answered = yield* ClaudeCodePermissions.decide({ policy })({
        toolName: Option.none(),
        input: { command: "rm -rf /" },
        toolUseId: Option.none()
      })
      assert.strictEqual(answered.behavior, "deny")
      // Fail closed *before* the policy: there is nothing to decide about.
      assert.strictEqual(yield* Ref.get(seen), 0)
    })
  )

  it.effect("the delegated agent's call is what the policy sees", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make(Option.none<Permission.Request>())
      const policy = Permission.make((request) =>
        Effect.as(Ref.set(seen, Option.some(request)), Permission.allow)
      )
      yield* ClaudeCodePermissions.decide({ policy, sessionId: "task-7" })(
        prompt("Bash", { command: "npm test" })
      )
      const request = yield* Ref.get(seen)
      assert.isTrue(Option.isSome(request))
      if (Option.isSome(request)) {
        assert.strictEqual(request.value.sessionId, "task-7")
        assert.strictEqual(request.value.tool.name, "Bash")
        assert.deepStrictEqual(request.value.tool.params, { command: "npm test" })
        // The CLI asks only for calls its own rules did not approve, so every
        // request that arrives here is approval-requiring by construction.
        assert.isTrue(request.value.intrinsicApproval)
        // The delegated agent's transcript is its own; claiming to have it
        // would be worse than saying it is empty.
        assert.deepStrictEqual(request.value.messages, [])
      }
    })
  )
})

describe("ClaudeCodePermissions.tool", () => {
  it("decodes what the CLI sends, in either spelling", () => {
    const decode = Schema.decodeUnknownSync(ClaudeCodePermissions.tool.parametersSchema)
    const snake = decode({
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "toolu_1"
    })
    assert.strictEqual(snake.tool_name, "Bash")
    // The payload's exact casing is the one part of this contract not nailed
    // down publicly, and getting it wrong would fail every call rather than
    // one. Both spellings decode.
    const camel = decode({ toolName: "Bash", tool_input: { command: "ls" } })
    assert.strictEqual(camel.toolName, "Bash")
    // An unknown extra field must not fail the whole decision.
    assert.doesNotThrow(() => decode({ tool_name: "Bash", permission_suggestions: [] }))
  })

  it("encodes the answer as a JSON object, which is what the CLI parses", () => {
    const encoded = Schema.encodeUnknownSync(ClaudeCodePermissions.tool.successSchema)({
      behavior: "allow",
      updatedInput: { command: "ls" }
    })
    // An object, so the MCP result carries `structuredContent` and its text is
    // `{"behavior":"allow",...}`. A string here would arrive quoted and the CLI
    // would refuse to parse it.
    assert.isTrue(typeof encoded === "object" && encoded !== null)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(encoded)), {
      behavior: "allow",
      updatedInput: { command: "ls" }
    })
  })
})

describe("ClaudeCodePermissions.args", () => {
  it("names the served tool, so the flag and the server cannot disagree", () => {
    const flags = ClaudeCodePermissions.args({ url: "http://127.0.0.1:4599/permission" })
    const index = flags.indexOf("--permission-prompt-tool")
    assert.isAbove(index, -1)
    assert.strictEqual(flags[index + 1], ClaudeCodePermissions.toolReference())

    const config = JSON.parse(flags[flags.indexOf("--mcp-config") + 1] ?? "{}")
    assert.deepStrictEqual(config, {
      mcpServers: {
        effect_agent_permissions: { type: "http", url: "http://127.0.0.1:4599/permission" }
      }
    })
    // Without this the CLI also loads whatever the host has configured, so a
    // delegated run's tool surface would depend on the machine.
    assert.include(flags, "--strict-mcp-config")
  })

  it("a named server is named in both places", () => {
    const flags = ClaudeCodePermissions.args({
      url: "http://127.0.0.1:1/x",
      serverName: "reviewer",
      strict: false
    })
    assert.strictEqual(
      flags[flags.indexOf("--permission-prompt-tool") + 1],
      "mcp__reviewer__approve"
    )
    const config = JSON.parse(flags[flags.indexOf("--mcp-config") + 1] ?? "{}")
    assert.property(config.mcpServers, "reviewer")
    assert.notInclude(flags, "--strict-mcp-config")
  })
})
