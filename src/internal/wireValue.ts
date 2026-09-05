import { Effect, Schema } from "effect"

/**
 * A value that crosses a wire as JSON and is decoded by the receiver with a
 * schema *it* declares.
 *
 * Three seams carry one: a submission's input (`AgentProtocol.Input`,
 * decoded by the host with the session's agent's input schema), a declared
 * output's value (`RemoteResult.value`, decoded by `AgentClient.typedSession`
 * with the agent's output schema) and an elicitation's `detail`
 * (`Schema.Unknown` on the event, decoded by whoever answers against
 * `Permission.ApprovalDetail`). Nothing on the wire names the schema, and
 * that is the point: the receiver already knows what it expects, so a
 * published schema would only be a second source of truth that could drift.
 * (`plan-after-seams.md` 2b.4.)
 *
 * The rule, once. **Encoding dies; decoding fails.** A value being encoded
 * came from this side's own run, checked against this side's own schema, so
 * one that will not encode is a bug here and nothing a caller could act on.
 * A value being decoded is the far end's claim -- a different version of the
 * agent, a different agent behind the same id, a client that guessed -- so
 * one that will not decode is a fact about the far end, and each seam maps
 * it to the error that says so: `AgentInvalidRequestError` at a host,
 * `AgentProtocolCodecError` at a client, the schema's own error on a fibre.
 * `AgentA2A.typed` drew this line first, attributing a bad result to the
 * peer as `BAD_RESULT`.
 */

/** Encode a value with the schema that typed it. Dies on failure: see the module note. */
export const encode = <A, I>(schema: Schema.Codec<A, I>, value: A): Effect.Effect<unknown> =>
  Effect.orDie(Schema.encodeUnknownEffect(schema)(value))

/** Decode a value the far end sent, with the schema this side declares. Fails on failure: see the module note. */
export const decode = <A, I>(schema: Schema.Codec<A, I>, encoded: unknown): Effect.Effect<A, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(schema)(encoded)
