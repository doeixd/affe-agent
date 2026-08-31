import { Duration, Effect, Option } from "effect"
import type * as JsonSchema from "effect/JsonSchema"
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { Extraction, Skipped, Descriptor, ToolSource } from "./ToolSource.js"
import { ExtractionError, InvocationError } from "./ToolSource.js"

const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const FETCH_TIMEOUT = Duration.seconds(30)

/**
 * The longest request URL this source will build.
 *
 * The conservative floor across proxies and servers; the HTTP specs set no
 * limit but implementations do, and a rejection there arrives as an opaque
 * 414 far from the query parameter that caused it. Refusing locally names the
 * operation. Not configurable: raising it does not raise anyone else's.
 */
const MAX_URL_CHARS = 2048

/**
 * How deep `$ref` expansion goes before it stops.
 *
 * The seen-set already terminates cycles, so this is for the non-cyclic case:
 * a schema legitimately nested deeper than this stops expanding and keeps the
 * pointer, which is honest rather than wrong — the model sees less, not
 * something false. Deep enough that no hand-written spec reaches it.
 */
const MAX_REF_DEPTH = 32

/**
 * How an OpenAPI source reaches its endpoint.
 *
 * Every limit here is stated with its default, because a caller meets these
 * fields and nothing else tells them what they get by leaving one out.
 */
interface OpenApiOptions {
  /** Base URL for every operation. Falls back to the spec's `servers[0].url`. */
  readonly endpoint?: string | undefined
  /** Overrides `globalThis.fetch`. Ignored when `httpClient` is supplied. */
  readonly fetchImpl?: typeof fetch | undefined
  /**
   * Resolved per invocation, so a rotating credential is picked up between
   * calls. Never part of a tool's parameter schema.
   */
  readonly headers?: Effect.Effect<Headers.Headers, unknown> | undefined
  /**
   * Resolved per invocation, like `headers`, and applied to *both* carriers:
   * the headers merge over `headers`'s, and the query pairs land on the
   * request URL. The shape is `Credentials.resolve`'s `Rendered`, so a
   * binding whose method places a key in the query string reaches the wire
   * without a second mechanism. Never part of a tool's parameter schema,
   * and never overridden by a model-chosen parameter -- credentials win.
   */
  readonly credentials?: Effect.Effect<CredentialParts, unknown> | undefined
  /** Per request, including the body read. Defaults to 30 seconds. */
  readonly timeout?: Duration.Duration | undefined
  /** Cap on the serialised request body. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number | undefined
  /**
   * Cap on the response body, enforced while reading rather than after, so an
   * oversized response is refused instead of buffered. Defaults to 1 MiB.
   */
  readonly maxResponseBytes?: number | undefined
  /** Use Effect's `HttpClient` instead of `fetch`. Takes precedence. */
  readonly httpClient?: HttpClient.HttpClient | undefined
}

/** The shape the `credentials` option resolves to; `Credentials.Rendered`. */
interface CredentialParts {
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
}

const emptyCredentialParts: Effect.Effect<CredentialParts, unknown> = Effect.succeed({ headers: {}, query: {} })

const isOpenApiOptions = (value: unknown): value is OpenApiOptions => {
  if (typeof value !== "object" || value === null) return false
  return "endpoint" in value || "fetchImpl" in value || "headers" in value || "credentials" in value || "timeout" in value || "httpClient" in value || "maxRequestBytes" in value || "maxResponseBytes" in value
}

/**
 * Make a header safe to send, and bound it.
 *
 * CR, LF and NUL are removed rather than escaped, because a header value
 * carrying them is header injection and there is no correct rendering of it.
 * The length caps are the conservative floor across common servers and
 * proxies — 8 KB for a whole header block is typical, so a single value at
 * 4 KiB and a name at 128 already leaves room.
 *
 * **These truncate silently**, which is the right trade for a header a model
 * chose: failing the whole call because a value was long would turn a
 * cosmetic problem into an outage, and an over-long header is refused
 * downstream anyway. A credential does not arrive this way — those come from
 * the `headers` resolver, which is not sanitised or truncated.
 */
const MAX_HEADER_VALUE_CHARS = 4096
const MAX_HEADER_NAME_CHARS = 128

const sanitizeHeaderValue = (value: string): string =>
  value.replace(/[\r\n\0]/g, " ").trim().slice(0, MAX_HEADER_VALUE_CHARS)
const sanitizeHeaderName = (name: string): string =>
  name.replace(/[\r\n\0:]/g, "").trim().slice(0, MAX_HEADER_NAME_CHARS)

