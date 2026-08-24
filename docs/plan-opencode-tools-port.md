# Plan: port opencode v2's tool engineering into CodingToolkit

Companion to [research-opencode-tools.md](./research-opencode-tools.md), which documents
*what* opencode v2 does. This plan is *how we adopt it* — what we vendor, what we
reimplement, what we deliberately skip, and the invariants the port must hold.

## Goal

Upgrade `src/coding/CodingToolkit.ts` from a proof-of-composition battery into a
production-quality coding toolkit, taking heavy inspiration (and, where the code is
pure, verbatim vendored code) from opencode v2's tool layer — without changing the
agent core, the `Sandbox` seam, or the `Permission` projection model. The toolkit
must remain "what user code looks like": ordinary Effect AI tools over
`Sandbox.Current`.

## Decision recap (settled in conversation, 2026-08-23)

- **No dependency on opencode.** Their tool layer is not published as a library
  (`opencode-ai` ships CLI binaries; `@opencode-ai/sdk`/`plugin` are server
  clients), and the handlers are entangled with their App context, `ctx.ask`,
  LSP, watcher, and Bun APIs. We vendor/reimplement instead.
- **MIT license permits copying.** Every vendored file keeps a header:
  origin path in sst/opencode, commit hash, the MIT notice, and their own
  upstream credits (Cline, Gemini CLI) where present.

## Method: take the implementation, not the API

The point of this port is opencode's *engineering*, not their function
signatures. Their parameter names are the least valuable thing they have; the
value is in the heuristics, thresholds, orderings and edge-case handling that
only exist because their tools have been run against real models at scale.

Three rules follow, and they apply to every milestone.

**1. Port behaviour, not shape.** A milestone is not done when a tool has the
same parameters and a plausible implementation. It is done when the specific
decisions are carried across: the exact thresholds and tolerances, the order
strategies are tried in, what each guard refuses, which candidate is preferred
when several qualify, and what happens at the boundaries. When their code
encodes a number (0.65, 0.5, 25%, 2000 lines, 50 KB, 5 MB, 30%), that number
is a finding from production use and is copied, with its origin noted, rather
than re-derived.

**2. Read the actual source. Descriptions are not sufficient.** Working from a
summary of an algorithm reproduces its shape and silently loses its judgement.
This was demonstrated in M1: a version written from a careful prose
description of all nine replacer strategies passed a thorough test suite, and
still diverged from upstream in three behavioural ways, one of which was a
real safety regression (offering fallback blocks that upstream never offers,
so an edit could land on the wrong block). No amount of testing our own
implementation would have surfaced it, because the tests encoded the same
misunderstanding.

**3. Every divergence is deliberate, documented, and justified.** We do not
copy bugs. Where upstream is wrong we fix it -- but the fix is recorded in the
vendored file's header with the reproduction, so a future reader can tell an
intentional improvement from a porting error. An undocumented difference is a
defect regardless of which behaviour is better.

### The verification procedure

Each milestone that ports upstream behaviour runs this before it is called
done:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/sst/opencode.git
cd opencode && git sparse-checkout set packages/opencode/src/tool
git rev-parse HEAD          # pin this commit in the vendored file's header
```

1. **Read the real file** for every behaviour being ported, start to finish.
2. **Diff it against ours**, function by function. Note every difference, then
   classify each as: faithful, an accidental divergence (fix ours), or a
   deliberate improvement (keep, and document with a reproduction).
3. **Prove the claimed bugs.** A divergence justified as "upstream is wrong"
   requires running upstream's own code and capturing the output. Their tool
   modules are largely self-contained; transpiling the relevant section and
   running it takes a few minutes and turns an assertion into evidence.
4. **Run a differential harness** over a corpus that exercises each behaviour
   and its edges, comparing our result to theirs case by case. The target is
   zero unexpected divergences.
5. **Pin the agreement in our own suite.** Upstream's code is not vendored
   wholesale, so the differential harness is throwaway -- but the cases it
   verified become ordinary tests with their verified expected values, citing
   the commit. That way the agreement survives later refactors instead of
   evaporating when the scratch directory is deleted.

M1 is the worked example: 32 cases, 30 identical, 2 differing, both of those
documented bug fixes, and 14 of the agreed cases pinned in
`test/Replace.test.ts` under "agreement with upstream".

## What we take, and how

| Piece | Mode | Why |
| --- | --- | --- |
| `replace()` + 9 replacer strategies + disproportionate-match guard | **Vendor** (near-verbatim) | Pure string functions, zero opencode deps. The single highest-value piece. |
| `truncate` / byte-and-line-bounded `tail()` with UTF-8-safe slicing | **Vendor** (adapt the overflow-to-file part to the sandbox) | Pure logic; only the persistence side touches their runtime. |
| Read-tool behavior: `N: ` line format, 2000-line/50 KB caps, exact continuation footers, "did you mean", binary sniffing, offset-out-of-range | **Reimplement following their code** | The file itself calls their internals, but every behavior is small and specifiable. |
| Edit pipeline details: read-before-edit enforcement, CRLF/BOM preservation, per-file write lock, diff summary in output | **Reimplement** | Ours must run over `Sandbox`, not `fs`. |
| Search/grep/glob output shaping: grouped-by-file format, hard result limit + truncated footer, batching guidance in prompts | **Reimplement** | Our `search` walks the sandbox in-process; ripgrep is a provider detail we can't assume. |
| Model-facing error prose (actionable-instruction philosophy) | **Copy the words** | The error strings are a design artifact; use them nearly verbatim. |
| Tool prompts (`.txt` descriptions) | **Adapt** | Rewrite for our parameter names and sandbox-relative paths. |
| Shell tree-sitter permission parsing, LSP integration, task/subagent, apply_patch, webfetch/websearch | **Skip (for now)** | Too entangled with their runtime, or out of scope for the toolkit battery. Design notes stay in the research doc for later. |

## Layout

```
src/coding/
  CodingToolkit.ts          — tools + handlers (grows, stays the only public surface)
  internal/
    replace.ts              — vendored replacer chain (license header)
    truncate.ts             — vendored/adapted output bounding
    readFormat.ts           — line numbering, caps, continuation footers, binary sniff
    lineEndings.ts          — CRLF/BOM detect & preserve helpers
  prompts/                  — per-tool description strings (TS template constants,
                              rendered with real limit constants, not .txt files)
