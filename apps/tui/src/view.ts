import type { EntryKind } from "./theme.ts"

/**
 * The view model: what the renderer draws, and the only vocabulary it knows.
 *
 * ---------------------------------------------------------------------------
 * Shape ported from opencode, `packages/opencode/src/cli/cmd/run/types.ts`,
 * read at commit 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT, see
 * `vendor/opencode/LICENSE.opencode`.
 *
 * Taken: the idea worth taking, which is **separating an entry's kind from its
 * body**. Their `RunEntryBody` is `none | text | code | markdown | structured`,
 * so one renderer decides *how* to draw content while the entry decides *what*
 * it is. That is what makes a tool result and an assistant message share a
 * renderer instead of each growing their own.
 *
 * Not taken: their concrete types. Theirs derive from `OpencodeClient` --
 * `RunCommand`, `RunProvider`, `PermissionReply` are all `Awaited<ReturnType<...>>`
 * of SDK calls -- so adopting them would pull opencode's session model into our
 * UI through the back door. Their `ToolSnapshot` variants are their tools
 * (task, todo, question); ours are ours.
 *
 * The rule this file exists to hold: **port their renderers to our types, never
 * our types to their renderers.** If a ported renderer needs something absent
 * here, this file grows -- the renderer does not reach past it to the harness.
 * ---------------------------------------------------------------------------
 */

/** Structured tool output, one variant per shape our tools actually return. */
export type ToolSnapshot =
  /** `list_files` -- a directory listing. */
  | {
    readonly kind: "listing"
    readonly items: ReadonlyArray<{ readonly path: string; readonly directory: boolean }>
  }
  /** `search` -- already grouped by file by the tool itself. */
  | { readonly kind: "matches"; readonly text: string; readonly truncated: boolean }
  /** `edit_file` / `write_file` -- a summary of what changed. */
  | {
    readonly kind: "change"
    readonly path: string
    readonly added: number
    readonly removed: number
    readonly strategy?: string
    /**
     * The two sides of the edit: the span as it stood, and what replaced it.
     *
     * Not a file diff -- just the region that changed. `before` is the text
     * that was *actually* matched rather than the text requested, which is the
     * whole point: under any strategy but `simple` those differ, and seeing
     * the difference is how a reader catches an edit that landed somewhere
     * slightly other than intended.
     */
    readonly before?: string
    readonly after?: string
  }
  /** `bash` -- a command's result. */
  | {
    readonly kind: "command"
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }
  /** `read_file` -- file content, already numbered by the tool. */
  | { readonly kind: "file"; readonly path: string; readonly content: string }

/**
 * An entry's content, separate from its kind.
 *
 * `none` is not the same as empty text: a tool that is still running has no
 * body yet, and drawing nothing is different from drawing a blank line.
 */
export type Body =
  | { readonly type: "none" }
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "code"; readonly content: string; readonly filetype?: string }
  | { readonly type: "markdown"; readonly content: string }
  | { readonly type: "structured"; readonly snapshot: ToolSnapshot }

/** How a tool call is going. */
export type ToolStatus = "running" | "ok" | "failed"

/**
 * One line of transcript.
 *
 * Mutable on purpose: a Solid store owns these, and streaming appends and
 * status changes are targeted writes into an existing entry rather than
 * replacements. `readonly` here would mean rebuilding an entry per token.
 */
export interface Entry {
  id: string
  kind: EntryKind
  /** The one-line header: the message text, or the tool's name and arguments. */
  title: string
  body: Body
  /** Present on tool entries only. */
  status?: ToolStatus
  /** True while deltas are still arriving. */
  streaming?: boolean
}

export type Status = "idle" | "working"

/**
 * How far back the conversation can be taken.
 *
 * `depth` is how many turn boundaries have been recorded on this line of work,
 * so `depth <= 1` is what greys out the affordance -- there is nowhere to
 * rewind *to*. The footer needs a number, not a tree.
 */