/**
 * Minimal OpenAPI extractor — `research-tool-sources.md` §6.3.
 *
 * Honest starting point: JSON bodies, JSON responses, `form` query,
 * `simple` path/header, everything else `skipped` rather than broken.
 * This already covers most real specs; the rest is edge-case handling
 * that `skipped` makes visible instead of silently wrong.
 *
 * `spec` is the parsed OpenAPI document (3.0 or 3.1) as `unknown` — the
 * caller is responsible for parsing JSON/YAML, this is pure extraction.
 * Tool names are `operationId` when present (dotted segments kept, they
 * become the namespace), otherwise `method_path` sanitized. Non-GET
 * operations carry `requiresApproval: true` via `annotations` so
 * `Permission` can gate them without the application hand-writing a rule.
 */

const METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head", "trace"])

const sanitize = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "root"

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isObject(value) ? (value as Record<string, unknown>) : undefined

/**
 * Where one model-facing field goes on the wire, and how.
 *
 * `explode` is resolved to the spec's default at extraction rather than left
 * optional, so the invocation path never has to re-derive it from `in`.
 * A body field carries `explode: false` because it is never URL-serialised.
 */
interface ParamMapping {
  readonly originalName: string
  readonly in: string
  readonly explode: boolean
}

/**
 * Serialise an object-valued parameter the way OpenAPI's `style`/`explode`
 * pair says to.
 *
 * `form` + `explode: true` (the spec default for query) is the one case that
 * is not a single string -- it becomes one query pair per own enumerable
 * entry -- so the caller handles it directly and everything else lands here:
 *
 * | style  | explode | result      |
 * |--------|---------|-------------|
 * | form   | false   | `a,1,b,2`   |
 * | simple | false   | `a,1,b,2`   |
 * | simple | true    | `a=1,b=2`   |
 *
 * `encode` is per-part rather than over the joined string, so the delimiters
 * stay delimiters. A path parameter passes `encodeURIComponent` (which is what
 * keeps a `/` inside a value from becoming a path segment); a query parameter
 * passes identity, because `URLSearchParams` encodes on the way out and
 * encoding twice would send `%252C`.
 */
const serializeObjectParam = (
  value: Record<string, unknown>,
  pair: string,
  encode: (part: string) => string
): string =>
  Object.entries(value)
    .map(([key, entry]) => `${encode(key)}${pair}${encode(String(entry))}`)
    .join(",")

/**
 * Whether an object-valued parameter contains a nested object or array.
 *
 * Only the flat case has an agreed encoding under `form`/`simple`; a nested
 * value needs `deepObject`, which this module already refuses. Inventing a
 * deep encoding here would send something no server asked for, so a nested
 * value is refused instead -- at extraction where possible, and again at
 * invocation for a schema too loose to have said so.
 */
const hasNestedMember = (value: Record<string, unknown>): boolean =>
  Object.values(value).some((entry) => typeof entry === "object" && entry !== null)

/**
 * Read a response body, refusing it as soon as it passes `limit`.
 *
 * The point is *as soon as*: a cap enforced after `text()` or `json()` has
 * already let the whole payload into memory, which is what the cap exists to
 * prevent. Streaming stops at the boundary and cancels the rest.
 *
 * Falls back to `text()` when the body is not a readable stream -- a mocked
 * `Response` in a test, or a runtime without streams. The `content-length`
 * check the caller does first covers the common case there.
 */
const readBounded = <E>(
  response: Response,
  limit: number,
  onError: (detail: string) => E
): Effect.Effect<string, E> =>
  Effect.tryPromise({
    try: async () => {
      const body = response.body
      if (body === null || typeof body.getReader !== "function") {
        const text = await response.text()
        // Bytes, not UTF-16 code units: the streaming path above sums
        // `byteLength`, and a multi-byte body would otherwise be allowed to
        // exceed the cap threefold on this path alone.
        if (new TextEncoder().encode(text).byteLength > limit) {
          throw new Error(`response too large: exceeded ${limit} bytes`)
        }
        return text
      }
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let total = 0
      let out = ""
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > limit) {
            throw new Error(`response too large: exceeded ${limit} bytes`)
          }
          out += decoder.decode(value, { stream: true })
        }
      } finally {
        // Releases the connection when the loop exits early.
        await reader.cancel().catch(() => {})
      }
      return out + decoder.decode()
    },
    catch: (cause) =>
      onError(cause instanceof Error ? cause.message : String(cause))
  })

