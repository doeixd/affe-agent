import { Schema } from "effect"

/**
 * Every reason a refusal can carry, in one place.
 *
 * Hoisted so the nested `more` entries reuse it rather than widening to
 * `Schema.String` -- which would have needed a cast to narrow back on the
 * way out, and a cast in `src/` for something this mechanical is a
 * signature problem, not a fact about the world.
 *
 * Closed on purpose: an executor does not extend it. An exhaustive
 * `switch` on `reason` in a host is worth more than each engine's own
 * vocabulary, so a new engine maps its findings onto these.
 */
const Reason = Schema.Literals([
  "parse-error",
  "unsupported-syntax",
  "blocked-member",
  "not-callable",
  "not-iterable",
  "call-depth",
  "tool-limit",
  "host-value",
  /** A host asked an executor that cannot resume to continue a run. */
  "not-resumable",
  /**
   * The program named a tool that does not exist.
   *
   * Found before the program runs (`internal/validate.ts`), which is the
   * point of it: the interpreter cannot, having never seen the toolkit, so
   * at runtime this arrives only after every call the program already
   * made.
   */
  "unknown-tool",
  /** An engine refused the whole program its own way, before running it. */
  "plan-invalid",
  "timeout",
  "output-limit",
  "internal"
])

/** One further problem from the same pass. */
const Further = Schema.Struct({
  reason: Reason,
  line: Schema.optional(Schema.Number),
  fix: Schema.String
})

/**
 * What the engine says when it refuses a program
 * (`docs/plan-code-mode-engine.md` decision 4: every diagnostic names the
 * fix). The whole value of owning the language over embedding an engine
 * is that a refusal can say "use for...of" instead of iterating zero
 * times -- a diagnostic that only reports a failure has thrown away the
 * reason for owning the interpreter.
 *
 * Diagnostics are the *host's* channel and deliberately not catchable by
 * a program's `try`/`catch`: a program that could swallow "unsupported
 * syntax" or "blocked member" would turn a refusal into a wrong answer.
 * Program-level throws travel separately (`interpret.ts`'s
 * `ProgramThrow`).
 */
export class CodeDiagnostic extends Schema.TaggedError<CodeDiagnostic>()(
  "affe-agent/code/CodeDiagnostic",
  {
    reason: Reason,
    /** 1-based line, when the AST or the parser could say. */
    line: Schema.optional(Schema.Number),
    /** What to do instead. Never empty. */
    fix: Schema.String,
    /**
     * Further problems found in the same pass, when a pass found several
     * (`internal/validate.ts`).
     *
     * Absent for a refusal that is one thing -- a parse error is one
     * error, a limit is one limit -- so the encoded form of every
     * diagnostic that existed before pre-flight is byte-identical, which
     * matters because these cross journals.
     *
     * The first finding stays in `reason`/`line`/`fix` rather than the
     * list becoming the only home: a caller that switches on `reason` is
     * unchanged, and a diagnostic still reads as one sentence.
     */
    more: Schema.optional(Schema.Array(Further))
  }
) {
  override get message() {
    const where = this.line === undefined ? "" : ` (line ${this.line})`
    const rest = this.more === undefined || this.more.length === 0
      ? ""
      : ` (and ${this.more.length} more)`
    return `${this.reason}${where}: ${this.fix}${rest}`
  }
}
