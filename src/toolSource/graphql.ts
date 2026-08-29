import { Duration, Effect, Option, Predicate } from "effect"
import type * as JsonSchema from "effect/JsonSchema"
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { Descriptor, Extraction, ToolSource } from "./ToolSource.js"
import { ExtractionError, InvocationError, ToolError } from "./ToolSource.js"

const isObject = Predicate.isObject

const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const FETCH_TIMEOUT = Duration.seconds(30)

/**
 * The longest `select` a caller may supply.
 *
 * A selection set is the one caller-supplied string spliced into the document,
 * so it is bounded independently of the operation: a runaway `select` should be
 * refused as a `select`, naming the input the caller controls, rather than
 * surfacing later as an oversized operation they cannot map back to anything.
 * Not configurable — a selection set this long is a defect in whatever produced
 * it, not a deployment choice.
 */
const MAX_SELECT_CHARS = 4096

/**
 * The longest assembled operation.
 *
 * A backstop rather than a policy. Argument *values* travel as variables and
 * are bounded by `maxRequestBytes`, so what remains here is the document this
 * module built from schema-derived names plus one validated `select` — which
 * cannot legitimately approach this. It exists so a malformed schema producing
 * absurd field names fails locally instead of at the server.
 */
const MAX_OPERATION_CHARS = 8192

/**
 * How deep a wrapped type reference may nest before it is refused.
 *
 * `renderTypeRef` and `typeRefToJsonSchema` walk `ofType` recursively, and an
 * introspection response is remote input. `{"kind":"LIST","ofType":{...}}`
 * costs about thirty bytes a level, so a 1.5MB answer buys fifty thousand
 * frames and the walk dies with `RangeError: Maximum call stack size
 * exceeded` -- a defect, thrown synchronously out of `makeGraphQLSource`
 * before any Effect exists to catch it. `openapi.ts` learned this first and
 * carries `MAX_REF_DEPTH`; this is the same bound for the same reason.
 *
 * Chosen well above anything a real schema reaches: `[[[Type!]!]!]!` is eight
 * levels, and nobody writes past a dozen.
 */
const MAX_TYPE_DEPTH = 64

/**
 * A GraphQL `Name`, per the specification's own production.
 *
 * Field names, argument names and type names are concatenated into the
 * operation document -- they are the parts a variable cannot carry. They come
 * from introspection, which is the remote's word for what it offers, so they
 * are untrusted in exactly the way `select` is. Left unchecked, a field named
 * `ok) { secret } q2: other(x: 1` renders as
 * `query { ok) { secret } q2: other(x: 1 { id } }` and the schema has rewritten
 * the request the agent believed it was making.
 *
 * `MAX_OPERATION_CHARS` already bounded absurd *length*; this bounds shape,
 * which is the half that changes meaning.
 */
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/
const isGraphQLName = (value: string | undefined | null): value is string =>
  typeof value === "string" && GRAPHQL_NAME.test(value)

/**
 * How a GraphQL source reaches its endpoint.
 *
 * Every limit here is stated with its default, because a caller meets these
 * fields and nothing else tells them what they get by leaving one out.
 */
interface GraphQLOptions {
  /** The HTTP URL for the GraphQL POST. Required to invoke anything. */
  readonly endpoint?: string | undefined
  /** Overrides `globalThis.fetch`. Ignored when `httpClient` is supplied. */
  readonly fetchImpl?: typeof fetch | undefined
  /**
   * Resolved per invocation, so a rotating credential is picked up between
   * calls. Never part of a tool's parameter schema.
   */
  readonly headers?: Effect.Effect<Headers.Headers> | undefined
  /** Per request, including the body read. Defaults to 30 seconds. */
  readonly timeout?: Duration.Duration | undefined
  /** Cap on the serialised request. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number | undefined
  /**
   * Cap on the response body, enforced while reading rather than after.
   * Defaults to 1 MiB.
   */
  readonly maxResponseBytes?: number | undefined
  /** Use Effect's `HttpClient` instead of `fetch`. Takes precedence. */
  readonly httpClient?: HttpClient.HttpClient | undefined
}

const isGraphQLOptions = (value: unknown): value is GraphQLOptions => {
  if (typeof value !== "object" || value === null) return false
  return "endpoint" in value || "fetchImpl" in value || "headers" in value || "timeout" in value || "httpClient" in value || "maxRequestBytes" in value || "maxResponseBytes" in value
}