```

`internal/` is not exported from the package index. Prompts are TypeScript
constants rather than `.txt` imports so limits interpolate from the same
constants the code enforces (opencode lesson #3: prompts are rendered, not
static) and so no bundler config is needed.

## Invariants

These must hold at the end of every milestone; the test suite asserts each.

**I1 — Fuzzy matching selects, never synthesizes.** Any replacer strategy may
only *locate a span of verbatim file content*; the splice always uses actual
file text as the removed region and `new_string` as the inserted text. No
strategy may construct the text it replaces.

**I2 — Uniqueness per strategy, three terminal errors.** With `replace_all`
off, a strategy that matches more than once falls through to the next strategy
(never picks one arbitrarily). The driver ends in exactly one of: *not found*,
*ambiguous*, or *disproportionate match* — each with opencode's actionable
error prose.

**I3 — Disproportionate-match guard.** A matched span ≥ `max(oldLines + 3,
oldLines × 2)` lines, or (for multi-line oldStrings) trimmed length >
`max(old + 500, old × 4)` chars, is refused. A fuzzy strategy can never
swallow more than the model plausibly meant.

**I4 — Byte fidelity outside the edit.** Line endings (CRLF vs LF), a BOM, and
every byte outside the replaced span survive an edit unchanged. Matching is
done LF-normalized; writing restores the file's detected ending.
Round-trip test: edit a CRLF+BOM file, diff bytes, only the span differs.

**I5 — No lost updates.** Concurrent edits to the same path serialize
(per-path semaphore keyed within the toolkit); an edit computed against stale
content must not clobber an interleaved write. (The sandbox seam gives no
compare-and-swap, so serialization inside the toolkit is the guarantee.)

**I6 — Bounded output everywhere, with an honest paper trail.** No tool
returns unbounded text: read caps at 2000 lines *and* 50 KB, search caps at
100 results, bash output is tail-bounded. Every cap that fires says so in the
output with the exact numbers and a concrete continuation (`offset=N`, "narrow
the pattern"). The stated limits are interpolated from the constants that
enforce them — the prompt can never drift from the code.

**I7 — UTF-8-safe truncation.** Byte-bounded slicing never splits a
multi-byte sequence; truncated output is always valid UTF-8.

**I8 — Failures are instructions.** Every model-visible failure string tells
the model what to *do next*, not just what went wrong. (This is already our
convention — `failure: Schema.String` — and now becomes a review checklist
item for every new error path.)

**I9 — Repo type rule.** Vendored code is brought up to the house standard at
its exported surface: no `as any`, no `as unknown as`, no hand-annotations the
compiler should infer — in the vendored files themselves, not just callers.
Inference precision is asserted in tests and each assertion broken once to
prove it bites.

**I10 — The seam stays sealed.** Nothing in the port touches `Sandbox.ts`,
`Permission.ts`, or the agent core, and no tool gains a dependency beyond
`Sandbox.Current`. Everything runs through `SandboxPath` (relative,
`..`-free) — vendored code that assumes absolute paths is adapted, and tool
prompts say "path relative to the workspace", not "absolute path".

**I12 — Ported behaviour is verified against real source.** No
milestone claims to port an upstream behaviour on the strength of a
description. The vendored file names the exact upstream commit it was verified
against, every deliberate divergence is listed in its header with a
reproduction, and a differential run against upstream's own code has shown no
unexpected differences. A vendored file whose header cites a branch rather
than a commit has not been verified.

## Milestones

### M1 — Vendor the replacer chain; wire into `edit_file`

1. `internal/replace.ts`: the driver + all nine strategies + guard, with
   license header and pinned upstream commit. Port to house style (no
   `function*`-with-`var` looseness leaking to the surface; typed `Replacer`
   signature), keeping the algorithms byte-for-byte.
2. `internal/lineEndings.ts`: detect dominant ending, detect/strip/restore
   BOM, LF-normalize.
3. Rewrite the `edit_file` handler: read → normalize → `replace()` → restore
   ending/BOM → write under the per-path semaphore → report
   `edited <path> (+A -D)` from a line diff.
4. Keep the current `$`-safe splice property (their driver already splices by
   substring, never `String.replace` — verify with a `$&` test).
5. Empty `old_string`: refuse on an existing file with opencode's "use
   write_file for an intentional full-file replacement" prose; on a missing
   file it is *not* a creation path for us (that's `write_file`) — refuse with
   a pointer to `write_file`. Divergence from opencode, recorded here.

**Tests:** per-strategy fixtures (each strategy has an input it uniquely
solves — trailing-whitespace drift, over-escaped `\n`, rewritten block
middle, re-indented block…); the three terminal errors; I3 guard both
branches; I4 round-trip; I5 with two racing edits; the `$&` case;
`replace_all` semantics.

**Status: landed (2026-08-24).** `src/coding/internal/replace.ts` (nine
strategies + guard, MIT header), `src/coding/internal/lineEndings.ts`, the
rewritten `edit_file` handler, `test/Replace.test.ts` (29 tests) and seven new
cases in `test/CodingToolkit.test.ts`. `npm run check` green: 735 tests, 0
language-service diagnostics, portability clean.

What implementation changed relative to the plan:

- **Line endings are reconciled on the search strings, not the file.** The
  plan said "normalise, edit, convert back"; doing that rewrites every ending
  in a mixed-ending file, breaking I4. Converting `old_string`/`new_string` to
  the file's convention and matching against the file exactly as stored keeps
  every byte outside the span untouched. A test pins a mixed CRLF/LF file.
- **`TextDecoder` strips a BOM by default**, so `Sandbox.readText` silently
  deletes one on any read-modify-write. Rather than change the shared helper
  (I10), the edit path decodes for itself with `ignoreBOM: true`:
  reading for display may drop a BOM, reading in order to write back may not.
  `read_file` still strips it, which is correct for display.
- **Strategies overlap, so per-strategy coverage cannot go through the
  driver.** Two fixtures written against `replace()` were answered by an
  earlier, stricter strategy -- correct behaviour, useless test. The module
  now exports `strategyByName`/`candidatesOf` so each generator is driven
  directly, and separate tests pin the *ordering* (strictest-that-can-answer
  wins) as its own property.
- **Blocks need two forms.** A candidate block must be compared without its
  terminating newline but often yielded with it; yielding the bare lines when
  the find ended in a newline inserts a blank line. `coreOf`/`blockOf` split
  the two.
- **The result is a discriminated union, not an exception** (as planned), and
  carries the strategy name, which the handler reports to the model whenever
  the match was not literal (`matched by line-trimmed`).
- **The write lock is a module-level registry keyed by workspace+path**, so
  the guarantee holds across toolkit instances in a process. The plan's caveat
  that two instances would not serialise no longer applies; the remaining
  limit is that it is per process, not per machine.

Every invariant was broken once to confirm it is enforced, per AGENTS.md. Two
did not bite on the first attempt and the tests were strengthened until they
did:

- **I5** -- the in-memory sandbox never suspends between read and write, so
  removing the lock changed nothing observable. The gated sandbox now yields
  *between* read and write (cooperative scheduling, not a sleep), which is the
  window a lost update actually needs. An earlier latch-based attempt and a
  yield-before-read version were both vacuous.
- **I4** -- the CRLF test used a single-line `old_string`, which contains no
  newline to reconcile. It now spans two lines.

Final break-check, each against its own suite: lock removed -> 2 failures;
guard disabled -> 2; CRLF reconciliation removed -> 1; strategy order shuffled
-> 8; BOM preservation removed -> 1.

**Verification pass against real source (2026-08-24).** The port was written
from a prose description of the strategies; it was then diffed line by line
against `sst/opencode` at commit `2a6be0a03b93a6734070e10a6c3b56863475f214`,
per the method above. The driver, both guard formulas, all thresholds and
tolerances, the strategy order and five of the nine strategies were already
faithful. Three behavioural divergences were found and corrected, and they are
the reason this pass is now mandatory:

- **BlockAnchor offered runner-up candidates.** Upstream scores every
  candidate and yields *only the best*; ours yielded all above threshold,
  best-first. A fallback to a worse-scoring block could land an edit on
  different code that merely shares both anchors. A safety regression that our
  own tests could not have caught, because they encoded the same assumption.
- **Blank middle lines scored backwards.** Upstream skips a blank pair, so it
  contributes nothing while still counting against the divisor -- blank
  middles are evidence *against* a block. Ours awarded a free point.
- **ContextAware** counted a line pair only when the search side was non-empty
  (upstream: either side), and stopped at the first candidate (upstream
  continues per anchor position).

Two divergences were kept, both upstream bugs reproduced by running upstream's
own code, and both documented in the vendored header:

- `replaceAll(search, newString)` interprets dollar patterns: replacing `A`
  with `$'` in `"A A"` yields `" A "`. Our index-splice keeps it literal.
