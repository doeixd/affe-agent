/**
 * One vocabulary for "this must not leave".
 *
 * There are two places content escapes this library -- a tracer's span
 * attributes and an export -- and both already had a `redact` hook of their
 * own shape. Two hooks means two ways to write the same rule and two chances
 * to apply it to only one of them. This is the rule; each of those decides
 * where to apply it.
 *
 * **What this is not: a secret scanner.** It ships a mechanism and two
 * matchers. Claiming to find every secret would be worse than finding none,
 * because a caller who believes it stops looking. `none` is the default
 * everywhere, so redaction is always something someone chose.
 */

/** Rewrite one string. Returns it unchanged when it has nothing to say. */
export interface Rule {
  readonly apply: (text: string) => string
}

/**
 * A redaction: what to do to every string that leaves.
 *
 * Deliberately a transform over *text* rather than over messages or spans.
 * Anything richer would have to know the shape of what it is redacting, and
 * the shapes differ -- which is how a redactor ends up covering tool results
 * and missing the truncation banner that quotes them.
 */
export interface Redaction {
  readonly redact: (text: string) => string
}

/** The default, everywhere. Redaction is always a choice someone made. */
export const none: Redaction = { redact: (text) => text }

/** Apply rules in order; each sees what the last one left. */
export const make = (...rules: ReadonlyArray<Rule>): Redaction => ({
  redact: (text) => rules.reduce((current, rule) => rule.apply(current), text)
})

/**
 * Replace every match of a pattern.
 *
 * The pattern is re-created with the global flag, because a caller who writes
 * `/token=\w+/` means every occurrence -- and a redactor that replaced only
 * the first would be worse than none at all, since it looks like it worked.
 */
export const pattern = (match: RegExp, replacement = "[redacted]"): Rule => {
  const flags = match.flags.includes("g") ? match.flags : `${match.flags}g`
  return { apply: (text) => text.replace(new RegExp(match.source, flags), replacement) }
}

/**
 * Replace an exact string wherever it appears.
 *
 * The most useful matcher in practice, and the one a scanner cannot replace:
 * a caller usually *knows* the secret -- it is the API key they just read from
 * the environment -- and knowing it beats guessing at its shape.
 */
export const literal = (secret: string, replacement = "[redacted]"): Rule => ({
  apply: (text) =>
    secret === "" ? text : text.split(secret).join(replacement)
})

/**
 * `Authorization: Bearer …` and similar.
 *
 * One of the two matchers this ships, chosen because it is unambiguous: a
 * bearer token is never something a reader needed to see.
 */
export const bearerTokens: Rule = pattern(
  /(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
  "$1[redacted]"
)

/**
 * `KEY=value` for names that look like credentials.
 *
 * The second, and the one with a false-positive rate: it is matching a *name*,
 * so a variable called `TOKEN_COUNT` loses its value. That is the right way
 * round for a redactor, and it is why this is not on by default.
 */
export const environmentSecrets: Rule = pattern(
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/g,
  "$1=[redacted]"
)

/**
 * Apply a redaction to every string in a JSON-shaped value.
 *
 * Totality is the whole point, and it is why this walks an *encoded* value
 * rather than a typed one. A redactor written against known fields covers the
 * fields its author thought of: the tool result, usually. It misses the
 * truncation banner that quotes the output, the error message that echoes the
 * command, and the parameters of the call that produced it -- which is exactly
 * where the interesting copy is.
 *
 * Object keys are left alone **by default**, and that default is about
 * structure: in a schema-shaped document a key is a field name, and rewriting
 * one produces something that no longer decodes -- a redactor that corrupts
 * its output has not protected anything, it has just lost it.
 *
 * But a key is not always structure. A tool's parameters or result can be a
 * record whose keys are user or model text -- an environment map, a header
 * set, a file listing -- and there the secret is in the key and this walked
 * straight past it. `keys: true` covers those, and is for values with no
 * schema to break: span attributes, log annotations. `Export.encode` leaves it
 * off and verifies its output instead.
 */
export const deep = (
  value: unknown,
  redaction: Redaction,
  options?: { readonly keys?: boolean | undefined }
): unknown => {
  if (typeof value === "string") return redaction.redact(value)
  if (Array.isArray(value)) return value.map((item) => deep(item, redaction, options))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      options?.keys === true ? redaction.redact(key) : key,
      deep(nested, redaction, options)
    ])
  )
}

/**
 * As the observability package's `redact` hook wants it.
 *
 * `Observability.RedactionPolicy` takes `(value: unknown) => unknown`, and this
 * is that -- so a rule written once covers span attributes and exports both,
 * which is the point of this module existing apart from either.
 */
export const asHook = (redaction: Redaction): (value: unknown) => unknown =>
(value) => deep(value, redaction, { keys: true })

/**
 * As the span-redaction hook wants it, ignoring the attribute's own name.
 *
 * The attribute name is chosen by the instrumentation and is not content, so
 * it is left as it is. Keys *inside* the value are a different matter -- a
 * record of environment variables is data all the way down -- and a span
 * attribute has no schema to corrupt, so they are covered.
 */
export const asSpanHook = (
  redaction: Redaction
): (key: string, value: unknown) => unknown =>
(_key, value) => deep(value, redaction, { keys: true })