/**
 * Validate a selection set without a GraphQL parser.
 *
 * `select` is the only caller-supplied text that reaches the document, because
 * a selection set names fields and cannot be carried by a variable. Everything
 * else is a variable, so this is the whole trust boundary.
 *
 * The grammar accepted is deliberately narrower than GraphQL: names, nesting
 * braces, aliases, and commas or whitespace between them. Not accepted are
 * arguments, directives, fragments, variables, strings and comments -- each of
 * which is either a way to change the shape of the request or a construct a
 * brace counter cannot reason about. A `#` comment, for instance, can hide a
 * closing brace from any counter that does not understand it.
 *
 * Returns a reason when the selection is rejected, `undefined` when it is
 * acceptable.
 */
const validateSelect = (select: string | undefined): string | undefined => {
  if (select === undefined || select.trim() === "") return undefined
  let depth = 0
  let index = 0
  const isNameStart = (ch: string) => /[A-Za-z_]/.test(ch)
  const isNameChar = (ch: string) => /[A-Za-z0-9_]/.test(ch)
  /**
   * GraphQL's ignored characters, not JavaScript's `\s`.
   *
   * `\s` also matches vertical tab, form feed, NBSP and the Unicode line
   * separators, none of which GraphQL accepts. Treating them as whitespace
   * here let a select through that the server then rejected as a parse error
   * -- a local check that says yes to something the remote says no to is worse
   * than no check, because the failure arrives further from its cause.
   */
  const isIgnored = (ch: string) =>
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "﻿"
  /** Consume a name at `index`, returning the position after it, or -1. */
  const readName = (from: number): number => {
    if (from >= select.length || !isNameStart(select[from]!)) return -1
    let at = from + 1
    while (at < select.length && isNameChar(select[at]!)) at += 1
    return at
  }
  const skipIgnored = (from: number): number => {
    let at = from
    while (at < select.length && (isIgnored(select[at]!) || select[at] === ",")) {
      at += 1
    }
    return at
  }
  while (index < select.length) {
    const ch = select[index]!
    if (isIgnored(ch) || ch === ",") {
      index += 1
      continue
    }
    if (ch === "{") {
      depth += 1
      index += 1
      continue
    }
    if (ch === "}") {
      depth -= 1
      if (depth < 0) {
        return "a closing brace would leave the field's selection set"
      }
      index += 1
      continue
    }
    if (isNameStart(ch)) {
      const afterName = readName(index)
      const afterGap = skipIgnored(afterName)
      // An alias is `name : name`, and exactly that. Skipping colons wherever
      // they appeared accepted `a:b:c`, which GraphQL does not parse -- another
      // local yes to something the server says no to.
      if (select[afterGap] === ":") {
        const afterAlias = readName(skipIgnored(afterGap + 1))
        if (afterAlias === -1) {
          return "an alias must be followed by a field name"
        }
        index = afterAlias
        continue
      }
      index = afterName
      continue
    }
    return `unexpected ${
      JSON.stringify(ch)
    } — only field names, aliases and nested braces are allowed`
  }
  if (depth !== 0) return "unbalanced braces"
  return undefined
}

/**
 * Minimal GraphQL extractor — `research-tool-sources.md` §2.4 / §6.3.
 *
 * Walks only root `Query` and `Mutation` fields — the actual API surface,
 * bounded at tens to low hundreds even for large schemas. Field arguments
 * become the tool's input schema: named `INPUT_OBJECT` types are hoisted into
 * a `$defs` block and referenced by `$ref`, `NON_NULL` → `required`, `LIST` →
 * `array`, `ENUM` → a string with `enum` values.
 *
 * Hoisting is not a size optimisation. Input objects are commonly
 * self-referential (`input Filter { and: [Filter!] }`), and inlining them
 * recursed until the stack overflowed — during extraction, before any network
 * call. A `$ref` back to a definition already being built terminates by
 * construction.
 *
 * **Argument values are sent as GraphQL variables, never interpolated.** The
 * operation is assembled from names this module derived from the schema —
 * `query ($id: ID!) { user(id: $id) { … } }` — and every caller-supplied value
 * travels in the `variables` object beside it. Nothing a caller provides can
 * change the document's structure, and enums and custom scalars are coerced by
 * the server rather than guessed at here.
 *
 * `select` is the sole exception, because a selection set names fields and a
 * variable cannot carry one. It is validated against a deliberately narrow
 * grammar — names, aliases, nested braces — before it is spliced, so it cannot
 * introduce arguments, directives, fragments or comments. See `validateSelect`.
 *
 * Upstream field and argument validity is left to the server, which reports it
 * verbatim, because the stored introspection snapshot is reduced.
 *
 * This is tier 3 only for now — `outputSchema` is not yet derived, there is
 * nothing to generate a type from even if one wanted to. The extraction is
 * eager (at wiring, not per turn) and the result is a plain `Extraction`
 * value the application can cache in `/state` or memory.
 */

