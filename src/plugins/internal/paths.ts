/**
 * The little bit of path arithmetic a plugin launch needs.
 *
 * Written here rather than taken from `node:path` because this module is
 * portable: `scripts/verify-portability.mjs` refuses a host import outside the
 * one module that is allowed one. What is needed is small and lexical -- is
 * this absolute, and what is this relative path joined to that root -- so the
 * cost of owning it is a few lines and the benefit is that a plugin loads the
 * same way on every runtime.
 *
 * Both separator conventions are understood, because a plugin root comes from
 * the host and a Windows host supplies a Windows path, while the manifest's
 * own paths are `/`-separated by specification.
 */

/** A rooted POSIX path, or a Windows drive- or UNC-qualified one. */
export const isAbsolute = (value: string): boolean =>
  value.startsWith("/") ||
  value.startsWith("\\") ||
  /^[A-Za-z]:[\\/]/.test(value)

/** Whichever separator the root already uses, so a joined path stays uniform. */
const separatorOf = (root: string): string =>
  root.includes("\\") && !root.includes("/") ? "\\" : "/"

/**
 * `root` with a plugin-relative path appended.
 *
 * `relative` is the manifest's form: `/`-separated, optionally `./`-prefixed.
 * A leading `./` is dropped rather than preserved, since `root/./x` is only
 * `root/x` written less clearly.
 */
export const join = (root: string, relative: string): string => {
  const separator = separatorOf(root)
  const trimmedRoot = root.endsWith("/") || root.endsWith("\\")
    ? root.slice(0, -1)
    : root
  const parts = relative.split("/").filter((part) => part !== "" && part !== ".")
  return parts.length === 0 ? trimmedRoot : `${trimmedRoot}${separator}${parts.join(separator)}`
}
