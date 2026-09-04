import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentInput from "../AgentInput.js"
import { AgentInvalidRequestError } from "../client/internal/protocolErrors.js"

/**
 * The one place a typed input is admitted across a boundary.
 *
 * Every surface that receives an input from outside the process -- a
 * transport, the durable client, the cluster entity, a job queue -- takes
 * `RemoteInput` and asks here whether it fits the agent: a prompt for an
 * agent without an `AgentInput`, the encoded value for one that declares it,
 * decoded with the schema the agent holds. Either the other way is an
 * `AgentInvalidRequestError`, named rather than mis-rendered.
 *
 * `asked` is what the session's `prompt` takes, and it is typed `unknown`
 * because the decode that produced it is the proof, not the type: the schema
 * is the agent's, so the value is `Input` by construction. `run` below holds
 * the one widening and every boundary goes through it.
 *
 * `Declared` is `None` for the default input (`AgentInput.prompt`) and
 * `Some` for a declared one, because the wire still carries two shapes --
 * a prompt, or a tagged typed value -- until `plan-input-default.md` step
 * 3. Every boundary reads it through `declared` so the distinction lives in
 * one place and goes when the second shape does.
 */

/** A prompt, or a typed input's encoded value. */
export type RemoteInput = Prompt.RawInput | AgentInput.Typed

export type Declared = Option.Option<AgentInput.AgentInput<any, any, any, any>>

/** The agent's declared input, or `None` for the default prompt. See the module note. */
export const declared = (agent: {
  readonly input: AgentInput.AgentInput<any, any, any, any>
}): Declared => AgentInput.isPrompt(agent.input) ? Option.none() : Option.some(agent.input)

export interface Admitted {
  /** The prompt, or empty when the value is typed: the rendering is the session's to produce. */
  readonly prompt: Prompt.Prompt
  /** The encoded value, present for a typed input -- what a journal or a store records. */
  readonly input?: unknown
  /** What the session is asked with: the prompt, or the decoded value. */
  readonly asked: unknown
}

/** A recorded admission: what a journal, claim or job holds between processes. */
export interface Recorded {
  readonly prompt: Prompt.Prompt
  readonly input?: unknown
}

export const admit = (
  declared: Declared,
  operation: "prompt" | "submit",
  input: RemoteInput
): Effect.Effect<Admitted, AgentInvalidRequestError> =>
  Option.match(declared, {
    onNone: () =>
      AgentInput.isTyped(input)
        ? Effect.fail(
          new AgentInvalidRequestError({
            operation,
            detail: "this session's agent is asked with a prompt, not a typed input"
          })
        )
        : Effect.sync(() => {
          const prompt = Prompt.make(input)
          return { prompt, asked: prompt }
        }),
    onSome: (declaredInput) =>
      AgentInput.isTyped(input)
        ? Schema.decodeUnknownEffect(declaredInput.schema)(input.value).pipe(
          Effect.map((asked): Admitted => ({ prompt: Prompt.empty, input: input.value, asked })),
          Effect.mapError((error) => new AgentInvalidRequestError({ operation, detail: error.message }))
        )
        : Effect.fail(
          new AgentInvalidRequestError({
            operation,
            detail: "this session's agent declares a typed input; send its value, not a prompt"
          })
        )
  })

/**
 * What a recorded admission asks the session with, decoded again with the
 * agent's schema. The value was validated when it was admitted, so a record
 * that no longer decodes -- or carries a value for an agent that declares
 * none -- is a bug in whoever recorded it, and dies as one.
 */
export const askedOf = (declared: Declared, recorded: Recorded): Effect.Effect<unknown> =>
  recorded.input === undefined
    ? Effect.succeed(recorded.prompt)
    : Option.match(declared, {
      onNone: () =>
        Effect.die(new Error("a recorded submission carries a typed input, but the agent declares none")),
      onSome: (declaredInput) => Effect.orDie(Schema.decodeUnknownEffect(declaredInput.schema)(recorded.input))
    })

/**
 * The one widening: from what a boundary decoded to what the session's
 * signature asks for. See the module note.
 */
export const asked = <Input>(value: unknown): Input => value as Input

/** Admit, then run the agent with what was admitted. */
export const run = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>,
  operation: "prompt" | "submit",
  input: RemoteInput
) =>
  Effect.flatMap(admit(declared(agent), operation, input), (admitted) =>
    Agent.run(agent, asked<Input>(admitted.asked)))

/** Run the agent with a recorded admission. */
export const runRecorded = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>,
  recorded: Recorded
) =>
  Effect.flatMap(askedOf(declared(agent), recorded), (value) => Agent.run(agent, asked<Input>(value)))
