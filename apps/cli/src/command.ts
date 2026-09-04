import { Config, Effect, Option, Redacted, Schema, Terminal } from "effect"
import type { Scope } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type * as AgentClient from "../../../src/client/AgentClient.js"
import * as PromptWire from "../../../src/PromptWire.js"

/** Connection policy shared by every command. */
export interface ConnectionOptions {
  readonly url: string
  readonly token: Option.Option<Redacted.Redacted<string>>
}

/**
 * Acquire one transport-neutral client for a command invocation.
 *
 * `Scope` is part of the acquisition because an HTTP adapter may own scoped
 * resources. `make` scopes it around the selected command, so no command can
 * leak a client handle after it exits.
 */
export type Connect<E = never, R = never> = (
  options: ConnectionOptions
) => Effect.Effect<AgentClient.Service, E, R | Scope.Scope>

const output = (text: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) => terminal.display(`${text}\n`))

/**
 * Render a value as JSON for the terminal.
 *
 * `--json` prints compactly for a pipe; without it, indented for a person.
 */
const asJson = (value: unknown, json: boolean): string =>
  JSON.stringify(value, undefined, json ? 0 : 2)

/**
 * History is a `Prompt.Prompt`, a domain value, not a JSON one.
 *
 * `JSON.stringify` on it renders a `Uint8Array` as `{"0":72,"1":101,...}` and
 * a `URL` as a bare string indistinguishable from string data -- exactly the
 * ambiguity `PromptWire` exists to remove. The command promises *encoded*
 * history, so it has to encode rather than let `JSON.stringify` improvise.
 */
const encodedPrompt = Schema.encodeEffect(PromptWire.Prompt)

const url = Flag.string("url").pipe(
  Flag.withDescription("Agent HTTP server base URL"),
  Flag.withFallbackConfig(
    Config.string("EFFECT_AGENT_URL").pipe(
      Config.withDefault("http://127.0.0.1:3000")
    )
  )
)

const token = Flag.redacted("token").pipe(
  Flag.withDescription("Bearer token (or EFFECT_AGENT_TOKEN)"),
  Flag.withFallbackConfig(Config.redacted("EFFECT_AGENT_TOKEN")),
  Flag.optional
)

const json = Flag.boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON"),
  Flag.withDefault(false)
)

const sessionId = Argument.string("session-id").pipe(
  Argument.withDescription("Session to address")
)

const input = Argument.string("input").pipe(
  Argument.withDescription("Prompt or out-of-band input"),
  Argument.variadic({ min: 1 })
)

/** Build the command tree around an injectable client acquisition. */
export const make = <E, R>(connect: Connect<E, R>) => {
  const root = Command.make("affe-agent").pipe(
    Command.withDescription("Operate an affe-agent HTTP server"),
    Command.withSharedFlags({ url, token, json })
  )

  const withClient = <A, E2, R2>(
    options: ConnectionOptions,
    use: (client: AgentClient.Service) => Effect.Effect<A, E2, R2>
  ) => Effect.scoped(Effect.flatMap(connect(options), use))

  const create = Command.make(
    "create",
    {
      id: Flag.string("id").pipe(
        Flag.withDescription("Requested session id"),
        Flag.optional
      )
    },
    Effect.fn("Cli.create")(function*({ id }) {
      const options = yield* root
      const created = yield* withClient(options, (client) =>
        client.createSession(
          Option.isSome(id) ? { sessionId: id.value } : undefined
        )
      )
      yield* output(
        options.json
          ? JSON.stringify({ sessionId: created.id })
          : created.id
      )
    })
  ).pipe(Command.withDescription("Create a session"))

  const prompt = Command.make(
    "prompt",
    { sessionId, input },
    Effect.fn("Cli.prompt")(function*({ input, sessionId }) {
      const options = yield* root
      const result = yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) =>
          session.prompt(input.join(" "))
        )
      )
      yield* output(options.json ? JSON.stringify(result) : result.text)
    })
  ).pipe(Command.withDescription("Send a prompt and wait for its result"))

  const status = Command.make(
    "status",
    { sessionId },
    Effect.fn("Cli.status")(function*({ sessionId }) {
      const options = yield* root
      const status = yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) => session.status)
      )
      yield* output(
        options.json
          ? JSON.stringify({ sessionId, status })
          : status
      )
    })
  ).pipe(Command.withDescription("Read session status"))

  const history = Command.make(
    "history",
    { sessionId },
    Effect.fn("Cli.history")(function*({ sessionId }) {
      const options = yield* root
      const history = yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) => session.history)
      )
      yield* output(asJson(yield* encodedPrompt(history), options.json))
    })
  ).pipe(Command.withDescription("Print the encoded session history"))

  const interrupt = Command.make(
    "interrupt",
    { sessionId },
    Effect.fn("Cli.interrupt")(function*({ sessionId }) {
      const options = yield* root
      yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) => session.interrupt())
      )
      yield* output(
        options.json
          ? JSON.stringify({ sessionId, interrupted: true })
          : `interrupted ${sessionId}`
      )
    })
  ).pipe(Command.withDescription("Interrupt the active run"))

  const steer = Command.make(
    "steer",
    { sessionId, input },
    Effect.fn("Cli.steer")(function*({ input, sessionId }) {
      const options = yield* root
      yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) =>
          session.steer(input.join(" "))
        )
      )
      yield* output(options.json ? JSON.stringify({ sessionId, steered: true }) : "queued")
    })
  ).pipe(Command.withDescription("Queue steering for the active run"))

  const followUp = Command.make(
    "follow-up",
    { sessionId, input },
    Effect.fn("Cli.followUp")(function*({ input, sessionId }) {
      const options = yield* root
      yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) =>
          session.followUp(input.join(" "))
        )
      )
      yield* output(options.json ? JSON.stringify({ sessionId, queued: true }) : "queued")
    })
  ).pipe(Command.withDescription("Queue a sequential follow-up"))

  const pending = Command.make(
    "pending",
    { sessionId },
    Effect.fn("Cli.pending")(function*({ sessionId }) {
      const options = yield* root
      const pending = yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) => session.pending)
      )
      yield* output(asJson(pending, options.json))
    })
  ).pipe(Command.withDescription("List pending elicitation requests"))

  const respond = Command.make(
    "respond",
    {
      sessionId,
      requestId: Argument.string("request-id").pipe(
        Argument.withDescription("Pending elicitation request id")
      ),
      decision: Argument.choice("decision", ["allow", "deny"]),
      value: Flag.string("value").pipe(
        Flag.withDescription("Optional string response value"),
        Flag.optional
      )
    },
    Effect.fn("Cli.respond")(function*({ decision, requestId, sessionId, value }) {
      const options = yield* root
      const matched = yield* withClient(options, (client) =>
        Effect.flatMap(client.session(sessionId), (session) =>
          session.respond({
            id: requestId,
            granted: decision === "allow",
            ...(Option.isSome(value) ? { value: value.value } : {})
          })
        )
      )
      yield* output(
        options.json
          ? JSON.stringify({ sessionId, requestId, matched })
          : matched
            ? "answered"
            : "no pending request matched"
      )
    })
  ).pipe(Command.withDescription("Answer a pending elicitation"))

  return root.pipe(
    Command.withSubcommands([
      create,
      prompt,
      status,
      history,
      interrupt,
      steer,
      followUp,
      pending,
      respond
    ])
  )
}
