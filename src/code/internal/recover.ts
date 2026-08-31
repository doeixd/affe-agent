/**
 * Shape recovery for model-written programs
 * (`docs/plan-code-mode-engine.md` step 3).
 *
 * Models wrap answers in code fences, write `export default`, and hand
 * back bare arrow functions -- executor's comment records a 180-second
 * production failure caused by rejecting exactly that. Refusing a
 * program for its wrapping is a wasted turn; unwrapping it is cheap,
 * pure, and independent of the engine.
 *
 * Deliberately *not* here: TypeScript type-syntax stripping. Without a
 * parser, a regex stripper mangles object literals, ternaries and
 * strings into programs that are wrong yet still run -- the silent
 * corruption class this module exists ahead of. Type stripping is step
 * 4's job, where the parser can do it honestly; until then TS syntax is
 * an `UnsupportedSyntax` diagnostic, not a guess.
 *
 * Every applied step is reported, so a diagnostic about the recovered
 * program can say what was unwrapped rather than confusing the model
 * with positions in text it did not write.
 */

export type Recovery = "fence" | "export-default" | "bare-arrow"

export interface Recovered {
  readonly code: string
  /** What was unwrapped, in application order. Empty means verbatim. */
  readonly applied: ReadonlyArray<Recovery>
}

/**
 * A fenced block: ``` with an optional language tag, through the closing
 * fence. Non-greedy, multiline; the tag is discarded whatever it says --
 * a model labelling its code `python` is still handing over the code.
 */
const FENCE = /```[^\n]*\n([\s\S]*?)```/g

/**
 * The whole text is one arrow-function expression.
 *
 * Conservative on purpose: only a text that *begins* with an arrow
 * parameter list and arrow is treated as one, and the rewrite keeps the
 * program intact inside a call -- `return (<arrow>)()`. A program that
 * merely contains an arrow somewhere is left alone; misfiring here would
 * rewrite a correct program, which is worse than not recovering one.
 */
const BARE_ARROW = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/

/**
 * Unwrap what the model wrapped. Pure, total, and honest about what it
 * did; text that needs nothing comes back verbatim with `applied: []`.
 */
export const recover = (text: string): Recovered => {
  const applied: Array<Recovery> = []
  let code = text

  const fences = [...code.matchAll(FENCE)]
  if (fences.length > 0) {
    // Every fenced block, joined: a model that explains between two
    // blocks wrote one program in two parts, and the prose was never
    // code. A single block is the common case and joins to itself.
    code = fences.map((match) => match[1]!).join("\n")
    applied.push("fence")
  }

  code = code.trim()

  const exported = code.match(/^export\s+default\s+/)
  if (exported !== null) {
    code = `return ${code.slice(exported[0].length)}`
    applied.push("export-default")
  } else if (BARE_ARROW.test(code)) {
    code = `return (${code})()`
    applied.push("bare-arrow")
  }

  return { code, applied }
}