- A find ending in a newline leaves a blank line behind, because upstream's
  span excludes the terminating newline.

Evidence: a differential harness over 32 cases -- 30 identical, 2 differing,
both of them the documented fixes, zero unexpected divergences. Fourteen of the
agreed cases are pinned in `test/Replace.test.ts` under "agreement with
upstream" so the result survives future refactors. Suite after the pass: 748
tests green.

### M2 — Read tool: format, caps, continuation, diagnostics

- `N: ` (colon-space) line prefix; prompt rule "never include the `N: `
  prefix in old_string" lands with it (edit prompt updated in the same PR —
  the two rules are one contract).
- Caps: 2000 lines AND 50 KB per read, 2000 chars per line with the
  `"... (line truncated)"` suffix; exact continuation footers (`Use offset=N
  to continue.`, `(End of file - total N lines)`).
- `offset` past EOF → `Offset N is out of range for this file (M lines)`.
- File-missing → "did you mean" scan of the parent directory via
  `sandbox.list` (case-insensitive substring both directions, top 3).
- Binary sniff: extension table + 4 KB sample (NUL byte, >30% non-printable)
  → `Cannot read binary file:`. Uses `sandbox.read` bytes directly.
- Read-before-edit/write enforcement: the toolkit keeps a per-session set of
  read paths; `edit_file` and `write_file` (on an existing file) fail with
  "Read the file first" if the path was never read. This is toolkit-local
  state, not a sandbox change (I10).

**Status: landed (2026-08-24), with one item deliberately not done.**
`src/coding/internal/readFormat.ts` and a rewritten `read_file` handler; 10 new
tests. `npm run check` green: 757 tests.

Ported with upstream's exact constants and wording: the `N: ` prefix, 2000-line
and 50 KB caps, the 2000-char line cap and its suffix, the 4 KB binary sample,
the 30% non-printable ratio and the binary extension list, the
`<path>/<type>/<content>` wrapper, all three footers, and the
offset-out-of-range message.

Two upstream subtleties worth naming, because both are easy to lose:

- **The byte budget counts the joining newline** (`byteLength(line) + (first ?
  0 : 1)`), so it bounds the string the model actually receives rather than the
  sum of the lines.
- **A line-capped read keeps counting; a byte-capped read stops.** That is why
  the line-capped footer can quote a real total and the byte-capped one quotes
  none. We hold the whole file and *could* report a total in the byte-capped
  case, but deliberately do not: the footers are kept identical to upstream.

Divergences, both forced by our shape rather than chosen: image and PDF
attachments are not carried (a tool here returns a string, so such a file is
reported as binary), and reading a directory is refused with a pointer to
`list_files` instead of doubling as `ls`, because unlike v2 we already have
that tool.

