import { Context } from "effect"
import * as Namespace from "./namespace.js"

/**
 * The id of the `ToolSource` a tool was bound from, as a tool annotation
 * (item 94). Set by `ToolSource.bind` and `bindDiscovered`; read by
 * `Agent.describe`, so a description can say an MCP server's tool came from
 * that server. A plain annotation key, not a defaulted Reference: a tool
 * written by hand has no source, and says so by the key's absence.
 */
export class ToolSourceId extends Context.Service<ToolSourceId, string>()(Namespace.tag("tool-source/ToolSourceId")) {}

/**
 * Mark `tool` as bound from `sourceId`. `annotate` returns the same tool
 * with one more annotation; Effect AI's signature widens it to the
 * structural `Tool<Name, Config, Requirements>`, which is `T` -- the same
 * restatement `Permission.annotate` makes.
 */
export const withSourceId = <T extends { readonly annotate: (key: typeof ToolSourceId, value: string) => unknown }>(
  tool: T,
  sourceId: string
): T => tool.annotate(ToolSourceId, sourceId) as T
