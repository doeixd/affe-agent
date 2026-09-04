# Research: opencode v2 built-in tools (edit / search / bash / etc.)

Research notes on how opencode ("opencode2" — the ground-up 2026 rewrite) implements
its built-in agent tools, to take heavy inspiration for affe-agent's tools.

- **Repo:** `github.com/sst/opencode`, branch `dev` (~201k stars). V2 installs as
  `opencode2` alongside v1; docs at opencode.ai/v2/docs.
- **Where the code lives:** `packages/opencode/src/tool/` — one `.ts` implementation
  plus one `.txt` LLM-facing description per tool (imported via
  `import DESCRIPTION from "./edit.txt"`).
- **Stack:** Effect-TS throughout — `Tool.define(id, Effect.gen(...))`, Effect
  `Schema` for parameters with `.annotate({description})` per field. Directly
  relevant to affe-agent: their tool layer is an Effect codebase.

Files: `edit.ts/.txt`, `read.ts/.txt`, `write.ts/.txt`, `grep.ts/.txt`,
`glob.ts/.txt`, `shell.ts` + `shell/{prompt.ts,shell.txt,id.ts}`,
`apply_patch.ts/.txt`, `task.ts/.txt`, `todo.ts` + `todowrite.txt`,
`webfetch.ts/.txt`, `websearch.ts/.txt`, `lsp.ts/.txt`, `question.ts/.txt`,
`skill.ts`, `plan.ts`, plus shared infra `tool.ts`, `truncate.ts`, `registry.ts`,
`external-directory.ts`.

---

## 1. Shared tool infrastructure (`tool.ts`, `truncate.ts`)

Every tool returns `{ title, metadata, output, attachments? }`. The `wrap()` layer:

- **Schema validation with model-facing repair prompt.** Invalid args raise
  `InvalidArgumentsError` whose message is fed back to the LLM:
  `"The ${tool} tool was called with invalid arguments: ${detail}. Please rewrite
  the input so it satisfies the expected schema."` Tools may supply
  `formatValidationError` for custom prose.
- **Universal output truncation.** Unless a tool sets `metadata.truncated` itself,
  output passes through `Truncate.output()`: limits **2000 lines / 50 KB**
  (configurable via `tool_output.max_lines/max_bytes`). Overflow writes the *full*
  text to a truncation dir (`tool_<ascending-id>` files, cleaned after 7 days on an
  hourly schedule) and returns a head/tail preview plus a hint that **adapts to the
  agent's permissions**: if the task tool is allowed — "Use the Task tool to have
  explore agent process this file with Grep and Read (with offset/limit). Do NOT
  read the full file yourself - delegate to save context."; otherwise "Use Grep to
  search the full content or Read with offset/limit".
- **Permissions.** Each tool calls `ctx.ask({permission, patterns, always,
  metadata})` before acting — a uniform declarative gate. Edit passes the rendered
  diff as metadata (so the approval UI shows the diff); shell passes parsed prefix
  patterns.

## 2. `edit` — the multi-strategy replacer

Header credits: strategies sourced from **Cline's diff-apply evals and Gemini CLI's
`editCorrector.ts`**.