Verified per the method above: differential harnesses against upstream's
accounting, footer templates and binary predicate -- 13 slice cases, 13 footer
cases, 10 binary cases, **zero divergences**. A property test walks a file by
following the footer's own `offset` hint and asserts every line appears exactly
once, in order.

One test corrected a wrong assumption of mine rather than a bug: I expected
"did you mean" to catch a misspelling. It does not -- upstream matches by
substring containment in both directions, which catches an abbreviation or a
missing extension but never a transposed letter. That bound is now pinned in a
test, so the hint's limits are documented rather than assumed.

**Not implemented: read-before-edit enforcement.** The plan listed it here; on
reading upstream's mechanism and weighing it against ours, it should not be
adopted as specified, and the conflict is recorded rather than worked around:

- Upstream compares a file's read time against its modification time, so it
  catches *staleness*, not merely "was this ever read". A naive "must have been
  read" set is a different, weaker rule wearing the same name.
- The staleness problem it solves is largely absent here. Our editor matches on
  content, not on line offsets, so a file that changed under the model either
  still contains `old_string` -- in which case the edit is meaningful -- or does
  not, in which case it already fails with an actionable message.
- Enforcing it needs per-session state. Our `handlers` are module-level, so the
  natural implementation is a process-wide map keyed by workspace and path,
  which leaks between sessions and makes a direct handler call fail for reasons
  unrelated to the call.

The remaining value is catching a model that edits a file it never opened. That
is real but small, and the cost is statefulness in a battery that is otherwise
a pure function of the sandbox. Recommend either dropping it or, if wanted,
implementing upstream's actual rule (content-hash staleness, per-session,
which needs `toolkit()` to build its own handlers) as its own scoped decision.

### M3 — Search and list: bounds and shape

- `search`: 100-result hard cap, `truncated` signaled with "narrow the path or
  pattern" prose; matched-line text capped per I6; skip binary files by the
  M2 sniff; optional `include` glob filter on filenames. Keep the in-process
  walk (ripgrep is a provider luxury, not a seam guarantee) but stop the walk
  early once the cap is hit rather than reading every file.
- `list_files`: keep the structured result; add the trailing-`/` convention
  and pagination only if a real transcript shows the need — not
  speculatively.
- `glob`-style filename matching folds into `search`/`list_files` params
  rather than a new tool, until usage argues otherwise.

**Status: landed (2026-08-24).** `src/coding/internal/searchFormat.ts`,
`src/coding/internal/glob.ts`, a rewritten `search` handler, and 20 new tests.
`npm run check` green: 777 tests.

Ported from `grep.ts` with upstream's wording and semantics: the 100-result
limit, `Found N matches` with `(more matches available)`, grouping by file with
a blank line between groups, the `  Line N: text` row, `No files found`, and
the truncation sentence. `truncated` means "we returned exactly the limit",
which cannot tell a search that found exactly 100 from one that stopped at 100
and warns for both -- upstream's behaviour, and the safe side to err on.

**`search` now returns a string rather than an array of matches.** The grouped
form states a path once per file instead of repeating it on every row, and the
truncation notice has somewhere to live. That is a breaking change to the
tool's success type, made deliberately: the format *is* the ported artefact.

Two divergences:

- **Each matched line is capped** at the same 2000 characters a read caps a
  line at. Upstream returns whatever ripgrep gives, so one minified file can
  dominate the output; I6 requires every tool's output to be bounded.
- **The search stops reading once it has the limit.** Upstream passes the limit
  to ripgrep, which does the same thing in another process. Ours is measured in
  a test: with 400 matching files, exactly 100 are opened.

`glob.ts` implements the `include` filter, and the semantics ported are
ripgrep's `--glob` (that is, gitignore's) rather than a general glob library's.
The rule worth stating because it surprises people: **a pattern with no `/`
matches the file's name at any depth**, so `*.ts` finds `src/deep/a.ts`, while
`src/*.ts` matches only files directly inside `src`. `**/` also swallows its
separator, so `**/a.ts` matches a top-level `a.ts`.

Also fixed, found while writing the handler rather than ported: a caller's
pattern may carry `/g`, and `RegExp.test` on a global regex advances
`lastIndex` between calls, so every other matching line would have been
skipped. `lastIndex` is reset before each line, with a test that fails without
it.

Not done, deliberately: `list_files` is unchanged. The plan said to add the
trailing-`/` convention and pagination "only if a real transcript shows the
need -- not speculatively", and nothing has. Upstream folds directory listing
into `read`; we already have a separate tool, so `read_file` on a directory
points at it instead.

Verified per the method above: a differential harness against upstream's output
assembly -- 8 cases covering empty, single, multi-file grouping, exactly the
limit, just under it, many lines in one file, unicode and empty match text --
**zero divergences**, with the line cap confirmed as the sole intended
difference.

### M4 — Bash: bounded tails and honest timeouts

- Output through `internal/truncate.ts`: tail-bounded by lines and bytes,
  UTF-8-safe (I7); when cut, prefix `...output truncated...` and (if the
  sandbox is writable) save the full output to a workspace-relative
  `.effect-agent/tool-output/<id>` file named in the message — the paper
  trail of I6, adapted from their truncation dir. Retention/cleanup is the
  application's business; we document the dir, we don't schedule jobs.
- Timeout surfaces opencode's prose: "…terminated after ${ms} ms. If this
  command is expected to take longer and is not waiting for interactive
  input, retry with a larger timeout value."
- Empty output → `(no output)`.
- The sandbox's own `OutputLimitError`/`TimeoutError` remain the hard bounds;
  the toolkit's tail-bounding is presentation on top, never a substitute.

**Status: landed (2026-08-24).** `src/coding/internal/truncate.ts`, a rewritten
`bash` handler, and 10 new tests. `npm run check` green: 787 tests.

