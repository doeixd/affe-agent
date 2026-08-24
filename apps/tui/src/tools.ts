import type { Approval, Body } from "./view.ts"

/**
 * How each tool is rendered: one rule per tool, in one place.
 *
 * ---------------------------------------------------------------------------
 * Architecture ported from opencode,
 * `packages/opencode/src/cli/cmd/run/tool.ts`, read at commit
 * 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT, see
 * `vendor/opencode/LICENSE.opencode`.
 *
 * Taken: the **registry**, which is the portable part of their 1,486 lines --
 * not the eighteen rules inside it, which render their tools. Theirs is
 * `ToolRule = { view, run, scroll?, permission?, snap? }` keyed by tool name;
 * ours keeps the three of those that mean anything here. Everything about how
 * one tool looks lives together, and a tool that wants no structured body just
 * omits `body`.
 *
 * Their narrowing helpers (`dict`, `text`, `num`, `list`) are ported too, and
 * for the same reason they exist there: a registry keyed by name receives
 * `unknown`, because the agent decodes each result against that tool's own
 * schema and the type does not survive into a generic event.
 *
 * **The one deliberate divergence: theirs is closed, ours is open.** Their
 * `type ToolName = keyof ToolDefs` fixes eighteen tools at compile time, which
 * is right for a fixed tool set. Ours is a `Record<string, ToolView>` with a
 * fallback, because the coding toolkit is built to be extended --
 * `test/CodingComposition.test.ts` in the main library exists to prove an
 * application can replace, subset or add tools. A closed registry would mean a
 * user who adds a tool must edit this file to make it render.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/** An object's own properties, or `{}` for anything that is not one. */
export const dict = (value: unknown): Record<string, unknown> =>
  value === null || typeof value !== "object" || Array.isArray(value) ? {} : { ...value }

/** A string, or `""`. */
export const str = (value: unknown): string => (typeof value === "string" ? value : "")

/** A finite number, or `undefined`. */
export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** An array, or `[]`. */
export const list = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : []

/** `n label` / `n labels`, so counts read as prose. */
export const count = (n: number, label: string): string =>
  `${n} ${label}${n === 1 ? "" : "s"}`

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * How one tool is presented.
 *
 * Every field is optional: a rule supplies only what it improves on, and the
 * fallback covers the rest. Each receives `unknown` -- see the note above --
 * so a rule narrows with the helpers before reading anything.
 */
