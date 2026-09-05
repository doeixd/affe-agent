import { Context, Effect } from "effect"
import * as Namespace from "./namespace.js"

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
  Namespace.tag("internal/Failpoint"),
  { defaultValue: (): Service => ({ hit: () => Effect.void }) }
)

/**
 * A subsystem's own typed door onto the shared reference.
 *
 * The locations are a closed tuple, so neither a call site nor a test can name
 * a boundary that does not exist: adding one is a deliberate edit to the list,
 * which someone reviews. `qualified` is how a test should name a boundary --
 * a misspelled string literal is the one way back into the failure mode this
 * closure exists to prevent.
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
    /** The name a test arms, checked against the closed set above. */
    qualified,
    /**
     * Every boundary this subsystem declares, qualified, in declaration order.
     *
     * For `Failpoints.covered`: a coverage row iterates this rather than a
     * list a test wrote, so a boundary added here is a boundary the row
     * crashes at -- or fails to reach, which is the finding.
     */
    all: locations.map((location) => qualified(location)) as ReadonlyArray<string>,
    hit: (location: Locations[number]): Effect.Effect<void> =>
      Effect.flatMap(Failpoint, (failpoint) => failpoint.hit(qualified(location)))
  } as const
}