Ported from `shell.ts`'s `tail` and the output assembly around it: the 2000-line
and 50 KB bounds, keeping the **tail rather than the head**, the byte accounting
including the joining newline, the character-boundary repair, and the
truncation banner and timeout sentence word for word.

The detail that matters most, and the reason this was worth porting rather than
writing: **when a single line is itself over budget, upstream keeps the end of
it and then walks the cut forward past any UTF-8 continuation byte**
(`(byte & 0xc0) === 0x80`). Without that step a truncated build log ends in a
half-decoded character. Ported exactly, with `TextEncoder` in place of `Buffer`
for portability.

Keeping the *tail* is the other decision worth naming: a failing command's
output is interesting at the end, so a head-bounded log throws away the error
and keeps the banner.

Divergences:

- **The paper trail lives in the workspace** (`.effect-agent/tool-output/`),
  because the sandbox is the only place we can write -- and the useful place,
  since `search` and `read_file` can be pointed at the saved file. Upstream
  writes to a global directory outside the project with a 7-day cleanup job; we
  schedule nothing, and the directory is the application's to keep or delete.
  Names ascend within a process and restart with it, so a later run can
  overwrite an earlier file: these exist to be read back during the session
  that produced them.
- **Saving is best-effort.** A read-only workspace still gets bounded output;
  it simply does not promise a file that was never written. Tested.
- **`bash` keeps its structured result** (`exit_code`/`stdout`/`stderr`) and
  bounds each stream separately, rather than merging the two into one string as
  upstream does. The ported artefact here is the bounding, not the merge, and
  merging would discard information our sandbox already separates. Upstream's
  `(no output)` placeholder is dropped with it: for a structured result an
  empty string is unambiguous, and a literal `(no output)` could be mistaken
  for output.
- **A timeout still fails the call.** Upstream returns partial output with a
  `<shell_metadata>` note; our sandbox kills the process and raises
  `TimeoutError`, discarding what it had. Changing that means changing the
  sandbox seam (I10), so the call fails -- but with upstream's actionable
  sentence rather than a bare elapsed budget.

Verified per the method above: a differential harness against upstream's `tail`
-- **103 cases, zero divergences** -- covering line and byte caps, exact-fit and
one-short budgets, empty and newline-only input, and every combination of four
multi-byte glyphs with eleven byte budgets, which is where the boundary repair
actually fires. The timeout and banner strings are compared literally. A
property test additionally asserts that no budget from 1 to 64 can produce a
replacement character or exceed the budget it was given (I7).

### M5 — Prompts pass

One PR that rewrites every tool description using their `.txt` files as raw
material: parallel-read guidance, "avoid tiny repeated slices", speculative
search batching, the anti-`undefined`-string warning on optional params, git
policy in the bash prompt, exact limits interpolated from the constants.
Descriptions live in `prompts/` and are asserted non-empty and
limit-consistent by a test (grep the rendered prompt for the constant's
value).

**Status: landed (2026-08-24).** `src/coding/internal/prompts.ts`, a
description on every tool, and `test/CodingPrompts.test.ts` (17 tests).
`npm run check` green: 804 tests across 95 files.

Adapted from upstream's `read.txt`, `write.txt`, `edit.txt`, `grep.txt`,
`glob.txt` and the shell prompt template: the parallel-read guidance, "avoid
tiny repeated slices", speculative search batching, the redirect-to-dedicated-
tools table, the "never include the line-number prefix" rule, the
never-proactively-create-documentation rule, and the git policy block.

Adapted rather than copied: paths are workspace-relative (ours refuses absolute
paths and `..`), tool names are ours, and guidance about tools we do not have is
dropped rather than left pointing at nothing -- a test asserts every tool the
bash description names actually exists in the toolkit.

**Every limit is interpolated from the constant that enforces it**, which is
the whole point of the milestone. A single file of template strings rather than
the planned `prompts/` directory: one file, no directory needed, and `.txt`
imports would need build machinery `tsc` does not give us.

The consistency test is stronger than "each limit appears somewhere": it
extracts **every run of digits** from each description and asserts each one is a
value some constant currently holds, with incidental numbers listed explicitly
so adding one is a decision rather than an accident. Typing a literal where a
constant belongs fails immediately if the number is wrong, and fails later --
when the constant moves -- if it happened to be right.

Verified by breaking it three ways: a hard-coded line count in prose fails; a
stated limit being dropped fails; and changing a constant while prose carries a
typed literal fails with the diagnostic
`bash description mentions 2000, which is not one of its constants (4000,
51200)`. Changing a constant on its own correctly does *not* fail, because the
prose follows it -- which is the behaviour being bought.

**Status: on hold (2026-08-24) -- the gate is not cleared.** M1-M5 are done;
this one is not started, and should not be started on my own authority.

The plan's own "verified against the repo" section put a gate here: a new
exported concept needs either a second independent consumer or a recorded
justification in `PLAN.md`. Checked against the repository rather than assumed,
the gate holds shut:

- **`PLAN.md` is the design authority and does not contemplate a network
  seam.** Its extension list is Memory, Sandbox, Subagent, Persistence, AG-UI
  and the coding toolkit. Adding one is a change to that document, which is the
  owner's call, not a porting decision.
- **The bar is explicit and this does not meet it.** §42.2 admits a new
  exported concept for "friction that was demonstrably repeated in this
  repository rather than friction someone might hypothetically feel". Nothing
  here has wanted web access. `WebAccess` would have exactly one consumer: the
  two tools written in the same change.
- **There is no upstream implementation to port anyway.** opencode's
  `websearch` is a thin wrapper over a paid API chosen by an env-var-then-flag-
  then-session-checksum A/B split; the engineering worth taking -- the year
  injection, result defaults, the Cloudflare `cf-mitigated` retry -- is prompt
  text and a few lines of fetch handling, not an algorithm. S9's differential
  verification has nothing to compare against.
- **It costs more than the other milestones.** A new `./web` export entry, and
  probably a runtime dependency for HTML-to-markdown, against a package whose
  `dependencies` is currently three entries.