**Parameters:** `filePath` (absolute path), `oldString`, `newString` ("must be
different from oldString"), `replaceAll?` (default false).

**Description (`edit.txt`) key rules:** must Read the file first or the edit
errors; preserve exact indentation as it appears AFTER the line-number prefix;
never include the `N: ` prefix in oldString/newString; fails if not found or
ambiguous — "either provide more context or use `replaceAll`"; prefer editing over
creating files; no unrequested emojis.

**Pipeline:** normalize CRLF→LF then convert oldString/newString to the file's
detected line ending; per-file **semaphore lock**; **BOM split/preserve**; empty
`oldString` allowed only for a *nonexistent* file (creation path), otherwise:
"oldString cannot be empty when editing an existing file. Provide the exact text to
replace, or use write for an intentional full-file replacement." After the write:
run the formatter, publish watcher events, compute a `createTwoFilesPatch` diff
(`trimDiff()` strips common leading indentation for display), count
additions/deletions via `diffLines`, then **touch the file in LSP and append
diagnostics**: `"\n\nLSP errors detected in this file, please fix:\n${block}"`.

### The `replace()` core

Replacers are **generators yielding candidate literal spans of the actual file
content**; the driver tries them in order, requires uniqueness per strategy, and
guards against runaway matches. Fuzzy matching only ever *selects a region* —
replacement always splices verbatim file text, never synthesized text.

```ts
export function replace(content, oldString, newString, replaceAll = false): string {
  ...
  for (const replacer of [
    SimpleReplacer, LineTrimmedReplacer, BlockAnchorReplacer,
    WhitespaceNormalizedReplacer, IndentationFlexibleReplacer,
    EscapeNormalizedReplacer, TrimmedBoundaryReplacer,
    ContextAwareReplacer, MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error("Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.")
      }
      if (replaceAll) return content.replaceAll(search, newString)
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue   // ambiguous under this strategy → try next strategy
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }
  if (notFound) throw new Error("Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.")
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}
```

### All nine strategies

1. **SimpleReplacer** — yields `find` unchanged (exact match).
   ```ts
   export const SimpleReplacer: Replacer = function* (_content, find) { yield find }
   ```
2. **LineTrimmedReplacer** — splits both into lines (dropping a trailing empty
   search line), slides a window comparing each line `.trim()`ed; on a full-window
   match, reconstructs exact char offsets and yields the original (untrimmed)
   block. Handles indentation/trailing-whitespace drift line-by-line.
3. **BlockAnchorReplacer** — for search blocks of ≥3 lines: trimmed **first and
   last lines as anchors**. Candidates: first line matches, and the *first*
   subsequent occurrence of the last line closes a block whose size differs from
   the search block by at most `max(1, floor(searchLines * 0.25))`. Middle lines
   scored by per-line Levenshtein similarity `1 - dist/maxLen`, averaged; accepted
   at threshold **0.65** (anchors-only blocks with no middle lines auto-accept at
   1.0). Tolerates rewritten middles as long as the boundaries stand.
4. **WhitespaceNormalizedReplacer** — normalizes `\s+`→single space + trim.
   Matches whole lines; for substring hits, rebuilds a regex from the find's words
   joined by `\s+` (regex-escaping each word) and yields the actual matched slice;
   also does multi-line block comparison under normalization.
5. **IndentationFlexibleReplacer** — computes minimum indent across non-empty
   lines and strips it (dedent) on both sides; matches blocks re-indented
   wholesale.
6. **EscapeNormalizedReplacer** — unescapes `\n \t \r \' \" \` \\ \$` sequences in
   the find string (classic LLM over-escaping failure); tries the unescaped find
   directly and matches file blocks whose *unescaped* form equals it.
7. **TrimmedBoundaryReplacer** — if `find.trim() !== find`, tries the trimmed
   version and blocks whose trim equals it (leading/trailing blank-line slop).
8. **ContextAwareReplacer** — like BlockAnchor but stricter/cheaper: block must be
   the *same line count*, first/last trimmed lines anchor, and ≥50% of trimmed
   middle non-empty lines must match exactly; yields first occurrence only.
9. **MultiOccurrenceReplacer** — yields the exact `find` once per occurrence;
   lets the driver's `replaceAll` path fire on exact text (last resort).

### Disproportionate-match guard

Prevents a fuzzy strategy from swallowing half a file — the safety piece naive
fuzzy editors lack:

```ts
function isDisproportionateMatch(search, oldString) {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}
```

## 3. `bash` / `shell` (`shell.ts`, `shell/prompt.ts`, `shell/shell.txt`)

**Parameters:** `command` (required), `timeout?` (positive int, ms; default 2
minutes), `workdir?` ("Defaults to the current directory. Use this instead of 'cd'
commands.").

- **Dynamic, shell-aware prompt.** `shell.txt` is a template (`${intro}`, `${os}`,
  `${shell}`, `${tmp}`, `${commandSection}`, git sections…) rendered at tool-init
  per configured shell (bash / pwsh / Windows PowerShell 5.1 / cmd.exe) and
  platform. Each profile carries its own quoting examples, chaining guidance
  (`&&` vs `cmd1; if ($?) { cmd2 }` vs `&`), a dedicated-tool redirection table
  ("File search: Use Glob (NOT Get-ChildItem)…"), truncation limits interpolated
  live from the real constants ("Do NOT use `head`, `tail`… the full output will
  already be captured"), a pre-approved tmp dir, workdir good/bad examples, and
  per-shell `gh pr create` body recipes (heredoc / `@'...'@` here-string / temp
  file). Compact Git policy block: only commit/push when asked, inspect
  status/diff/log first, never amend failed commits, no hook-skipping/force-push.
- **Permission via tree-sitter parsing.** Commands parsed with web-tree-sitter
  WASM grammars for bash *and* PowerShell. Every `command` node is decomposed into
  tokens; builds `patterns` (exact source per command) and `always` (a prefix
  pattern `BashArity.prefix(tokens).join(" ") + " *"`, so "always allow" covers
  e.g. `git status *`).
- **External-directory detection:** for a curated set of file-touching commands
  (`rm cp mv mkdir touch chmod chown cat` + PS cmdlets `remove-item`, `copy-item`…
  + cmd.exe `del`, `copy`…), extracts path arguments (PS flag-aware:
  `-Path`/`-Destination`/`-LiteralPath` take values; `-Force`/`-Recurse` don't),
  expands `~`, `$env:VAR`, `$HOME/$PWD/$PSHOME`, unquotes, resolves via `cygpath`
  on Windows, skips anything dynamic (`$(`, backticks, `${`, bare `$`) or
  glob-prefixed, and asks a separate `external_directory` permission for resolved
  dirs outside the workspace. `cd`-family commands are exempt from command
  permission but their targets count for dir checks.
- **Execution:** spawned via the configured shell (`-NoLogo -NoProfile
  -NonInteractive -Command` for PS on Windows; `detached` on POSIX),
  `stdin: "ignore"`, merged stdout+stderr. Race of exitCode vs abort-signal vs
  timeout (`timeout + 100ms`); on timeout/abort,
  `kill({forceKillAfter: "3 seconds"})`. Timeout message (in a `<shell_metadata>`
  block): "shell tool terminated command after exceeding timeout ${timeout} ms. If
  this command is expected to take longer and is not waiting for interactive
  input, retry with a larger timeout value in milliseconds."
- **Output handling:** rolling chunk ring of `2 × maxBytes`; once the in-memory
  buffer exceeds `maxBytes`, opens a **file sink and streams the rest to disk** —
  unbounded output never lives in RAM. Final output is `tail(raw, maxLines,
  maxBytes)`: byte-and-line bounded tail with **UTF-8 continuation-byte-safe**
  slicing of an oversized single line. If cut: prefix
  `...output truncated...\n\nFull output saved to: ${file}\n\n`. Live
  `ctx.metadata({output: last})` streams a 30 KB preview to the UI during
  execution. Empty output → `"(no output)"`.

## 4. `read`

**Parameters:** `filePath` ("absolute path to the file or directory"), `offset?`
(1-indexed start line), `limit?` (default 2000 lines).

- Line format `` `<line>: <content>` `` (colon-space, not tab); caps **2000 lines
  AND 50 KB** per read; line cap 2000 chars with suffix
  `"... (line truncated to 2000 chars)"`. Streams with `TextDecoder` +
  `Stream.splitLines`, stopping early via a tagged `ReadStop` error once caps hit.
- Output wrapped in `<path>/<type>/<content>` tags; **exact continuation
  footers**: byte-capped → `(Output capped at 50 KB. Showing lines A-B. Use
  offset=N to continue.)`; line-capped → `(Showing lines A-B of TOTAL. Use
  offset=N to continue.)`; else `(End of file - total N lines)`.
- File-not-found runs a **"did you mean"** scan of the parent dir
  (case-insensitive substring both directions, top 3 suggestions); `offset` beyond
  EOF → `Offset N is out of range for this file (M lines)`.
- **Binary detection** by extension table + content sniff of a 4 KB sample (NUL
  byte → binary; >30% non-printable → binary) with `Cannot read binary file:`.
- Images (`jpeg/png/gif/webp` by MIME sniffing, not extension) and PDFs returned
  as base64 data-URI **attachments**.
- **Reading a directory doubles as `ls`** — no separate list tool in v2; dirs
  return entries with trailing `/`, paginated via offset/limit.
- A successful read **warms the LSP server in the background** (fork, failures
  ignored). Reads can also inject `<system-reminder>` content from instruction
  files associated with the path.
- Prompt: "Call this tool in parallel when you know there are multiple files";
  "Avoid tiny repeated slices (30 line chunks)".

## 5. `grep` / `glob`

Both shell out to a bundled **ripgrep**; both hard-limited to **100 results** with
`truncated = results == limit`.

- **grep:** `pattern`, `path?`, `include?` (`"*.js"`, `"*.{ts,tsx}"`). Output
  groups matches by file: `Found N matches` header, `path:` then `  Line N: text`
  rows, footer `(Results truncated. Consider using a more specific path or
  pattern.)`. Prompt: for *counting* use Bash with `rg` directly ("Do NOT use
  `grep`"); for open-ended multi-round search use the Task tool.
- **glob:** `pattern`, `path?` — with the anti-hallucination gem: *"IMPORTANT:
  Omit this field to use the default directory. DO NOT enter "undefined" or
  "null" - simply omit it."* Rejects file paths (`glob path must be a directory`).
  Prompt pushes speculative batching: "It is always better to speculatively
  perform multiple searches as a batch."

## 6. `write`

Params: `content`, `filePath` (absolute). Overwrites; **must Read an existing file
first or the tool fails**; "ALWAYS prefer editing existing files. NEVER write new
files unless explicitly required. NEVER proactively create documentation files
(*.md) or README files." Mirrors edit: BOM preservation, diff attached to the
permission ask, formatter pass, watcher events, LSP diagnostics — including errors
in **up to 5 other project files** ("LSP errors detected in other files:").

## 7. `apply_patch` — Codex-style patch envelope

Single param `patchText`. Teaches the OpenAI envelope: `*** Begin Patch` /
`*** End Patch` with `*** Add File:` (all lines `+`-prefixed), `*** Delete File:`,
`*** Update File:` (+ optional `*** Move to:`), `@@` context markers.
**Verify-everything-then-apply-all:** parses to hunks, computes every file's
old/new content, diff, and +/- counts *before* a single combined permission ask
(per-file metadata for the UI), then applies, formats, and reports `A/M/D path`
lines plus per-file LSP diagnostics. Exists because GPT-family models are trained
on this format; edit remains primary for Claude-family.

## 8. `task` (subagents)

**Params:** `description` (3-5 words), `prompt`, `subagent_type`, `task_id?`
(resume a prior subagent session with its context), `command?`, and (behind
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`) `background?` — the tool **serves a
reduced JSON schema when the flag is off** while keeping one implementation.

- Prompt covers when NOT to use it (specific file → Read/Glob; `class Foo` →
  Grep; 2-3 files → Read), launching multiple agents concurrently in one message,
  relaying results (invisible to the user), fresh context unless `task_id`.
- Subagent runs as a *child session* with **derived permissions** — a computed
  subset of the parent's, with `todowrite` and `task` denied unless the agent
  definition grants them; `subagent_depth` guard (default 1: "Subagent depth limit
  reached").
- Results wrapped in structured XML:
  `<task id=... state="running|completed|error"><summary>…<task_result>…`.
- Background mode: job registry, `extend()` to send additional context into a
  *running* background task, promotion of a foreground task to background,
  completion **injected as a synthetic message** into the parent session. Strong
  anti-poll language: "DO NOT sleep, poll for progress, ask the task for status,
  or duplicate this task's work."

## 9. `todowrite`

Param: `todos` array (id/content/status). States
`pending / in_progress / completed / cancelled`; exactly **one** `in_progress`;
update in real time, don't batch; complete "only after the required work is
actually done, including any required verification. Never based on intent";
blocked → keep in_progress + add a blocker todo; "Preserve user-provided commands
verbatim (flags, args, order)"; "When in doubt, use it." Output is the JSON list;
title is the count of unfinished todos.

## 10. `webfetch` / `websearch`

- **webfetch:** `url`, `format` (`"text"|"markdown"|"html"`, default markdown),
  `timeout?` (seconds, max 120; default 30). 5 MB cap checked on both
  Content-Length and actual body. Chrome UA with format-appropriate `Accept`
  q-values; **on a Cloudflare 403 with `cf-mitigated: challenge`, retries once
  with an honest `"opencode"` UA** (TLS-fingerprint mismatch workaround).
  HTML→markdown via Turndown; images returned as attachments.
- **websearch:** `query`, `numResults?` (default 8), `livecrawl?`, `type?`
  (`auto|fast|deep`), `contextMaxCharacters?` (default 10000). Backed by Exa or
  Parallel, chosen by env override → flags → a deterministic
  checksum-of-sessionID A/B split. Prompt injects `{{year}}`: "The current year
  is {{year}}. You MUST use this year when searching for recent information."

## 11. `lsp`

One tool, `operation` enum of nine ops: `goToDefinition, findReferences, hover,
documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy,
incomingCalls, outgoingCalls`; params `filePath`, `line`, `character` (**1-based
as in editors**, converted internally), `query?` for workspaceSymbol. Errors:
`File not found`, `No LSP server available for this file type.` Output is
pretty-printed JSON or `No results found for ${operation}`. LSP is also woven into
edit/write (post-edit diagnostics) and read (background warm-up).

## 12. `question`, `plan`, `skill`

- **question:** `questions` array; UI adds "Type your own answer" when `custom` is
  on ("don't include 'Other' or catch-all options"); `multiple: true` for
  multi-select; "If you recommend a specific option, make that the first option
  and add '(Recommended)'". Returns
  `User has answered your questions: "q"="a", ...`.
- **plan:** two pseudo-tools (`plan-enter`/`plan-exit`) that *ask the user* to
  switch between plan and build agents — mode transitions modeled as tools with
  clear call/don't-call criteria (exit only "After you have written a complete
  plan to the plan file").
- **skill:** loads named skill instructions into the turn. V2 also has
  `code-mode.ts` — an experimental mode where the model writes TS that calls
  tools as an API.

---

## Design lessons worth copying into affe-agent

1. **Generator-based replacer chain with a uniqueness driver.** Fuzzy strategies
   *select spans*, never synthesize text; the driver splices verbatim file
   content, enforces uniqueness per strategy (falling through instead of
   failing), and ends with three crisp errors (not found / ambiguous /
   disproportionate). The disproportionate-match guard (`+3 lines or 2×`,
   `+500 chars or 4×`) is the safety piece most naive fuzzy editors lack.
2. **Truncation as a shared service with a paper trail.** Every tool's overflow
   goes to a retained file with a delegation-aware hint; bash streams overflow to
   disk mid-run. Prompts state the exact limits because they're interpolated from
   the same constants.
3. **Prompts are rendered, not static.** Shell description assembled per
   shell/OS/limits/timeout; websearch injects the current year; task description
   *and schema* change with a feature flag.
4. **Permission asks carry rich metadata** (the diff for edits, parsed prefix
   patterns for shell, per-file patch list for apply_patch) so approval UX and
   "always allow" generalization are principled. Tree-sitter parsing of commands
   for path-permission extraction is far more robust than regexing.
5. **LSP feedback loop:** edits/writes immediately return compiler diagnostics in
   the tool output; reads pre-warm servers.
6. **Small correctness details:** per-file semaphore write locks; CRLF and BOM
   preservation; UTF-8-safe byte slicing; 1-indexed `N: ` line prefixes with an
   explicit "don't echo the prefix" prompt rule; "did you mean" on missing files;
   exact `offset` continuation hints; binary sniffing before read;
   read-before-write/edit enforcement.
7. **Model-facing error philosophy:** every guardrail failure is an *actionable
   instruction* ("Re-read the file and provide the full exact oldString…",
   "Provide more surrounding context…", "retry with a larger timeout value"), and
   schema failures are echoed back with "Please rewrite the input."

Sources: [sst/opencode](https://github.com/sst/opencode) (`packages/opencode/src/tool/` on `dev`),
[OpenCode v2 docs](https://opencode.ai/v2/docs),
[Migrate from V1](https://opencode.ai/v2/docs/migrate-v1).
