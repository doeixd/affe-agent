import { Tool } from "effect/unstable/ai"

/**
 * Signatures, the budgeted catalog, and deterministic search: the
 * interpreter-free half of code mode
 * (`docs/research-code-mode.md` §5.4 step 1).
 *
 * The premise of code mode is that a large tool catalog should not sit in
 * the prompt -- which is only honest if the model can still *find* tools.
 * This module is that answer on its own, useful before any program ever
 * runs: `bindDiscovered` over a large plugin set needs it today.
 *
 * Three rules carried over from the research deliberately:
 *
 * - **Every namespace is always listed with its tool count**, whatever the
 *   budget; only full signatures are budgeted.
 * - **Round-robin across namespaces**: each round, every namespace with
 *   un-inlined tools tries to place its next-cheapest signature, so every
 *   namespace gets some representation before any gets everything.
 * - **The catalog states its own completeness** -- `COMPLETE list` vs
 *   `PARTIAL - N of M shown`, and `(3 tools, 1 shown)` per namespace -- so
 *   the model knows whether to search.
 *
 * Search is additive field-weighted scoring with no embeddings and no
 * model call, and its results carry the *same* generated signature as the
 * inline catalog, so no second lookup is needed.
 */

/** Anything that groups tools under names: a `Toolkit.WithHandler`, or less. */
export interface ToolGroup {
  readonly tools: Readonly<Record<string, Tool.Any>>
}

/** One tool, addressed and rendered. */
export interface Entry {
  readonly namespace: string
  readonly name: string
  /** A usable JavaScript expression: `tools.github.list_issues`. */
  readonly path: string
  readonly description: string | undefined
  /** The JSDoc-annotated TypeScript signature. */
  readonly signature: string
  /** `chars/4`, the same heuristic the budget uses. */
  readonly tokens: number
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** `tools.orders.lookup`, or `tools.context7["resolve-library-id"]`. */
export const pathOf = (namespace: string, name: string): string => {
  const segment = (value: string) =>
    IDENTIFIER.test(value) ? `.${value}` : `[${JSON.stringify(value)}]`
  return `tools${segment(namespace)}${segment(name)}`
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Render a JSON-schema node as a TypeScript type expression.
 *
 * Deliberately shallow where honesty demands it: an unconstrained or
 * unrecognised node renders as `unknown` rather than a guess, and depth is
 * bounded so a pathological schema cannot make a signature the size of the
 * catalog it was meant to shrink.
 */
const typeOf = (schema: unknown, depth: number): string => {
  if (!isObject(schema) || depth > 4) return "unknown"
  const enumValues = schema["enum"]
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ")
  }
  const constValue = schema["const"]
  if (constValue !== undefined) return JSON.stringify(constValue)
  const anyOf = schema["anyOf"] ?? schema["oneOf"]
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const members = [...new Set(anyOf.map((member) => typeOf(member, depth + 1)))]
    // Effect's Number codec admits "Infinity"/"-Infinity"/"NaN" as wire
    // sentinels for the same decoded number; a signature is about the
    // decoded type, so the sentinels collapse into `number` rather than
    // widening every numeric field's rendering.
    const sentinels = new Set(['"Infinity"', '"-Infinity"', '"NaN"'])
    const isSentinelOnly = (member: string) =>
      member.split(" | ").every((part) => sentinels.has(part))
    const collapsed = members.includes("number")
      ? members.filter((member) => !isSentinelOnly(member))
      : members
    return collapsed.join(" | ")
  }
  const type = schema["type"]
  if (type === "string") return "string"
  if (type === "number" || type === "integer") return "number"
  if (type === "boolean") return "boolean"
  if (type === "null") return "null"
  if (type === "array") return `Array<${typeOf(schema["items"], depth + 1)}>`
  if (type === "object") {
    const properties = schema["properties"]
    if (!isObject(properties) || Object.keys(properties).length === 0) {
      return "Record<string, unknown>"
    }
    const required = new Set(
      Array.isArray(schema["required"])
        ? schema["required"].filter((name): name is string => typeof name === "string")
        : []
    )
    const members = Object.entries(properties).map(([name, member]) => {
      const key = IDENTIFIER.test(name) ? name : JSON.stringify(name)
      return `${key}${required.has(name) ? "" : "?"}: ${typeOf(member, depth + 1)}`
    })
    return `{ ${members.join(", ")} }`
  }
  return "unknown"
}

