import { assert, describe, it } from "@effect/vitest"
import {
  Effect,
  FileSystem,
  ConfigProvider,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Stdio,
  Stream,
  Terminal
} from "effect"
import { Prompt } from "effect/unstable/ai"
import { Command } from "effect/unstable/cli"
import { ChildProcessSpawner } from "effect/unstable/process"
import { make } from "../apps/cli/src/command.js"
import * as AgentClient from "../src/client/AgentClient.js"
import * as AgentProtocol from "../src/client/AgentProtocol.js"
import * as PromptWire from "../src/PromptWire.js"

const cliLayer = (written: Array<string>) =>
  Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest({}),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: Effect.die("unused"),
        readLine: Effect.die("unused"),
        display: (text) => Effect.sync(() => written.push(text))
      })
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unused"))
    )
  )

const remoteSession: AgentClient.RemoteSession = {
  id: "session-1",
  prompt: (input) =>
    Effect.succeed({
      submissionId: AgentProtocol.SubmissionId.make("submission-1"),
      status: "completed",
      runs: 1,
      turns: 1,
      text: typeof input === "string" ? `answer: ${input}` : "answer",
      content: []
    }),
  submit: () => Effect.die("submit is not part of this fixture"),
  awaitSubmission: () => Effect.die("awaitSubmission is not part of this fixture"),
  steer: () => Effect.void,
  followUp: () => Effect.void,
  interrupt: () => Effect.void,
  respond: () => Effect.succeed(true),
  pending: Effect.succeed([]),
  history: Effect.succeed(Prompt.empty),
  status: Effect.succeed("idle"),
  events: () => Stream.empty
}

const client: AgentClient.Service = {
  createSession: () => Effect.succeed(remoteSession),
  session: () => Effect.succeed(remoteSession)
}

/**
 * A client that records what it was addressed with.
 *
 * Routing a session id is most of what these commands do, and a stub that
 * ignores its arguments cannot tell a command that passes the right id from
 * one that passes the flag value, the wrong argument, or nothing at all.
 */
const recordingClient = (
  overrides?: Partial<AgentClient.RemoteSession>
): {
  readonly client: AgentClient.Service
  readonly addressed: Array<string>
  readonly created: Array<string | undefined>
} => {
  const addressed: Array<string> = []
  const created: Array<string | undefined> = []
  const sessionFor = (id: string): AgentClient.RemoteSession => ({
    ...remoteSession,
    ...overrides,
    id
  })
  return {
    addressed,
    created,
    client: {
      createSession: (options) =>
        Effect.sync(() => {
          created.push(options?.sessionId)
          return sessionFor(options?.sessionId ?? "generated-1")
        }),
      session: (id) =>
        Effect.sync(() => {
          addressed.push(id)
          return sessionFor(id)
        })
    }
  }
}

/** Run one argv against a command backed by `service`. */
const runCli = (
  service: AgentClient.Service,
  argv: ReadonlyArray<string>,
  written: Array<string>
) =>
  Command.runWith(make(() => Effect.succeed(service)), { version: "test" })([
    ...argv
  ]).pipe(Effect.provide(cliLayer(written)))

