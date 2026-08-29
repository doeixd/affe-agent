# Plan: Pi Toolkit

Second in the series that began with [plan-opencode-tools-port.md](./plan-opencode-tools-port.md).
Same method, different source: take the best parts of the **Pi** agent harness's
tool implementations — not their API shape — and verify the result against real
source rather than a description.

- **Upstream:** [`earendil-works/pi`](https://github.com/earendil-works/pi),
  MIT licence, Copyright (c) 2025 Mario Zechner. Read at commit
  **`dcd461925db2edf69a43c8135db1180d418afd54`**.
- **Where the code lives:** two sets, and the difference matters.
  - `packages/agent/src/harness/tools/` — the minimal harness core:
    `bash`, `edit` (+ `edit-diff`), `read`, `write`, plus `image`,
    `file-mutation-queue`, `path-utils`.
  - `packages/coding-agent/src/core/tools/` — the fuller set: adds `find`,
    `grep`, `ls`, `powershell`, `truncate`, `output-accumulator`,
    `render-utils`, `tool-definition-wrapper`.
- **Stack:** TypeScript, TypeBox schemas, promise-based. Not Effect, so nothing
  here transplants as directly as opencode's Effect code did; the algorithms
  port, the plumbing does not.

## The decision this plan exists to force

**Should this be a second toolkit, or should the good parts land in
`/coding`?** Everything below depends on the answer, so it is settled first.

A `/pi` toolkit shipping its own `read_file`, `write_file`, `edit_file`,
`search` and `bash` would give the library **two overlapping batteries** that
do the same six things, double the maintenance, and force every user to choose
between them with no good basis for choosing. AGENTS.md's rule — no new
exported concept until two independent features need it — points the same way.

**Recommendation: absorb, don't duplicate.** Pi's genuinely additive ideas make
the *existing* tools better; they are not a different product. The milestones
below are written as improvements to `/coding`.

**The one case for a separate surface** is different and legitimate: if the
goal is *contract fidelity* — an agent authored against Pi's tool schemas
(`edits[]`, `oldText`/`newText`, Pi's tool names) running unmodified here —
then that is a **compatibility adapter**, not a battery. It would be a thin
mapping layer over the same handlers, and it should be named for what it is
(`/coding/pi-compat`) rather than presented as an alternative toolkit. It is
out of scope until someone actually needs it, and P0 records that.

## P0 — Settle the shape (no code)

Confirm the above with the owner, and record the outcome here. If "absorb" is
confirmed, P1–P5 proceed and no new export entry is created. If a Pi-shaped
contract surface is genuinely wanted, it is planned separately, because it is
an adapter with different success conditions (fidelity to Pi's schema) than a
battery (quality of behaviour).

**P0 settled (2026-08-26): ship a second toolkit.** The owner wants Pi's
contracts as `@doeixd/effect-agent/pi`, not absorbed into `/coding`.
`/coding` stays the OpenCode-shaped battery (structured `list_files`, one
edit per call, `bash -lc`). `/pi` is contract fidelity: batch `edits[]`,
rendered listings, injectable shell. Same sandbox seam, same permission
projections, different tool schemas. Mixing both on one workspace is not
the intended use.

P1 (canonical-path lock) landed 2026-08-26 for both toolkits, on one shared
registry. P2–P5 land in `/pi`.

## What is worth taking, and why

Grounded in the source, not the README. Ordered by value.

| Piece | Mode | Why it is worth the change |
| --- | --- | --- |
| `file-mutation-queue.ts` — canonical-path serialisation with cleanup | **Port the design** | Fixes *both* limitations I documented in our own lock. |
| `edit.ts` + `edit-diff.ts` — a batch of edits applied atomically | **Port the design** | Fewer round trips and all-or-nothing semantics; genuinely additive to our single-edit tool. |
| Overlap detection between edits | **Port** | The correctness piece a batch edit cannot ship without. |
| Indexed error messages (`edits[2] ...`) | **Copy the words** | With five edits in flight, "not found" is useless unless it says which one. |
| Argument coercion (`prepareEditArguments`) | **Port the idea, carefully** | Repairs a model sending `edits` as a JSON string, or the legacy single-edit shape. |
| `truncateHead` alongside `truncateTail` | **Port** | We only kept tails; a head is right for some output. |
| `formatSize` + "why it truncated" warnings | **Port** | Names the limit that fired, not just that one did. |
| `GREP_MAX_LINE_LENGTH = 500` | **Consider** | Pi caps search lines four times tighter than we do. |
| `powershell.ts` — one implementation, two shells | **Port the design** | Our command tool used to hardcode Bash; since `plan-shell-tool.md` landed it is `shell`, built for the configured dialect. |
| `ls.ts` conventions — `/` suffix, dotfiles, alphabetical, 500-entry cap | **Port** | Exactly the `list_files` work M3 deferred for want of evidence. Now there is evidence. |
| `output-accumulator.ts` | **Skip for now** | Streaming progress needs a preliminary-results path our tools do not use yet. |
| `.gitignore` support in `find`/`grep` | **Skip** | Pi gets it from ripgrep (`Default: local filesystem plus ripgrep`), so there is no portable implementation to take. Same conclusion as before, now confirmed twice. |
| `image.ts`, `render-utils`, `tool-definition-wrapper` | **Skip** | Attachments and TUI rendering; no counterpart here. |

### Two findings that change existing code

**1. Our write lock is beaten on both counts I called acceptable.** Pi keys its
mutation queue on the **canonical path**, so two names for one file (a symlink,
a differently-spelled path) serialise — ours keys on the literal sandbox path
and would let them race. And Pi **deletes a queue entry when it drains**
(`if (state.queues.get(key) === chainedQueue) state.queues.delete(key)`), so it
does not grow forever — I documented unbounded growth as the better trade, and
Pi shows the trade was not necessary. Its state is per-environment in a
`WeakMap` rather than module-global, which is also tidier.

**2. Their edit is a batch, ours is one at a time.** Pi takes
`edits: [{oldText, newText}, ...]`, matches **every edit against the original
content** (never incrementally), requires each to be unique, sorts the matches
and **rejects overlaps**, then applies them together. When its fuzzy fallback
fires it applies replacements to a normalised copy while
`applyReplacementsPreservingUnchangedLines` keeps untouched lines byte-identical
— the same instinct as our "select, never synthesize", reached differently.

Note the contrast worth keeping: Pi has **one** fuzzy fallback where opencode
has nine strategies. Ours is already the more forgiving matcher; Pi's advantage
is the *batch*, not the matching. Take the batch, keep our chain.

## Invariants

I1–I12 from the opencode plan carry over unchanged. Three are added.

**I13 — A batch edit is atomic.** Either every edit in a call applies or the
file is untouched. A batch that fails partway must not leave a half-edited
file, and every edit is matched against the file as it was at the start of the
call, never against the result of an earlier edit in the same batch.

**I14 — Overlapping edits are refused, not resolved.** Two edits whose matched
spans intersect are an error naming both indices. There is no rule for
"resolving" them, because any such rule silently produces something the caller
did not ask for.

**I15 — Every batch failure names its edit.** A failure in a multi-edit call
reports the index and the total (`edits[2] of 5`), so the model can fix one
edit rather than re-sending all of them.

## Milestones

Each is one PR, with its own invariant tests, and follows the verification
procedure in the opencode plan: read the real file, diff behaviour, prove any
claimed upstream bug by running their code, differential-test the pure parts,
pin the agreed cases.

### P1 — Canonical-path mutation queue

Rework `lockFor` into Pi's shape: key on the canonical path where the sandbox
can resolve one, and drop the entry when the queue drains. Needs a way to
canonicalise a path; the sandbox has no such operation today, so either
`stat`-based identity is used where available or this stays keyed on the
normalised path with the *cleanup* half adopted regardless — the cleanup needs
no new seam and removes the documented leak on its own.

**Both halves are done.** The cleanup landed first
([audit-effect-ecosystem.md](./audit-effect-ecosystem.md) A-1); canonical-path
keying landed 2026-08-26 by answering the open question below in favour of a
seam operation: `Sandbox.canonical(path)` returns an opaque identity that is
equal for every name of one file. The local provider derives it from the
`realpath` walk `resolveWithin` already does (so a not-yet-existing file has
one, through its deepest existing ancestor); the memory provider's is the
normalised path, since its world has no links and no case folding. The lock
itself moved to `src/coding/internal/fileLock.ts` and is shared by `/coding`
and `/pi` — one process-wide registry, so the two toolkits serialise against
each other rather than each holding a private lock over the same file. If
`canonical` fails the operation fails (#40 reversed the earlier fallback to the spelled path): the operation is
about to fail with the same error, and an ordering step should not add a
failure mode of its own. The paragraphs below record why the cleanup was built
the way it was.

**Build the cleanup on `Tx*`, not on the `Map`.** Today `lockFor` is a
module-global `Map<string, Semaphore.Semaphore>` whose own comment
(`CodingToolkit.ts:249`) explains why entries are never removed: *dropping a
lock somebody holds would silently end the mutual exclusion*. That objection is
correct, and it is fatal to Pi's `if (queues.get(key) === chained) delete` idiom
transplanted as-is — the check and the delete are two steps, and a waiter can
arrive between them. Pi gets away with it because JavaScript's single-threaded
event loop makes those two lines one atomic region; we run on fibres and cannot
borrow that assumption.

A transactional registry makes "the queue drained **and** the entry is gone" a
single commit. The hazard the comment names then cannot occur, so the cleanup is
adoptable without the canonicalisation half and without the leak — which turns a
limitation we documented as unfixable into an ordinary transaction.

*As built:* a `TxRef<HashMap<string, LockEntry>>` where the entry keeps its
ordinary `Semaphore` and gains a holder count. Not `TxHashMap` (it is a `TxRef`
holding a `HashMap`, and `TxRef.modify` already does exactly the read-decide-write
this needs), and not `TxReentrantLock` (mutual exclusion was never the broken
part — the *registry* was). The count rises before the permit is taken and falls
after it is released, so an entry outlives everyone queued behind it; the whole
thing runs under `Effect.acquireUseRelease`, so an interrupted edit still
decrements.

The registry stays module-global rather than moving into a layer. `TxRef.makeUnsafe`
constructs without an `Effect`, so the process-wide guarantee this comment
already claimed — that two toolkit instances over one workspace serialise —
survives the change instead of being quietly traded for runtime-wide.

**Tests:** ✅ the registry returns to empty after edits complete; ✅ **a waiter
arriving concurrently with a drain still gets exclusion** (the test the old
comment said could not be written); ✅ an interrupted edit does not pin its
entry; ✅ the existing lost-update and ordering tests still pass; ✅ two names
for one file (a symlink and its target, on the local provider) serialise —
the test loses an update when the key is switched back to the spelled path.

### P2 — Batch edits on `edit_file` ✅

Landed in `src/pi/PiToolkit.ts` / `test/PiToolkit.test.ts` (I13–I15, overlap,
JSON-string coercion, `replace_all`, lock drain).

`edits: [{ old_string, new_string }]` accepted alongside today's single pair,
with the single form kept as the common case. Each edit matched against the
original content through our existing replacer chain, uniqueness enforced per
edit, matches sorted and overlaps rejected, all applied together under one
lock. Errors carry `edits[i] of n`. The report becomes one summary line for the
batch.

**Tests:** I13 (a failing third edit leaves the file untouched), I14 (adjacent
edits allowed, overlapping refused, with both indices named), I15 (each failure
mode names its index), a batch where two edits would have collided if applied
incrementally, and the single-edit form unchanged.

### P3 — `list_files` conventions ✅

Landed: rendered text, `/` suffix, dotfiles, alphabetical, 500-entry cap
that names the cut. The work M3 deliberately deferred, now with Pi as the evidence: `/` suffix for
directories, dotfiles included, alphabetical, a 500-entry cap with the same
"why it truncated" warning as everything else. Whether the structured result
stays or becomes rendered text is decided by the same argument that settled
`search` in M3 — the format is the artefact.

### P4 — Truncation: heads, and saying which limit fired ✅

Landed: `formatSize` + named-limit notices; `GREP_MAX_LINE_LENGTH = 500`
on `/pi` search (tighter than `/coding`'s 2000, recorded). `truncateHead`
is exported; bash output still keeps the tail.

Add `truncateHead` beside our tail, and adopt `formatSize` plus the warning
that names the limit that fired (`50.0KB limit` / `2000 lines`). Consider
Pi's 500-character cap for search lines against our 2000 — a decision to make
explicitly and record, not to drift into.

### P5 — Shell selection ✅

Landed: `toolkit({ shell: "powershell" })` / `Shell.layer`; default remains
`bash -c` (was `-lc`; #39). SP5 is the scripted-exec test in `test/PiToolkit.test.ts`.

Follow `powershell.ts`: one implementation, the shell injected. Our `bash`
hardcodes `bash -lc`, which fails on a Windows host without bash — a real gap
given this repository is developed on win32. The shell becomes a parameter of
the tool's construction, defaulting to today's behaviour, with a PowerShell
variant available. Interacts with the `Permission` projection: the resource is
still the command string, so policies are unaffected.

## Success conditions

- **SP1 (P1):** The lock registry is empty after a batch of edits completes;
  the existing concurrency tests still fail when the lock is removed.
- **SP2 (P2):** A three-edit batch whose last edit fails leaves the file
  byte-identical to before the call, proven by comparing bytes, and every
  failure message names its index and the total.
- **SP3 (P2):** A batch that would produce a different result if applied
  incrementally produces the original-matched result, with a test that fails
  under incremental application.
- **SP4 (P4):** Every truncated output names the limit that caused it.
- **SP5 (P5):** The toolkit runs against a PowerShell-only host with no bash
  present, exercised by a scripted sandbox `exec`.
- **SP6 (global):** Each of I13–I15 has a test that fails when the invariant is
  deliberately broken; no casts anywhere; every ported file cites Pi's commit
  and lists its deliberate divergences.

## Risks and open questions

- **Two sources, one toolkit.** After this, `/coding` carries ideas from
  opencode *and* Pi. Each ported file must say which upstream it came from and
  at which commit; a file with both needs both notices. The risk is a muddle
  where neither lineage is checkable.
- **Batch edits multiply the failure surface.** One bad edit in five failing
  the whole call is correct but frustrating; the error messages are what make
  it workable, which is why I15 is an invariant rather than a nicety.
- **Pi is not Effect.** Their concurrency is promise chains and their tool
  definition is TypeBox. Only the algorithms and the decisions port; expect the
  differential harnesses to compare pure functions only, and expect fewer of
  them than the opencode port allowed.
- **Settled: the sandbox has `canonical`.** Added 2026-08-26 as the one seam
  change this plan makes; a required member, so a provider cannot silently
  opt out of file identity.
- **Open: is a Pi-contract adapter actually wanted?** P0 exists to answer this.
  If yes, it is a different plan with fidelity, not quality, as its measure.

## Related

Pi's session tree is planned separately in
[plan-session-tree.md](./plan-session-tree.md), with a TUI as its driving use
case. It shares this plan's upstream and method but nothing else: it is a
session subsystem rather than a tool, needs no tool change, and can proceed
independently of P0-P5.

[audit-effect-ecosystem.md](./audit-effect-ecosystem.md) supplies P1's
mechanism (E7) and flags two further items this plan touches: a
per-tool `ToolExecution.Strategy` (E11) — one `bash` at a time while reads run
wide, which the batch work in P2 makes more attractive — and a cache evaluation
for files re-read within a turn (E12). A-6 closed both: `perTool` ships, while
`PartitionedSemaphore` was rejected because its keys share one global capacity,
and file caching was rejected because edits make rereads semantically fresh.
Neither changed P0-P5.

## Non-goals

Pi's extension model, session tree, TUI, provider layer, `image` attachments,
MCP handling, and its `.gitignore` support (ripgrep-derived, not portable).
Nothing here touches `Sandbox`, `Permission`, or the agent core unless P1's
open question is answered in favour of a `canonicalPath` operation, which would
be planned on its own.
