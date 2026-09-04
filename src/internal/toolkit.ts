import { Effect, Option } from "effect"
import type { Tool, Toolkit } from "effect/unstable/ai"

/**
 * A toolkit input that says what it holds before it is resolved.
 *
 * Upstream `Toolkit` is already an Effect with a `tools` property, and this
 * keeps that shape through the harness's own lowering: `Agent.toolkit`,
 * `Agent.make({ tools })` and `withTools` all build from a static list, so
 * the Effect they return can carry it. A toolkit resolved from runtime state
 * is a bare Effect and declares nothing, which is the honest answer.
 *
 * The declared record is exactly what the Effect resolves to. `withTools`
 * merges the two records the same way `mergeHandled` merges the toolkits, so
 * the declaration cannot drift from the resolution.
 */
export interface Declared<Tools extends Record<string, Tool.Any>, E, R>
  extends Effect.Effect<Toolkit.WithHandler<Tools>, E, R> {
  readonly tools: Tools
}

/** Attach the static record to a toolkit Effect. */
export const declare = <Tools extends Record<string, Tool.Any>, E, R>(
  effect: Effect.Effect<Toolkit.WithHandler<Tools>, E, R>,
  tools: Tools
): Declared<Tools, E, R> => Object.assign(effect, { tools })

/**
 * The tools a toolkit input declares, if it declares them.
 *
 * `Some` for a handled toolkit value and for a `Declared` Effect; `None` for
 * an Effect that will only say what it holds once it has run. Anything that
 * wants to inspect an agent's tools before the agent runs -- a wiring check,
 * a listing -- reads this, so the "can we know yet?" question is answered in
 * one place.
 */
export const declaredTools = <Tools extends Record<string, Tool.Any>, E, R>(
  input: Toolkit.WithHandler<Tools> | Effect.Effect<Toolkit.WithHandler<Tools>, E, R>
): Option.Option<Tools> =>
  "tools" in input && typeof input.tools === "object" && input.tools !== null
    ? Option.some(input.tools as Tools)
    : Option.none()

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