describe("CLI", () => {
  it.effect("passes Redacted connection policy and prints a prompt result", () =>
    Effect.gen(function*() {
      const written: Array<string> = []
      const connected: Array<{ readonly url: string; readonly token: string }> = []
      const command = make((options) =>
        Effect.sync(() => {
          connected.push({
            url: options.url,
            token: Option.match(options.token, {
              onNone: () => "missing",
              onSome: Redacted.value
            })
          })
          return client
        })
      )

      yield* Command.runWith(command, { version: "test" })([
        "prompt",
        "session-1",
        "hello",
        "world"
      ]).pipe(
        Effect.provide([
          cliLayer(written),
          ConfigProvider.layer(ConfigProvider.fromUnknown({
            EFFECT_AGENT_URL: "https://agent.example",
            EFFECT_AGENT_TOKEN: "secret"
          }))
        ])
      )

      assert.deepStrictEqual(connected, [{
        url: "https://agent.example",
        token: "secret"
      }])
      assert.deepStrictEqual(written, ["answer: hello world\n"])
    })
  )

  it.effect("offers machine-readable status output", () =>
    Effect.gen(function*() {
      const written: Array<string> = []
      const command = make(() => Effect.succeed(client))

      yield* Command.runWith(command, { version: "test" })([
        "status",
        "session-1",
        "--json"
      ]).pipe(Effect.provide(cliLayer(written)))

      assert.deepStrictEqual(written, [
        '{"sessionId":"session-1","status":"idle"}\n'
      ])
    })
  )

  it.effect("answers a pending elicitation through the client seam", () =>
    Effect.gen(function*() {
      const written: Array<string> = []
      const answers: Array<{
        readonly id: string
        readonly granted: boolean
        readonly value?: unknown
      }> = []
      const respondingSession: AgentClient.RemoteSession = {
        ...remoteSession,
        respond: (response) =>
          Effect.sync(() => {
            answers.push(response)
            return true
          })
      }
      const command = make(() =>
        Effect.succeed<AgentClient.Service>({
          createSession: () => Effect.succeed(respondingSession),
          session: () => Effect.succeed(respondingSession)
        })
      )

      yield* Command.runWith(command, { version: "test" })([
        "respond",
        "session-1",
        "approval-1",
        "allow",
        "--value",
        "remember"
      ]).pipe(Effect.provide(cliLayer(written)))

      assert.deepStrictEqual(answers, [{
        id: "approval-1",
        granted: true,
        value: "remember"
      }])
      assert.deepStrictEqual(written, ["answered\n"])
    })
  )

  /**
   * Every command that takes a session id has to actually route it.
   *
   * Table-driven because the interesting property is uniform: the argument
   * reaches `client.session`, once, unchanged. A stub that returned a fixed
   * session could not observe any of this.
   */
  describe("session addressing", () => {
    const cases: ReadonlyArray<{
      readonly name: string
      readonly argv: ReadonlyArray<string>
    }> = [
      { name: "prompt", argv: ["prompt", "s-prompt", "hi"] },
      { name: "status", argv: ["status", "s-status"] },
      { name: "history", argv: ["history", "s-history"] },
      { name: "interrupt", argv: ["interrupt", "s-interrupt"] },
      { name: "steer", argv: ["steer", "s-steer", "go"] },
      { name: "follow-up", argv: ["follow-up", "s-follow", "next"] },
      { name: "pending", argv: ["pending", "s-pending"] },
      {
        name: "respond",
        argv: ["respond", "s-respond", "req-1", "allow"]
      }
    ]

    for (const { argv, name } of cases) {
      it.effect(`${name} addresses the session it was given`, () =>
        Effect.gen(function*() {
          const written: Array<string> = []
          const recorder = recordingClient()
          yield* runCli(recorder.client, argv, written)
          assert.deepStrictEqual(
            recorder.addressed,
            [argv[1]],
            `${name} must pass its session-id argument through unchanged`
          )
        }))
    }

    it.effect("create passes an explicit --id and omits it otherwise", () =>
      Effect.gen(function*() {
        const written: Array<string> = []
        const withId = recordingClient()
        yield* runCli(withId.client, ["create", "--id", "chosen"], written)
        assert.deepStrictEqual(withId.created, ["chosen"])
        assert.deepStrictEqual(written, ["chosen\n"])

        const withoutId = recordingClient()
        const bare: Array<string> = []
        yield* runCli(withoutId.client, ["create"], bare)
        assert.deepStrictEqual(withoutId.created, [undefined])
        assert.deepStrictEqual(bare, ["generated-1\n"])
      }))
  })

  /**
   * The variadic commands join their words into one prompt.
   *
   * `prompt` already proves the joining; these two share the code path and
   * would fail identically if it regressed, so they are pinned too.
   */
  describe("variadic input", () => {
    it.effect("steer and follow-up join their words", () =>
      Effect.gen(function*() {
        const steered: Array<string> = []
        const queued: Array<string> = []
        const recorder = recordingClient({
          steer: (input) =>
            Effect.sync(() => {
              steered.push(typeof input === "string" ? input : "not-a-string")
            }),
          followUp: (input) =>
            Effect.sync(() => {
              queued.push(typeof input === "string" ? input : "not-a-string")
            })
        })
        const written: Array<string> = []
        yield* runCli(
          recorder.client,
          ["steer", "s-1", "turn", "left", "now"],
          written
        )
        yield* runCli(
          recorder.client,
          ["follow-up", "s-1", "then", "stop"],
          written
        )
        assert.deepStrictEqual(steered, ["turn left now"])
        assert.deepStrictEqual(queued, ["then stop"])
      }))
  })

  /**
   * `history` promises *encoded* history, and history is a `Prompt.Prompt`.
   *
   * A raw `JSON.stringify` renders `Uint8Array` as `{"0":72,...}` and a `URL`
   * as a bare string indistinguishable from string data. Both are silent: the
   * command still prints something that looks like JSON. So the assertion is
   * that the printed text decodes back through `PromptWire` to the *same*
   * prompt, with each file-data variant intact -- which a stub carrying an
   * empty prompt could never have shown.
   */
  describe("history encoding", () => {
    const multimodalMessages: ReadonlyArray<Prompt.MessageEncoded> = [{
      role: "user",
      content: [
        { type: "text", text: "look at these" },
        {
          type: "file",
          mediaType: "image/png",
          data: new Uint8Array([137, 80, 78, 71])
        },
        {
          type: "file",
          mediaType: "image/png",
          data: new URL("https://cdn.example.com/b.png")
        },
        {
          type: "file",
          mediaType: "text/plain",
          data: "inline string payload"
        }
      ]
    }]
    const multimodal = Prompt.make(multimodalMessages)

    it.effect("prints history that round-trips through PromptWire", () =>
      Effect.gen(function*() {
        const written: Array<string> = []
        const recorder = recordingClient({
          history: Effect.succeed(multimodal)
        })
        yield* runCli(recorder.client, ["history", "s-1", "--json"], written)

        const printed = written[0] ?? ""
        // Bytes must not have been rendered as an index-keyed object.
        assert.notInclude(
          printed,
          '"0":137',
          "a Uint8Array leaked through raw JSON.stringify"
        )

        const decoded = yield* Schema.decodeUnknownEffect(PromptWire.Prompt)(
          JSON.parse(printed)
        )
        assert.deepStrictEqual(decoded, multimodal)

        const message = decoded.content[0]
        assert.strictEqual(message?.role, "user")
        if (message?.role !== "user") return
        const parts = message.content
        assert.strictEqual(parts[1]?.type, "file")
        if (parts[1]?.type === "file") {
          assert.isTrue(
            parts[1].data instanceof Uint8Array,
            "the bytes variant must survive as bytes"
          )
        }
        assert.strictEqual(parts[2]?.type, "file")
        if (parts[2]?.type === "file") {
          assert.isTrue(
            parts[2].data instanceof URL,
            "the URL variant must survive as a URL, not decay to a string"
          )
        }
        assert.strictEqual(parts[3]?.type, "file")
        if (parts[3]?.type === "file") {
          assert.strictEqual(parts[3].data, "inline string payload")
        }
      }))

    it.effect("indents for a person and compacts for a pipe", () =>
      Effect.gen(function*() {
        const pretty: Array<string> = []
        const compact: Array<string> = []
        const recorder = recordingClient({
          history: Effect.succeed(multimodal)
        })
        yield* runCli(recorder.client, ["history", "s-1"], pretty)
        yield* runCli(recorder.client, ["history", "s-1", "--json"], compact)
        assert.include(pretty[0] ?? "", "\n  ", "no --json prints indented")
        assert.notInclude(compact[0] ?? "", "\n  ", "--json prints compact")
      }))
  })
})