/** The JSDoc lines a property earns: its description, and its default. */
const jsdocOf = (member: unknown): ReadonlyArray<string> => {
  if (!isObject(member)) return []
  const lines: Array<string> = []
  if (typeof member["description"] === "string" && member["description"] !== "") {
    lines.push(...member["description"].split("\n"))
  }
  if (member["default"] !== undefined) {
    lines.push(`@default ${JSON.stringify(member["default"])}`)
  }
  return lines
}

const renderJsdoc = (lines: ReadonlyArray<string>, indent: string): string =>
  lines.length === 0
    ? ""
    : lines.length === 1
    ? `${indent}/** ${lines[0]} */\n`
    : `${indent}/**\n${lines.map((line) => `${indent} * ${line}`).join("\n")}\n${indent} */\n`

/**
 * The JSDoc-annotated TypeScript signature for one tool.
 *
 * Constraints TypeScript cannot express ride along as tags (`@default`);
 * field descriptions come from the schema's own annotations. If the
 * repo's tools do not annotate, the signature is accurate and terse --
 * which is the open question the research names, answered by annotating
 * the tools, not by inventing text here.
 */
export const signatureOf = (namespace: string, tool: Tool.Any): string => {
  const schema = Tool.getJsonSchema(tool)
  const head = tool.description === undefined || tool.description === ""
    ? ""
    : renderJsdoc(tool.description.split("\n"), "")
  const path = pathOf(namespace, tool.name)
  if (!isObject(schema) || !isObject(schema["properties"]) || Object.keys(schema["properties"]).length === 0) {
    return `${head}${path}(): Promise<unknown>`
  }
  const properties = schema["properties"]
  const required = new Set(
    Array.isArray(schema["required"])
      ? (schema["required"] as ReadonlyArray<unknown>).filter((name): name is string => typeof name === "string")
      : []
  )
  const members = Object.entries(properties).map(([name, member]) => {
    const key = IDENTIFIER.test(name) ? name : JSON.stringify(name)
    const doc = renderJsdoc(jsdocOf(member), "  ")
    return `${doc}  ${key}${required.has(name) ? "" : "?"}: ${typeOf(member, 1)},`
  })
  return `${head}${path}(input: {\n${members.join("\n")}\n}): Promise<unknown>`
}

/** The `chars/4` heuristic, everywhere the budget is measured. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

const entryOf = (namespace: string, tool: Tool.Any): Entry => {
  const signature = signatureOf(namespace, tool)
  return {
    namespace,
    name: tool.name,
    path: pathOf(namespace, tool.name),
    description: tool.description,
    signature,
    tokens: estimateTokens(signature)
  }
}

/** Every tool of every namespace, rendered once. Namespaces and names sorted. */
export const entries = (
  namespaces: Readonly<Record<string, ToolGroup>>
): ReadonlyArray<Entry> =>
  Object.keys(namespaces)
    .sort()
    .flatMap((namespace) =>
      Object.values(namespaces[namespace]!.tools)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tool) => entryOf(namespace, tool))
    )

export interface Catalog {
  /** What goes in the prompt. */
  readonly text: string
  readonly complete: boolean
  /** The signatures that made it under the budget, in placement order. */
  readonly inlined: ReadonlyArray<Entry>
  /** Everything, for the host's own bookkeeping and for `search`. */
  readonly all: ReadonlyArray<Entry>
}

/**
 * The token-budgeted catalog.
 *
 * Every namespace is always listed with its count; signatures are placed
 * round-robin, cheapest-next per namespace, and a namespace whose next
 * signature does not fit drops out of the rotation while the others
 * continue. The header states completeness, so a model reading a PARTIAL
 * catalog knows to search rather than conclude a tool does not exist.
 */
