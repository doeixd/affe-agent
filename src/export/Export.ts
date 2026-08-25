import { DateTime, Effect, Option, Schema } from "effect"
import type { Prompt } from "effect/unstable/ai"
import * as AgentSession from "../AgentSession.js"
import type { AgentBusyError, AgentClosedError } from "../Errors.js"
import * as Redaction from "../redaction/Redaction.js"

/**
 * A transcript that leaves the process.
 *
 * **This is not `AgentSession.Snapshot`, and conflating them would spoil
 * both.** A snapshot is the *restore contract*: the minimum needed to rebuild
 * a live session inside a process that already knows which agent, model and
 * tools are involved. Its docstring is emphatic that it is "deliberately only
 * the conversation", and nothing here changes it.
 *
 * An export is read somewhere else -- a different build, a different machine, a
 * person, a test six months from now -- and none of that context is available
 * to whoever opens it. So an export has to say what it is. Bolting that onto
 * `Snapshot` would tax every restore with data restore does not need; this is
 * an envelope that *contains* a snapshot instead.
 */

/**
 * The format's version.
 *
 * Bumped when a decoder written against an older version would misread a
 * newer file rather than merely miss a field. A format without a version is a
 * format that can only be written once.
 */
export const VERSION = 1

/**
 * Where a transcript came from.
 *
 * **Advisory, and deliberately so.** The session-tree research established
 * that a snapshot is not bound to the agent that produced it and that types
 * cannot fix that -- `Snapshot` is Schema-defined precisely so it can be
 * serialised, and no phantom parameter survives a database. This is the
 * runtime half of the answer: recording the tool names means an import can
 * *explain* that a transcript calling `edit_file` is being restored into an
 * agent with no such tool. It does not prevent it, and it must never be
 * presented as though it did.
 */
export const Provenance = Schema.Struct({
  /** The library version that wrote the file. */
  harnessVersion: Schema.String,
  agent: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      /**
       * A hash, not the instructions.
       *
       * Enough to notice that two transcripts ran under different prompts,
       * without publishing a system prompt that may be proprietary or may
       * itself contain something private.
       */
      instructionsHash: Schema.optional(Schema.String)
    })
  ),
  model: Schema.optional(
    Schema.Struct({
      provider: Schema.String,
      modelId: Schema.String
    })
  ),
  /** Tool names only. What the transcript may refer to, not what they do. */
  tools: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The working directory, when the caller asks for it.
   *
   * Off by default, and that is a decision rather than an oversight: an
   * absolute path routinely contains a username, and the whole point of an
   * export is that it goes somewhere else. Pi records it unconditionally; we
   * make it opt-in because the first thing anyone does with an export is paste
   * it into a bug report.
   */
  cwd: Schema.optional(Schema.String),
  /**
   * Lineage: the session or node this one continued from.
   *
   * Both halves optional, because lineage can be known either way and often
   * only one is. A tree export knows the parent *node*; a session that was
   * forked from another knows the parent *session*. `sessionId` used to be
   * required, so the tree export filled it with the parent node's id -- which
   * is not a session id, and is exactly the field a reader lines up against
   * another export's `sessionId`. Saying nothing is better than saying
   * something false about the one field whose job is to be trusted.
   */
  parent: Schema.optional(
    Schema.Struct({
      sessionId: Schema.optional(Schema.String),
      nodeId: Schema.optional(Schema.String)
    })
  )
})
export type Provenance = typeof Provenance.Type

/**
 * A self-describing transcript.
 *
 * The snapshot is embedded unchanged, so restoring from an export is exactly
 * restoring from a snapshot -- the envelope adds context and takes nothing
 * away.
 */
export const Export = Schema.Struct({
  version: Schema.Number,
  /** When the file was written, in epoch milliseconds. */
  exportedAt: Schema.Number,
  session: AgentSession.Snapshot,
  provenance: Provenance
})
export type Export = typeof Export.Type

/**
 * An export could not be read.
 *
 * A version this build does not know is refused *here*, by name, rather than
 * failing three fields later on something that happens to be missing -- which
 * is the failure mode a version exists to prevent.
 */
export class ExportError extends Schema.TaggedError<ExportError>()(
  "@doeixd/effect-agent/export/ExportError",
  {
    reason: Schema.Literals(["unsupported-version", "malformed"]),
    detail: Schema.String,
    /** The version found, when one was. */
    found: Schema.optional(Schema.Number)
  }
) {
  override get message() {
    return this.reason === "unsupported-version"
      ? `Cannot read an export written at version ${this.found}: this build reads version ${VERSION}`
      : `Malformed export: ${this.detail}`
  }
}

/**
 * Wrap a snapshot for the world outside.
 *
 * `exportedAt` is read from the `Clock` rather than `Date.now`, so a test can
 * fix it -- which is what makes two exports of one session byte-identical and
 * therefore diffable when they are committed as fixtures.
 */
export const of = (
  session: AgentSession.Snapshot,
  provenance: Provenance
): Effect.Effect<Export> =>
  Effect.map(DateTime.now, (now) => ({
    version: VERSION,
    exportedAt: DateTime.toEpochMillis(now),
    session,
    provenance
  }))