type IntrospectionTypeRef = {
  kind: string
  name?: string | null
  ofType?: IntrospectionTypeRef | null
}

type IntrospectionInputValue = {
  name: string
  description?: string | null
  type: IntrospectionTypeRef
  /**
   * The schema's own default, as a GraphQL literal string.
   *
   * Carried into the JSON Schema so the model can see what it gets by leaving
   * an argument out, rather than having to guess or always supply one.
   */
  defaultValue?: string | null
}

type IntrospectionField = {
  name: string
  description?: string | null
  args: ReadonlyArray<IntrospectionInputValue>
  type: IntrospectionTypeRef
}

type IntrospectionType = {
  kind: string
  name: string
  description?: string | null
  fields?: ReadonlyArray<IntrospectionField> | null
  inputFields?: ReadonlyArray<IntrospectionInputValue> | null
  enumValues?: ReadonlyArray<{ name: string; description?: string | null }> | null
}

type IntrospectionSchema = {
  queryType: { name: string }
  mutationType?: { name: string } | null
  types: ReadonlyArray<IntrospectionType>
}

const scalarToJson = (name: string): JsonSchema.JsonSchema => {
  switch (name) {
    case "Int":
      return { type: "integer" } as JsonSchema.JsonSchema
    case "Float":
      return { type: "number" } as JsonSchema.JsonSchema
    case "Boolean":
      return { type: "boolean" } as JsonSchema.JsonSchema
    case "ID":
      return { type: "string" } as JsonSchema.JsonSchema
    default:
      return { type: "string" } as JsonSchema.JsonSchema
  }
}

const unwrapNonNull = (type: IntrospectionTypeRef): { type: IntrospectionTypeRef; required: boolean } => {
  if (type.kind === "NON_NULL" && type.ofType !== undefined && type.ofType !== null) {
    return { type: type.ofType, required: true }
  }
  return { type, required: false }
}

/**
 * The GraphQL type name a value must be declared as in an operation.
 *
 * Variables carry their type in the operation header (`query ($x: Filter!)`),
 * so the wrapper structure -- `NON_NULL`, `LIST` -- has to be rendered, not
 * unwrapped and discarded the way the JSON Schema conversion does.
 */
const renderTypeRef = (ref: IntrospectionTypeRef, depth = 0): string | undefined => {
  // Past the bound, and for a name that is not a GraphQL `Name`, the answer is
  // the same: unrenderable. `buildInputSchema` already drops such an argument
  // from the callable surface and `extractGraphQL` reports it in `skipped`, so
  // refusing here routes a hostile type through the path built for one that is
  // merely exotic.
  if (depth > MAX_TYPE_DEPTH) return undefined
  if (ref.kind === "NON_NULL") {
    const inner = ref.ofType === undefined || ref.ofType === null
      ? undefined
      : renderTypeRef(ref.ofType, depth + 1)
    return inner === undefined ? undefined : `${inner}!`
  }
  if (ref.kind === "LIST") {
    const inner = ref.ofType === undefined || ref.ofType === null
      ? undefined
      : renderTypeRef(ref.ofType, depth + 1)
    return inner === undefined ? undefined : `[${inner}]`
  }
  return isGraphQLName(ref.name) ? ref.name : undefined
}

/** A JSON Schema pointer into the shared `$defs` block. */
const refTo = (name: string): JsonSchema.JsonSchema =>
  ({ $ref: `#/$defs/${name}` }) as JsonSchema.JsonSchema

