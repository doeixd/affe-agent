/**
 * The tool descriptions the model reads.
 *
 * ---------------------------------------------------------------------------
 * Adapted from opencode's `*.txt` tool descriptions, verified against commit
 * 2a6be0a03b93a6734070e10a6c3b56863475f214.
 * Upstream: https://github.com/sst/opencode -- MIT License, Copyright (c) sst.
 * ---------------------------------------------------------------------------
 *
 * **Every limit here is interpolated from the constant that enforces it.**
 * That is the point of this module existing at all: a description quoting
 * "2000 lines" while the code stops at 4000 is worse than one saying nothing,
 * because the model plans around the number it was told. Upstream renders its
 * shell description the same way, from the same constants the truncator uses.
 *
 * These are TypeScript template strings rather than `.txt` files because this
 * package builds with plain `tsc` and copies no assets -- a `.txt` import would
 * need build machinery we do not have.
 *
 * Adapted rather than copied: paths here are workspace-relative (the sandbox
 * refuses absolute paths and `..`), the tool names are ours, and guidance about
 * upstream-only tools is dropped rather than left pointing at things that do
 * not exist.
 */

import { DEFAULT_LIMIT, MAX_BYTES_LABEL, MAX_LINE_LENGTH } from "./readFormat.js"
import { SEARCH_LIMIT } from "./searchFormat.js"
import { MAX_BYTES, MAX_LINES, OUTPUT_DIR } from "./truncate.js"

export const READ_FILE = `Read a file from the workspace.

Usage:
- \`path\` is relative to the workspace root. Absolute paths and \`..\` segments are refused.
- By default this returns up to ${DEFAULT_LIMIT} lines from the start of the file.
- \`offset\` is the line to start from (1-indexed). Every capped read ends with the exact offset to pass next, so continuing never requires arithmetic.
- The read is capped at ${DEFAULT_LIMIT} lines and ${MAX_BYTES_LABEL}, whichever comes first. A single line longer than ${MAX_LINE_LENGTH} characters is truncated.
- Each line is prefixed with its number as \`<line>: <content>\`, so a file containing "foo" comes back as "1: foo". The prefix is not part of the file: never include any part of it in an \`edit_file\` \`old_string\`.
- Use \`search\` to find content in large files rather than reading them whole.
- Call this tool in parallel when you know there are several files you want.
- Avoid tiny repeated slices. If you need more context, read a larger window rather than many small ones.
- Binary files are refused. Use \`list_files\` for a directory.`

export const WRITE_FILE = `Write a file to the workspace, creating it or replacing it entirely.

Usage:
- \`path\` is relative to the workspace root.
- This overwrites an existing file completely. To change part of one, use \`edit_file\`.
- ALWAYS prefer editing an existing file. NEVER write a new file unless it is required.
- NEVER proactively create documentation files (*.md) or README files. Only create them when explicitly asked.
- Only use emojis if the user explicitly requests it.`

export const EDIT_FILE = `Replace a string in a file.

Usage:
- Read the file first. Preserve the exact indentation as it appears AFTER the \`<line>: \` prefix that \`read_file\` adds, and never include any part of that prefix in \`old_string\` or \`new_string\`.
- \`old_string\` must identify one place in the file. If it appears more than once the edit is refused: add surrounding context to make it unique, or pass \`replace_all\` to change every occurrence.
- \`replace_all\` is what you want for renaming a variable throughout a file.
- \`new_string\` must differ from \`old_string\`, and \`old_string\` cannot be empty. To replace a whole file, use \`write_file\`.
- Small drift is tolerated: trailing whitespace, indentation, and an over-escaped \\n still match. The result reports \`strategy\`; anything but \`simple\` means the text matched was not the text you supplied, so your copy of the file has drifted -- read it again before editing further.
- The result also reports \`path\`, \`replacements\`, the lines \`added\` and \`removed\`, and \`matched\` -- the text that was actually replaced, which differs from your \`old_string\` whenever the match was not exact.
- An edit is refused rather than guessed if the closest match is far larger than \`old_string\`. Re-read the file and quote the exact text.
- ALWAYS prefer editing an existing file over writing a new one. Only use emojis if the user asks for them.`

export const LIST_FILES = `List the entries of a directory in the workspace.

Usage:
- \`path\` is relative to the workspace root. Omit it to list the root. Do not pass "undefined" or "null" -- simply omit the field.
- Returns each entry with its type, one level deep. Use \`search\` to find files by content, and pass \`include\` there to filter by name.`

export const SEARCH = `Search file contents with a regular expression.

Usage:
- Full regular expression syntax is supported, e.g. "log.*Error" or "function\\s+\\w+".
- \`include\` filters by file name glob, e.g. "*.ts" or "*.{ts,tsx}". A pattern with no \`/\` matches the file's name at any depth, so "*.ts" finds nested files; a pattern containing \`/\` is matched against the whole workspace-relative path, so "src/*.ts" matches only directly inside \`src\`.
- \`path\` restricts the search to a subtree.
- At most ${SEARCH_LIMIT} matches are returned, grouped by file with line numbers. If the result says it was truncated, narrow the path, the pattern, or \`include\` -- there is no paging.
- Binary files are skipped, as are build and dependency directories such as \`node_modules\`, \`dist\` and \`.git\`. To search one of those, point \`path\` at it explicitly.
- It is always better to run several searches as a batch than to search once and wait.`

/**
 * The command tool's description, for the dialect the toolkit was built
 * with. The first sentence names it, so a model writing for PowerShell is
 * told so before it writes; the rest is shared and dialect-neutral.
 */
export const shell = (displayName: string): string => `Run a command in the workspace using ${displayName}.

Usage:
- This tool is for terminal operations: git, npm, docker and the like. DO NOT use it for file operations -- the dedicated tools are better and cheaper:
  - Find files by content: use \`search\` (NOT grep or find)
  - Read a file: use \`read_file\` (NOT cat, head or tail)
  - Write a file: use \`write_file\` (NOT echo redirection)
  - Edit a file: use \`edit_file\` (NOT sed or awk)
- \`timeout_ms\` bounds how long the command may run. If a command is killed for exceeding it and is not waiting for input, retry with a larger value.
- stdout and stderr are each capped at ${MAX_LINES} lines and ${MAX_BYTES} bytes, keeping the END of the output, which is where a failure reports itself. When output is cut, the whole of it is written to a file under \`${OUTPUT_DIR}\` and the path is named in the result: read or search that file rather than re-running the command piped through head or tail.

# Git and GitHub
- Only commit, amend, push, or create pull requests when explicitly asked.
- Before committing, inspect \`git status\`, \`git diff\`, and the recent log; stage only intended files and never commit secrets.
- Write a concise commit message matching the repository's style.
- Do not update git config, skip hooks, use interactive \`-i\` flags, force-push, or create empty commits unless explicitly asked.
- If a commit fails or a hook rejects it, fix the problem and make a new commit; do not amend the failed one.
- Use \`gh\` for GitHub tasks, and return the pull request URL when you create one.`
