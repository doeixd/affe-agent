import { Effect } from "effect"
import type { Tool, Toolkit } from "effect/unstable/ai"

/**
 * Resolve a toolkit that is either a plain value or an `Effect` (the form
 * resolved per turn, so capabilities can vary with runtime state).
 *
 * Shared by the definition builder (`Agent.withToolkit`, which keeps the `E`/`R`)
 * and the turn executor (`AgentTurn`, which discharges them through the captured
 * session environment) so the "is it an Effect?" dispatch lives in one place.
 */
export const resolveToolkitInput = <Tools extends Record<string, Tool.Any>, E, R>(
  input: Toolkit.WithHandler<Tools> | Effect.Effect<Toolkit.WithHandler<Tools>, E, R>
): Effect.Effect<Toolkit.WithHandler<Tools>, E, R> =>
  Effect.isEffect(input) ? input : Effect.succeed(input)
