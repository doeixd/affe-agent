import { Context, Option } from "effect"
import type { Effect } from "effect"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as Namespace from "./namespace.js"

/**
 * Where a delegated child's envelopes go when it is asked to forward them.
 *
 * Provided by the harness around each tool handler, bound to the parent's
 * bus, the parent's correlation and this tool call: a child session made
 * inside the handler with `Inherit.events: "parent"` gives every envelope of
 * its own bus to this, and each arrives on the parent's stream wrapped in
 * one `DelegatedEvent` naming the tool and the call (`plan-streaming.md`
 * P3). `None` outside any tool execution, so a child made directly in a test
 * forwards nowhere and says so.
 *
 * Same shape and rule as `CurrentSessionId`: a `Reference` with a `None`
 * default, set by the harness, never carried by a protocol.
 */
export interface Forward {
  (envelope: AgentEventEnvelope): Effect.Effect<void>
}

export const ParentEvents = Context.Reference<Option.Option<Forward>>(
  Namespace.tag("internal/ParentEvents"),
  { defaultValue: () => Option.none() }
)