/**
 * Named input types are hoisted into `$defs` and referenced, never inlined.
 *
 * Input objects are routinely self-referential -- `input Filter { and: [Filter!] }`
 * is what Hasura, Prisma and Shopify all emit for a where-clause. Inlining
 * them recurses forever, which is not a hypothetical: it overflowed the stack
 * during extraction, before any network call, for every such schema.
 *
 * Hoisting terminates by construction. A cycle becomes a `$ref` back to a
 * definition that is already being built, which is exactly what `$ref` is for,
 * and the caller assembles one `$defs` block for the whole tool.
 */
interface Definitions {
  readonly defs: Record<string, JsonSchema.JsonSchema>
  readonly building: Set<string>
}

const emptyDefinitions = (): Definitions => ({ defs: {}, building: new Set() })

/** One field argument, and the GraphQL type its variable must declare. */
interface VariableBinding {
  readonly name: string
  readonly graphqlType: string
}

/** What `invoke` needs to rebuild one field's operation. */
interface FieldMeta {
  readonly fieldName: string
  readonly isMutation: boolean
  readonly variables: ReadonlyArray<VariableBinding>
}

const typeRefToJsonSchema = (
  ref: IntrospectionTypeRef,
  typeMap: Map<string, IntrospectionType>,
  definitions: Definitions,
  depth = 0
): JsonSchema.JsonSchema => {
  // See `MAX_TYPE_DEPTH`. `$defs` hoisting already terminates *cycles* through
  // named input objects; nothing bounded a straight `LIST` chain, which is
  // unnamed and so never reaches the hoist. A permissive `{}` is the honest
  // answer for a shape this module declines to describe.
  if (depth > MAX_TYPE_DEPTH) return {} as JsonSchema.JsonSchema
  // `required` is carried by the enclosing object's `required` array, not by
  // the member schema, so the non-null wrapper is dropped here.
  const { type } = unwrapNonNull(ref)
  if (type.kind === "LIST" && type.ofType !== undefined && type.ofType !== null) {
    const inner = typeRefToJsonSchema(type.ofType, typeMap, definitions, depth + 1)
    return { type: "array", items: inner } as JsonSchema.JsonSchema
  }
  if (type.kind === "SCALAR") {
    return scalarToJson(type.name ?? "String")
  }
  if (type.kind === "ENUM") {
    const def = type.name !== undefined && type.name !== null ? typeMap.get(type.name) : undefined
    if (def?.enumValues !== undefined && def.enumValues !== null) {
      return { type: "string", enum: def.enumValues.map((v) => v.name) } as JsonSchema.JsonSchema
    }
    return { type: "string" } as JsonSchema.JsonSchema
  }
  if (type.kind === "INPUT_OBJECT") {
    const name = type.name ?? undefined
    if (name === undefined) {
      return { type: "object", additionalProperties: true } as JsonSchema.JsonSchema
    }
    // Already emitted, or currently being emitted further up this stack: the
    // reference is what breaks the cycle.
    if (name in definitions.defs || definitions.building.has(name)) {
      return refTo(name)
    }
    const def = typeMap.get(name)
    if (def?.inputFields === undefined || def.inputFields === null) {
      definitions.defs[name] = {
        type: "object",
        additionalProperties: true
      } as JsonSchema.JsonSchema
      return refTo(name)
    }
    definitions.building.add(name)
    const properties: Record<string, JsonSchema.JsonSchema> = {}
    const required: Array<string> = []
    for (const field of def.inputFields) {
      const { required: isRequired } = unwrapNonNull(field.type)
      properties[field.name] = typeRefToJsonSchema(field.type, typeMap, definitions, depth + 1)
      if (isRequired) required.push(field.name)
    }
    definitions.building.delete(name)
    definitions.defs[name] = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false
    } as JsonSchema.JsonSchema
    return refTo(name)
  }
  if (type.kind === "OBJECT") {
    // A return type. Not part of an input schema -- `select` requests its
    // fields instead -- so nothing meaningful can be said about it here.
    return { type: "string" } as JsonSchema.JsonSchema
  }
  return { type: "string" } as JsonSchema.JsonSchema
}

/**
 * The model-facing input schema for one root field, and how to send it.
 *
 * The variable bindings come out alongside the schema because they are the
 * same information seen from the wire side: every argument the model may set
 * is declared once here and passed as a GraphQL variable at invoke, so no
 * caller-supplied value is ever concatenated into the document.
 */