export interface ToolView {
  /** The entry's one-line header. */
  readonly title?: (params: unknown) => string | undefined
  /** The structured body drawn beneath it. */
  readonly body?: (result: unknown) => Body | undefined
  /** How the tool is described when it asks for approval. */
  readonly approval?: (request: Approval) => string | undefined
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

/**
 * Scalar fields as `[key=value, ...]`, or `""`.
 *
 * Their `info()`, and the reason it exists is worth keeping: for a tool nobody
 * wrote a rule for, showing *something* about its arguments beats showing the
 * name alone. Only scalars, so a nested object cannot flood the line.
 */
export const info = (
  params: unknown,
  skip: ReadonlyArray<string> = []
): string => {
  const shown = Object.entries(dict(params)).filter(([key, value]) =>
    !skip.includes(key) &&
    (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
  )
  return shown.length === 0
    ? ""
    : `[${shown.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

/**
 * The header for a tool with no rule.
 *
 * The most identifying argument if one of the usual suspects is present,
 * otherwise every scalar field. An unknown tool must still render legibly:
 * that is the whole reason the fallback is required rather than optional.
 */
export const fallbackTitle = (name: string, params: unknown): string => {
  const fields = dict(params)
  const detail = [fields.command, fields.pattern, fields.path, fields.query]
    .map(str)
    .find((value) => value !== "")
  if (detail !== undefined) return `${name} ${detail}`
  const rest = info(params)
  return rest === "" ? name : `${name} ${rest}`
}

/** The body for a tool with no rule: whatever it returned, as text. */
export const fallbackBody = (result: unknown): Body =>
  typeof result === "string"
    ? { type: "text", content: result }
    : { type: "text", content: JSON.stringify(result) ?? "" }

/** How a tool with no rule is described when asking for approval. */
export const fallbackApproval = (request: Approval): string =>
  `${request.toolName} wants to ${request.action}: ${request.resource}`

// ---------------------------------------------------------------------------
// The default rules: our six tools
// ---------------------------------------------------------------------------

export const defaultViews: Readonly<Record<string, ToolView>> = {
  list_files: {
    body: (result) => ({
      type: "structured",
      snapshot: {
        kind: "listing",
        items: list(result).flatMap((entry) => {
          const fields = dict(entry)
          const path = str(fields.path)
          return path === "" ? [] : [{ path, directory: fields.type === "directory" }]
        })
      }
    })
  },

  search: {
    title: (params) => {
      const fields = dict(params)
      const pattern = str(fields.pattern)
      const where = str(fields.path)
      const include = str(fields.include)
      const scope = [where === "" ? undefined : `in ${where}`, include === "" ? undefined : include]
        .filter((part) => part !== undefined)
        .join(" ")
      return scope === "" ? `search "${pattern}"` : `search "${pattern}" ${scope}`
    },
    body: (result) =>
      typeof result !== "string" ? undefined : {
        type: "structured",
        snapshot: {
          kind: "matches",
          text: result,
          truncated: result.includes("Results truncated")
        }
      }
  },

  read_file: {
    body: (result) =>
      typeof result === "string" ? { type: "code", content: result } : undefined
  },

  bash: {
    body: (result) => {
      const fields = dict(result)
      const exitCode = num(fields.exit_code)
      return exitCode === undefined ? undefined : {
        type: "structured",
        snapshot: {
          kind: "command",
          exitCode,
          stdout: str(fields.stdout),
          stderr: str(fields.stderr)
        }
      }
    },
    // A command is its own best description; naming the tool adds nothing.
    approval: (request) => `run: ${request.resource}`
  },

  edit_file: {
    title: (params) => {
      const path = str(dict(params).path)
      return path === "" ? "edit_file" : `edit ${path}`
    },
    // `edit_file` returns a record rather than a sentence, so the change is
    // rendered from fields instead of parsed out of prose.
    body: (result) => {
      const fields = dict(result)
      const added = num(fields.added)
      const removed = num(fields.removed)
      if (added === undefined || removed === undefined) return undefined
      const strategy = str(fields.strategy)
      return {
        type: "structured",
        snapshot: {
          kind: "change",
          path: str(fields.path),
          added,
          removed,
          // Only when the match was not literal: "simple" is the expected
          // case and saying so every time would be noise.
          ...(strategy === "" || strategy === "simple" ? {} : { strategy })
        }
      }
    },
    approval: (request) => `edit ${request.resource}`
  },

  write_file: {
    title: (params) => {
      const path = str(dict(params).path)
      return path === "" ? "write_file" : `write ${path}`
    },
    approval: (request) => `overwrite ${request.resource}`
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The rules, with an application's own added.
 *
 * The extension point the closed version cannot have: an application that adds
 * a tool to the toolkit adds its rendering the same way, without editing this
 * file. A name present in both wins from `extra`, so a rule here can be
 * replaced as well as extended -- the same rule `Agent.toolkit` follows for
 * handlers.
 */
export const withViews = (
  extra: Readonly<Record<string, ToolView>>,
  base: Readonly<Record<string, ToolView>> = defaultViews
): Readonly<Record<string, ToolView>> => ({ ...base, ...extra })

export const titleOf = (
  views: Readonly<Record<string, ToolView>>,
  name: string,
  params: unknown
): string => views[name]?.title?.(params) ?? fallbackTitle(name, params)

export const bodyOf = (
  views: Readonly<Record<string, ToolView>>,
  name: string,
  result: unknown
): Body => views[name]?.body?.(result) ?? fallbackBody(result)

export const approvalOf = (
  views: Readonly<Record<string, ToolView>>,
  request: Approval
): string => views[request.toolName]?.approval?.(request) ?? fallbackApproval(request)
