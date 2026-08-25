import { Effect } from "effect"
import { StorageError } from "../src/Errors.js"
import type * as DurableChannels from "../src/durable/DurableChannels.js"
import type * as DurableSessionStore from "../src/durable/DurableSessionStore.js"

/**
 * Store decorators for D7 -- storage failure degrades, it does not corrupt.
 *
 * Shared rather than copied, because the same shapes are needed at every path
 * in the durability matrix: the store on its own, the durable client over it,
 * the HTTP adapter over that, and the cluster entity beside it. A claim about
 * what a storage failure does to a *deployment* is only worth making if it is
 * made the same way at each layer.
 *
 * One decorator per operation, rather than one taking the operation's name.
 * The generic version reads better and cannot be written without a cast: an
 * assignment through a generic key has to satisfy every member of the union,
 * which a single failing function does not. Naming the key in an object
 * literal types exactly, and the parameters come from the interface rather
 * than being widened to `unknown` and asserted back.
 */

export const detail = "the disk is on fire"

export const failure = (operation: string) =>
  new StorageError({ operation, detail })

/**
 * Whether the operation runs before it fails.
 *
 * **`after` is the one that means something.** A decorator that replaces the
 * operation with a bare failure never executes the mutation under test, so
 * "no claim was left behind" is true of a store nothing has touched -- a
 * tautology wearing the clothes of a durability test, and what made the D7
 * row unearned when it was first written.
 *
 * Running the operation and then failing is the real partial failure: the
 * caller is told it failed while the write has already landed. If the store is
 * transactional the state is unchanged and the assertions hold; if it is not,
 * they fail, and that is the finding.
 *
 * `before` is still right where the subject is genuinely a refused call --
 * the *shape* of the error channel, say, rather than what a half-done write
 * leaves behind.
 */
export type When = "before" | "after"

const refuse = <A, E>(
  when: When,
  operation: string,
  real: Effect.Effect<A, E>
): Effect.Effect<never, StorageError> =>
  when === "before"
    ? Effect.fail(failure(operation))
    : Effect.andThen(
      // Ignored, because what happens to *this* call's result is not the
      // question: the caller is about to be told it failed either way.
      Effect.ignore(real),
      Effect.fail(failure(operation))
    )

/** A store whose `claim` fails. */
export const breakingClaim = (
  inner: DurableSessionStore.DurableSessionStore,
  when: When
): DurableSessionStore.DurableSessionStore => ({
  ...inner,
  claim: (sessionId, submission) =>
    refuse(when, "claim", inner.claim(sessionId, submission))
})

/** A store whose `finish` fails. */
export const breakingFinish = (
  inner: DurableSessionStore.DurableSessionStore,
  when: When
): DurableSessionStore.DurableSessionStore => ({
  ...inner,
  finish: (sessionId, submissionId, history) =>
    refuse(when, "finish", inner.finish(sessionId, submissionId, history))
})

/** A store whose `get` fails. */
export const breakingGet = (
  inner: DurableSessionStore.DurableSessionStore,
  when: When
): DurableSessionStore.DurableSessionStore => ({
  ...inner,
  get: (sessionId) => refuse(when, "get", inner.get(sessionId))
})

/**
 * A channels store whose `offerIfOpen` fails.
 *
 * The cluster entity's storage is this one, not the session store: steering
 * and follow-ups are offers against a key gated by the admission marker. So
 * D7 on the `/cluster` path is asked here.
 */
export const breakingOfferIfOpen = (
  inner: DurableChannels.Store,
  when: When
): DurableChannels.Store => ({
  ...inner,
  offerIfOpen: (key, input, gateKey) =>
    refuse(when, "offerIfOpen", inner.offerIfOpen(key, input, gateKey))
})
