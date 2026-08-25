import type { Tool, Toolkit } from "effect/unstable/ai"
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
 * fallback covers the rest.
 *
 * `Params` and `Result` default to `unknown`, which is what a rule written
 * against the erased registry gets -- it narrows with the helpers below. A
 * rule registered through `withViews` against a real toolkit gets that tool's
 * own types instead, and narrows nothing.
 */
export interface ToolView<Params = unknown, Result = unknown> {
  /** The entry's one-line header. */
  readonly title?: (params: Params) => string | undefined
  /**
   * The structured body drawn beneath it.
   *
   * Receives the call's parameters as well as its result, because what a tool
   * was *asked* to do is often half the story -- `edit_file` returns the text
   * it replaced and the request holds the text that replaced it.
   */
  readonly body?: (result: Result, params: Params) => Body | undefined
  /** How the tool is described when it asks for approval. */
  readonly approval?: (request: Approval) => string | undefined
}

/** The erased registry the renderer holds: any tool name, any rule. */
export type Views = Readonly<Record<string, ToolView>>

/**
 * Rules for a known toolkit, each typed by the tool it renders.
 *
 * The two sides are deliberately different, because the events they come from
 * are different. `ToolCallStarted` carries what the *model* produced, which is
 * the schema's `Encoded` side -- so a rule reads `old_string`, not whatever
 * the decoded type happens to call it. `ToolCallSucceeded` carries the handler's
 * decoded return. Typing both as the decoded `Type` would be the more obvious
 * choice and would be wrong about the half a rule reads most.
 *
 * Optional per key, so a toolkit's tools need not all have rules.
 */
export type ViewsFor<Tools> = {
  readonly [K in keyof Tools & string]?: ToolView<
    Tool.ParametersEncoded<Tools[K]>,
    Tool.Success<Tools[K]>
  >
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

/**
 * How a tool with no rule is described when asking for approval.
 *
 * The subject when there is one, because that is the specific thing about to
 * happen; the resource is the scope the answer will be remembered under, and
 * showing only that hid a URL's path and query behind its origin.
 */
export const fallbackApproval = (request: Approval): string =>
  `${request.toolName} wants to ${request.action}: ${request.subject ?? request.resource}`

// ---------------------------------------------------------------------------
// The default rules: our six tools
// ---------------------------------------------------------------------------

export const defaultViews: Views = {
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
    body: (result, params) => {
      const fields = dict(result)
      const added = num(fields.added)
      const removed = num(fields.removed)
      if (added === undefined || removed === undefined) return undefined
      const strategy = str(fields.strategy)
      const before = str(fields.matched)
      const after = str(dict(params).new_string)
      return {
        type: "structured",
        snapshot: {
          kind: "change",
          path: str(fields.path),
          added,
          removed,
          // Only when the match was not literal: "simple" is the expected
          // case and saying so every time would be noise.
          ...(strategy === "" || strategy === "simple" ? {} : { strategy }),
          ...(before === "" ? {} : { before }),
          ...(after === "" ? {} : { after })
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
/**
 * Register rules for a toolkit's tools, keeping every other rule.
 *
 * The tools are passed for their *type*, and that is the whole point of this
 * signature: a rule for `edit_file` then receives `edit_file`'s parameters,
 * and a typo in a field name is a compile error rather than a blank line at
 * runtime. Without it the registry hands out `unknown` and every consumer
 * writes the cast this exists to remove -- which is exactly what the earlier
 * version of this file made the extension example do.
 *
 * The registry stays *open*. `Tools` comes from whatever is passed, so an
 * application that adds a tool passes its own tools and its own rules are
 * typed too. A closed `keyof` union over our six tools would type the rules we
 * wrote and force a cast on everyone else's, which is the wrong way round.
 *
 * Erasure at the boundary is the library's job: `titleOf` and `bodyOf` receive
 * the same `unknown` they always did, narrowed here, once.
 */
export const withViews = <const Tools extends ReadonlyArray<Tool.Any> | Record<string, Tool.Any>>(
  tools: Tools,
  extra: ViewsFor<Toolkit.ToolsByName<Tools>>,
  base: Views = defaultViews
): Views => ({
  ...base,
  // The one narrowing, here rather than in every consumer. A rule typed for
  // its tool is not assignable to one taking `unknown` -- parameters are
  // contravariant -- and this is the boundary that erasure is *for*: the
  // renderer holds a registry keyed by name, so it cannot hold types. Eating
  // the variance here is what keeps it out of user code.
  ...(extra as Views)
})

export const titleOf = (
  views: Views,
  name: string,
  params: unknown
): string => views[name]?.title?.(params) ?? fallbackTitle(name, params)

export const bodyOf = (
  views: Views,
  name: string,
  result: unknown,
  params: unknown = undefined
): Body => views[name]?.body?.(result, params) ?? fallbackBody(result)

export const approvalOf = (
  views: Views,
  request: Approval
): string => views[request.toolName]?.approval?.(request) ?? fallbackApproval(request)
