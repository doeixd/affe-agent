/**
 * The library's hard ceilings, and the one rule about them.
 *
 * A caller may lower a limit and may not raise it. The point of a bound is that
 * the runtime cannot be made to hold an unbounded amount however the
 * application is configured, and a raisable ceiling is not that.
 *
 * `docs/limits.md` keeps the three distinct bounds apart, and they must stay
 * apart here too: observer lag, tool-progress production, and a tool's terminal
 * result each protect against a different thing.
 */

/** 8 MiB of wire JSON per submission. */
export const TOOL_PROGRESS_BYTES = 8 * 1024 * 1024

const lowerable = (where: string, ceiling: number, requested: number | undefined): number => {
  if (requested === undefined) return ceiling
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error(`${where} must be a positive integer, got ${requested}`)
  }
  // Clamped rather than rejected: a caller asking for more than the ceiling
  // wants "as much as possible", and failing construction over it would be a
  // worse answer than giving them the most the runtime will hold.
  return Math.min(requested, ceiling)
}

/** How much tool progress one submission may publish, in wire bytes. */
export const toolProgressBytes = (requested: number | undefined): number =>
  lowerable("toolProgress.maxBytes", TOOL_PROGRESS_BYTES, requested)

/** 2048 envelopes retained for a one-shot handle's replay. */
export const TRACE_ENVELOPES = 2048

/** 8 MiB of wire JSON retained for a one-shot handle's replay. */
export const TRACE_BYTES = 8 * 1024 * 1024

/** How many envelopes a one-shot handle may retain for replay. */
export const traceEnvelopes = (requested: number | undefined): number =>
  lowerable("traceLimits.envelopes", TRACE_ENVELOPES, requested)

/** How many wire bytes a one-shot handle may retain for replay. */
export const traceBytes = (requested: number | undefined): number =>
  lowerable("traceLimits.bytes", TRACE_BYTES, requested)