Writing a justification into `PLAN.md` to clear a gate I set is the exact
failure the gate exists to prevent, so it is not being done.

**What would change this:** a second consumer appearing (an agent in this repo
that genuinely needs to fetch), or the owner deciding the seam is wanted and
recording it in `PLAN.md`. If it is wanted, the design in this section stands
as written -- seam first, thin tools over it, `action: "net"` on the domain,
providers as layers, I11 (no ambient network) as the invariant -- and the
smallest honest version is `web_fetch` alone, since fetching has real logic to
own while searching is an API key.

### M6 — Web tools: a seam, then thin tools (independent of M1–M5)

opencode's `websearch` has no algorithm to vendor — it is a thin tool over paid
APIs (Exa or Parallel, chosen env → flag → session-checksum A/B). `webfetch` is
closer to portable (5 MB cap, Turndown HTML→markdown, Cloudflare
`cf-mitigated: challenge` retry with an honest UA) but does raw network I/O.
Which backend exists — or whether network access exists at all — is the
application's business, so this mirrors the `Sandbox` answer:

1. **`src/web/WebAccess.ts` — a new seam**, shaped like `Sandbox`:
   - `search(query, options)` → ranked results (title, url, snippet/content),
     `fetch(url, options)` → `{ status, contentType, body }` with format
     (`text|markdown|html`), timeout, and byte-cap options.
   - Tagged errors in house style (`FetchDeniedError`, `ByteLimitError`,
     `SearchProviderError`, …); failures reach the model as actionable
     strings per I8.
   - A `WebAccessProvider`/`Current` pair exactly like `SandboxProvider`/
     `Sandbox.Current`, so tools depend on `WebAccess.Current` and apps wire
     a provider layer.
2. **Toolkit tools** `web_search` and `web_fetch` over the seam,
   `Permission.annotate`d with `action: "net"` and the *domain* as resource —
   so a policy can allow `docs.*` and ask about everything else without
   knowing the tools' parameter shapes.
3. **Reference providers** (separate modules, optional): one fetch provider
   (global `fetch`, 5 MB checked on Content-Length *and* body, HTML→markdown,
   the Cloudflare retry trick) and one search provider over a single
   pick-one API (decide at implementation: whichever has the simplest
   keyed REST surface). A canned-results test provider ships with the
   testing utilities.
