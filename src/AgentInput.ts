import { Context, Effect, Option, Schema, SchemaGetter } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as WireValue from "./internal/wireValue.js"
import * as PromptWire from "./PromptWire.js"

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
 * `prompt` and `submit` take the value; `steer` and `followUp` still take
 * `Prompt.RawInput`, because they add to a conversation the input already
 * opened rather than opening one, and the value on the fibre stays the
 * submission's for its follow-up runs.
 *
 * **Across a boundary.** The wire carries one shape: the session's encoded
 * input. For an agent with the default input that is the prompt wire, byte
 * for byte what it always was; for a declared input it is the schema's
 * encoded value, bare. The host decodes with the schema the session's agent
 * declares, refusing a mismatch as an invalid request rather than
 * mis-rendering it. `AgentClient.typed(agent)` is the spelling that writes
 * the value and never the wire form. Under `/durable`
 * the encoded value is journalled and re-rendered on replay; an
 * Effect-valued `render` runs there as an activity, so a replay reads the
 * rendering back rather than rendering again. Every other entry point --
 * `Scheduling`, the cluster entity, a `Subagent` tool (whose parameters
 * become the child's schema) -- admits the same way, through one boundary.
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

/** A `Prompt.RawInput`: a string, an iterable of messages, or a `Prompt`. */
const RawInput = Schema.declare(
  (u: unknown): u is Prompt.RawInput => typeof u === "string" || (typeof u === "object" && u !== null)
)

/**
 * The default input: a prompt, in the shape the system already speaks.
 *
 * Every agent has an input (`plan-input-default.md`). One that declares
 * none is asked with `Prompt.RawInput`, and this is that declaration made
 * explicit: the schema is the prompt wire codec every boundary already
 * uses, so the encoded form of a prompt is today's prompt wire byte for
 * byte, and the rendering is the identity. `Agent.make` fills it in when
 * `input` is absent, which is what lets `Input` default to
 * `Prompt.RawInput` instead of `never` -- the `never` was what no generic
 * signature could unify with, and every awkwardness in typed input traced
 * back to it.
 *
 * One value, compared by identity (`isPrompt`), so a boundary that still
 * carries two wire shapes can tell "the default" from "a declared input"
 * without a flag on the definition.
 */
export const prompt: AgentInput<Prompt.RawInput, unknown, never, never> = {
  schema: PromptWire.Prompt.pipe(
    Schema.decodeTo(RawInput, {
      decode: SchemaGetter.transform((decoded: Prompt.Prompt): Prompt.RawInput => decoded),
      encode: SchemaGetter.transform((raw: Prompt.RawInput): Prompt.Prompt => Prompt.make(raw))
    })
  ),
  render: (raw) => raw
}

/** Whether an agent's input is the default prompt rather than a declared shape. */
export const isPrompt = (input: AgentInput<any, any, any, any>): boolean => input === prompt

/**
 * The encoded input of the submission running on this fibre, or `None`
 * outside one.
 *
 * Always set inside a submission: for an agent with the default input it is
 * the encoded prompt, so `None` means exactly "not inside a submission" and
 * nothing else.
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
  "affe-agent/AgentInput/Current",
  { defaultValue: () => Option.none() }
)

/**
 * The current submission's input, as `input`'s schema decodes it.
 *
 * `None` outside a submission. Fails with the schema's own error if the
 * fibre holds an input of another shape -- a tool wired into the wrong
 * agent, or one asking for a ticket under an agent asked with a prompt --
 * rather than returning it mistyped. That is the honest answer in both
 * cases, and the same one.
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

/**
 * Whether a remote input is a raw prompt rather than an already-encoded value.
 *
 * The wire carries one shape -- the session's encoded input, which the host
 * decodes with the session's own schema (`plan-input-default.md` step 3).
 * A caller in-process may still hand a client a `Prompt.RawInput`, and this
 * is how the client tells the two apart before encoding: a string, a
 * `Prompt`, or an iterable of messages is raw; anything else is the encoded
 * form and passes through as it is. That is also why a typed input's schema
 * must encode to an *object* -- a value that encoded to a string or an
 * array would be read as a prompt -- the same rule `AgentOutput` states for
 * its schema, for the same reason.
 */
export const isRaw = (input: unknown): input is Prompt.RawInput =>
  typeof input === "string" ||
  Prompt.isPrompt(input) ||
  (typeof input === "object" && input !== null && Symbol.iterator in input)

/**
 * Encode a value for the wire with the agent's declared input.
 *
 * Encoding a value the signature typed cannot fail except by a schema bug,
 * which dies as one -- the same rule the session applies.
 */
export const encode = <A, I>(input: AgentInput<A, I, any, any>, value: A): Effect.Effect<unknown> =>
  WireValue.encode(input.schema, value)
