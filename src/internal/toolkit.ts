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

/**
 * Combine two handled toolkits into one, by delegation.
 *
 * Effect AI composes toolkits before their handlers are bound; once bound, a
 * `WithHandler` is a closed value. Adding a tool to an agent that already has
 * some therefore merges at the `handle` level: the name decides which
 * toolkit answers. Solved once here, so every authoring path shares it --
 * `Agent.withTools` at definition time, and the output tool the turn injects.
 */
export const mergeHandled = <
  A extends Record<string, Tool.Any>,
  B extends Record<string, Tool.Any>
>(
  left: Toolkit.WithHandler<A>,
  right: Toolkit.WithHandler<B>
): Toolkit.WithHandler<A & B> => {
  for (const name of Object.keys(right.tools)) {
    if (Object.hasOwn(left.tools, name)) {
      throw new Error(`Agent: duplicate tool name "${name}"`)
    }
  }
  const tools = { ...left.tools, ...right.tools } as A & B
  // Dispatch by own name only (`Object.hasOwn`): `"toString" in right.tools`
  // would be true of any object and route a tool of that name wrongly. The
  // `any` on the two `handle` calls is this module's documented structural
  // cast: each side's `handle` is typed for its own record, and the merged
  // signature is exactly their union by name.
  const handle = ((name: string, params: unknown, toolCallId?: string) =>
    Object.hasOwn(right.tools, name)
      ? (right.handle as any)(name, params, toolCallId)
      : (left.handle as any)(name, params, toolCallId)) as Toolkit.WithHandler<
    A & B
  >["handle"]
  return { tools, handle }
}
