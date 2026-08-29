/**
 * Pi-shaped coding tools over the same sandbox seam as `/coding`.
 *
 * ---------------------------------------------------------------------------
 * Algorithms and contracts from Pi (earendil-works/pi), MIT, Copyright (c)
 * 2025 Mario Zechner, read at commit
 * dcd461925db2edf69a43c8135db1180d418afd54.
 *
 * This is a *second toolkit*, not an improvement to `/coding`. `/coding`
 * keeps OpenCode's contracts (structured `list_files`, one edit per call).
 * This module is for callers who want Pi's:
 *
 * - `edit_file` accepts `edits: [{ old_string, new_string }, ...]` and
 *   applies them atomically against the original file, refusing overlaps
 * - `list_files` is rendered text: `/` suffix, alphabetical, 500-entry cap
 * - `bash` takes its argv from `Shell` (`toolkit({ shell: "zsh" })` or
 *   `Effect.provide(Shell.layer("nushell"))`)
 * - truncated output names the limit that fired
 *
 * Handlers still demand `Sandbox.Current` and carry the same `Permission`
 * projections. Mixing both toolkits on one workspace is not the intended
 * use: each has its own write-lock registry.
 * ---------------------------------------------------------------------------
 */
import { Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as Permission from "../Permission.js"
import * as Sandbox from "../sandbox/Sandbox.js"
import * as Shell from "../shell/Shell.js"
import * as FileLock from "../coding/internal/fileLock.js"
import * as Glob from "../coding/internal/glob.js"
import * as LineEndings from "../coding/internal/lineEndings.js"
import * as Prompts from "../coding/internal/prompts.js"
import * as ReadFormat from "../coding/internal/readFormat.js"
import * as RegexSafety from "../coding/internal/regexSafety.js"
import * as Replace from "../coding/internal/replace.js"
import * as SearchFormat from "../coding/internal/searchFormat.js"
import * as Truncate from "../coding/internal/truncate.js"

/** Command output kept: at most 50 KB from the tail, after the 2000-line cap — the same budget `coding/internal/truncate.ts` truncates to, and the banner names which fired. */
export const MAX_BYTES = 50 * 1024
/** Lines of command output kept from the tail; mirroring `truncate.ts`'s 2000-line budget. */
export const MAX_LINES = 2000
/** A single grep match line longer than this is capped with `... (line truncated to 500 chars)` rather than dominating the result. */
export const GREP_MAX_LINE_LENGTH = 500
/** `list_files` renders at most 500 entries; above that it warns to narrow the path or use search. */
export const LS_LIMIT = 500
/** Human label for `MAX_BYTES` — `50.0KB`, used in truncation banners. */
export const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`

export const formatSize = Truncate.formatSize
export const head = Truncate.head
export type Head = Truncate.Head

export const headNotice = (limit: string): string => `...output truncated (head, ${limit} limit)...\n\n`
export const tailNotice = (limit: string): string => `...output truncated (tail, ${limit} limit)...\n\n`

export const ReadFile = Permission.annotate(
  Tool.make("read_file", {
    description: Prompts.READ_FILE,
    parameters: Schema.Struct({
      path: Schema.String,
      offset: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number)
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "read", resource: (params) => params.path }
)

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

export const EditFile = Permission.annotate(
  Tool.make("edit_file", {
    description: Prompts.EDIT_FILE,
    parameters: Schema.Struct({
      path: Schema.String,
      old_string: Schema.optional(Schema.String),
      new_string: Schema.optional(Schema.String),
      replace_all: Schema.optional(Schema.Boolean),
      edits: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Struct({ old_string: Schema.String, new_string: Schema.String }))]))
    }),
    success: Schema.Struct({
      path: Schema.String,
      replacements: Schema.Number,
      added: Schema.Number,
      removed: Schema.Number,
      strategy: Schema.String,
      matched: Schema.String
    }),
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "write", resource: (params) => params.path }
)

export const ListFiles = Permission.annotate(
  Tool.make("list_files", {
    description: Prompts.LIST_FILES,
    parameters: Schema.Struct({ path: Schema.optional(Schema.String) }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "read", resource: (params) => params.path ?? "." }
)

export const Search = Permission.annotate(
  Tool.make("search", {
    description: Prompts.SEARCH,
    parameters: Schema.Struct({
      pattern: Schema.String,
      path: Schema.optional(Schema.String),
      include: Schema.optional(Schema.String)
    }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "read", resource: (params) => params.path ?? ".", describe: (params) => `${params.pattern} in ${params.path ?? "."}` }
)

export const Bash = Permission.annotate(
  Tool.make("bash", {
    description: Prompts.BASH,
    parameters: Schema.Struct({
      command: Schema.String,
      timeout_ms: Schema.optional(Schema.Number)
    }),
    success: Schema.Struct({ exit_code: Schema.Number, stdout: Schema.String, stderr: Schema.String }),
    failure: Schema.String,
    dependencies: [Sandbox.Current]
  }),
  { action: "shell", resource: (params) => params.command }
)

export const tools = [ReadFile, WriteFile, EditFile, ListFiles, Search, Bash] as const

/** The per-file write lock, shared with `/coding`: see `coding/internal/fileLock.ts`. @internal */
export const lockRegistrySize = FileLock.lockRegistrySize

const errorMessage = (error: { readonly message: string }): string => error.message

const readPreservingBom = (
  sandbox: Sandbox.Sandbox,
  path: Sandbox.SandboxPath
): Effect.Effect<string, Sandbox.FileError | string> =>
  Effect.flatMap(sandbox.read(path), (bytes) =>
    Effect.try({
      try: () => new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(bytes),
      catch: () => `Refusing to edit ${path}: it is not valid UTF-8, and rewriting it would replace every undecodable byte -- including bytes nowhere near the edit. Convert the file to UTF-8 first, or use write_file to replace it whole.`
    }))

const suggestFor = (sandbox: Sandbox.Sandbox, path: Sandbox.SandboxPath): Effect.Effect<string> =>
  Effect.gen(function* () {
    const parent = ReadFormat.dirname(path)
    const at = parent === undefined ? undefined : yield* Effect.orElseSucceed(Sandbox.path(parent), () => undefined)
    const entries = yield* Effect.orElseSucceed(sandbox.list(at), () => [])
    return ReadFormat.notFoundMessage(path, entries.map((entry) => entry.path))
  })

const bounded = (sandbox: Sandbox.Sandbox, text: string): Effect.Effect<string> =>
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
    const limit = Truncate.nameLimit(end.fired ?? "lines")
    return Option.isNone(saved) ? Truncate.unsavedNotice(limit) + end.text : Truncate.savedNotice(saved.value, limit) + end.text
  })

const lineCount = (text: string): number => ReadFormat.toLines(text).length

const walk = (
  sandbox: Sandbox.Sandbox,
  root: Sandbox.SandboxPath | undefined,
  skip: ReadonlySet<string> = new Set()
): Effect.Effect<ReadonlyArray<Sandbox.Entry>, string> =>
  Effect.gen(function* () {
    const entries = yield* sandbox.list(root).pipe(Effect.mapError(errorMessage))
    const files: Array<Sandbox.Entry> = []
    for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (entry.type === "file") files.push(entry)
      else if (!skip.has(ReadFormat.basename(entry.path))) files.push(...(yield* walk(sandbox, entry.path, skip)))
    }
    return files
  })

/**
 * The size a search should judge a file by, or `None` when the provider will
 * not say. `list` already sized ordinary files; only an entry it declined to
 * size (the local provider will not size a symlink) costs a `stat`, and a
 * failing `stat` is not fatal -- the read that follows raises the same error.
 */
const sizeOf = (
  sandbox: Sandbox.Sandbox,
  entry: Sandbox.Entry
): Effect.Effect<Option.Option<number>> =>
  Option.isSome(entry.size)
    ? Effect.succeed(entry.size)
    : Effect.map(Effect.option(sandbox.stat(entry.path)), Option.flatMap((found) => found.size))

export type ShellKind = Shell.Kind
export interface PiToolkitOptions {
  readonly shell?: Shell.Kind | Shell.Service | undefined
}

const EditPair = Schema.Struct({
  old_string: Schema.String,
  new_string: Schema.String
})
const decodeEdits = Schema.decodeUnknownOption(Schema.Array(EditPair))

const coerceEdits = (
  old_string: string | undefined,
  new_string: string | undefined,
  edits: ReadonlyArray<{ readonly old_string: string; readonly new_string: string }> | string | undefined
): ReadonlyArray<{ readonly old_string: string; readonly new_string: string }> | string => {
  if (edits !== undefined) {
    if (typeof edits === "string") {
      let parsed: unknown
      try {
        parsed = JSON.parse(edits) as unknown
      } catch {
        return `edits is a string that is not valid JSON`
      }
      const decoded = decodeEdits(parsed)
      if (Option.isNone(decoded)) return `edits is a string but not a JSON array`
      return decoded.value
    }
    return edits
  }
  if (old_string !== undefined || new_string !== undefined) {
    if (old_string === undefined || new_string === undefined) {
      return `old_string and new_string must both be provided for a single edit`
    }
    return [{ old_string, new_string }]
  }
  return `Provide old_string/new_string or edits`
}

export const handlersFor = (options: PiToolkitOptions = {}): Toolkit.HandlersFrom<Toolkit.ToolsByName<typeof tools>> => {
  const fallback = options.shell === undefined
    ? Shell.bash
    : typeof options.shell === "string"
    ? Shell.fromKind(options.shell)
    : options.shell
  return {
    read_file: ({ limit, offset, path: file }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.Current
        const sandboxPath = yield* Sandbox.path(file).pipe(Effect.mapError(errorMessage))
        const found = yield* Effect.option(sandbox.stat(sandboxPath))
        if (Option.isNone(found)) return yield* Effect.fail(yield* suggestFor(sandbox, sandboxPath))
        if (found.value.type === "directory") return yield* Effect.fail(`${file} is a directory, not a file. Use list_files to see what it contains.`)
        const bytes = yield* sandbox.read(sandboxPath).pipe(Effect.mapError(errorMessage))
        if (ReadFormat.isBinary(sandboxPath, bytes.slice(0, ReadFormat.SAMPLE_BYTES))) return yield* Effect.fail(`Cannot read binary file: ${file}`)
        const text = new TextDecoder().decode(bytes)
        const from = Math.max(1, offset ?? 1)
        const window = ReadFormat.slice(text, from, limit ?? ReadFormat.DEFAULT_LIMIT)
        if (ReadFormat.offsetOutOfRange(window)) return yield* Effect.fail(`Offset ${from} is out of range for this file (${window.counted} lines)`)
        return ReadFormat.render(file, window)
      }),
    write_file: ({ content, path: file }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.Current
        const sandboxPath = yield* Sandbox.path(file)
        yield* FileLock.withFileLock(sandbox, sandboxPath, sandbox.write(sandboxPath, content))
        return `wrote ${file} (${content.length} bytes)`
      }).pipe(Effect.mapError(errorMessage)),
    edit_file: ({ edits, new_string, old_string, path: file, replace_all }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.Current
        const sandboxPath = yield* Sandbox.path(file).pipe(Effect.mapError(errorMessage))
        const coerced = coerceEdits(old_string, new_string, edits)
        if (typeof coerced === "string") return yield* Effect.fail(coerced)
        if (coerced.length === 0) return yield* Effect.fail(`edits cannot be empty`)
        for (let i = 0; i < coerced.length; i++) {
          const edit = coerced[i]!
          if (edit.old_string === "") return yield* Effect.fail(`edits[${i}] old_string cannot be empty when editing ${file}. Provide the exact text to replace, or use write_file for an intentional full-file replacement.`)
          if (edit.old_string === edit.new_string) return yield* Effect.fail(`edits[${i}] old_string and new_string are identical, so this edit would change nothing in ${file}.`)
        }
        if (coerced.length === 1 && replace_all === true) {
          const single = coerced[0]!
          return yield* FileLock.withFileLock(sandbox, sandboxPath,
            Effect.gen(function* () {
              const text = yield* readPreservingBom(sandbox, sandboxPath).pipe(Effect.mapError((error) => typeof error === "string" ? error : errorMessage(error)))
              const newline = LineEndings.detect(text)
              const find = LineEndings.convert(single.old_string, newline)
              const replacement = LineEndings.convert(single.new_string, newline)
              const outcome = Replace.replace(text, find, replacement, true)
              switch (outcome._tag) {
                case "NotFound": return yield* Effect.fail(`old_string was not found in ${file}. It must match the file exactly, including whitespace and indentation. Re-read the file and copy the text you mean to replace.`)
                case "Ambiguous": return yield* Effect.fail(`old_string is not unique in ${file}: it matches in more than one place. Include more surrounding context so the match is unambiguous, or pass replace_all to change every occurrence.`)
                case "Disproportionate": return yield* Effect.fail(`Refusing to edit ${file}: the closest match spans ${lineCount(outcome.matched)} lines but old_string is ${lineCount(find)} -- far more than intended would be replaced. Re-read the file and provide the exact text to replace.`)
                case "Replaced": {
                  yield* sandbox.write(sandboxPath, outcome.content).pipe(Effect.mapError(errorMessage))
                  return { path: file, replacements: outcome.count, added: lineCount(replacement) * outcome.count, removed: lineCount(outcome.matched) * outcome.count, strategy: outcome.strategy, matched: outcome.matched }
                }
              }
            })
          ).pipe(
            Effect.mapError((error) =>
              typeof error === "string" ? error : errorMessage(error)
            )
          )
        }
        if (replace_all === true && coerced.length > 1) return yield* Effect.fail(`replace_all cannot be used with multiple edits`)
        return yield* FileLock.withFileLock(sandbox, sandboxPath,
          Effect.gen(function* () {
            const text = yield* readPreservingBom(sandbox, sandboxPath).pipe(Effect.mapError((error) => typeof error === "string" ? error : errorMessage(error)))
            const newline = LineEndings.detect(text)
            type Match = { readonly index: number; readonly matched: string; readonly replacement: string; readonly strategy: string; readonly editIndex: number }
            const matches: Array<Match> = []
            for (let i = 0; i < coerced.length; i++) {
              const edit = coerced[i]!
              const find = LineEndings.convert(edit.old_string, newline)
              const replacement = LineEndings.convert(edit.new_string, newline)
              const outcome = Replace.replace(text, find, replacement, false)
              switch (outcome._tag) {
                case "NotFound": return yield* Effect.fail(`edits[${i}] of ${coerced.length}: old_string was not found in ${file}. It must match the file exactly, including whitespace and indentation.`)
                case "Ambiguous": return yield* Effect.fail(`edits[${i}] of ${coerced.length}: old_string is not unique in ${file}: it matches in more than one place. Include more surrounding context so the match is unambiguous.`)
                case "Disproportionate": return yield* Effect.fail(`edits[${i}] of ${coerced.length}: refusing to edit ${file}: the closest match spans ${lineCount(outcome.matched)} lines but old_string is ${lineCount(find)} -- far more than intended would be replaced.`)
                case "Replaced": {
                  const idx = text.indexOf(outcome.matched)
                  matches.push({ index: idx, matched: outcome.matched, replacement, strategy: outcome.strategy, editIndex: i })
                  break
                }
              }
            }
            const sorted = [...matches].sort((a, b) => a.index - b.index)
            for (let i = 0; i + 1 < sorted.length; i++) {
              const a = sorted[i]!
              const b = sorted[i + 1]!
              if (a.index + a.matched.length > b.index) return yield* Effect.fail(`edits[${a.editIndex}] and edits[${b.editIndex}] overlap in ${file}: their matched spans intersect. Provide non-overlapping edits.`)
            }
            let next = text
            for (let i = sorted.length - 1; i >= 0; i--) {
              const m = sorted[i]!
              next = next.slice(0, m.index) + m.replacement + next.slice(m.index + m.matched.length)
            }
            yield* sandbox.write(sandboxPath, next).pipe(Effect.mapError(errorMessage))
            const added = sorted.reduce((sum, m) => sum + lineCount(m.replacement), 0)
            const removed = sorted.reduce((sum, m) => sum + lineCount(m.matched), 0)
            return { path: file, replacements: sorted.length, added, removed, strategy: sorted.length === 1 ? sorted[0]!.strategy : "batch", matched: sorted.map((m) => m.matched).join("\n---\n") }
          })
        ).pipe(
          // The lock now surfaces a `canonical` failure rather than silently
          // keying on the spelled path; it joins the sandbox's other errors.
          Effect.mapError((error) =>
            typeof error === "string" ? error : errorMessage(error)
          )
        )
      }),
    list_files: ({ path: dir }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.Current
        const at = dir === undefined ? undefined : yield* Sandbox.path(dir)
        const entries = yield* sandbox.list(at)
        const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
        const rendered = sorted.map((entry) => entry.type === "directory" ? `${entry.path}/` : entry.path)
        if (rendered.length > LS_LIMIT) {
          const shown = rendered.slice(0, LS_LIMIT).join("\n")
          // The size named is what the *whole* listing would have been, not a
          // limit: the cap here is the entry count, and calling the observed
          // size a "limit" told the model a byte budget had fired that had not.
          return `${shown}\n\n...truncated to ${LS_LIMIT} entries (${rendered.length} total, ${formatSize(rendered.join("\n").length)} untruncated). Narrow the path or use search.`
        }
        if (rendered.length === 0) return `No entries in ${dir ?? "."}`
        return rendered.join("\n")
      }).pipe(Effect.mapError(errorMessage)),
    search: ({ include, path: dir, pattern }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.Current
        const unsafe = RegexSafety.refuse(pattern)
        if (unsafe !== undefined) return yield* Effect.fail(`Refusing to search with this pattern: ${unsafe}. Rewrite it without the nested repetition, or search for a simpler pattern and filter the results.`)
        const regex = yield* Effect.try({ try: () => new RegExp(pattern), catch: () => `invalid regular expression: ${pattern}` })
        const filter = include === undefined ? undefined : Glob.compile(include)
        if (filter !== undefined && filter._tag === "Refused") return yield* Effect.fail(`Refusing to search: ${filter.reason}. Simplify the include pattern.`)
        const at = dir === undefined ? undefined : yield* Sandbox.path(dir).pipe(Effect.mapError(errorMessage))
        const files = yield* walk(sandbox, at, SearchFormat.IGNORED_DIRECTORIES)
        const matches: Array<SearchFormat.Match> = []
        const capLine = (text: string): string => text.length > GREP_MAX_LINE_LENGTH ? text.slice(0, GREP_MAX_LINE_LENGTH) + `... (line truncated to ${GREP_MAX_LINE_LENGTH} chars)` : text
        let skippedForSize = 0
        for (const entry of files) {
          const file = entry.path
          if (matches.length >= SearchFormat.SEARCH_LIMIT) break
          if (filter !== undefined && !filter.matches(file)) continue
          // Before the read, so the bytes are never allocated at all. See
          // `SearchFormat.MAX_SEARCH_FILE_BYTES` for why 1 MiB.
          const size = yield* sizeOf(sandbox, entry)
          if (Option.isSome(size) && size.value > SearchFormat.MAX_SEARCH_FILE_BYTES) {
            skippedForSize++
            continue
          }
          const bytes = yield* sandbox.read(file).pipe(Effect.mapError(errorMessage))
          if (ReadFormat.isBinary(file, bytes.slice(0, ReadFormat.SAMPLE_BYTES))) continue
          const lines = ReadFormat.toLines(new TextDecoder().decode(bytes))
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= SearchFormat.SEARCH_LIMIT) break
            const text = lines[i] ?? ""
            if (regex.test(text)) matches.push({ path: file, line: i + 1, text: capLine(text) })
          }
        }
        return SearchFormat.render(matches, skippedForSize)
      }),
    bash: ({ command, timeout_ms }) =>
      Effect.gen(function* () {
        const sandbox = yield* Sandbox.Current
        const shell = yield* Shell.current(fallback)
        const result = yield* sandbox.exec(shell.toCommand(command), timeout_ms === undefined ? undefined : { timeout: timeout_ms }).pipe(
          Effect.mapError((error) => error instanceof Sandbox.TimeoutError ? Truncate.timedOut(error.timeoutMillis) : errorMessage(error))
        )
        return { exit_code: result.exitCode, stdout: yield* bounded(sandbox, result.stdout), stderr: yield* bounded(sandbox, result.stderr) }
      })
  }
}

export const handlers: Toolkit.HandlersFrom<Toolkit.ToolsByName<typeof tools>> = handlersFor()

export const toolkit = (options: PiToolkitOptions = {}) => Agent.toolkit(tools, handlersFor(options))
