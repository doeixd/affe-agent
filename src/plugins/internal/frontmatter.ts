import { Option } from "effect"

/**
 * A parsed `SKILL.md` frontmatter block and the markdown body after it.
 *
 * `fields` holds the flat scalar keys (`name`, `description`, `license`,
 * `compatibility`, `allowed-tools`); `metadata` holds the one nested block the
 * Agent Skills spec defines (a flat string→string map). Anything outside this
 * shape is ignored rather than errored — the spec's non-fatal stance — so the
 * caller decides validity from the required fields it finds (`name`,
 * `description`), not from parser failure.
 */
export interface Frontmatter {
  readonly fields: Readonly<Record<string, string>>
  readonly metadata: Readonly<Record<string, string>>
  readonly body: string
}

/** Strip one layer of matching single or double quotes; otherwise return as-is. */
const unquote = (value: string): string => {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "\"" || first === "'") && last === first) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Split a `key: value` line on the first colon. `None` if there is no colon. */
const splitPair = (line: string): Option.Option<{ readonly key: string; readonly value: string }> => {
  const colon = line.indexOf(":")
  if (colon === -1) return Option.none()
  return Option.some({
    key: line.slice(0, colon).trim(),
    value: unquote(line.slice(colon + 1).trim())
  })
}

const isIndented = (line: string): boolean => line.length > 0 && (line[0] === " " || line[0] === "\t")

/**
 * Parse the leading `---` … `---` frontmatter fence of a `SKILL.md` document.
 *
 * Returns `None` when the document does not open with a well-formed fence (no
 * leading `---`, or no closing `---`), which the caller treats as "no
 * frontmatter" — i.e. an invalid skill to skip. This is deliberately not a
 * general YAML parser: it accepts the documented Agent Skills subset (flat
 * scalars plus one `metadata` map) and quietly ignores anything else, so
 * malformed extras never crash a load.
 */
export const parse = (text: string): Option.Option<Frontmatter> => {
  // Tolerate a leading UTF-8 BOM (even repeated) and CRLF endings.
  const normalised = text.replace(/^﻿+/, "").replace(/\r\n/g, "\n")

  // The document must open with a `---` fence on its own line.
  if (!normalised.startsWith("---\n") && normalised !== "---") return Option.none()

  const lines = normalised.split("\n")
  // lines[0] is the opening "---". Find the closing "---".
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i
      break
    }
  }
  if (close === -1) return Option.none() // no closing fence -> malformed

  const fields: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  let inMetadata = false

  for (let i = 1; i < close; i++) {
    const line = lines[i]!
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue

    if (inMetadata && isIndented(line)) {
      // A member of the `metadata:` block.
      const pair = splitPair(line)
      if (Option.isSome(pair) && pair.value.key !== "") {
        metadata[pair.value.key] = pair.value.value
      }
      continue
    }

    // A top-level line ends any metadata block.
    inMetadata = false
    const pair = splitPair(line)
    if (Option.isNone(pair) || pair.value.key === "") continue

    if (pair.value.key === "metadata" && pair.value.value === "") {
      // `metadata:` with no inline value opens the nested block.
      inMetadata = true
      continue
    }
    fields[pair.value.key] = pair.value.value
  }

  // Body is everything after the closing fence line, with a single leading
  // newline consumed so `--- \n\nbody` and `---\nbody` both start at `body`.
  const body = lines.slice(close + 1).join("\n").replace(/^\n/, "")

  return Option.some({ fields, metadata, body })
}
