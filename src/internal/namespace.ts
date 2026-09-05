/**
 * The one place the package's wire-level and storage-level identifiers are
 * spelled (`docs/plan-two-decisions.md`, decision 1, 2026-09-05).
 *
 * Every `_tag` a `Schema.TaggedError` puts on a wire, every `Context`
 * service key, every `Schema.brand`, every SQL table default and every
 * persisted key prefix this package mints is built from the three roots
 * below. They are spelled as the package was called when they were frozen,
 * and that is a coincidence the reader should not lean on: **they are not
 * the package name and will not follow a rename.** A rename once orphaned
 * every table and checkpoint and made two versions' relay errors mutually
 * unreadable; these constants are why that cannot happen again.
 *
 * Two checks hold the line, because they catch different things:
 * `test/Namespace.test.ts` compares every identifier the code emits against
 * `test/fixtures/namespace-manifest.json`, whose values are written out and
 * do not derive from these constants (so editing a root fails the build); and
 * the claims checker's `no-grep` pins hold that no literal `"affe-agent/`,
 * `"affe_` or `"affe-agent:` appears in `src` outside this file (so a tag
 * cannot creep back as a string).
 *
 * The one deliberate exception is `Sandbox`'s default workspace directory,
 * `/tmp/affe-agent/<workspace>`: a local path on the machine running the
 * agent, not an identifier another party reads.
 */

/** The root of every tag, service key and brand: `affe-agent/<name>`. */
export const NAMESPACE = "affe-agent"
/** The root of every SQL table default: `affe_<name>`. */
export const TABLE_PREFIX = "affe_"

/**
 * A wire tag, service key or brand. The return type is the literal, so a
 * `Schema.TaggedError` keeps a literal `_tag` and `catchTag` still narrows.
 */
export const tag = <const Name extends string>(name: Name): `${typeof NAMESPACE}/${Name}` =>
  `${NAMESPACE}/${name}`

/** A SQL table default. */
export const table = <const Name extends string>(name: Name): `${typeof TABLE_PREFIX}${Name}` =>
  `${TABLE_PREFIX}${name}`

/** A persisted key prefix, `affe-agent:<name>:`, for a `KeyValueStore.prefix`. */
export const keyPrefix = <const Name extends string>(name: Name): `${typeof NAMESPACE}:${Name}:` =>
  `${NAMESPACE}:${name}:`
