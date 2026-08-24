import { Effect, Predicate } from "effect"
import { PluginError, warn } from "./types.js"
import type { Warning } from "./types.js"

/** The canonical Agent Plugins 1.0.0 manifest schema identifier. */
export const SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

/** Plugin name: 1–64 chars, `[a-z0-9.-]`, no leading/trailing separator, no `--`/`..`. */
const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

const KNOWN_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions"
])

const AUTHOR_KEYS = new Set(["name", "email", "url"])

/** The decoded, validated manifest. Optional fields are present only when valid. */
export interface Manifest {
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly author?: { readonly name?: string; readonly email?: string; readonly url?: string }
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: ReadonlyArray<string>
  /** Extension namespaces, kept verbatim. The loader never inspects their contents. */
  readonly extensions?: Readonly<Record<string, unknown>>
}

const fail = (reason: string) => new PluginError({ reason })

// Each helper validates a *present* value (the caller handles absence), so none
// of them ever succeeds with `undefined`.

const requireString = (value: unknown, key: string): Effect.Effect<string, PluginError> =>
  Predicate.isString(value) ? Effect.succeed(value) : Effect.fail(fail(`plugin.json "${key}" must be a string`))

const decodeAuthor = (value: unknown): Effect.Effect<
  { readonly name?: string; readonly email?: string; readonly url?: string },
  PluginError
> => {
  if (!Predicate.isObject(value)) return Effect.fail(fail("plugin.json \"author\" must be an object"))
  const author: { name?: string; email?: string; url?: string } = {}
  for (const key of Object.keys(value)) {
    if (!AUTHOR_KEYS.has(key)) return Effect.fail(fail(`plugin.json "author" has an unknown field "${key}"`))
    const field = value[key]
    if (!Predicate.isString(field)) return Effect.fail(fail(`plugin.json "author.${key}" must be a string`))
    if (key === "name") author.name = field
    else if (key === "email") author.email = field
    else if (key === "url") author.url = field
  }
  return Effect.succeed(author)
}

const decodeKeywords = (value: unknown): Effect.Effect<ReadonlyArray<string>, PluginError> => {
  if (!Array.isArray(value)) return Effect.fail(fail("plugin.json \"keywords\" must be an array"))
  if (!value.every(Predicate.isString)) return Effect.fail(fail("plugin.json \"keywords\" must be an array of strings"))
  return Effect.succeed(value)
}

/**
 * Parse and validate a `plugin.json` document.
 *
 * Fatal (fails with `PluginError`): not valid JSON, not an object, wrong or
 * missing `$schema`, missing or malformed `name`, and any typed field of the
 * wrong shape (`version`, `author`, `keywords`, …). Non-fatal (a `Warning`, then
 * ignored): an unknown top-level field, and a non-object `extensions`. This is
 * exactly the spec's failure split — only the two documented exceptions are
 * non-fatal; everything else rejects the plugin.
 */
export const decodeManifest = (
  text: string
): Effect.Effect<{ readonly manifest: Manifest; readonly warnings: ReadonlyArray<Warning> }, PluginError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => fail("plugin.json is not valid JSON")
    })
    if (!Predicate.isObject(raw)) return yield* fail("plugin.json must be a JSON object")

    // Required: $schema must be the canonical v1 identifier.
    if (raw["$schema"] !== SCHEMA_ID) return yield* fail(`plugin.json "$schema" must be "${SCHEMA_ID}"`)

    // Required: a valid name.
    const name = raw["name"]
    if (!Predicate.isString(name)) return yield* fail("plugin.json \"name\" is required and must be a string")
    if (name.length < 1 || name.length > 64 || !NAME_PATTERN.test(name)) {
      return yield* fail(`plugin.json "name" is invalid: "${name}"`)
    }

    const warnings: Array<Warning> = []

    // Non-fatal: unknown top-level fields are reported and ignored.
    for (const key of Object.keys(raw)) {
      if (!KNOWN_KEYS.has(key)) warnings.push(warn("manifest", `ignored unknown field "${key}"`))
    }

    // Typed optional fields — decoded only when present, fatal on the wrong type.
    // Absence is a plain `undefined`, never an `Effect.succeed(undefined)`.
    const version = raw["version"] === undefined ? undefined : yield* requireString(raw["version"], "version")
    const description = raw["description"] === undefined ? undefined : yield* requireString(raw["description"], "description")
    const homepage = raw["homepage"] === undefined ? undefined : yield* requireString(raw["homepage"], "homepage")
    const repository = raw["repository"] === undefined ? undefined : yield* requireString(raw["repository"], "repository")
    const license = raw["license"] === undefined ? undefined : yield* requireString(raw["license"], "license")
    const author = raw["author"] === undefined ? undefined : yield* decodeAuthor(raw["author"])
    const keywords = raw["keywords"] === undefined ? undefined : yield* decodeKeywords(raw["keywords"])

    // Non-fatal: a non-object `extensions` is reported and ignored.
    let extensions: Readonly<Record<string, unknown>> | undefined
    const rawExtensions = raw["extensions"]
    if (rawExtensions !== undefined) {
      if (Predicate.isObject(rawExtensions)) extensions = rawExtensions
      else warnings.push(warn("manifest", "ignored non-object \"extensions\""))
    }

    const manifest: Manifest = {
      name,
      ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }),
      ...(author === undefined ? {} : { author }),
      ...(homepage === undefined ? {} : { homepage }),
      ...(repository === undefined ? {} : { repository }),
      ...(license === undefined ? {} : { license }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(extensions === undefined ? {} : { extensions })
    }
    return { manifest, warnings }
  })
