import { Context, Effect, Option, Schema } from "effect"
import type { Prompt } from "effect/unstable/ai"

/**
 * A typed value a submission is asked with — the mirror of `AgentOutput`.
 *
 * `AgentOutput` types what an agent *answers*; this types what it is
 * *asked*, and splits that into two things a prompt string conflates:
 *
 * - the **value**, the full input as the caller means it, validated by the
 *   schema, stored in its encoded form, and reachable by every tool and
 *   permission decision the submission makes (`Current` / `current`);
 * - the **rendering**, what the model is shown, derived from the value by
 *   `render`. It is what enters canonical history.
 *
 * The split is the point. A ticket's `customerId` should decide which
 * records a tool may touch without the model being the one to relay it;
 * a document's full text may be what a tool needs while the model sees a
 * summary; a secret in the input has no business in the transcript at all.
 * Rendering is a projection, so the value and what the model sees can
 * differ on purpose, and a `Permission` policy reads the value.
 *
 * Declared on the `Agent`, as the output is, because an agent that is
 * asked in a shape is *defined* by that shape: its instructions and its
 * input are written together. With one declared, `session.prompt` and
 * `Agent.run` take the schema's type instead of `Prompt.RawInput`, and the
 * compiler holds the caller to it.
 *
 * `render` may be an `Effect`: its failure joins the agent's `E` and its
 * requirements the agent's `R`, so a rendering that reads a service says so
 * in the type.
 *
 * **Scope, stated.** This is the in-process seam: `AgentSession`,
 * `Agent.run`, tools, permissions and the `SubmissionStarted` event. The
 * remote surfaces (`AgentClient` and every transport over it) and the
 * durable interpreter still take `Prompt.RawInput`; an agent with an input
 * is refused by them at compile time rather than mis-rendered at runtime.
 * Carrying the value across a wire means deciding how a client names the
 * schema to encode it with, which is the next phase, not a field.
 */
export interface AgentInput<A, I, E = never, R = never> {
  readonly schema: Schema.Codec<A, I>
  /** What the model is shown for a value. Never the value itself unless it says so. */
  readonly render: (input: A) => Prompt.RawInput | Effect.Effect<Prompt.RawInput, E, R>
}

/**
 * Describe the shape a submission is asked in, and how the model sees it.
 *
 * ```ts
 * const Ticket = AgentInput.make(
 *   Schema.Struct({ customerId: Schema.String, body: Schema.String }),
 *   ({ body }) => `A customer writes:\n\n${body}`
 * )
 * const Support = Agent.make({ instructions: "...", input: Ticket })
 *
 * yield* Agent.run(Support, { customerId: "c-42", body: "my order is late" })
 * ```
 *
 * The model never sees `customerId`; a tool that needs it reads
 * `AgentInput.current(Ticket)`.
 */
export const make = <A, I, E = never, R = never>(
  schema: Schema.Codec<A, I>,
  render: (input: A) => Prompt.RawInput | Effect.Effect<Prompt.RawInput, E, R>
): AgentInput<A, I, E, R> => ({ schema, render })

/**
 * The encoded input of the submission running on this fibre, or `None`
 * outside one — or inside one whose agent declares no input.
 *
 * A `Context.Reference`, as `Principal.CurrentPrincipal` is: set by the
 * session around the submission it admits, so a tool handler, a
 * `Permission` policy or a context transform reads it with no plumbing.
 * The *encoded* form is held rather than the decoded value, so that
 * `current` can decode it against the schema it is asked with and hand
 * back a typed value honestly, rather than trusting that whatever is on
 * the fibre is the shape the caller expects.
 */
export const Current = Context.Reference<Option.Option<unknown>>(
  "@doeixd/effect-agent/AgentInput/Current",
  { defaultValue: () => Option.none() }
)

/**
 * The current submission's input, as `input`'s schema decodes it.
 *
 * `None` outside a submission or under an agent without an input. Fails
 * with the schema's own error if the fibre holds an input of another
 * shape -- a tool wired into the wrong agent -- rather than returning it
 * mistyped.
 */
export const current = <A, I>(
  input: AgentInput<A, I, any, any>
): Effect.Effect<Option.Option<A>, Schema.SchemaError> =>
  Effect.flatMap(Current, (encoded) =>
    Option.isNone(encoded)
      ? Effect.succeedNone
      : Effect.map(Schema.decodeUnknownEffect(input.schema)(encoded.value), Option.some)
  )

/** `render`, normalised to an Effect. */
export const rendered = <A, I, E, R>(
  input: AgentInput<A, I, E, R>,
  value: A
): Effect.Effect<Prompt.RawInput, E, R> => {
  const result = input.render(value)
  return Effect.isEffect(result) ? result : Effect.succeed(result)
}
