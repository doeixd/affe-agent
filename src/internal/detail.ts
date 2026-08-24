/**
 * Render an unknown failure as a human-readable detail string.
 *
 * Internal: `StorageError` is public vocabulary, but the helper that fills in
 * its `detail` is not something a caller needs, and exporting it from
 * `Errors.ts` put it in the library's public surface for no reason.
 */
export const detailOf = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  return String(cause)
}
