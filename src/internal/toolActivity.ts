/**
 * Activity identity for durable tool calls.
 *
 * Internal: not part of the public surface. It lives here so the ordering
 * property below can be tested directly, because it is the kind of property
 * that an end-to-end test can pass by luck — the scheduler has to actually
 * interleave two calls differently for the hazard to show, and nothing makes
 * it do that on demand.
 */

/**
 * How many times this exact call has been seen.
 *
 * A provider is only obliged to make tool call ids unique within a single
 * response, so the id alone cannot identify an activity: a model that reused
 * one across turns would collide, and the later call would silently replay the
 * earlier result instead of executing.
 *
 * The obvious fix — a global counter, incremented per call — is wrong once a
 * turn's tools run concurrently, which PLAN §17 says they do. The counter is
 * read at call time, so two tools racing to start take their ordinals in
 * whatever order the scheduler picked. If replay picks the other order, each
 * call looks up an activity belonging to its sibling: at best the journal entry
 * is missed and the tool runs a second time, at worst the wrong result returns.
 *
 * Counting occurrences *per call* removes ordering from the identity entirely.
 * Within a turn the ids are distinct, so every call is occurrence 0 however the
 * scheduler interleaves them; across turns a reused id increments, and turns
 * are sequential, so that stays deterministic.
 */
export const nextOccurrence =
  (name: string, id: string) =>
  (seen: Map<string, number>): [number, Map<string, number>] => {
    const key = `${name}-${id}`
    const index = seen.get(key) ?? 0
    const next = new Map(seen)
    next.set(key, index + 1)
    return [index, next]
  }

/** The activity name for a tool call, given its occurrence. */
export const activityName = (
  occurrence: number,
  name: string,
  id: string
): string => `tool-${occurrence}-${name}-${id}`
