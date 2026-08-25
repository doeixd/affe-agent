import { Effect, HashMap, Option, Schema, Semaphore, TxRef } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as Permission from "../Permission.js"
import * as Sandbox from "../sandbox/Sandbox.js"
import * as LineEndings from "./internal/lineEndings.js"
import * as Glob from "./internal/glob.js"
import * as Prompts from "./internal/prompts.js"
import * as ReadFormat from "./internal/readFormat.js"
import * as SearchFormat from "./internal/searchFormat.js"
import * as Truncate from "./internal/truncate.js"
import * as Replace from "./internal/replace.js"

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
 *
 * ## Making it yours
 *
 * The battery is a starting point, not a package deal. `tools` and `handlers`
 * are ordinary values, so the four things an application usually wants are all
 * ordinary composition -- no casts, and parameters still infer:
 *
 * **Replace one implementation**, keeping the rest. An application with its own
 * index answers `search` itself:
 *
 * ```ts
 * Agent.toolkit(CodingToolkit.tools, {
 *   ...CodingToolkit.handlers,
 *   search: ({ pattern }) => myIndex.query(pattern)   // `pattern` is string
 * })
 * ```
 *
 * Passed inline like this, the parameter position supplies the type. If you
 * want to name the record first, annotate it -- a bare object literal has no
 * contextual type, so the override's parameters would otherwise infer as `any`:
 *
 * ```ts
 * const handlers: typeof CodingToolkit.handlers = {
 *   ...CodingToolkit.handlers,
 *   search: ({ pattern }) => myIndex.query(pattern)
 * }
 * ```
 *
 * **Take a subset** -- a read-only agent is a shorter array:
 *
 * ```ts
 * Agent.toolkit([CodingToolkit.ReadFile, CodingToolkit.ListFiles], {
 *   read_file: CodingToolkit.handlers.read_file,
 *   list_files: CodingToolkit.handlers.list_files
 * })
 * ```
 *
 * **Add your own tool** beside them:
 *
 * ```ts
 * Agent.toolkit([...CodingToolkit.tools, Deploy], {
 *   ...CodingToolkit.handlers,
 *   deploy: ({ environment }) => ship(environment)
 * })
 * ```
 *
 * **Use one tool on its own**, bound to its handler:
 *
 * ```ts
 * Agent.tool(CodingToolkit.ReadFile, CodingToolkit.handlers.read_file)
 * ```
 *
 * A replacement tool of your own carries its own `Permission.annotate`, so a
 * remote `search` can project to `net` on the domain while the shipped one
 * projects to `read`. `test/CodingComposition.test.ts` exercises all of these,
 * with compile-time assertions that the inference does not degrade to `any`.
 */

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Read a file, optionally a line range, with 1-based line numbers. */
export const ReadFile = Permission.annotate(
  Tool.make("read_file", {
    description: Prompts.READ_FILE,
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
    description: Prompts.WRITE_FILE,
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
 * Replace a string in a file, tolerating the ways a model's quotation drifts
 * from the file (indentation, trailing whitespace, over-escaped `\n`, a
 * reformatted block middle) without ever guessing.
 *
 * Fails if the text is not found, if it is found in more than one place and
 * `replace_all` was not set, or if the closest match is far larger than what
 * was asked for -- an ambiguous edit is a mistake, not a coin flip. See
 * `internal/replace.ts` for how the strategies stay safe.
 */
export const EditFile = Permission.annotate(
  Tool.make("edit_file", {
    description: Prompts.EDIT_FILE,
    parameters: Schema.Struct({
      path: Schema.String,
      old_string: Schema.String,
      new_string: Schema.String,
      replace_all: Schema.optional(Schema.Boolean)
    }),
    /**
     * What changed, structured.
     *
     * A record rather than a sentence, for the same reason `bash` returns
     * `{exit_code, stdout, stderr}`: the caller should not have to parse prose
     * to learn what happened. `strategy` is the part worth having explicitly --
     * anything but `"simple"` means the text matched was not the text supplied,
     * so the model's copy of the file has drifted and it should re-read before
     * editing again.
     */
    success: Schema.Struct({
      path: Schema.String,
      replacements: Schema.Number,
      added: Schema.Number,
      removed: Schema.Number,
      strategy: Schema.String,
      /**
       * The text that was actually replaced, exactly as it stood in the file.
       *
       * Not the same as `old_string` whenever `strategy` is anything but
       * `"simple"`: the matching chain selects a span that *resembles* what was
       * supplied, so this is the only way for a caller to see what an edit
       * really did. Bounded by the size of the edit rather than the file, and
       * the proportionality guard already refuses a span far larger than asked
       * for.
       */
      matched: Schema.String
    }),
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "write", resource: (params) => params.path }
)

/** List a directory's entries. */
export const ListFiles = Permission.annotate(
  Tool.make("list_files", {
    description: Prompts.LIST_FILES,
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

/**
 * Search file contents for a regular expression, walking the tree in process.
 *
 * Results are grouped by file and bounded: the search stops once it has enough
 * and says so, rather than returning a wall of matches nobody asked for.
 */
export const Search = Permission.annotate(
  Tool.make("search", {
    description: Prompts.SEARCH,
    parameters: Schema.Struct({
      pattern: Schema.String,
      /** Restrict to this subtree. Omit to search the whole workspace. */
      path: Schema.optional(Schema.String),
      /** Only search files whose name matches this glob, e.g. `*.ts`. */
      include: Schema.optional(Schema.String)
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  {
    action: "read",
    /**
     * The subtree being read, not the query used to read it.
     *
     * This projected `params.pattern`, which is the regular expression -- so
     * a path-scoped policy could neither authorize nor refuse the directory
     * whose contents were about to be disclosed, and an approval prompt
     * showed a regex where the sensitive thing was the location. The
     * operation reads every eligible file below `path`; that is the resource.
     */
    resource: (params) => params.path ?? ".",
    /**
     * The question names the query too, because a person deciding wants both:
     * what is being read, and what is being looked for in it. The *scope* is
     * still the directory, which is what an "always" would remember.
     */
    describe: (params) => `${params.pattern} in ${params.path ?? "."}`
  }
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
    description: Prompts.BASH,
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

/**
 * One write lock per file, so two edits to the same path cannot interleave.
 *
 * An edit is read-modify-write, and the sandbox seam offers no
 * compare-and-swap: without this, two concurrent edits both read the original
 * text and the second write silently discards the first edit's change. The
 * registry is module-level and keyed by workspace and path, so the guarantee
 * holds across every toolkit instance in the process, not merely within one.
 *
 * Keyed with a NUL separator, which no sandbox path may contain, so
 * `a/b` + `c` cannot collide with `a` + `b/c`.
 *
 * **Why the entry carries a holder count.** This registry used to be a plain
 * `Map` that only ever grew, and the comment here said evicting safely would
 * need reference counting -- because dropping a lock somebody holds silently
 * ends the mutual exclusion it exists to provide. That was right about the
 * hazard and wrong that it was unavoidable. The obvious repair, "remove the
 * entry when the last holder leaves", is unsafe only because the check and the
 * removal are two steps: a fibre can arrive between them, find no entry, mint a
 * second semaphore, and edit the same file under a lock nobody else respects.
 *
 * A `TxRef` makes those two steps one transaction. `releaseLock` observes the
 * holder count and removes the entry in a single atomic commit, so there is no
 * instant at which a waiter can see an entry that is about to vanish. The count
 * is incremented *before* the permit is acquired and decremented *after* it is
 * released, so an entry survives for as long as anyone holds it or is queued
 * behind it -- which is precisely the invariant that makes removal safe.
 *
 * Built with `makeUnsafe` for the same reason the semaphores are: this is
 * module-level construction with no yield point, so no fibre can observe a
 * half-initialised registry.
 */
interface LockEntry {
  readonly semaphore: Semaphore.Semaphore
  /** Fibres holding the permit or queued behind it. Zero means evictable. */
  readonly holders: number
}

const editLocks: TxRef.TxRef<HashMap.HashMap<string, LockEntry>> =
  TxRef.makeUnsafe(HashMap.empty<string, LockEntry>())

const lockKey = (workspace: string, path: string): string =>
  `${workspace}\u0000${path}`

/**
 * Join the queue for a path's lock, creating it if this is the first holder.
 *
 * Returns the semaphore to wait on. One transaction, so two fibres racing for
 * an absent key cannot both publish a semaphore -- the loser sees the winner's.
 */
const acquireLock = (key: string): Effect.Effect<Semaphore.Semaphore> =>
  TxRef.modify(editLocks, (map) => {
    const existing = HashMap.get(map, key)
    if (Option.isSome(existing)) {
      const entry = existing.value
      return [
        entry.semaphore,
        HashMap.set(map, key, { ...entry, holders: entry.holders + 1 })
      ]
    }
    const semaphore = Semaphore.makeUnsafe(1)
    return [semaphore, HashMap.set(map, key, { semaphore, holders: 1 })]
  })

/** Leave the queue, dropping the entry when nobody is left. */
const releaseLock = (key: string): Effect.Effect<void> =>
  TxRef.update(editLocks, (map) => {
    const existing = HashMap.get(map, key)
    if (Option.isNone(existing)) return map
    const holders = existing.value.holders - 1
    return holders <= 0
      ? HashMap.remove(map, key)
      : HashMap.set(map, key, { ...existing.value, holders })
  })

/**
 * Run an effect under a path's write lock.
 *
 * `acquireUseRelease` rather than a bare `withPermit`, so the holder count is
 * decremented even when the caller is interrupted while waiting or mid-edit. A
 * leaked count would pin the entry forever, which is the leak this replaced.
 */
const withFileLock = <A, E, R>(
  workspace: string,
  path: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
  const key = lockKey(workspace, path)
  return Effect.acquireUseRelease(
    acquireLock(key),
    (semaphore) => semaphore.withPermit(effect),
    () => releaseLock(key)
  )
}

/**
 * How many paths currently hold a lock entry.
 *
 * Exported for the test that asserts the registry drains. The leak this
 * replaced was invisible from outside, and an invariant nobody can observe is
 * one nobody can defend.
 *
 * @internal
 */
export const lockRegistrySize: Effect.Effect<number> = Effect.map(
  TxRef.get(editLocks),
  HashMap.size
)

/**
 * A file's text, byte-for-byte recoverable, or a refusal.
 *
 * Two things this must not do, both of which it used to.
 *
 * `TextDecoder` strips a leading BOM unless told not to, so decoding through
 * the ordinary text helper and writing the result back silently deletes it.
 * Reading for *display* may drop it; reading in order to write again must
 * not, which is why the edit path decodes for itself.
 *
 * And the default decoder is *non-fatal*: an invalid byte sequence becomes
 * U+FFFD. `edit_file` writes the whole decoded string back, so a single
 * malformed byte anywhere in a file -- a latin-1 name in a comment, a stray
 * byte in a legacy file -- was replaced by a replacement character, and every
 * byte around the edit was rewritten. The nearby claim that nothing outside
 * the replaced span is re-encoded was simply false for such a file, and the
 * binary heuristic does not catch them: they are text, just not this text.
 *
 * `fatal: true` turns that into a refusal. Losing the edit is recoverable;
 * corrupting the file is not.
 */
const readPreservingBom = (
  sandbox: Sandbox.Sandbox,
  path: Sandbox.SandboxPath
): Effect.Effect<string, Sandbox.FileError | string> =>
  Effect.flatMap(sandbox.read(path), (bytes) =>
    Effect.try({
      try: () => new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes),
      catch: () =>
        `Refusing to edit ${path}: it is not valid UTF-8, and rewriting it would` +
        ` replace every undecodable byte -- including bytes nowhere near the edit.` +
        ` Convert the file to UTF-8 first, or use write_file to replace it whole.`
    }))

/**
 * The message for a file that is not there, naming look-alikes beside it.
 *
 * Listing the parent can fail in its own right -- it may not exist either --
 * and that is not worth reporting over the original miss, so it degrades to a
 * plain not-found.
 */
const suggestFor = (
  sandbox: Sandbox.Sandbox,
  path: Sandbox.SandboxPath
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const parent = ReadFormat.dirname(path)
    const at = parent === undefined
      ? undefined
      : yield* Effect.orElseSucceed(Sandbox.path(parent), () => undefined)
    const entries = yield* Effect.orElseSucceed(sandbox.list(at), () => [])
    return ReadFormat.notFoundMessage(path, entries.map((entry) => entry.path))
  })

/**
 * One stream of a command's output, bounded for the model with the whole of it
 * kept on disk.
 *
 * The saved file is inside the workspace, which is the only place the sandbox
 * can write -- and the useful place, since `search` and `read_file` can then be
 * pointed at it. If saving fails (a read-only workspace, say) the output is
 * still bounded and simply does not promise a file that is not there.
 */
const bounded = (
  sandbox: Sandbox.Sandbox,
  text: string
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const end = Truncate.tail(text)
    if (!end.cut) return end.text
    const saved = yield* Effect.option(
      Effect.gen(function* () {
        const at = yield* Sandbox.path(Truncate.nextOutputPath())
        yield* sandbox.write(at, text)
        return at
      })
    )
    return Option.isNone(saved)
      ? Truncate.unsavedNotice() + end.text
      : Truncate.savedNotice(saved.value) + end.text
  })

/**
 * How many lines a span covers.
 *
 * Counted the way a reader sees them, so a span that ends with a newline is
 * not credited with an extra empty line: replacing one whole line reports
 * `-1`, not `-2`.
 */
const lineCount = (text: string): number => ReadFormat.toLines(text).length

/**
 * Recursively list every file under a directory, depth-first and deterministic.
 *
 * `skip` names directories not worth descending into. It applies only to
 * directories the walk would enter, never to the root it was given, so a search
 * scoped at an ignored directory still searches it.
 */
const walk = (
  sandbox: Sandbox.Sandbox,
  root: Sandbox.SandboxPath | undefined,
  skip: ReadonlySet<string> = new Set()
): Effect.Effect<ReadonlyArray<Sandbox.SandboxPath>, string> =>
  Effect.gen(function* () {
    const entries = yield* sandbox.list(root).pipe(Effect.mapError(errorMessage))
    const files: Array<Sandbox.SandboxPath> = []
    for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (entry.type === "file") {
        files.push(entry.path)
      } else if (!skip.has(ReadFormat.basename(entry.path))) {
        files.push(...(yield* walk(sandbox, entry.path, skip)))
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
      const sandboxPath = yield* Sandbox.path(file).pipe(Effect.mapError(errorMessage))

      const found = yield* Effect.option(sandbox.stat(sandboxPath))
      if (Option.isNone(found)) {
        // A missing file is usually a near miss, so name the neighbours that
        // look like what was asked for rather than only reporting the failure.
        return yield* Effect.fail(yield* suggestFor(sandbox, sandboxPath))
      }
      if (found.value.type === "directory") {
        return yield* Effect.fail(
          `${file} is a directory, not a file. Use list_files to see what it contains.`
        )
      }

      const bytes = yield* sandbox.read(sandboxPath).pipe(Effect.mapError(errorMessage))
      if (ReadFormat.isBinary(sandboxPath, bytes.slice(0, ReadFormat.SAMPLE_BYTES))) {
        return yield* Effect.fail(`Cannot read binary file: ${file}`)
      }

      const text = new TextDecoder().decode(bytes)
      // A non-positive offset means the top, not `slice(-1)`'s last line.
      const from = Math.max(1, offset ?? 1)
      const window = ReadFormat.slice(text, from, limit ?? ReadFormat.DEFAULT_LIMIT)
      if (ReadFormat.offsetOutOfRange(window)) {
        return yield* Effect.fail(
          `Offset ${from} is out of range for this file (${window.counted} lines)`
        )
      }
      return ReadFormat.render(file, window)
    }),

  write_file: ({ content, path: file }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const sandboxPath = yield* Sandbox.path(file)
      /**
       * Under the same lock `edit_file` takes.
       *
       * A whole-file write is one operation, so on its own it needs no lock --
       * but it is not on its own. `edit_file` is a read-modify-write, and a
       * write landing between its read and its write was simply overwritten
       * by a value derived from content that no longer existed. The lock is
       * per path and per workspace, so this only ever contends with another
       * mutation of the same file.
       *
       * Two writes to one path are also ordered by it, which turns
       * "whichever finished last" into "whichever started last".
       */
      yield* withFileLock(
        sandbox.workspace,
        sandboxPath,
        sandbox.write(sandboxPath, content)
      )
      return `wrote ${file} (${content.length} bytes)`
    }).pipe(Effect.mapError(errorMessage)),

  edit_file: ({ new_string, old_string, path: file, replace_all }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const sandboxPath = yield* Sandbox.path(file).pipe(Effect.mapError(errorMessage))
      if (old_string === "") {
        return yield* Effect.fail(
          `old_string cannot be empty when editing ${file}. Provide the exact text to replace, ` +
            `or use write_file for an intentional full-file replacement.`
        )
      }
      if (old_string === new_string) {
        return yield* Effect.fail(
          `old_string and new_string are identical, so this edit would change nothing in ${file}. ` +
            `Provide the replacement text you actually want.`
        )
      }
      // Read-modify-write is only safe under the file's lock: see `editLocks`.
      return yield* withFileLock(
        sandbox.workspace,
        sandboxPath,
          Effect.gen(function* () {
            // Two failures with one shape: the sandbox's, mapped to prose,
            // and this module's own refusal, which is already prose.
            const text = yield* readPreservingBom(sandbox, sandboxPath).pipe(
              Effect.mapError((error) =>
                typeof error === "string" ? error : errorMessage(error))
            )
            // The file is matched exactly as it sits on disk; it is the search
            // strings that are converted to its convention. Nothing outside
            // the replaced span is ever re-encoded, so line endings and a BOM
            // survive an edit untouched.
            const newline = LineEndings.detect(text)
            const find = LineEndings.convert(old_string, newline)
            const replacement = LineEndings.convert(new_string, newline)

            const outcome = Replace.replace(text, find, replacement, replace_all === true)
            switch (outcome._tag) {
              case "NotFound":
                return yield* Effect.fail(
                  `old_string was not found in ${file}. It must match the file exactly, including ` +
                    `whitespace and indentation. Re-read the file and copy the text you mean to replace.`
                )
              case "Ambiguous":
                return yield* Effect.fail(
                  `old_string is not unique in ${file}: it matches in more than one place. Include ` +
                    `more surrounding context so the match is unambiguous, or pass replace_all to ` +
                    `change every occurrence.`
                )
              case "Disproportionate":
                return yield* Effect.fail(
                  `Refusing to edit ${file}: the closest match spans ${
                    lineCount(outcome.matched)
                  } lines but ` +
                    `old_string is ${
                      lineCount(find)
                    } -- far more than intended would be replaced. Re-read ` +
                    `the file and provide the exact text to replace.`
                )
              case "Replaced": {
                yield* sandbox.write(sandboxPath, outcome.content).pipe(
                  Effect.mapError(errorMessage)
                )
                return {
                  path: file,
                  replacements: outcome.count,
                  added: lineCount(replacement) * outcome.count,
                  removed: lineCount(outcome.matched) * outcome.count,
                  strategy: outcome.strategy,
                  matched: outcome.matched
                }
              }
            }
          })
      )
    }),

  list_files: ({ path: dir }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const at = dir === undefined ? undefined : yield* Sandbox.path(dir)
      const entries = yield* sandbox.list(at)
      return entries.map((entry) => ({ path: entry.path, type: entry.type }))
    }).pipe(Effect.mapError(errorMessage)),

  search: ({ include, path: dir, pattern }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const regex = yield* Effect.try({
        try: () => new RegExp(pattern),
        catch: () => `invalid regular expression: ${pattern}`
      })
      /**
       * The filter, compiled once for the whole walk.
       *
       * It used to be rebuilt for every file considered, so a search over a
       * thousand paths compiled a thousand identical regular expressions --
       * and for an adversarial pattern that multiplied the cost by the size
       * of the tree.
       *
       * A refusal is reported rather than treated as "matches nothing": the
       * pattern comes from the model, and a filter that silently excludes
       * everything is indistinguishable from a search that found nothing.
       */
      const filter = include === undefined ? undefined : Glob.compile(include)
      if (filter !== undefined && filter._tag === "Refused") {
        return yield* Effect.fail(
          `Refusing to search: ${filter.reason}. Simplify the include pattern.`
        )
      }
      const at = dir === undefined
        ? undefined
        : yield* Sandbox.path(dir).pipe(Effect.mapError(errorMessage))
      const files = yield* walk(sandbox, at, SearchFormat.IGNORED_DIRECTORIES)

      const matches: Array<SearchFormat.Match> = []
      for (const file of files) {
        if (matches.length >= SearchFormat.SEARCH_LIMIT) break
        if (filter !== undefined && !filter.matches(file)) continue
        const bytes = yield* sandbox.read(file).pipe(Effect.mapError(errorMessage))
        // A binary file has no lines worth showing, and its bytes would wreck
        // the output. Skipping is not an error: it is simply not a match.
        if (ReadFormat.isBinary(file, bytes.slice(0, ReadFormat.SAMPLE_BYTES))) continue
        const lines = ReadFormat.toLines(new TextDecoder().decode(bytes))
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= SearchFormat.SEARCH_LIMIT) break
          const text = lines[i] ?? ""
          if (regex.test(text)) matches.push({ path: file, line: i + 1, text })
        }
      }
      return SearchFormat.render(matches)
    }),

  bash: ({ command, timeout_ms }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const result = yield* sandbox.exec(
        Sandbox.command("bash", ["-lc", command]),
        timeout_ms === undefined ? undefined : { timeout: timeout_ms }
      ).pipe(
        Effect.mapError((error) =>
          // A timeout is the one failure with an obvious next move, so it says
          // what that is rather than only reporting the elapsed budget.
          error instanceof Sandbox.TimeoutError
            ? Truncate.timedOut(error.timeoutMillis)
            : errorMessage(error)
        )
      )
      return {
        exit_code: result.exitCode,
        stdout: yield* bounded(sandbox, result.stdout),
        stderr: yield* bounded(sandbox, result.stderr)
      }
    })
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