export interface Rewind {
  readonly depth: number
  /** Non-zero once the user has rewound, so the footer can say so. */
  readonly taken: number
}

/** How the harness pushes into the view model. */
export interface Sink {
  readonly append: (entry: Entry) => void
  readonly patch: (id: string, change: Partial<Entry>) => void
  /** Append a streamed chunk to an existing entry's title. */
  readonly appendTitle: (id: string, delta: string) => void
  readonly setStatus: (status: Status) => void
  /** The footer's active surface; `undefined` returns it to the prompt. */
  readonly setApproval: (request: Approval | undefined) => void
  readonly setRewind: (rewind: Rewind) => void
  /**
   * Name the model and workspace in the footer.
   *
   * Not decoration. A scripted backend answers every prompt from a fixed list
   * and a memory sandbox invents a workspace, so a transcript from one looks
   * exactly like real work. Saying which is running is the difference between
   * a demo and a lie.
   */
  readonly setBackend: (label: string) => void
  /** Open the palette, or `undefined` to return to the prompt. */
  readonly setPalette: (commands: ReadonlyArray<Command> | undefined) => void
  /** Open the branch selector, or `undefined` to return to the prompt. */
  readonly setBranches: (items: ReadonlyArray<BranchItem> | undefined) => void
}

/**
 * Which interactive surface the footer is showing.
 *
 * Ported from opencode's `FooterView` (`vendor/opencode/types.ts`), and their
 * comment is the design: *"Only one view is active at a time. The reducer
 * drives transitions: when a permission arrives the view switches to
 * permission, and when the permission resolves it falls back to prompt."*
 *
 * A union rather than a set of booleans, so "asking for approval while also
 * accepting a prompt" is unrepresentable instead of merely avoided.
 */
export type FooterView =
  | { readonly type: "prompt" }
  | { readonly type: "approval"; readonly request: Approval }
  /** `/` typed at an empty prompt. */
  | { readonly type: "palette"; readonly commands: ReadonlyArray<Command> }
  /** Somewhere else to be. Empty means the tree has only one line of work. */
  | { readonly type: "branches"; readonly items: ReadonlyArray<BranchItem> }

/** One thing the `/` palette can do. */
export interface Command {
  readonly name: string
  readonly description: string
}

/**
 * A branch, as a selector lists it.
 *
 * Flattened from `SessionTree.Summary` on purpose: the renderer should not
 * have to know what a node is, and a list of branch points is a list of
 * strings and one flag whatever the tree underneath looks like.
 */
export interface BranchItem {
  readonly id: string
  /** The lane's name, or the words that started this line of work. */
  readonly label: string
  /** `3 turns · 12 messages`, or similar. */
  readonly detail: string
  /** The one the user is on. A selector that cannot say so is a list. */
  readonly active: boolean
}

/** A tool call waiting on a decision. */
export interface Approval {
  readonly id: string
  readonly toolName: string
  readonly action: string
  readonly resource: string
  readonly reason?: string
}

/** What the UI can ask of the agent. */
export interface Handle {
  readonly submit: (text: string) => void
  readonly interrupt: () => void
  /** Answer the pending approval. Refusal is an answer, not a failure. */
  readonly respond: (id: string, granted: boolean) => void
  /**
   * Take the conversation back one turn and continue from there.
   *
   * The transcript above is deliberately *not* erased. Scrollback is
   * write-once -- a committed line cannot be repainted -- so pretending
   * otherwise would mean either abandoning scrollback or lying about what the
   * user saw. A rewind is marked instead, and what follows continues from the
   * earlier point. The log then records that a rewind happened, which is true
   * and is also what a reader wants.
   */
  readonly rewind: () => void
  /** Run a palette command by name. Unknown names are reported, not ignored. */
  readonly command: (name: string) => void
  /** Switch to a branch by id. */
  readonly switchTo: (id: string) => void
  /** The commands the palette offers. Static, so the renderer can filter. */
  readonly commands: ReadonlyArray<Command>
}