/**
 * Follow a local `$ref` to the node it names.
 *
 * Real specs put nearly everything behind a reference -- Stripe, GitHub and
 * even the Petstore describe parameters, request bodies and schemas in
 * `components` and point at them. Left unresolved, a `$ref` parameter has no
 * `name` and was silently dropped, and a `$ref` request body looked like an
 * operation with no body at all. Both produced a *broken tool* rather than a
 * skipped one, which inverts what this module promises.
 *
 * Only in-document pointers are followed. An external or remote reference
 * needs a fetch, and a fetch during extraction is a network dependency the
 * caller did not ask for; those are reported instead.
 *
 * `seen` breaks reference cycles, which are legal and common in schemas that
 * describe trees. Returning the unresolved node leaves a `$ref` in the output,
 * which is honest: the pointer is the best available description of a value
 * that refers to itself.
 *
 * Cycles are not the only way a chain gets long: `$ref -> $ref -> $ref` over
 * ten thousand *distinct* pointers is acyclic, so the seen-set never fires and
 * the recursion overflows the stack. `depth` bounds it, and past the bound the
 * pointer is reported as `unresolved` — the caller then skips the operation
 * with a reason naming the pointer, which is the same honest outcome an
 * external reference gets, rather than a thrown stack overflow.
 *
 * `seen` is one mutable set threaded down rather than a fresh copy per level:
 * the copy made resolution O(n^2) in chain length. Add before recursing and
 * delete after, so a sibling branch does not inherit a path it is not on.
 */
const resolveRef = (
  root: Record<string, unknown>,
  value: unknown,
  seen: Set<string> = new Set(),
  depth = 0
): { readonly node: unknown; readonly unresolved?: string } => {
  if (!isObject(value)) return { node: value }
  const pointer = value["$ref"]
  if (typeof pointer !== "string") return { node: value }
  if (!pointer.startsWith("#/")) {
    return { node: undefined, unresolved: pointer }
  }
  if (depth > MAX_REF_DEPTH) return { node: undefined, unresolved: pointer }
  if (seen.has(pointer)) return { node: value }
  let current: unknown = root
  for (const rawSegment of pointer.slice(2).split("/")) {
    // JSON Pointer escapes, in the order the spec requires.
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~")
    if (!isObject(current)) return { node: undefined, unresolved: pointer }
    current = current[segment]
  }
  if (current === undefined) return { node: undefined, unresolved: pointer }
  seen.add(pointer)
  try {
    return resolveRef(root, current, seen, depth + 1)
  } finally {
    seen.delete(pointer)
  }
}

/**
 * Resolve every `$ref` inside a schema so the model sees a usable shape.
 *
 * The model receives the JSON Schema verbatim and has nothing to resolve a
 * pointer against, so a `$ref` left in place is an instruction it cannot read.
 * A cycle stops at the pointer, for the reason `resolveRef` explains.
 */
const resolveSchemaRefs = (
  root: Record<string, unknown>,
  value: unknown,
  seen: ReadonlySet<string> = new Set(),
  depth = 0
): unknown => {
  if (depth > MAX_REF_DEPTH) return value
  if (Array.isArray(value)) {
    return value.map((entry) => resolveSchemaRefs(root, entry, seen, depth + 1))
  }
  if (!isObject(value)) return value
  const pointer = value["$ref"]
  if (typeof pointer === "string") {
    if (seen.has(pointer)) return value
    // A copy, because `resolveRef` now mutates what it is given and this
    // set is shared across the sibling branches of the schema walk.
    const resolved = resolveRef(root, value, new Set(seen))
    if (resolved.node === undefined) return value
    return resolveSchemaRefs(
      root,
      resolved.node,
      new Set([...seen, pointer]),
      depth + 1
    )
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = resolveSchemaRefs(root, entry, seen, depth + 1)
  }
  return out
}

