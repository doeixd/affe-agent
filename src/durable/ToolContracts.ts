import { Context, Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { Activity, WorkflowEngine } from "effect/unstable/workflow"
import * as ToolExecution from "../ToolExecution.js"

/**
 * A durable tool contract is part of the persisted program (item 107).
 *
 * A journal records model responses and tool results in the shape a tool had
 * *when they were recorded*, and replay decodes them against whatever the
 * running process has now. An upgrade that changed a tool's parameters or
 * result schema therefore surfaced, at best, as a `SchemaError` with no
 * mention of the upgrade -- and at worst as a recorded value quietly read as
 * something else. So a submission journals a digest of every tool contract
 * it can mention at its first execution, and a replay compares: a recorded
 * tool whose contract changed, or that no longer exists, refuses the replay
 * with a `ToolContractChangedError` naming each tool and both digests.
 *
 * A tool *added* since is not a conflict: nothing recorded refers to it.
 *
 * The digest covers what decoding and execution depend on: the name, the
 * JSON Schema of the parameters, success and failure schemas, and whether the
 * tool must be `Alone` in its turn. Not the description -- rewording what the
 * model reads changes nothing a journal holds.
 */

/** One tool whose recorded contract no longer matches the running one. */
export const ChangedContract = Schema.Struct({
  name: Schema.String,
  recorded: Schema.String,
  /** `null` when the tool is gone. */
  current: Schema.NullOr(Schema.String)
})

export class ToolContractChangedError extends Schema.TaggedError<ToolContractChangedError>()(
  "ToolContractChangedError",
  { tools: Schema.Array(ChangedContract) }
) {
  override get message() {
    return (
      "This submission was recorded under different tool contracts, so it cannot be replayed here: " +
      this.tools
        .map((tool) =>
          tool.current === null
            ? `${tool.name} was removed`
            : `${tool.name} changed (recorded ${tool.recorded.slice(0, 12)}, now ${tool.current.slice(0, 12)})`
        )
        .join("; ") +
      ". Restore the recorded definitions to finish it, or let it fail."
    )
  }
}

/** JSON with object keys sorted at every depth, so equal contracts render equal. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
    ? Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
    : value

/**
 * A schema's JSON Schema, or -- for one that has none -- its AST's printed
 * form, which still changes when the schema does.
 */
const shapeOf = (schema: Schema.Top): unknown => {
  try {
    return Tool.getJsonSchemaFromSchema(schema)
  } catch {
    return { unrepresentable: String(schema.ast) }
  }
}

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

/** The contract's SHA-256, over Web Crypto so it runs wherever the library does. */
export const digestOf = (tool: Tool.Any): Effect.Effect<string> => {
  const contract = canonical({
    name: tool.name,
    parameters: Tool.getJsonSchema(tool),
    success: shapeOf(tool.successSchema),
    failure: shapeOf(tool.failureSchema),
    alone: Context.get(tool.annotations, ToolExecution.Alone)
  })
  const bytes = new TextEncoder().encode(JSON.stringify(contract))
  return Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", bytes)).pipe(Effect.map(hex))
}

/**
 * Journal the contracts of `tools` at this submission's first execution, and
 * on a replay refuse if a recorded one changed or disappeared.
 *
 * Named `contract-digests`, not `tool-…`: that prefix names tool-call
 * activities in the SD3 census.
 */
export const check = (
  tools: ReadonlyArray<Tool.Any>,
  prefix: string
): Effect.Effect<void, ToolContractChangedError, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance> =>
  Effect.gen(function*() {
    const current: Record<string, string> = {}
    for (const tool of tools) current[tool.name] = yield* digestOf(tool)
    const recorded = yield* Activity.make({
      name: `${prefix}contract-digests`,
      success: Schema.Record(Schema.String, Schema.String),
      execute: Effect.succeed(current)
    })
    const changed = Object.keys(recorded)
      .sort()
      .flatMap((name) =>
        current[name] === recorded[name]
          ? []
          : [{ name, recorded: recorded[name]!, current: current[name] ?? null }]
      )
    if (changed.length > 0) return yield* new ToolContractChangedError({ tools: changed })
  })
