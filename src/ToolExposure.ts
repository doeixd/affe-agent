import { Option, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"

/**
 * Which of an agent's tools the model is shown, turn by turn -- as distinct
 * from which it may call (item 93).
 *
 * An agent with a few hundred tools mounted from several sources does not
 * want a few hundred schemas on every request. Three things are kept apart:
 *
 * ```text
 * registered   every tool the toolkit resolves
 *   ↓ visible   what this caller may know exists (a rule over the principal)
 * eligible
 *   ↓ exposed   what this turn's request carries: pinned ∪ selected ∪ protocol tools
 *   ↓ model
 *   ↓ Permission, per call, unchanged
 * ```
 *
 * **Exposure changes what the model sees, never what it may do.** A tool the
 * visibility rule hides is absent everywhere -- not in a request, not in a
 * discovery result -- and pinning it does not bring it back. A call to a tool
 * that is eligible but not exposed this turn is refused, with a
 * `ToolNotExposedError` the model can read, rather than run: the model should
 * discover it first. And every call that does run still goes through
 * `Permission`.
 *
 * Under `progressive`, the model starts with the pinned tools and
 * `discover_tools`. Discovery searches the eligible tools, returns their
 * signatures, and its result *is* the selection: the next turn's request
 * carries what it found. Because the selection is read from the committed
 * discovery result in canonical history, replay, restore and branching rebuild
 * it without discovering again. A new discovery replaces the previous
 * selection rather than adding to it, so exposure stays bounded.
 *
 * Not automatically cheaper: a discovery turn costs a model call, and a tool
 * list that changes between requests can cost a provider's prompt cache. Use
 * it when the eager list is the bigger cost.
 */

/**
 * Whether a caller may know a tool exists. Given the tool's name and the
 * calling principal (`CurrentPrincipal`, `None` outside a host). A pure
 * function: it runs every turn and must not depend on anything else.
 */
export type Visible = (tool: string, principal: Option.Option<string>) => boolean

export type ToolExposure =
  | { readonly _tag: "Eager"; readonly visible: Option.Option<Visible> }
  | {
    readonly _tag: "Progressive"
    readonly visible: Option.Option<Visible>
    /** Always exposed, when visible. */
    readonly pinned: ReadonlyArray<string>
    /** The most tools a request carries, pinned and protocol tools included. */
    readonly maxTools: number
    /** The most tools one discovery returns. */
    readonly maxResults: number
  }

/** Every eligible tool on every request -- today's behaviour. The default. */
export const eager = (options?: { readonly visible?: Visible | undefined }): ToolExposure => ({
  _tag: "Eager",
  visible: Option.fromUndefinedOr(options?.visible)
})

/** Pinned tools and `discover_tools`, then what discovery selects. See the module doc. */
export const progressive = (options: {
  readonly pinned?: ReadonlyArray<string> | undefined
  readonly maxTools?: number | undefined
  readonly maxResults?: number | undefined
  readonly visible?: Visible | undefined
}): ToolExposure => {
  const maxTools = options.maxTools ?? 16
  const maxResults = options.maxResults ?? 8
  if (!Number.isSafeInteger(maxTools) || maxTools < 2) {
    throw new RangeError("ToolExposure.progressive: maxTools must be an integer of at least 2")
  }
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new RangeError("ToolExposure.progressive: maxResults must be a positive integer")
  }
  return {
    _tag: "Progressive",
    visible: Option.fromUndefinedOr(options.visible),
    pinned: options.pinned ?? [],
    maxTools,
    maxResults
  }
}

/** One tool discovery found: enough to call it without a second lookup. */
export const DiscoveredTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** The parameters' JSON Schema, as the provider will be given it. */
  parameters: Schema.Unknown
})

export const Discovery = Schema.Struct({
  tools: Schema.Array(DiscoveredTool),
  /** What the next request will carry beyond the pinned tools. */
  selected: Schema.Array(Schema.String),
  /** Whether more eligible tools matched than were returned. */
  more: Schema.Boolean
})
export type Discovery = typeof Discovery.Type

/** The protocol tool `progressive` injects. Read-only: it changes exposure, and nothing in the world. */
export const DiscoverTools = Tool.make("discover_tools", {
  description:
    "Search the tools you can use but have not been shown, by name or purpose. The tools found are " +
    "available on your next turn; a new search replaces the previous selection. Tools you have been " +
    "shown are already available.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Discovery,
  failure: Schema.String
}).annotate(Tool.Readonly, true)

/** A tool a call named that this turn did not expose, or this caller may not see. */
export class ToolNotExposedError extends Schema.TaggedError<ToolNotExposedError>()(
  "ToolNotExposedError",
  { toolName: Schema.String, toolCallId: Schema.String }
) {
  override get message() {
    return `Tool ${this.toolName} is not available on this turn. Use discover_tools to find it first.`
  }
}

/**
 * The selection the latest committed discovery made, from canonical history.
 * Empty before any discovery. Replay-stable: history is what replay rebuilds.
 */
export const selectionFrom = (history: Prompt.Prompt): ReadonlyArray<string> => {
  for (let index = history.content.length - 1; index >= 0; index--) {
    const message = history.content[index]!
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.name !== DiscoverTools.name || part.isFailure) continue
      const found = Schema.decodeUnknownOption(Discovery)(part.result)
      if (Option.isSome(found)) return found.value.selected
    }
  }
  return []
}

/**
 * The names this turn exposes, or `None` when exposure restricts nothing
 * (eager, and every tool visible). `protocol` are the harness's own tools --
 * the output tool -- which are exposed whenever the exposure is progressive.
 */
export const exposed = (
  exposure: ToolExposure,
  registered: ReadonlyArray<string>,
  protocol: ReadonlyArray<string>,
  principal: Option.Option<string>,
  history: Prompt.Prompt
): Option.Option<ReadonlySet<string>> => {
  const isVisible = (name: string) => Option.match(exposure.visible, {
    onNone: () => true,
    onSome: (visible) => visible(name, principal)
  })
  const eligible = registered.filter(isVisible)
  if (exposure._tag === "Eager") {
    return eligible.length === registered.length ? Option.none() : Option.some(new Set([...eligible, ...protocol]))
  }
  const always = [DiscoverTools.name, ...protocol, ...exposure.pinned.filter((name) => eligible.includes(name))]
  const room = Math.max(0, exposure.maxTools - always.length)
  const selected = selectionFrom(history).filter((name) => eligible.includes(name) && !always.includes(name))
  return Option.some(new Set([...always, ...selected.slice(0, room)]))
}

/** The eligible tools, for discovery to search: never a hidden one. */
export const eligible = <T extends Tool.Any>(
  exposure: ToolExposure,
  tools: ReadonlyArray<T>,
  principal: Option.Option<string>
): ReadonlyArray<T> =>
  Option.match(exposure.visible, {
    onNone: () => tools,
    onSome: (visible) => tools.filter((tool) => visible(tool.name, principal))
  })
