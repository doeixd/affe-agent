import { Schema } from "effect"

/**
 * The store could not do what was asked: the database failed, or a row it
 * wrote earlier no longer decodes. Not the kernel's `StorageError`, which is
 * about session state; this is product metadata.
 */
export class WorkbenchStorageError extends Schema.TaggedError<WorkbenchStorageError>()("WorkbenchStorageError", {
  operation: Schema.String,
  detail: Schema.String
}, { httpApiStatus: 503 }) {}

export const detailOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause) ?? String(cause)

/** Map whatever a store operation failed with, keeping this error as it is. */
export const failedAs = (operation: string) => (cause: unknown): WorkbenchStorageError =>
  cause instanceof WorkbenchStorageError ? cause : new WorkbenchStorageError({ operation, detail: detailOf(cause) })