export const catalog = (
  namespaces: Readonly<Record<string, ToolGroup>>,
  options?: { readonly budgetTokens?: number | undefined }
): Catalog => {
  const budget = options?.budgetTokens ?? 2_000
  const all = entries(namespaces)
  const byNamespace = new Map<string, Array<Entry>>()
  for (const entry of all) {
    const held = byNamespace.get(entry.namespace) ?? []
    held.push(entry)
    byNamespace.set(entry.namespace, held)
  }
  // Cheapest-next within each namespace.
  for (const held of byNamespace.values()) {
    held.sort((left, right) => left.tokens - right.tokens)
  }

  const inlined: Array<Entry> = []
  let spent = 0
  const rotation = [...byNamespace.keys()].sort()
  const cursor = new Map(rotation.map((namespace) => [namespace, 0]))
  let active = new Set(rotation)
  while (active.size > 0) {
    const next = new Set<string>()
    for (const namespace of rotation) {
      if (!active.has(namespace)) continue
      const held = byNamespace.get(namespace)!
      const at = cursor.get(namespace)!
      if (at >= held.length) continue
      const candidate = held[at]!
      if (spent + candidate.tokens > budget) continue // drops out this round and after
      inlined.push(candidate)
      spent += candidate.tokens
      cursor.set(namespace, at + 1)
      if (at + 1 < held.length) next.add(namespace)
    }
    active = next
  }

  const complete = inlined.length === all.length
  const lines: Array<string> = []
  lines.push(
    complete
      ? `Available tools (COMPLETE list):`
      : `Available tools (PARTIAL - ${inlined.length} of ${all.length} shown; use search for the rest):`
  )
  for (const namespace of rotation) {
    const held = byNamespace.get(namespace)!
    const shown = cursor.get(namespace)!
    lines.push(
      shown === held.length
        ? `## ${namespace} (${held.length} tool${held.length === 1 ? "" : "s"})`
        : `## ${namespace} (${held.length} tool${held.length === 1 ? "" : "s"}, ${shown} shown)`
    )
    for (const entry of held.slice(0, shown)) {
      lines.push(entry.signature)
    }
    if (shown < held.length) {
      lines.push(
        `// not shown: ${held.slice(shown).map((entry) => entry.name).join(", ")}`
      )
    }
  }
  return { text: lines.join("\n\n"), complete, inlined, all }
}

// ---------------------------------------------------------------------------
// Search: deterministic, additive, no embeddings, no model call
// ---------------------------------------------------------------------------

const tokenize = (value: string): ReadonlyArray<string> =>
  value
    // camelCase and PascalCase boundaries become separators before splitting.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "")

/** Naive singular: `issues` matches `issue`. Enough on purpose. */
const variants = (token: string): ReadonlyArray<string> =>
  token.endsWith("s") && token.length > 3 ? [token, token.slice(0, -1)] : [token]

/** Property names and their descriptions, once per entry. */
const searchableText = (tool: Tool.Any): string => {
  const schema = Tool.getJsonSchema(tool)
  if (!isObject(schema) || !isObject(schema["properties"])) return ""
  const parts: Array<string> = []
  for (const [name, member] of Object.entries(schema["properties"])) {
    parts.push(name)
    if (isObject(member) && typeof member["description"] === "string") {
      parts.push(member["description"])
    }
  }
  return parts.join(" ").toLowerCase()
}

export interface SearchResult {
  readonly results: ReadonlyArray<Entry & { readonly score: number }>
  /** Spread back into the next request to continue: `{ offset }`. */
  readonly next: { readonly offset: number } | undefined
  readonly total: number
}

/**
 * Field-weighted additive scoring: exact path or path segment 20, path
 * substring 8, description substring 4, searchable text (input property
 * names and their descriptions) 2 -- per query token, singular variants
 * included. Deterministic: equal scores order by path.
 */
export const search = (
  namespaces: Readonly<Record<string, ToolGroup>>,
  query: string,
  options?: { readonly offset?: number | undefined; readonly limit?: number | undefined }
): SearchResult => {
  const offset = Math.max(0, options?.offset ?? 0)
  const limit = Math.max(1, options?.limit ?? 10)
  const queryTokens = tokenize(query)

  const toolsByPath = new Map<string, Tool.Any>()
  for (const [namespace, group] of Object.entries(namespaces)) {
    for (const tool of Object.values(group.tools)) {
      toolsByPath.set(pathOf(namespace, tool.name), tool)
    }
  }

  const scored = entries(namespaces)
    .map((entry) => {
      const path = `${entry.namespace}.${entry.name}`.toLowerCase()
      const segments = new Set(tokenize(path))
      const description = (entry.description ?? "").toLowerCase()
      const searchable = searchableText(toolsByPath.get(entry.path)!)
      let score = 0
      for (const raw of queryTokens) {
        for (const token of variants(raw)) {
          if (path === token || segments.has(token)) score += 20
          else if (path.includes(token)) score += 8
          if (description.includes(token)) score += 4
          if (searchable.includes(token)) score += 2
        }
      }
      return { ...entry, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.path.localeCompare(right.path)
    )

  const page = scored.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return {
    results: page,
    next: nextOffset < scored.length ? { offset: nextOffset } : undefined,
    total: scored.length
  }
}