const buildInputSchema = (
  field: IntrospectionField,
  typeMap: Map<string, IntrospectionType>
): {
  readonly schema: JsonSchema.JsonSchema
  readonly variables: ReadonlyArray<VariableBinding>
  /** Arguments dropped from the callable surface, for the caller's `skipped`. */
  readonly unsendable: ReadonlyArray<string>
} => {
  const properties: Record<string, JsonSchema.JsonSchema> = {}
  const required: Array<string> = []
  const definitions = emptyDefinitions()
  const variables: Array<VariableBinding> = []
  const unsendable: Array<string> = []

  for (const arg of field.args) {
    const { required: isRequired } = unwrapNonNull(arg.type)
    const schema = typeRefToJsonSchema(arg.type, typeMap, definitions)
    properties[arg.name] = {
      ...schema,
      ...(arg.description ? { description: arg.description } : {}),
      // The schema's default, verbatim as GraphQL wrote it. Not parsed into a
      // JSON value: `defaultValue` is a GraphQL literal (`ASC`, `[1, 2]`) and
      // guessing at its JSON equivalent would be a second place to get enum
      // handling wrong.
      ...(typeof arg.defaultValue === "string" && arg.defaultValue !== ""
        ? { description: `${arg.description ?? ""}${arg.description ? " " : ""}(default: ${arg.defaultValue})`.trim() }
        : {})
    } as JsonSchema.JsonSchema
    if (isRequired) required.push(arg.name)
    const declared = renderTypeRef(arg.type)
    // An argument whose type cannot be rendered cannot be sent as a variable,
    // and interpolating it instead is what this design exists to avoid. Drop
    // it from the callable surface rather than smuggle it into the document.
    //
    // The argument's own *name* is under the same rule for the same reason: it
    // is written into the operation twice, as `$name` in the declaration and as
    // `name: $name` in the field, and a name the remote chose is no more
    // trusted than a type it chose.
    if (declared !== undefined && isGraphQLName(arg.name)) {
      variables.push({ name: arg.name, graphqlType: declared })
    } else {
      unsendable.push(arg.name)
      delete properties[arg.name]
      const at = required.indexOf(arg.name)
      if (at >= 0) required.splice(at, 1)
    }
  }

  // `select` is a control input, not a GraphQL argument: it names fields, and
  // a variable cannot carry a selection set. It is the one caller-supplied
  // string that reaches the document, and it is checked before it does.
  properties["select"] = {
    type: "string",
    description: `GraphQL selection set for ${field.name} — e.g. "id name" or "author { name }". Field names only; validated before send.`
  } as JsonSchema.JsonSchema

  const schema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(Object.keys(definitions.defs).length > 0
      ? { $defs: definitions.defs }
      : {}),
    additionalProperties: false
  } as JsonSchema.JsonSchema
  return { schema, variables, unsendable }
}

export const extractGraphQL = (introspection: unknown): Extraction => {
  let schema: IntrospectionSchema | undefined
  if (isObject(introspection) && "__schema" in introspection && isObject((introspection as { __schema: unknown }).__schema)) {
    schema = (introspection as { __schema: IntrospectionSchema }).__schema
  } else if (isObject(introspection) && "queryType" in introspection && isObject((introspection as { queryType: unknown }).queryType)) {
    schema = introspection as IntrospectionSchema
  } else {
    schema = undefined
  }

  if (schema === undefined || schema.queryType === undefined) {
    return { tools: [], skipped: [{ name: "(schema)", reason: "introspection missing __schema.queryType" }] }
  }

  const typeMap = new Map<string, IntrospectionType>()
  for (const type of schema.types ?? []) typeMap.set(type.name, type)

  const tools: Array<Descriptor> = []
  const skipped: Array<{ name: string; reason: string }> = []

  const rootNames = [schema.queryType.name, schema.mutationType?.name].filter(
    (name): name is string => typeof name === "string"
  )

  for (const typeName of rootNames) {
    const type = typeMap.get(typeName)
    if (type?.fields === undefined || type.fields === null) continue
    for (const field of type.fields) {
      // The field name is spliced into the operation document -- it is the one
      // part of the request no variable can carry. A remote offering a name
      // that is not a GraphQL `Name` is either broken or rewriting the request,
      // and neither is worth a tool. See `GRAPHQL_NAME`.
      if (!isGraphQLName(field.name)) {
        skipped.push({
          name: String(field.name),
          reason: "field name is not a GraphQL name"
        })
        continue
      }
      // No skip for the return type — every root field becomes a tool. A field
      // whose return type is not representable would be `skipped` with a
      // reason, but for minimal we surface all.
      //
      // `unsendable` comes back from `buildInputSchema` rather than being
      // recomputed here: the two must agree on which arguments were dropped,
      // and recomputing was a second copy of the condition free to drift.
      const { schema: input, unsendable, variables } = buildInputSchema(field, typeMap)
      if (unsendable.length > 0) {
        skipped.push({
          name: field.name,
          reason: `arguments that cannot be sent as variables are not exposed: ${unsendable.join(", ")}`
        })
      }
      tools.push({
        name: field.name,
        description: field.description ?? undefined,
        input,
        annotations: typeName === schema.mutationType?.name ? { requiresApproval: true } : undefined,
        meta: {
          fieldName: field.name,
          isMutation: typeName === schema.mutationType?.name,
          variables
        }
      })
    }
  }

  return { tools, skipped }
}