export const extractOpenApi = (spec: unknown): Extraction => {
  const skipped: Array<Skipped> = []
  const tools: Array<Descriptor> = []

  const root = asRecord(spec)
  if (root === undefined) {
    return { tools: [], skipped: [{ name: "(spec)", reason: "spec is not an object" }] }
  }

  const paths = asRecord(root["paths"])
  if (paths === undefined) {
    return { tools: [], skipped: [{ name: "(spec)", reason: "spec.paths is missing or not an object" }] }
  }

  for (const [path, item] of Object.entries(paths)) {
    const pathItem = asRecord(item)
    if (pathItem === undefined) continue

    for (const [method, operationRaw] of Object.entries(pathItem)) {
      if (!METHODS.has(method)) continue
      const operation = asRecord(operationRaw)
      if (operation === undefined) continue

      const operationId = typeof operation["operationId"] === "string" ? (operation["operationId"] as string) : undefined
      const summary = typeof operation["summary"] === "string" ? (operation["summary"] as string) : undefined
      const description = typeof operation["description"] === "string" ? (operation["description"] as string) : undefined
      const toolDescription = description ?? summary

      const rawName = operationId ?? `${method}_${path}`
      // Keep dotted operationId as namespace, sanitize each segment. No
      // fallback: `sanitize` ends in `|| "root"`, so every segment is
      // non-empty and the join can never be.
      const toolName = rawName
        .split(".")
        .map((segment) => sanitize(segment))
        .join("_")

      // ---- Decide if this operation should be skipped, with a precise reason ----
      let skipReason: string | undefined

      const rawParameters = Array.isArray(operation["parameters"]) ? (operation["parameters"] as Array<unknown>) : []
      // Resolve once, here, so every later pass sees real parameter objects
      // rather than pointers it would quietly skip for having no `name`.
      const unresolvedRefs: Array<string> = []
      const parameters = rawParameters.map((entry) => {
        const resolved = resolveRef(root, entry)
        if (resolved.unresolved !== undefined) {
          unresolvedRefs.push(resolved.unresolved)
        }
        return resolved.node
      })
      for (const paramRaw of parameters) {
        const param = asRecord(paramRaw)
        if (param === undefined) continue
        // Checked, not asserted, and checked the same way the build loop below
        // does it. When these two disagreed, a non-string `in` matched nothing
        // here (so no skip) and defaulted to "query" there -- quietly sending a
        // header parameter as a query parameter.
        const paramIn = typeof param["in"] === "string" ? param["in"] : undefined
        const rawStyle = param["style"]
        const style = (typeof rawStyle === "string" ? rawStyle : undefined) ?? (paramIn === "query" ? "form" : paramIn === "path" || paramIn === "header" ? "simple" : undefined)
        if (paramIn === "query" && style !== "form" && style !== undefined) {
          skipReason = `unsupported query parameter style "${style}" for "${String(param["name"])}" — only form is supported`
          break
        }
        if ((paramIn === "path" || paramIn === "header") && style !== "simple" && style !== undefined) {
          skipReason = `unsupported ${paramIn} parameter style "${style}" for "${String(param["name"])}" — only simple is supported`
          break
        }
        if (paramIn === "cookie") {
          skipReason = `cookie parameter "${String(param["name"])}" not supported`
          break
        }
        // `explode` *is* evaluated, for object-valued parameters, because the
        // earlier claim that "a wrong explode is tolerated by most servers"
        // holds for an array and not for an object: an unhandled object was
        // sent as the literal `[object Object]`. The four style/explode
        // combinations are implemented in `serializeObjectParam` and its
        // caller; what is refused is a *nested* object or array inside one,
        // which has no encoding outside `deepObject`.
        const paramSchema = asRecord(resolveSchemaRefs(root, param["schema"]))
        if (paramSchema?.["type"] === "object") {
          const properties = asRecord(paramSchema["properties"])
          const nested = properties === undefined
            ? []
            : Object.entries(properties).filter(([, entry]) => {
              const member = asRecord(entry)
              if (member === undefined) return false
              return member["type"] === "object" || member["type"] === "array" ||
                member["properties"] !== undefined || member["items"] !== undefined
            })
          if (nested.length > 0) {
            skipReason =
              `object parameter "${String(param["name"])}" has nested member(s) ${nested.map(([key]) => key).join(", ")} — only flat objects can be encoded as ${style}`
            break
          }
        }
      }
      if (skipReason !== undefined) {
        skipped.push({ name: toolName, reason: skipReason })
        continue
      }

      if (unresolvedRefs.length > 0) {
        // A pointer this module cannot follow -- external, or naming a node
        // that is not in the document -- would become a parameter with no
        // name, which is exactly the silent drop `skipped` exists to replace.
        skipped.push({
          name: toolName,
          reason: `unresolvable parameter $ref: ${unresolvedRefs.join(", ")}`
        })
        continue
      }

      const requestBodyResolved = resolveRef(root, operation["requestBody"])
      if (requestBodyResolved.unresolved !== undefined) {
        skipped.push({
          name: toolName,
          reason: `unresolvable requestBody $ref: ${requestBodyResolved.unresolved}`
        })
        continue
      }
      const requestBody = asRecord(requestBodyResolved.node)
      if (requestBody !== undefined) {
        const content = asRecord(requestBody["content"])
        if (content !== undefined) {
          const contentTypes = Object.keys(content)
          const hasJson = contentTypes.some((type) => type === "application/json" || type.endsWith("+json"))
          if (!hasJson) {
            // No JSON body — this is binary, form, multipart, or streaming.
            const first = contentTypes[0] ?? "(empty)"
            skipped.push({ name: toolName, reason: `requestBody content-type "${first}" not supported — only application/json` })
            continue
          }
          // If there are multiple content types and one is JSON, we use JSON and ignore others.
        }
      }

      const responses = asRecord(operation["responses"])
      if (responses !== undefined) {
        // Check if success response is binary/streaming — if so, skip rather than lie.
        const successKeys = Object.keys(responses).filter((code) => code.startsWith("2"))
        for (const code of successKeys) {
          const response = asRecord((responses as Record<string, unknown>)[code])
          const content = response !== undefined ? asRecord(response["content"]) : undefined
          if (content !== undefined) {
            const types = Object.keys(content)
            const hasJson = types.some((t) => t === "application/json" || t.endsWith("+json") || t === "text/plain" || t === "application/xml" || t === "*/*")
            const hasBinary = types.some((t) => t === "application/octet-stream" || t.startsWith("image/") || t.startsWith("audio/") || t.startsWith("video/"))
            if (hasBinary && !hasJson) {
              skipReason = `response content-type "${types[0]}" is binary/streaming`
              break
            }
          }
        }
        if (skipReason !== undefined) {
          skipped.push({ name: toolName, reason: skipReason })
          continue
        }
      }

      // ---- Build input JSON Schema from parameters + requestBody ----
      const properties: Record<string, JsonSchema.JsonSchema> = {}
      const required: Array<string> = []
      const seenNames = new Set<string>()
      const paramMap: Record<string, ParamMapping> = {}

      for (const paramRaw of parameters) {
        const param = asRecord(paramRaw) as Record<string, unknown> & { name?: string; required?: boolean; schema?: unknown; in?: string }
        const name = typeof param["name"] === "string" ? (param["name"] as string) : undefined
        const paramIn = typeof param["in"] === "string" ? (param["in"] as string) : "query"
        if (name === undefined) continue
        // Flatten path/query/header/body fields into one model-facing object.
        // On cross-location collision, prefix with location (path_id vs query_id) — opencode's default.
        let effectiveName = name
        if (seenNames.has(name)) {
          effectiveName = `${paramIn}_${name}`
        }
        seenNames.add(effectiveName)
        // The spec's own defaults, not a guess: `explode` defaults to true for
        // `form` (query) and false for `simple` (path/header).
        const explode = typeof param["explode"] === "boolean"
          ? param["explode"]
          : paramIn === "query"
        paramMap[effectiveName] = { originalName: name, in: paramIn, explode }
        // The model gets this schema verbatim and has nothing to resolve a
        // pointer against, so references are expanded before it is handed over.
        const paramSchema = param["schema"] === undefined
          ? { type: "string" }
          : resolveSchemaRefs(root, param["schema"])
        properties[effectiveName] = paramSchema as JsonSchema.JsonSchema
        if (param["required"] === true) required.push(effectiveName)
      }

      if (requestBody !== undefined) {
        const content = asRecord(requestBody["content"]) as Record<string, unknown> | undefined
        const jsonContent = content !== undefined ? (content["application/json"] ?? content["application/json; charset=utf-8"] ?? Object.entries(content).find(([k]) => k.endsWith("+json"))?.[1]) : undefined
        const jsonRecord = asRecord(jsonContent)
        const bodySchema = jsonRecord?.["schema"] === undefined
          ? undefined
          : (resolveSchemaRefs(root, jsonRecord["schema"]) as JsonSchema.JsonSchema)
        if (bodySchema !== undefined) {
          // If body schema is an object with properties, flatten them; otherwise nest under `body`.
          const bodyObj = bodySchema as Record<string, unknown>
          if (bodyObj["type"] === "object" && isObject(bodyObj["properties"])) {
            // Hoisted and a Set: the list does not depend on the loop, and
            // `includes` per property is quadratic on a wide body.
            const bodyRequiredNames = new Set(
              Array.isArray(bodyObj["required"])
                ? (bodyObj["required"] as ReadonlyArray<unknown>).filter(
                  (entry): entry is string => typeof entry === "string"
                )
                : []
            )
            for (const [key, schema] of Object.entries(bodyObj["properties"] as Record<string, unknown>)) {
              let effectiveKey = key
              if (seenNames.has(key)) effectiveKey = `body_${key}`
              seenNames.add(effectiveKey)
              paramMap[effectiveKey] = { originalName: key, in: "body", explode: false }
              properties[effectiveKey] = schema as JsonSchema.JsonSchema
              if (bodyRequiredNames.has(key)) required.push(effectiveKey)
            }
          } else {
            // Non-object body — single `body` field carrying the JSON value.
            const bodyKey = seenNames.has("body") ? "body_payload" : "body"
            seenNames.add(bodyKey)
            paramMap[bodyKey] = { originalName: "__body", in: "body", explode: false }
            properties[bodyKey] = bodySchema
            const bodyRequired = (requestBody as Record<string, unknown>)["required"] === true
            if (bodyRequired) required.push(bodyKey)
          }
        }
      }

      const input: JsonSchema.JsonSchema = {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false
      } as JsonSchema.JsonSchema

      const annotations = method.toLowerCase() === "get" ? undefined : { requiresApproval: true as const }

      tools.push({
        name: toolName,
        description: toolDescription,
        input,
        annotations,
        meta: { method, path, paramMap }
      })
    }
  }

  return { tools, skipped }
}

