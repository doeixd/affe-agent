import { Schema } from "effect"

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
  "@doeixd/effect-agent/code/CodeDiagnostic",
  {
    reason: Schema.Literals([
      "parse-error",
      "unsupported-syntax",
      "blocked-member",
      "not-callable",
      "not-iterable",
      "call-depth",
      "tool-limit",
      "host-value",
      "timeout",
      "output-limit",
      "internal"
    ]),
    /** 1-based line, when the AST or the parser could say. */
    line: Schema.optional(Schema.Number),
    /** What to do instead. Never empty. */
    fix: Schema.String
  }
) {
  override get message() {
    const where = this.line === undefined ? "" : ` (line ${this.line})`
    return `${this.reason}${where}: ${this.fix}`
  }
}
