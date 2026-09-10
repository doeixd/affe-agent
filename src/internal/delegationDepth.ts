import { Context } from "effect"
import * as Namespace from "./namespace.js"

/**
 * How many delegations deep the current fibre is: `0` in a top-level agent,
 * `1` inside a subagent's run, and so on. Set by `Subagent` around the child
 * it opens and read by the next delegation, which refuses past its
 * `maxDepth` (item 111).
 *
 * A `Reference` defaulting to `0` because absence is exactly "not delegated":
 * the count is only ever raised by the code that delegates, never carried by a
 * protocol, the same rule as `CurrentSessionId`.
 */
export const DelegationDepth = Context.Reference<number>(
  Namespace.tag("internal/DelegationDepth"),
  { defaultValue: () => 0 }
)
