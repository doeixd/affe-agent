import { Context } from "effect"
import * as Namespace from "./namespace.js"

/**
 * Whether this fibre is running a durable tool call's handler -- inside an
 * activity (item 113). Set by `DurableToolkit` around the handler it
 * journals; read by `DurableElicitation`, which cannot suspend the workflow
 * from there.
 *
 * A `Reference` defaulting to `false` because absence is exactly "not in a
 * durable tool call": only `DurableToolkit` raises it.
 */
export const InsideToolActivity = Context.Reference<boolean>(
  Namespace.tag("internal/InsideToolActivity"),
  { defaultValue: () => false }
)
