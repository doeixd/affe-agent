import { Schema } from "effect"

/**
 * The store failed, or gave back something it could not have written.
 *
 * ## Why this exists
 *
 * The durable stores used to convert every failure into a defect with
 * `Effect.orDie`, so their interfaces read `Effect.Effect<SessionRecord>` --
 * no error channel at all. That is a stronger claim than `unknown` in an error
 * channel, and a false one: there is a database on the other side.
 *
 * Two costs followed, and both were real rather than theoretical.
 *
 * `DurableSubmission` needs to tell "the infrastructure under the agent
 * failed" from "the agent failed", because the first must not be reported to a
 * client as the submission ending. With the error channel emptied, the only
 * way left was to walk the defects and pattern-match their shapes -- checking
 * `_tag === "SqlError"` and, failing that, whether a `name` string *contains*
 * `"SqlError"`. That check reconstructs, unreliably, exactly the information
 * `orDie` threw away.
 *
 * And the durability plan's fault-injection milestone (H4) could not say
 * anything. A wrapper that fails a write, duplicates a record or half-commits
 * produces one observation through an `orDie`d store -- a defect -- so the
 * suite can prove the system noticed and nothing about *how* it degraded.
 * Invariant D7 ("storage failure degrades, it does not corrupt") was
 * untestable by construction.
 *
 * ## What is still a defect
 *
 * Not everything moved. Encoding a value the process just built stays
 * `orDie`: if a `Prompt` we assembled cannot be encoded by its own schema,
 * that is a bug in this library, not a condition a caller can act on. The
 * distinction this type draws is between *our* mistakes and *the world's*.
 *
 * @see `docs/audit-effect-ecosystem.md` E14
 */
export class StorageError extends Schema.TaggedError<StorageError>()(
  "StorageError",
  {
    /** What was being attempted, e.g. `claim`, `getOrCreate`, `decodeHistory`. */
    operation: Schema.String,
    /** The session the operation concerned, where one applies. */
    sessionId: Schema.optional(Schema.String),
    detail: Schema.String
  }
) {
  override get message() {
    const where = this.sessionId === undefined ? "" : ` for session ${this.sessionId}`
    return `Storage operation ${this.operation}${where} failed: ${this.detail}`
  }
}

/**
 * Whether a value is a `StorageError`.
 *
 * Structural rather than `instanceof`, because a store failure can cross a
 * workflow journal and come back as a decoded value rather than the original
 * instance.
 */
export const isStorageError = (u: unknown): u is StorageError =>
  typeof u === "object" &&
  u !== null &&
  (u as { readonly _tag?: unknown })._tag === "StorageError"

/** Render an unknown failure as the `detail` of a `StorageError`. */
export const detailOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  return String(cause)
}
