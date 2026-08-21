/**
 * Configuration numbers that only make sense as positive integers.
 *
 * These are read once, at construction, and then govern a loop or a cache for
 * the life of the process. `maxTurns(0)` is a run that cannot take a turn;
 * `maxTurns(-1)` is the same with a more confusing symptom; `maxTurns(2.5)`
 * compares against a turn counter that will never equal it. All three are
 * mistakes at the call site, and all three currently produce behaviour that
 * looks like a bug somewhere else entirely.
 *
 * Failing loudly here costs one comparison and turns a mystified debugging
 * session into a stack trace pointing at the wrong argument.
 */
export const positiveInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer, got ${String(value)}`
    )
  }
  return value
}
