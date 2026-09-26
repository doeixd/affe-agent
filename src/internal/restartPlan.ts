import type { Restart, Strategy } from "../sessions/Supervisor.js"

/**
 * The Supervisor's two decisions, stated as pure functions so each is tested
 * as a table rather than through timed child exits (item 128's discipline,
 * applied to `sessions/Supervisor.ts`).
 *
 * The Supervisor's own state stays mutable. The one lock serialises every
 * change, and each change reads the state the last one left. What was
 * tangled was the *rule* for each change, written inline in the loop. The
 * rules are here now.
 */

/**
 * Whether one more restart fits in the window: fewer than `max` inside the
 * last `window` milliseconds. `recent` comes back pruned of anything outside
 * the window. It does not hold `now`: the caller records the restart only once
 * every other check (the budget) has admitted it too.
 */
export const intensity = (
  recent: ReadonlyArray<number>,
  now: number,
  window: number,
  max: number
): { readonly admitted: boolean; readonly recent: ReadonlyArray<number> } => {
  const inside = recent.filter((at) => at > now - window)
  return { admitted: inside.length < max, recent: inside }
}

/**
 * Who restarts with a failed child, in the order the Supervisor acts:
 * `stop` last-started first, then `start` in the spec's order.
 *
 * - `one_for_one`: the child alone.
 * - `one_for_all`: every running sibling is stopped too.
 * - `rest_for_one`: every running sibling started after it.
 *
 * A stopped sibling starts again unless it is `temporary`: a temporary child
 * runs once, and being taken down by a neighbour does not earn it a second
 * start.
 */
export const siblingsOf = (
  strategy: Strategy,
  children: ReadonlyArray<{ readonly id: string; readonly restart: Restart }>,
  failed: string,
  running: (id: string) => boolean
): { readonly stop: ReadonlyArray<string>; readonly start: ReadonlyArray<string> } => {
  const index = children.findIndex((child) => child.id === failed)
  const taken = strategy === "one_for_one"
    ? []
    : children.filter((child, position) =>
      child.id !== failed && running(child.id) && (strategy === "one_for_all" || position > index)
    )
  const again = new Set(taken.filter((child) => child.restart !== "temporary").map((child) => child.id))
  return {
    stop: taken.map((child) => child.id).reverse(),
    start: children.filter((child) => child.id === failed || again.has(child.id)).map((child) => child.id)
  }
}

/** The first `${name}-${n}` no child holds. */
export const freshId = (name: string, taken: ReadonlySet<string>): string => {
  let n = 1
  while (taken.has(`${name}-${n}`)) n += 1
  return `${name}-${n}`
}