/**
 * Create a `ToolSource` from a parsed OpenAPI document.
 *
 * `spec` is the document value (parsed JSON/YAML). `id` becomes the source's
 * address segment (`tools.<id>.*`). `endpoint` is the base URL (e.g.
 * `https://api.example.com`) — if omitted the first `servers[].url` from the
 * spec is used, or `""` for path-only. `fetch` is `globalThis.fetch` by
 * default, so the source is portable (no `node:*`); a custom fetch can be
 * supplied for testing or for an `HttpClient`-backed transport.
 */
export const makeOpenApiSource = (
  id: string,
  spec: unknown,
  endpoint?: string | OpenApiOptions | undefined,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis) as typeof fetch,
  headers?: Effect.Effect<Headers.Headers, unknown>
): ToolSource => {
  const resolvedEndpoint = isOpenApiOptions(endpoint) ? endpoint.endpoint : typeof endpoint === "string" ? endpoint : undefined
  const resolvedFetchImpl = isOpenApiOptions(endpoint) ? (endpoint.fetchImpl ?? (globalThis.fetch.bind(globalThis) as typeof fetch)) : fetchImpl
  const resolvedHeaders = isOpenApiOptions(endpoint) ? endpoint.headers : headers
  const resolvedCredentials = isOpenApiOptions(endpoint) ? endpoint.credentials : undefined
  const resolvedTimeout = isOpenApiOptions(endpoint) ? (endpoint.timeout ?? FETCH_TIMEOUT) : FETCH_TIMEOUT
  const resolvedMaxRequestBytes = isOpenApiOptions(endpoint) ? (endpoint.maxRequestBytes ?? MAX_REQUEST_BYTES) : MAX_REQUEST_BYTES
  const resolvedMaxResponseBytes = isOpenApiOptions(endpoint) ? (endpoint.maxResponseBytes ?? MAX_RESPONSE_BYTES) : MAX_RESPONSE_BYTES
  const resolvedHttpClient = isOpenApiOptions(endpoint) ? endpoint.httpClient : undefined
  const extraction = extractOpenApi(spec)
  const metaByName = new Map<string, { method: string; path: string; paramMap: Record<string, ParamMapping> }>()
  for (const tool of extraction.tools) {
    const meta = (tool as Descriptor & { meta?: unknown }).meta as
      | { method: string; path: string; paramMap: Record<string, ParamMapping> }
      | undefined
    if (meta !== undefined) metaByName.set(tool.name, meta)
  }

  const baseUrl =
    resolvedEndpoint ??
    (() => {
      const specRecord = asRecord(spec)
      const serversArr = specRecord?.["servers"] as Array<Record<string, unknown>> | undefined
      if (Array.isArray(serversArr) && serversArr.length > 0) {
        const first = serversArr[0] as Record<string, unknown>
        if (typeof first["url"] === "string") return first["url"] as string
      }
      return ""
    })()

  return {
    id,
    extract: Effect.succeed(extraction),
    invoke: (name, args) =>
      Effect.gen(function* () {
        const meta = metaByName.get(name)
        if (meta === undefined) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `tool ${name} not found in extraction` })
        }

        const params = (args ?? {}) as Record<string, unknown>
        // Guard against huge args object (DoS via large JSON)
        const argsJson = JSON.stringify(params)
        if (argsJson.length > resolvedMaxRequestBytes) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `request args too large: ${argsJson.length} bytes > ${resolvedMaxRequestBytes}` })
        }

        let urlPath = meta.path
        const query = new URLSearchParams()
        const paramHeaders: Record<string, string> = {}
        const bodyFields: Record<string, unknown> = {}
        let hasBody = false
        let singleBodyKey: string | undefined
        let singleBodyValue: unknown

        const unknownKeys: Array<string> = []
        for (const [effectiveName, value] of Object.entries(params)) {
          if (effectiveName === "select") continue
          const mapping = meta.paramMap[effectiveName]
          if (mapping === undefined) {
            unknownKeys.push(effectiveName)
            continue
          }
          // Extraction refuses a *schema* that declares a nested member, but a
          // schema can be loose enough to say nothing; this catches the value.
          if (isObject(value) && hasNestedMember(value) && mapping.in !== "body") {
            return yield* new InvocationError({
              sourceId: id,
              toolName: name,
              detail: `parameter "${effectiveName}" is an object with a nested object or array member, which has no form/simple encoding`
            })
          }
          if (mapping.in === "path") {
            // Path injection: encodeURIComponent prevents `../` and `/` traversal
            const rendered = isObject(value)
              ? serializeObjectParam(value, mapping.explode ? "=" : ",", encodeURIComponent)
              : encodeURIComponent(String(value))
            urlPath = urlPath.replaceAll(`{${mapping.originalName}}`, rendered)
          } else if (mapping.in === "query") {
            if (value !== undefined && value !== null) {
              if (Array.isArray(value)) {
                for (const v of value as ReadonlyArray<unknown>) {
                  if (v !== undefined && v !== null) query.append(mapping.originalName, String(v))
                }
              } else if (isObject(value)) {
                if (mapping.explode) {
                  // `style: form, explode: true` — the object's own entries
                  // become top-level pairs, and the parameter's own name
                  // disappears, which is what the spec says and what surprises
                  // people reading the query string.
                  for (const [key, entry] of Object.entries(value)) {
                    if (entry !== undefined && entry !== null) query.append(key, String(entry))
                  }
                } else {
                  query.set(mapping.originalName, serializeObjectParam(value, ",", (part) => part))
                }
              } else {
                query.set(mapping.originalName, String(value))
              }
            }
          } else if (mapping.in === "header") {
            if (value !== undefined && value !== null) {
              const cleanName = sanitizeHeaderName(mapping.originalName)
              const rendered = isObject(value)
                ? serializeObjectParam(value, mapping.explode ? "=" : ",", (part) => part)
                : String(value)
              const cleanValue = sanitizeHeaderValue(rendered)
              if (cleanName.length > 0) paramHeaders[cleanName] = cleanValue
            }
          } else if (mapping.in === "body") {
            if (value === undefined) continue
            if (mapping.originalName === "__body") {
              singleBodyKey = effectiveName
              singleBodyValue = value
              hasBody = true
            } else {
              bodyFields[mapping.originalName] = value
              hasBody = true
            }
          }
        }
        if (unknownKeys.length > 0) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `unknown parameter(s): ${unknownKeys.join(", ")}` })
        }
        const extraHeaders = yield* (resolvedHeaders ?? Effect.succeed(Headers.empty)).pipe(
          Effect.mapError((cause) => new InvocationError({ sourceId: id, toolName: name, detail: `headers resolver failed: ${String(cause)}` }))
        )

        const credentialParts = yield* (resolvedCredentials ?? emptyCredentialParts).pipe(
          Effect.mapError((cause) => new InvocationError({ sourceId: id, toolName: name, detail: `credentials resolver failed: ${String(cause)}` }))
        )
        // Credentials win over anything the model chose: `set`, after the
        // parameter loop, so a tool argument cannot shadow an api key's
        // query name with its own value.
        for (const [key, value] of Object.entries(credentialParts.query)) {
          query.set(key, value)
        }

        // All path params must be supplied — leftover `{param}` means missing required path param
        if (urlPath.includes("{") || urlPath.includes("}")) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `missing required path parameter for ${urlPath}` })
        }

        const queryString = query.toString()
        const url = `${baseUrl.replace(/\/$/, "")}${urlPath}${queryString ? `?${queryString}` : ""}`
        if (url.length > MAX_URL_CHARS) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `URL too long: ${url.length} chars > ${MAX_URL_CHARS}` })
        }

        let body: string | undefined
        if (singleBodyKey !== undefined) {
          body = JSON.stringify(singleBodyValue)
        } else if (hasBody && Object.keys(bodyFields).length > 0) {
          body = JSON.stringify(bodyFields)
        }
        if (body !== undefined && body.length > resolvedMaxRequestBytes) {
          return yield* new InvocationError({ sourceId: id, toolName: name, detail: `request body too large: ${body.length} bytes > ${resolvedMaxRequestBytes}` })
        }

        const baseHeaders: Record<string, string> = {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...paramHeaders
        }
        const allHeaders = Headers.merge(
          Headers.merge(Headers.fromInput(baseHeaders), extraHeaders),
          Headers.fromInput(credentialParts.headers)
        )
        const headersForFetch: Record<string, string> = { ...allHeaders }
        const method = meta.method.toUpperCase()

        let result: unknown
        if (resolvedHttpClient !== undefined) {
          const httpMethod = method as import("effect/unstable/http/HttpMethod").HttpMethod
          const req = HttpClientRequest.make(httpMethod)(url)
          const withHeaders = HttpClientRequest.setHeaders(req, allHeaders)
          const finalReq = body !== undefined ? HttpClientRequest.bodyText(body)(withHeaders) : withHeaders
          const httpResponse = yield* resolvedHttpClient.execute(finalReq).pipe(
            Effect.timeout(resolvedTimeout),
            Effect.catchTag("TimeoutError", () => Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: `fetch timed out after ${Duration.toMillis(resolvedTimeout)}ms` }))),
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
            return yield* new InvocationError({ sourceId: id, toolName: name, detail: `HTTP ${httpResponse.status} ${""}${text ? `: ${text.slice(0, 500)}` : ""}` })
          }
          const contentType = Option.getOrNull(Headers.get(httpResponse.headers, "content-type")) ?? ""
          if (contentType.includes("application/json") || contentType.includes("+json")) {
            const json = yield* httpResponse.json.pipe(
              Effect.mapError((cause: unknown) => new InvocationError({ sourceId: id, toolName: name, detail: `failed to parse JSON response: ${String(cause)}` })),
              Effect.timeout(resolvedTimeout),
              Effect.catchTag("TimeoutError", () => Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: "response body read timed out" })))
            )
            const size = JSON.stringify(json).length
            if (size > resolvedMaxResponseBytes) {
              return yield* new InvocationError({ sourceId: id, toolName: name, detail: `response JSON too large: ${size} bytes > ${resolvedMaxResponseBytes}` })
            }
            result = json
          } else {
            const text = yield* httpResponse.text.pipe(
              Effect.mapError((cause: unknown) => new InvocationError({ sourceId: id, toolName: name, detail: `failed to read response text: ${String(cause)}` })),
              Effect.timeout(resolvedTimeout),
              Effect.catchTag("TimeoutError", () => Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: "response body read timed out" })))
            )
            if (text.length > resolvedMaxResponseBytes) {
              return yield* new InvocationError({ sourceId: id, toolName: name, detail: `response text too large: ${text.length} bytes > ${resolvedMaxResponseBytes}` })
            }
            result = text
          }
        } else {
          /**
           * The signal is what makes the timeout mean anything.
           *
           * `Effect.timeout` alone abandons the promise: the fiber moves on
           * and the request keeps running, holding a connection until the
           * upstream decides otherwise. Against a hung server that is an
           * unbounded leak, one socket per call. `Effect.tryPromise` hands its
           * own `AbortSignal` in, so interruption -- from the timeout, or from
           * a caller cancelling the tool -- actually cancels the request.
           */
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              resolvedFetchImpl(url, {
                method,
                headers: headersForFetch,
                ...(body !== undefined ? { body } : {}),
                signal
              }),
            catch: (cause) => new InvocationError({ sourceId: id, toolName: name, detail: `fetch failed: ${String(cause)}` })
          }).pipe(
            Effect.timeout(resolvedTimeout),
            Effect.catchTag("TimeoutError", () => Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: `fetch timed out after ${Duration.toMillis(resolvedTimeout)}ms` })))
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
            const text = yield* Effect.tryPromise({ try: () => response.text(), catch: () => "" }).pipe(Effect.orElseSucceed(() => ""))
            return yield* new InvocationError({ sourceId: id, toolName: name, detail: `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}` })
          }
          const contentType = (() => {
            try {
              return response.headers.get("content-type") ?? ""
            } catch {
              return ""
            }
          })()
          /**
           * Read the body with a running cap instead of measuring it after.
           *
           * `response.json()` buffers and parses the whole payload before
           * anything can object to its size, so a limit checked afterwards
           * has already been exceeded by the time it fires -- the memory is
           * spent, and on a hostile or merely large upstream that is the
           * failure the limit was meant to prevent. Reading the stream lets it
           * stop at the boundary. The `content-length` check above still helps
           * when the server declares one, but chunked responses do not.
           */
          const text = yield* readBounded(
            response,
            resolvedMaxResponseBytes,
            (detail) => new InvocationError({ sourceId: id, toolName: name, detail })
          ).pipe(
            Effect.timeout(resolvedTimeout),
            Effect.catchTag("TimeoutError", () => Effect.fail(new InvocationError({ sourceId: id, toolName: name, detail: "response body read timed out" })))
          )
          if (contentType.includes("application/json") || contentType.includes("+json")) {
            result = yield* Effect.try({
              try: () => JSON.parse(text) as unknown,
              catch: (cause) => new InvocationError({ sourceId: id, toolName: name, detail: `failed to parse JSON response: ${String(cause)}` })
            })
          } else {
            result = text
          }
        }
        return result
      })
  }
}
