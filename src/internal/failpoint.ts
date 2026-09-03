import { Context, Effect, Schema } from "effect"

/**
 * A place a durable pass can be made to die, named.
 *
 * Internal: the seam is not part of the public surface, and production never
 * sees it. The default is a no-op `Context.Reference`, so an application that
 * provides nothing pays one context read per boundary and nothing else, and no
 * public signature mentions it -- the same reasoning that keeps
 * `CurrentPrincipal` out of every effect's type.
 *
 * **Why this exists.** Every "what happens if the process dies here" question
 * in `/durable`, `/cluster` and `/relay` was previously answered by reading the
 * code. `test/DurableStorageFaults.test.ts` can make a *store* fail, which is a
 * different question: it exercises error handling, not the window between two
 * durable writes. The relay's own review is the cautionary case -- two real
 * defects in teardown, and a test for them that passed with the fix removed
 * (`docs/plan-failure-paths.md` §3.2).
 *
 * **The naming rule.** A location names the durable *boundary* it sits beside
 * -- `before-persist`, `after-persist` -- never a function or a line. Renaming
 * an internal must not invalidate a test that pins a crash window.
 */

export interface Service {
  /**
   * Called at a named boundary. Returning normally continues; failing, dying
   * or interrupting is how a test simulates a process that stopped here.
   */
  readonly hit: (location: string) => Effect.Effect<void>
}

export const Failpoint = Context.Reference<Service>(
  "@doeixd/effect-agent/internal/Failpoint",
  { defaultValue: (): Service => ({ hit: () => Effect.void }) }
)

/**
 * A subsystem's own typed door onto the shared reference.
 *
 * The locations are a closed tuple, so a call site cannot name a boundary that
 * does not exist and a test cannot pin one that was deleted -- adding a
 * boundary is a deliberate edit to the list, which someone reviews. The
 * `Schema.Literals` is exported alongside for the same closure at runtime,
 * which is what lets a test's own configuration be validated rather than
 * silently ignored when a name is misspelled.
 *
 * Locations are qualified with the subsystem on the way out, so two subsystems
 * may both have a `before-persist` without a test having to disambiguate them
 * by luck.
 */
export const group = <const Locations extends readonly [string, ...Array<string>]>(
  subsystem: string,
  locations: Locations
) => {
  const qualified = (location: Locations[number]) => `${subsystem}:${location}`
  return {
    subsystem,
    locations,
    /** Every location of this group, qualified, for a test that wants the list. */
    all: locations.map((location) => `${subsystem}:${location}`),
    schema: Schema.Literals(locations),
    qualified,
    hit: (location: Locations[number]): Effect.Effect<void> =>
      Effect.flatMap(Failpoint, (failpoint) => failpoint.hit(qualified(location)))
  } as const
}

export type Group<Locations extends readonly [string, ...Array<string>]> = ReturnType<
  typeof group<Locations>
>
