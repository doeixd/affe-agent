import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentInput from "../AgentInput.js"
import type * as AgentSession from "../AgentSession.js"
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
 * is the agent's, so the value is `PromptInput<Input>` by construction. The
 * compiler cannot resolve that conditional for an abstract `Input`, so `run`
 * below holds the one widening and every boundary goes through it.
 */

/** A prompt, or a typed input's encoded value. */
export type RemoteInput = Prompt.RawInput | AgentInput.Typed

export type Declared = Option.Option<AgentInput.AgentInput<any, any, any, any>>

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
export const asked = <Input>(value: unknown): AgentSession.PromptInput<Input> =>
  value as AgentSession.PromptInput<Input>

/** Admit, then run the agent with what was admitted. */
export const run = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>,
  operation: "prompt" | "submit",
  input: RemoteInput
) =>
  Effect.flatMap(admit(agent.input, operation, input), (admitted) =>
    Agent.run(agent, asked<Input>(admitted.asked)))

/** Run the agent with a recorded admission. */
export const runRecorded = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>,
  recorded: Recorded
) =>
  Effect.flatMap(askedOf(agent.input, recorded), (value) => Agent.run(agent, asked<Input>(value)))
