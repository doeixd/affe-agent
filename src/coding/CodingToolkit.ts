import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as Permission from "../Permission.js"
import * as Sandbox from "../sandbox/Sandbox.js"

/**
 * A coding agent's tools, over the sandbox seam (issue #4 item 2).
 *
 * This is a *battery*, not a core capability: every tool is an ordinary
 * Effect AI `Tool` whose handler depends on `Sandbox.Current`, exactly as a
 * user would write. Nothing here changes the agent core, and which sandbox
 * runs -- an in-memory one for tests, a real directory on disk -- arrives
 * through layer wiring, invisible to the tools. That a serious coding toolkit
 * needs no core change is the point.
 *
 * Two things it adds beyond the raw sandbox:
 *
 * - **Ergonomics a model needs.** `read_file` numbers lines and takes a
 *   range; `edit_file` is an exact string replace that refuses an ambiguous
 *   match, the way a careful editor does; `search` walks the tree in process
 *   so it works against any provider, not only one with `grep`.
 * - **A permission projection on every tool** (`Permission.annotate`). A file
 *   tool projects to `read`/`write` on the path; `bash` projects to `shell`
 *   on the command. So a `Permission` policy can allow reads, ask before
 *   writes outside `src/`, and deny `rm -rf` -- without the policy knowing
 *   anything about these tools' parameter shapes.
 *
 * Failures are returned to the model as strings: a bad path, a missing file
 * or an ambiguous edit is something the model can correct on the next turn,
 * so it is a `failure` value rather than a defect that fails the run.
 */

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Read a file, optionally a line range, with 1-based line numbers. */
export const ReadFile = Permission.annotate(
  Tool.make("read_file", {
    parameters: Schema.Struct({
      path: Schema.String,
      /** First line to return, 1-based. Omit to start at the top. */
      offset: Schema.optional(Schema.Number),
      /** How many lines to return. Omit for the whole file from `offset`. */
      limit: Schema.optional(Schema.Number)
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "read", resource: (params) => params.path }
)

/** Create or overwrite a file. */
export const WriteFile = Permission.annotate(
  Tool.make("write_file", {
    parameters: Schema.Struct({
      path: Schema.String,
      content: Schema.String
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "write", resource: (params) => params.path }
)

/**
 * Replace an exact string in a file. Fails if it is not found, or found more
 * than once and `replace_all` was not set -- an ambiguous edit is a mistake,
 * not a coin flip.
 */
export const EditFile = Permission.annotate(
  Tool.make("edit_file", {
    parameters: Schema.Struct({
      path: Schema.String,
      old_string: Schema.String,
      new_string: Schema.String,
      replace_all: Schema.optional(Schema.Boolean)
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "write", resource: (params) => params.path }
)

/** List a directory's entries. */
export const ListFiles = Permission.annotate(
  Tool.make("list_files", {
    parameters: Schema.Struct({
      path: Schema.optional(Schema.String)
    }),
    success: Schema.Array(
      Schema.Struct({ path: Schema.String, type: Schema.Literals(["file", "directory"]) })
    ),
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "read", resource: (params) => params.path ?? "." }
)

/** Search file contents for a regular expression, walking the tree in process. */
export const Search = Permission.annotate(
  Tool.make("search", {
    parameters: Schema.Struct({
      pattern: Schema.String,
      /** Restrict to this subtree. Omit to search the whole workspace. */
      path: Schema.optional(Schema.String)
    }),
    success: Schema.Array(
      Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String })
    ),
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "read", resource: (params) => params.pattern }
)

/**
 * Run a shell command in the workspace.
 *
 * The command is one string a shell interprets (`bash -lc`), which is what a
 * model expects of a shell tool; the sandbox's isolation still bounds what it
 * can touch. `action: "shell"` on the command is what a policy gates, so
 * `git status` can be allowed and `git push` asked about.
 */
export const Bash = Permission.annotate(
  Tool.make("bash", {
    parameters: Schema.Struct({
      command: Schema.String,
      /** Kill the command after this many milliseconds. Provider default otherwise. */
      timeout_ms: Schema.optional(Schema.Number)
    }),
    success: Schema.Struct({
      exit_code: Schema.Number,
      stdout: Schema.String,
      stderr: Schema.String
    }),
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "shell", resource: (params) => params.command }
)

/** Every tool the toolkit provides, annotated for policy. */
export const tools = [ReadFile, WriteFile, EditFile, ListFiles, Search, Bash] as const

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const errorMessage = (error: { readonly message: string }): string => error.message

const numberLines = (text: string, from: number): string =>
  text.split("\n").map((line, i) => `${from + i}\t${line}`).join("\n")

/** Recursively list every file under a directory, depth-first and deterministic. */
const walk = (
  sandbox: Sandbox.Sandbox,
  root: Sandbox.SandboxPath | undefined
): Effect.Effect<ReadonlyArray<Sandbox.SandboxPath>, string> =>
  Effect.gen(function* () {
    const entries = yield* sandbox.list(root).pipe(Effect.mapError(errorMessage))
    const files: Array<Sandbox.SandboxPath> = []
    for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (entry.type === "file") {
        files.push(entry.path)
      } else {
        files.push(...(yield* walk(sandbox, entry.path)))
      }
    }
    return files
  })

/**
 * The handlers, typed against the tools so every parameter infers from its
 * schema. Errors reach the model as strings it can act on.
 */
export const handlers: Toolkit.HandlersFrom<Toolkit.ToolsByName<typeof tools>> = {
  read_file: ({ limit, offset, path: file }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const text = yield* Sandbox.readText(sandbox)(yield* Sandbox.path(file))
      const start = offset ?? 1
      const slice = text
        .split("\n")
        .slice(start - 1, limit === undefined ? undefined : start - 1 + limit)
      return numberLines(slice.join("\n"), start)
    }).pipe(Effect.mapError(errorMessage)),

  write_file: ({ content, path: file }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      yield* sandbox.write(yield* Sandbox.path(file), content)
      return `wrote ${file} (${content.length} bytes)`
    }).pipe(Effect.mapError(errorMessage)),

  edit_file: ({ new_string, old_string, path: file, replace_all }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const sandboxPath = yield* Sandbox.path(file).pipe(Effect.mapError(errorMessage))
      const text = yield* Sandbox.readText(sandbox)(sandboxPath).pipe(Effect.mapError(errorMessage))
      const occurrences = old_string === "" ? 0 : text.split(old_string).length - 1
      if (occurrences === 0) {
        return yield* Effect.fail(`old_string was not found in ${file}`)
      }
      if (occurrences > 1 && replace_all !== true) {
        return yield* Effect.fail(
          `old_string is not unique in ${file} (${occurrences} matches); pass replace_all or include more context`
        )
      }
      const next = replace_all === true
        ? text.split(old_string).join(new_string)
        : text.replace(old_string, new_string)
      yield* sandbox.write(sandboxPath, next).pipe(Effect.mapError(errorMessage))
      return `edited ${file} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`
    }),

  list_files: ({ path: dir }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const at = dir === undefined ? undefined : yield* Sandbox.path(dir)
      const entries = yield* sandbox.list(at)
      return entries.map((entry) => ({ path: entry.path, type: entry.type }))
    }).pipe(Effect.mapError(errorMessage)),

  search: ({ path: dir, pattern }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const regex = yield* Effect.try({
        try: () => new RegExp(pattern),
        catch: () => `invalid regular expression: ${pattern}`
      })
      const at = dir === undefined ? undefined : yield* Sandbox.path(dir).pipe(Effect.mapError(errorMessage))
      const files = yield* walk(sandbox, at)
      const hits: Array<{ path: string; line: number; text: string }> = []
      for (const file of files) {
        const text = yield* Sandbox.readText(sandbox)(file).pipe(Effect.mapError(errorMessage))
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            hits.push({ path: file, line: i + 1, text: lines[i]! })
          }
        }
      }
      return hits
    }),

  bash: ({ command, timeout_ms }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const result = yield* sandbox.exec(
        Sandbox.command("bash", ["-lc", command]),
        timeout_ms === undefined ? undefined : { timeout: timeout_ms }
      )
      return {
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      }
    }).pipe(Effect.mapError(errorMessage))
}

// ---------------------------------------------------------------------------
// The toolkit
// ---------------------------------------------------------------------------

/**
 * The tools bound to their handlers, for
 * `Agent.make({ toolkit: CodingToolkit.toolkit() })`. The sandbox provider is
 * the application's to supply (`Sandbox.currentLayer` over a provider); a
 * `Permission` policy is optional and composes as usual.
 */
export const toolkit = () => Agent.toolkit(tools, handlers)