4. **From opencode verbatim:** the prompt engineering — current-year
   injection ("The current year is ${year}. You MUST use this year when
   searching for recent information."), result-count defaults, format
   parameter docs, timeout prose.

New invariant for this milestone:

**I11 — No ambient network.** No tool in the package performs network I/O
except through `WebAccess.Current`; an application that wires no web provider
has agents that *cannot* fetch, and the tools are simply absent from the
toolkit unless explicitly included. Fetch responses are byte-capped before
they reach the model (I6 applies).

This is a new seam — a design decision, not a port — so it lands as its own
PR series and must not block or be blocked by M1–M5.

## Success conditions

The plan is done when all of the following hold; each milestone's PR checks
its own rows before merge.

- **S1 (M1):** The edit-strategy fixture suite passes: for each of the nine
  replacers, a fixture that *only* that strategy (or an earlier one) solves;
  the three terminal errors and the I3 guard each have a failing-input test;
  the CRLF+BOM byte-round-trip test (I4) and the two-racing-edits test (I5)
  are green on win32 and on POSIX CI.
- **S2 (M1, behavioral):** Edits that fail today succeed after the port —
  demonstrated by a small corpus of real failed-edit transcripts (collect
  from our own sessions: over-escaped `\n`, indentation drift, stale
  trailing whitespace). Target: every corpus case either applies correctly
  or fails with one of the three actionable errors; zero silent mis-edits.
- **S3 (M2):** Read output matches the specified format exactly (`N: `
  prefix, footers with real numbers); property test: for any file and any
  `offset`, following the footer's `offset=N` hint eventually yields
  `(End of file …)` with no line skipped or repeated. Binary files refuse;
  missing files suggest; unread files block edit/write with the
  read-first error.
- **S4 (M3):** Search over a tree larger than the cap stops early (measured:
  files read < total files), returns exactly the cap, and says so; binary
  files are skipped, not errored.
- **S5 (M4):** A command emitting more than the tail bound returns valid
  UTF-8 (I7 property test over multi-byte output), names the overflow file,
  and that file contains the complete output; the timeout message matches
  the specified prose.
- **S6 (M5):** A test renders every tool description and asserts each
  numeric limit named in prose equals the enforcing constant; changing any
  constant without the prompt following breaks the build.
- **S7 (M6):** With no web provider wired, the package compiles and a
  toolkit without web tools runs unchanged (I11); with the test provider, a
  policy on `action: "net"` gates by domain without referencing tool
  parameter shapes; the reference fetch provider enforces the byte cap on a
  response whose Content-Length lies.
- **S8 (global):** Every invariant I1–I12 has at least one test that fails
  when the invariant is deliberately broken (each was broken once during
  development to prove it — the repo's standing rule for inference applies
  to invariants too); no `as any`/`as unknown as` anywhere in `src/coding/`
  or `src/web/`, including vendored files; vendored files carry origin
  path + pinned commit + MIT notice.

- **S9 (every porting milestone):** The upstream file has been read in full
  and diffed against ours; each difference is classified and, if deliberate,
  documented in the header with a reproduction; a differential run over a
  corpus covering each behaviour and its edges shows zero unexpected
  divergences; the verified cases are pinned as ordinary tests naming the
  commit; and the vendored header cites that commit rather than a branch.

## Verified against the repo (2026-08-23)

Claims in this plan checked against the actual codebase:

- **`action: "net"` is legal.** `Permission.Projection.action` is an open
  `string` (`src/Permission.ts`); no registry to extend. Rules match by
  string/RegExp/predicate, so domain-gating policies work as sketched.
- **The in-memory sandbox is byte-faithful.** `sandbox/memory.ts` stores raw
  `Uint8Array` (strings pass through `TextEncoder` once, on write); CRLF and
  BOM bytes survive round-trips, so the I4 tests are trustworthy against it.
  Risk retired.
- **Prompts as TS constants is confirmed necessary,** not just preferred: the
  build is plain `tsc` (`tsconfig.build.json`) with no asset copying, so
  `.txt` imports would need build machinery we don't have.
- **Packaging:** `./coding` already has an export entry; M1–M5 need no
  `package.json` change (`internal/` and `prompts/` stay unexported). **M6
  requires a new `./web` export entry**, and if a reference provider grows a
  real dependency (HTML→markdown), that dependency must be weighed against
  the near-dependency-free posture (`dependencies` is currently three
  packages) — prefer a minimal built-in tag-stripper or make markdown
  conversion pluggable before adding Turndown.
- **Portability rules (AGENTS.md):** `src/coding` is a portable module — the
  vendored code must import nothing host-specific (it doesn't; pure string
  work), and `npm run lint:portability` enforces it. For M6, `fetch` is an
  explicitly allowed web-standard global, so the reference fetch provider
  can live in portable code; if any part needs more, it follows the
  `sandbox/local` pattern: own export entry + `HOST_MODULES` line.
- **Test conventions:** flat `test/*.test.ts` on `@effect/vitest`;
  `CodingToolkit.test.ts` and `Sandbox.test.ts` exist to extend, and pure
  internals get their own files (`Replace.test.ts`, `Truncate.test.ts`).
  AGENTS.md's determinism rule bites the I5 racing-edits test: synchronize
  the two edits with `Deferred`/latches (e.g. a scripted sandbox `write`
  that blocks on a latch), never timing. "Assert exact sequences" applies to
  the replacer driver too: assert *which* strategy matched, not just that
  the edit landed.
- **Governance:** AGENTS.md names `PLAN.md` as the design authority and bans
  new exported concepts "until two independent features need it". M1–M5 add
  no exported concept (everything lands behind the existing `./coding`
  surface). **M6's `WebAccess` seam is a new exported concept with one
  consumer** — before implementing it, either record it in `PLAN.md` with
  the justification (the second "feature" is the seam's own purpose:
  applications supplying providers, same argument that admitted `Sandbox`)
  or hold M6 until a second consumer materializes. `STATUS.md` gets a line
  per landed milestone.
- **House error style:** internal modules return typed results or
  `Schema.TaggedError`s (message as getter); the *toolkit* surface keeps
  `failure: Schema.String` as today, mapping errors to actionable strings at
  the handler boundary. Vendored `replace.ts` should return a discriminated
  result (`NotFound | Ambiguous | Disproportionate | Replaced`) rather than
  throw, converted to prose in the handler — same algorithms, house shape.

## Review of M1-M5 (2026-08-24)

A read-through of everything the port added, looking for defects rather than
confirmation. Five findings, all fixed; final state 819 tests green, all four
differentials clean, every invariant still failing when broken.

**1. A phantom line at the end of nearly every file (real bug).** `read_file`
counted lines with `String.split("\n")`, which reports an extra empty line for
any text ending in a newline. A normal `"a\nb\n"` was read as **three** lines,
rendering a bogus `3: ` row and a total one too high; an empty file reported one
line instead of none. Upstream reads through `Stream.splitLines`, which never
yields that line -- confirmed by running both against the same inputs.

The differential harness had missed it because the harness was wrong in the
same way: it transcribed upstream's *accounting loop* faithfully but fed it
`split()` instead of stream semantics, so it compared my mistake against
itself. **A differential is only as good as its model of the other side**, and
the parts of upstream not being diffed are exactly where that model can be
wrong. Both the code and the harness are fixed; `toLines` is now shared by the
reader and by `search`, which had the same flaw (a pattern like `.*` would have
reported a match on a line past the end of the file).

**2. A test that tested nothing.** The M4 test asserting "the saved file
contains the complete output" opened a *fresh* sandbox, wrote the content
itself, read it back, and compared -- exercising `TextEncoder`, not the tool.
S5's claim was unverified. It now reads the file back from the same sandbox the
tool wrote it to, and additionally asserts the saved file contains the
beginning that the bounded view dropped.

**3. A misleading test and the dead code it defended.** `search` reset
`regex.lastIndex` before each line, with a test claiming to prove a `/g` pattern
would otherwise skip alternate lines. But the regex is built with
`new RegExp(pattern)` and never carries flags, so `lastIndex` is never
advanced: the guard was dead and the test proved nothing. Both removed; the
test now asserts what it actually checks (every matching line in a file is
reported).

**4. A user-facing count that was wrong.** `edit_file` reported `+2 -2` for
replacing a single line, because the matched span carries its terminating
newline and `split` counted that as a second line. Now counted the way a reader
counts, with a test pinning `+1 -1` and `+3 -2`.

**5. Dead code.** `numberLines`, the old tab-prefixed formatter, survived M2
unused. `noUnusedLocals` is not enabled and the language service did not flag
it, so nothing caught it but reading.

Also checked and found sound: the local sandbox's `write` creates parent
directories, so M4's `.effect-agent/tool-output/` paper trail works on a real
filesystem, not only against the in-memory provider; no casts or non-null
assertions anywhere in `src/coding/` or its tests; all 31 package entry points
still import from the packed artifact, with `internal/` correctly unexported;
and no consumer of the toolkit depended on `search`'s old array result
(`examples/` and `test/Integration.test.ts` use the file tools individually).

`glob.ts` was stress-tested separately, since it is the one module written from
scratch rather than ported: 33 adversarial cases including regex
metacharacters as literals, brace alternation, `**` crossing directories where
a bare `*` must not, case sensitivity, and a malformed pattern matching nothing
instead of throwing. The risky ones are now permanent tests.

**Known limitations, accepted rather than hidden:**

- **Whole-file reads.** The sandbox exposes `read(path)` with no range, so
  `read_file` and `search` load a file entirely before slicing it. Upstream
  streams and stops early. For `search` this is worse than it looks: a file is
  read in full only to have its first 4 KB sniffed and be discarded as binary.
  Fixing it properly means a ranged read on the sandbox seam, which is a
  separate decision.
- **The lock registry only grows** -- one semaphore per path ever edited, for
  the life of the process. Evicting safely needs reference counting, since
  dropping a held lock would silently end the mutual exclusion it exists to
  provide. A few bytes per file is the better trade.

## Should search shell out to ripgrep? (asked and answered, 2026-08-24)

No -- but the question found a real defect, which is now fixed.

**What the question exposed.** Run against this repository, `search` took
4.6 seconds and returned 100 matches from 13 files: plan documents and
`dist/*.js`. It walks alphabetically, filled its entire result budget with
build output, and never reached `src` at all. The tool was not so much slow as
useless on any real project.

**Why ripgrep is not the fix.**

- **Results would depend on the machine.** "Use rg if it is installed" means the
  same query returns different answers on different machines -- different
  ignore rules, different ordering, different binary detection. That is a worse
  failure mode than being slow, and it means the test suite (in-memory sandbox,
  no `exec`) would exercise a different code path than production, which is
  where bugs hide.
- **We cannot bundle it.** Upstream can rely on ripgrep because they ship the
  binary. A portable library cannot, so availability is genuinely uncertain.
- **It would go through `Sandbox.exec`**, which not every sandbox has (the
  in-memory one has none) and which `Permission` gates as `shell`. A read-only
  search policy would suddenly need shell permission in order to search -- a
  real regression in what a policy can express.
- The escape hatch already exists: a model that wants ripgrep can invoke it
  through `bash`, which is what upstream's own grep description recommends for
  counting matches.

**The actual fix: default ignore rules.** `search` no longer descends into
`node_modules`, `dist`, `.git`, `coverage`, `target` and the rest of the usual
suspects. Deterministic, provider-independent, and it addresses both halves of
the problem: **4639ms to 143ms on this repository, returning source instead of
build output.** A directory is only skipped when the walk would descend into
it, so scoping a search at `dist` still searches `dist`; the description says
so, and three tests pin the behaviour, including the nested case.

Parsing `.gitignore` properly would be better still, and is what ripgrep does.
It is not done here: a fixed list is most of the value for none of the
machinery, and it stays deterministic. If a project needs its own rules, that
is a reason to make the list a parameter -- when a second project actually
needs it.

## Considerations & risks

- **Sandbox has no rename/delete.** Nothing in M1–M5 needs one; apply_patch
  (skipped) would. If we ever add it, that's a deliberate seam extension, not
  part of this plan.
- **Per-path semaphore scope.** The lock lives in the toolkit closure
  (`toolkit()` already constructs per call), so two *toolkit instances* over
  one workspace don't serialize. Acceptable now; note in the doc comment.
  **Superseded twice over:** the registry is now module-global (see the
  `editLocks` comment at `CodingToolkit.ts:249`, which also documents why
  entries can never be removed), and both that leak and this scoping question
  are answered by moving it to `TxHashMap` + `TxSemaphore` —
  [plan-pi-toolkit.md](./plan-pi-toolkit.md) P1, per
  [audit-effect-ecosystem.md](./audit-effect-ecosystem.md) E7. A transactional
  registry built in a layer is per-runtime rather than per-closure or
  per-module, which is the scope this note was reaching for.
- **Windows.** We develop on win32; I4's CRLF tests are not hypothetical.
  (Verified: the in-memory sandbox stores raw bytes, so round-trip tests
  against it are meaningful.)
- **Performance of the replacer chain.** Nine strategies over a large file is
  fine (each is linear-ish), but `LineTrimmedReplacer`/`BlockAnchorReplacer`
  are O(file × search) in the worst case; keep files under the read cap
  mentality and don't pre-optimize.
- **Prompt drift.** Any PR that changes a limit constant must run the M5
  consistency test — that's the whole reason prompts render from constants.
- **Attribution hygiene.** One `NOTICE`-style block in each vendored file +
  a line in the repo README/AGENTS if we publish. Pin the upstream commit in
  the header so future syncs can diff against it.
- **Upstream sync.** We do *not* promise to track opencode. If their replacer
  chain improves, syncing is a manual diff against the pinned commit -- which
  is exactly why the commit is pinned in each vendored header.
- **Verification does not apply uniformly.** M2 and M3 reimplement behaviour
  over our own sandbox rather than vendoring, so a line-by-line diff is the
  wrong tool: read their file for the decisions (cap values, footer wording,
  the binary-sniff ratio, the "did you mean" rule) and port those, but expect
  our control flow to differ. A differential harness is still worth it where
  the logic is pure and comparable (truncation and tail-slicing in M4 are, and
  their read-tool formatting mostly is). M6 has no upstream algorithm to
  compare against at all -- their websearch is a thin wrapper over a paid API
  -- so S9 does not apply to it beyond copying the prompt engineering.
- **Cost.** The M1 verification took roughly as long as the original port.
  That is the correct trade for the edit engine, which silently corrupts files
  when it is subtly wrong. Weigh it per milestone: it is clearly worth it for
  anything that writes to a file, and less so for output formatting where a
  mistake is visible immediately.

## Explicit non-goals

LSP diagnostics in tool output, tree-sitter command parsing for permissions,
apply_patch, task/subagent tooling, todo tools, and any change to `Sandbox`,
`Permission`, or the agent core. All are catalogued in the research doc if
they're wanted later. (Web search/fetch were originally here; promoted to M6.)

## Order & effort

M1 is the win and the risk concentrate — do it first and alone. M2 unlocks the
read/edit contract (`N: ` prefix rule) so it follows immediately. M3–M5 are
independent of each other after M2 and small. M6 is a separate track — a new
seam, independent of the others, can proceed in parallel or later. Each
milestone is one PR with its invariant tests; no milestone starts until the
previous one's invariants are green.