/**
 * Export a live session.
 *
 * Idle only, inheriting `snapshot`'s rule and for its reason: a running
 * session's history is mid-flight, and an export taken then would record a
 * conversation that never existed. IE4 -- this reads and changes nothing.
 */
export const ofSession = (
  session: AgentSession.AgentSession<any, any>,
  provenance: Provenance
): Effect.Effect<Export, AgentBusyError | AgentClosedError> =>
  Effect.flatMap(AgentSession.snapshot(session), (snapshot) => of(snapshot, provenance))

const decodeExport = Schema.decodeUnknownEffect(Export)

/**
 * Read an export, refusing a version this build does not understand.
 *
 * The version is checked *before* the rest is decoded. Decoding first would
 * report a newer file as a missing field, which sends the reader looking for a
 * bug in their data rather than telling them to upgrade.
 */
export const decode = (value: unknown): Effect.Effect<Export, ExportError> =>
  Effect.suspend(() => {
    const version = (value as { version?: unknown } | null)?.version
    if (typeof version !== "number") {
      return Effect.fail(
        new ExportError({
          reason: "malformed",
          detail: "no version field, so this is not an export"
        })
      )
    }
    if (version !== VERSION) {
      return Effect.fail(
        new ExportError({ reason: "unsupported-version", detail: "", found: version })
      )
    }
    return decodeExport(value).pipe(
      Effect.mapError((error) =>
        new ExportError({ reason: "malformed", detail: error.message, found: version })
      )
    )
  })

const encodeExport = Schema.encodeUnknownEffect(Export)

/**
 * Write an export as JSON text.
 *
 * Keys are emitted in a fixed order rather than whatever the encoder produced.
 * Two exports of one session have to be byte-identical or every fixture update
 * is an unreadable diff -- and key order is the part of that nobody notices
 * until it bites.
 *
 * **Redaction happens here, at the boundary, and nowhere earlier.** This is the
 * moment the transcript stops being a value in a process and becomes text that
 * can be pasted into a bug report; redacting when the envelope is *built*
 * would leave every `Export` value in memory a differently-redacted thing
 * depending on who made it. Applied to the encoded form, so it reaches inside
 * tool results, truncation banners and call parameters alike -- see
 * `Redaction.deep` for why partial coverage is the failure mode that matters.
 *
 * The default is `Redaction.none`, and that is documented rather than
 * implied: a caller should have to know that nothing is being removed.
 */
export const encode = (
  self: Export,
  options?: { readonly redact?: Redaction.Redaction | undefined }
): Effect.Effect<string, ExportError> =>
  encodeExport(self).pipe(
    Effect.mapError((error) => new ExportError({ reason: "malformed", detail: error.message })),
    Effect.flatMap((encoded) => {
      const redaction = options?.redact ?? Redaction.none
      const redacted = Redaction.deep(encoded, redaction)
      /**
       * Check that the redaction produced an export, not wreckage.
       *
       * `deep` rewrites *every* string, and some of the strings in an encoded
       * transcript are structure: a message's `"user"` role, a part's
       * `"text"` type, an `Option`'s tag. A rule as ordinary as
       * `literal("user")` -- a username is exactly the sort of thing someone
       * redacts -- rewrote those too, and the result was a file that no
       * longer parsed. Silently.
       *
       * Decoding it back is what turns that into an answer. It costs one
       * decode on a path that already encodes and stringifies, and it means a
       * redacted export either round-trips or fails loudly, never neither.
       *
       * Structure-aware redaction would be better still -- it would let the
       * rule apply and keep the document -- but it is a schema walk, and the
       * property that matters is that nothing corrupt is ever handed back.
       */
      return decode(redacted).pipe(
        Effect.mapError(() =>
          new ExportError({
            reason: "malformed",
            detail: "the redaction rewrote structure, not just content:" +
              " the redacted transcript no longer decodes." +
              " Narrow the rule so it cannot match a role, a part type or a tag."
          })
        ),
        Effect.as(JSON.stringify(sorted(redacted), null, 2))
      )
    })
  )

/** Recursively order object keys, leaving arrays alone. */
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== "object") return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return Object.fromEntries(entries.map(([key, nested]) => [key, sorted(nested)]))
}

/** Read an export from JSON text. */
export const parse = (text: string): Effect.Effect<Export, ExportError> =>
  Effect.suspend(() => {
    try {
      return decode(JSON.parse(text))
    } catch (cause) {
      return Effect.fail(
        new ExportError({
          reason: "malformed",
          detail: cause instanceof Error ? cause.message : String(cause)
        })
      )
    }
  })

/**
 * The conversation, for restoring.
 *
 * Named rather than reached through `.session.history` so that where the
 * history lives inside the envelope stays this module's business.
 */
export const historyOf = (self: Export): Prompt.Prompt => self.session.history

/**
 * What an import should warn about.
 *
 * Advisory, per `Provenance`. It answers "will this transcript make sense
 * here", and the honest answer is a list of names that are mentioned and
 * absent -- not a verdict.
 */
export const missingTools = (
  self: Export,
  available: ReadonlyArray<string>
): ReadonlyArray<string> =>
  Option.fromNullishOr(self.provenance.tools).pipe(
    Option.map((tools) => tools.filter((tool) => !available.includes(tool))),
    Option.getOrElse(() => [] as ReadonlyArray<string>)
  )
