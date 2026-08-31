import * as acorn from "acorn"
import { Result } from "effect"
import { CodeDiagnostic } from "./diagnostics.js"

/**
 * Parse a recovered program (`docs/plan-code-mode-engine.md` step 4).
 *
 * Plain JavaScript, ES2023, as a script whose top level may `return` and
 * `await` -- the program *is* the body of an async function the host
 * runs. TypeScript is deliberately not parsed: v1 answers the research's
 * open question by telling the model to write JavaScript, and when it
 * writes TypeScript anyway the diagnostic says exactly that, instead of a
 * regex strip producing a wrong-but-running program.
 */

const TS_HINTS = [
  /\binterface\s+[A-Za-z_$]/,
  /\btype\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=/,
  /\bas\s+(const\b|[A-Z])/,
  /\bsatisfies\s+[A-Za-z_$]/,
  /[),a-zA-Z0-9_$\]]\s*:\s*(string|number|boolean|unknown|any|void|Promise|Array|Record)\b/
]

const looksLikeTypeScript = (code: string): boolean =>
  TS_HINTS.some((hint) => hint.test(code))

const lineOf = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const loc = (error as { readonly loc?: { readonly line?: unknown } }).loc
  return typeof loc?.line === "number" ? loc.line : undefined
}

export const parse = (code: string): Result.Result<acorn.Program, CodeDiagnostic> => {
  try {
    return Result.succeed(
      acorn.parse(code, {
        ecmaVersion: 2023,
        sourceType: "script",
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true
      })
    )
  } catch (error) {
    const line = lineOf(error)
    const detail = error instanceof Error ? error.message : String(error)
    return Result.fail(
      new CodeDiagnostic({
        reason: "parse-error",
        ...(line === undefined ? {} : { line }),
        fix: looksLikeTypeScript(code)
          ? `this looks like TypeScript -- write plain JavaScript: remove type annotations, interface/type declarations, and "as" casts. Parser said: ${detail}`
          : `the program does not parse: ${detail}`
      })
    )
  }
}
