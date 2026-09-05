import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import type { AgentDefinition } from "../Agent.js"
import * as AgentInput from "../AgentInput.js"
import * as WireValue from "./wireValue.js"
import { AgentInvalidRequestError } from "../client/internal/protocolErrors.js"

/**
 * The one place a typed input is admitted across a boundary.
 *
 * Every surface that receives an input from outside the process -- a
 * transport, the durable client, the cluster entity, a job queue -- takes
 * `RemoteInput` and asks here whether it fits the agent: decoded with the
 * schema the agent holds, which is the prompt wire for the default input
 * and the declared schema otherwise. A value that does not fit is an
 * `AgentInvalidRequestError`, named rather than mis-rendered.
 *
 * `asked` is what the session's `prompt` takes, and it is typed `unknown`
 * because the decode that produced it is the proof, not the type: the schema
 * is the agent's, so the value is `Input` by construction. `run` below holds
 * the one widening and every boundary goes through it.
 *
 * `Declared` is `None` for the default input (`AgentInput.prompt`) and
 * `Some` for a declared one. The wire carries one shape now, but a *record*
 * -- a journal, a claim, a job -- still holds a prompt plus an optional
 * encoded value (`Recorded`), and `Subagent` still offers the parent model
 * either `{ prompt }` or the child's schema; those are what read it.
 */

/**
 * What a boundary receives: a raw prompt, or the session's encoded input.
 *
 * `unknown`, honestly. The wire names no schema -- the session the value is
 * addressed to declares it -- so nothing narrower is true of a value before
 * the host has decoded it. A caller who wants the type is `AgentClient.typed`.
 */
export type RemoteInput = Prompt.RawInput | unknown

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

/**
 * Admit an input across a boundary: decode it with the session's schema.
 *
 * One path, since every agent has an input. A raw prompt is admitted as
 * itself for the default and refused, by name, for an agent that declares a
 * shape -- the schema would refuse it too, but "send its value, not a
 * prompt" is the message that helps. An encoded value is decoded with the
 * agent's schema: the prompt wire for the default, the declared schema
 * otherwise, and a value that does not fit is an invalid request carrying
 * the schema's own message.
 */
export const admit = (
  agent: { readonly input: AgentInput.AgentInput<any, any, any, any> },
  operation: "prompt" | "submit",
  input: RemoteInput
): Effect.Effect<Admitted, AgentInvalidRequestError> => {
  const shape = declared(agent)
  if (AgentInput.isRaw(input)) {
    if (Option.isSome(shape)) {
      return Effect.fail(
        new AgentInvalidRequestError({
          operation,
          detail: "this session's agent declares a typed input; send its value, not a prompt"
        })
      )
    }
    const prompt = Prompt.make(input)
    return Effect.succeed({ prompt, asked: prompt })
  }
  return WireValue.decode(agent.input.schema, input).pipe(
    Effect.map((asked): Admitted =>
      Option.isSome(shape)
        ? { prompt: Prompt.empty, input, asked }
        // The default: what decoded is a `Prompt.RawInput`, and the record
        // stays the prompt it always was.
        : { prompt: Prompt.make(asked as Prompt.RawInput), asked: Prompt.make(asked as Prompt.RawInput) }
    ),
    Effect.mapError((error) =>
      new AgentInvalidRequestError({
        operation,
        detail: Option.isSome(shape)
          ? error.message
          // Said in the caller's terms: the value sent was read as a prompt,
          // because that is what this session's agent is asked with.
          : `this session's agent is asked with a prompt, and the value sent is not one: ${error.message}`
      }))
  )
}

/**
 * What a recorded admission asks the session with.
 *
 * A record holds the prompt, and the encoded value when the agent declared
 * a shape at the time it was written. The prompt is what a default-input
 * agent is asked with, as it is; a value is decoded again with the agent's
 * schema. The value was validated when it was admitted, so a record that no
 * longer decodes -- including one written for a declared input and replayed
 * by an agent whose input is now the prompt -- is a bug in whoever changed
 * the agent under its own journal, and dies as one.
 *
 * `plan-input-default.md` step 4 asked for `input` to be written for every
 * record; it is not, deliberately, because for the default it would store
 * every prompt twice forever to delete this one branch. See the plan.
 */
export const askedOf = (
  agent: { readonly input: AgentInput.AgentInput<any, any, any, any> },
  recorded: Recorded
): Effect.Effect<unknown> =>
  recorded.input === undefined
    ? Effect.succeed(recorded.prompt)
    : Effect.orDie(WireValue.decode(agent.input.schema, recorded.input))

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
  Effect.flatMap(admit(agent, operation, input), (admitted) =>
    Agent.run(agent, asked<Input>(admitted.asked)))

/** Run the agent with a recorded admission. */
export const runRecorded = <Tools extends Record<string, Tool.Any>, E, R, Model, Value, Input>(
  agent: AgentDefinition<Tools, E, R, Model, Value, Input>,
  recorded: Recorded
) =>
  Effect.flatMap(askedOf(agent, recorded), (value) => Agent.run(agent, asked<Input>(value)))