/**
 * Create a `ToolSource` from a GraphQL introspection result.
 *
 * `endpoint` is the HTTP URL for the GraphQL POST.
 *
 * Argument values are sent as **GraphQL variables**, never concatenated into
 * the document, so no caller-supplied value can alter its structure. `select`
 * is the one exception -- a selection set names fields and cannot be a
 * variable -- and it is validated against a field-name grammar before it is
 * spliced. Upstream field and argument validity is left to the server, which
 * reports it verbatim.
 */
export const makeGraphQLSource = (
  id: string,
  introspection: unknown,
  endpoint?: string | GraphQLOptions | undefined,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis) as typeof fetch,
  headers?: Effect.Effect<Headers.Headers>
): ToolSource => {
  const resolvedEndpoint = isGraphQLOptions(endpoint) ? endpoint.endpoint : typeof endpoint === "string" ? endpoint : undefined
  const resolvedFetchImpl = isGraphQLOptions(endpoint) ? (endpoint.fetchImpl ?? (globalThis.fetch.bind(globalThis) as typeof fetch)) : fetchImpl
  const resolvedHeaders = isGraphQLOptions(endpoint) ? endpoint.headers : headers
  const resolvedTimeout = isGraphQLOptions(endpoint) ? (endpoint.timeout ?? FETCH_TIMEOUT) : FETCH_TIMEOUT
  const resolvedMaxRequestBytes = isGraphQLOptions(endpoint) ? (endpoint.maxRequestBytes ?? MAX_REQUEST_BYTES) : MAX_REQUEST_BYTES
  const resolvedMaxResponseBytes = isGraphQLOptions(endpoint) ? (endpoint.maxResponseBytes ?? MAX_RESPONSE_BYTES) : MAX_RESPONSE_BYTES
  const resolvedHttpClient = isGraphQLOptions(endpoint) ? endpoint.httpClient : undefined
  const extraction = extractGraphQL(introspection)
  const metaByName = new Map<string, FieldMeta>()
  for (const tool of extraction.tools) {
    const meta = (tool as Descriptor & { meta?: unknown }).meta as
      | FieldMeta
      | undefined
    if (meta !== undefined) metaByName.set(tool.name, meta)
  }
  return {
    id,
    extract: Effect.succeed(extraction),
    invoke: (name, args) =>
      Effect.gen(function* () {
        const meta = metaByName.get(name)
        if (meta === undefined) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `tool ${name} not found in extraction` })
        }
        if (resolvedEndpoint === undefined || resolvedEndpoint === "") {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: "GraphQL endpoint not configured — pass endpoint to makeGraphQLSource" })
        }

        const params = (args ?? {}) as Record<string, unknown>
        const argsJson = JSON.stringify(params)
        if (argsJson.length > resolvedMaxRequestBytes) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `request args too large: ${argsJson.length} bytes > ${resolvedMaxRequestBytes}` })
        }
        const select = typeof params["select"] === "string" ? (params["select"] as string) : undefined
        if (select !== undefined && select.length > MAX_SELECT_CHARS) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `select too large: ${select.length} chars > ${MAX_SELECT_CHARS}` })
        }
        const fieldArgs: Record<string, unknown> = { ...params }
        delete fieldArgs["select"]
        // Skip undefined optional args — they were not provided, not `null`
        for (const key of Object.keys(fieldArgs)) {
          if (fieldArgs[key] === undefined) delete fieldArgs[key]
        }

        // Only declared arguments become variables. An unrecognised key is a
        // mistake worth reporting, not something to pass along quietly, and
        // reporting it is also what stops a crafted key reaching the document.
        const declared = new Map(
          meta.variables.map((binding) => [binding.name, binding])
        )
        const unknownKeys = Object.keys(fieldArgs).filter(
          (key) => !declared.has(key)
        )
        if (unknownKeys.length > 0) {
          return yield* new InvocationError({
            sourceId: id,
            toolName: name,
            detail: `unknown argument${unknownKeys.length > 1 ? "s" : ""}: ${
              unknownKeys.join(", ")
            }`
          })
        }

        const used = meta.variables.filter((binding) => binding.name in fieldArgs)
        const declaration = used.length === 0
          ? ""
          : `(${used.map((b) => `$${b.name}: ${b.graphqlType}`).join(", ")})`
        const argsPart = used.length === 0
          ? ""
          : `(${used.map((b) => `${b.name}: $${b.name}`).join(", ")})`

        const invalidSelect = validateSelect(select)
        if (invalidSelect !== undefined) {
          return yield* new InvocationError({
            sourceId: id,
            toolName: name,
            detail: `invalid select: ${invalidSelect}`
          })
        }

        const selection = select !== undefined && select.trim() !== ""
          ? `{ ${select} }`
          : ""
        const operation =
          `${meta.isMutation ? "mutation" : "query"}${declaration} { ${meta.fieldName}${argsPart} ${selection} }`
        if (operation.length > MAX_OPERATION_CHARS) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `operation too large: ${operation.length} chars > ${MAX_OPERATION_CHARS}` })
        }

        const variableValues: Record<string, unknown> = {}
        for (const binding of used) {
          variableValues[binding.name] = fieldArgs[binding.name]
        }

        const extraHeaders = yield* (resolvedHeaders ?? Effect.succeed(Headers.empty)).pipe(
          Effect.mapError((cause) => new InvocationError({ sourceId: id, toolName: name, detail: `headers resolver failed: ${String(cause)}` }))
        )
        const baseHeaders = Headers.fromInput({ "content-type": "application/json" })
        const allHeaders = Headers.merge(baseHeaders, extraHeaders)
        const headersForFetch: Record<string, string> = { ...allHeaders }

        let json: unknown
        if (resolvedHttpClient !== undefined) {
          const req = HttpClientRequest.post(resolvedEndpoint!)
          const withHeaders = HttpClientRequest.setHeaders(req, allHeaders)
          const finalReq = HttpClientRequest.bodyText(JSON.stringify({ query: operation, variables: variableValues }))(withHeaders)
          const httpResponse = yield* resolvedHttpClient.execute(finalReq).pipe(
            Effect.timeout(resolvedTimeout),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: `fetch timed out after ${Duration.toMillis(resolvedTimeout)}ms` }))
            ),
            Effect.mapError((cause) => new InvocationError({ sourceId: id, toolName: name, detail: `fetch failed: ${String(cause)}` }))
          )
          const contentLengthHeader = Option.getOrNull(Headers.get(httpResponse.headers, "content-length"))
          if (contentLengthHeader !== null) {
            const len = Number(contentLengthHeader)
            if (!Number.isNaN(len) && len > resolvedMaxResponseBytes) {
              return yield* new InvocationError({ sourceId: id, toolName: name, detail: `response too large: ${len} bytes > ${resolvedMaxResponseBytes}` })
            }
          }
          if (httpResponse.status < 200 || httpResponse.status >= 300) {
            const text = yield* httpResponse.text.pipe(Effect.orElseSucceed(() => ""))
            return yield* new InvocationError({
              sourceId: id,
              toolName: name,
              detail: `HTTP ${httpResponse.status} ${""}${text ? `: ${String(text).slice(0, 500)}` : ""}`
            })
          }
          json = yield* httpResponse.json.pipe(
            Effect.mapError((cause: unknown) => new InvocationError({ sourceId: id, toolName: name, detail: `failed to parse JSON response: ${String(cause)}` })),
            Effect.timeout(resolvedTimeout),
            Effect.catchTag("TimeoutError", () => Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: "response body read timed out" }))),
            Effect.flatMap((value) => {
              const size = JSON.stringify(value).length
              return size > resolvedMaxResponseBytes
                ? Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: `response JSON too large: ${size} bytes > ${resolvedMaxResponseBytes}` }))
                : Effect.succeed(value)
            })
          )
        } else {
          // The signal is what makes the timeout mean anything: without it the
          // fiber gives up but the request runs on, holding a connection. See
          // the same note in `openapi.ts`.
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              resolvedFetchImpl(resolvedEndpoint!, {
                method: "POST",
                headers: headersForFetch,
                body: JSON.stringify({ query: operation, variables: variableValues }),
                signal
              }),
            catch: (cause) => new InvocationError({ sourceId: id, toolName: name, detail: `fetch failed: ${String(cause)}` })
          }).pipe(
            Effect.timeout(resolvedTimeout),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: `fetch timed out after ${Duration.toMillis(resolvedTimeout)}ms` }))
            )
          )

          const contentLengthHeader = (() => {
            try {
              return response.headers.get("content-length")
            } catch {
              return null
            }
          })()
          if (contentLengthHeader !== null) {
            const len = Number(contentLengthHeader)
            if (!Number.isNaN(len) && len > resolvedMaxResponseBytes) {
              return yield* new InvocationError({ sourceId: id, toolName: name, detail: `response too large: ${len} bytes > ${resolvedMaxResponseBytes}` })
            }
          }

          if (!response.ok) {
            const text = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () => ""
            }).pipe(Effect.orElseSucceed(() => ""))
            return yield* new InvocationError({
              sourceId: id,
              toolName: name,
              detail: `HTTP ${response.status} ${response.statusText}${text ? `: ${String(text).slice(0, 500)}` : ""}`
            })
          }

          json = yield* Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: (cause) => new InvocationError({ sourceId: id, toolName: name, detail: `failed to parse JSON response: ${String(cause)}` })
          }).pipe(
            Effect.timeout(resolvedTimeout),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: "response body read timed out" }))
            ),
            Effect.flatMap((value) => {
              const size = JSON.stringify(value).length
              return size > resolvedMaxResponseBytes
                ? Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: `response JSON too large: ${size} bytes > ${resolvedMaxResponseBytes}` }))
                : Effect.succeed(value)
            })
          )
        }

        /**
         * The GraphQL envelope is `{ data?, errors? }`, and a request that
         * failed still answers 200.
         *
         * Reported errors become a `ToolError`, not a successful result. The
         * distinction is the whole point of having two error types: a
         * `ToolError` is the tool's own failure, which `FailurePolicy` can
         * hand back to the model to retry or rephrase, while returning the
         * envelope as success tells the harness nothing went wrong and leaves
         * the model to notice on its own.
         *
         * Partial success -- `data` *and* `errors` together, which GraphQL
         * allows -- is still a failure here, but the payload carries both so
         * whatever did resolve is not thrown away.
         */
        const envelope = isObject(json) ? json as Record<string, unknown> : {}
        const errors = envelope["errors"]
        if (Array.isArray(errors) && errors.length > 0) {
          return yield* new ToolError({
            sourceId: id,
            toolName: name,
            error: {
              errors,
              ...("data" in envelope ? { data: envelope["data"] } : {})
            }
          })
        }

        if (!("data" in envelope)) {
          return yield* new InvocationError({
            sourceId: id,
            toolName: name,
            detail: "response has neither data nor errors, so it is not a GraphQL envelope"
          })
        }

        const data = envelope["data"]
        // `data: null` is legal on a top-level failure. Indexing it would be a
        // TypeError -- a defect escaping the declared error channel -- so it is
        // reported rather than dereferenced.
        if (!isObject(data)) {
          return yield* new InvocationError({
            sourceId: id,
            toolName: name,
            detail: `response data is ${data === null ? "null" : typeof data}, not an object`
          })
        }
        // `in` rather than `??`: a field that legitimately resolves to `null`
        // must return `null`, not fall back to the whole `data` object.
        return meta.fieldName in data
          ? (data as Record<string, unknown>)[meta.fieldName]
          : data
      })
  }
}
