# Plan: porting opencode's minimal UI into our TUI

Seventh in the series. The others port a library's *engineering*; this one ports
a *user interface*, which is a different job with different risks.

- **Upstream:** [opencode](https://github.com/sst/opencode),
  `packages/opencode/src/cli/cmd/run/` — the inline UI behind `run`, not the
  full `tui` application. MIT.
- **Commit:** `2a6be0a03b93a6734070e10a6c3b56863475f214`
- **Vendored to:** `apps/tui/vendor/opencode/` — 10 files, ~4,625 lines,
  unmodified, never compiled. See that directory's README for provenance.

## Where we start from

`apps/tui` already works: `harness.ts` (Effect side) and `App.tsx` (Solid side),
proven by a headless smoke test that drives a real prompt through a real session
and asserts on the rendered frame — user message, tool call, tool success,
assistant reply, status. What it lacks is everything that makes a transcript
usable: scrollback, per-tool rendering, a real footer, a theme.

## Why this port is tractable

**Their seam is our seam.** The `run` UI splits into a render cluster whose
imports are only `@opentui/*`, `solid-js` and sibling files, and a runtime
cluster (`runtime.*`, `stream.*`, `session-data`) that reaches into
`@opencode-ai/sdk/v2` and their session schema. `scrollback.writer.tsx` imports
nothing from opencode at all.

We already have the runtime half, and ours is better suited to us: it talks to
an in-process `AgentSession` rather than to an HTTP server. So the port is the
render half only, which is exactly the half we are missing.

**The API surface exists in our OpenTUI.** They pin `@opentui/core` 0.4.5; we
are on 0.5.8. Every symbol the render cluster imports was checked individually
against the installed 0.5.8 types and is present — including the three that
decide the whole thing: `ScrollbackSurface`, `ScrollbackWriter` and
`ScrollbackRenderContext`. Presence is not the same as an unchanged signature,
so drift is still a cost, but it is a fixing-signatures cost rather than a
missing-feature one.

## The keystone: `types.ts`

Their `types.ts` (350 lines) is where the session model meets the renderer.
Everything else in the cluster is typed against it, so it is both the first
thing to port and the thing that decides how much of the rest comes for free.

Ours already has the equivalent: the `Entry` union in `harness.ts`
(`user | assistant | tool | notice`), deliberately *not* the agent's event ADT.
The work is to widen `Entry` to carry what their renderers need — per-part
structure, tool state, timing — while keeping it a **view model owned by us**
rather than adopting their session shape.

The temptation to avoid: making `Entry` mirror their `types.ts` so the render
files port unchanged. That would pull their session model in through the back
door and couple our UI to opencode's data design. Port the renderers to our
types; do not port our types to their renderers.

## Milestones

Ordered by value ÷ coupling. Each is a PR that ends with the smoke test
asserting the new thing renders.

### V0 — The view model

Widen `Entry` to what the renderers need, and adapt the harness projection to
populate it. No visual change; everything after this depends on it.

### V1 — `theme.ts` (690 lines)

Self-contained, imports only `@opentui/core`. Colour tokens plus terminal colour
handling. Adopting it immediately makes every later port easier, because the
render files reference theme tokens throughout. Expect to keep their token
*names* (so ported code reads unchanged) and to choose our own values.

**V0 and V1: landed (2026-08-24).** `src/view.ts`, `src/theme.ts`,
`src/store.ts`, and rewritten `harness.ts` / `App.tsx`. The smoke test asserts
10 things and passes, including the new structured bodies:

```
 › what is in this workspace?

 ✓ list_files
   README.md
   src/

 ● That is what the workspace holds.

 › now run something

 ✓ bash echo hi
   hi

 ● The command ran.
```

What was taken, and what was not:

- **Taken from `types.ts`: the kind/body separation.** An entry has a *kind*
  (which decides its marker and colour) and a *body* (`none | text | code |
  markdown | structured`), so one renderer serves an assistant message and a
  tool result alike. That is the idea worth having from their file.
- **Not taken: their concrete types.** Theirs derive from `OpencodeClient` --
  `RunCommand`, `RunProvider` and `PermissionReply` are all
  `Awaited<ReturnType<...>>` of SDK calls -- so adopting them would pull
  opencode's session model into our UI through the back door. Their
  `ToolSnapshot` variants are their tools (task, todo, question); ours are ours
  (`listing`, `matches`, `change`, `command`, `file`), one per shape our tools
  actually return.
- **Taken from `theme.ts`: the shape and the token names.** A `Tone` per entry
  kind with an optional separate marker colour, plus separate footer and block
  groups. Keeping their names means later ports of their render files read
  almost unchanged.
- **Not taken: ~500 of their 690 theme lines.** `resolveTheme`,
  `generateSystem` and the theme JSON model are a terminal colour-scheme
  detector that derives a palette from the terminal's own colours. Good work,
  and environment handling we cannot yet test -- adopting it wholesale would
  mean inheriting behaviour we have not thought about. A fixed palette first.

Two things learned in the doing:

- **`Body.none` is not empty text.** A tool that is still running has no body,
  and drawing nothing differs from drawing a blank line. Worth a variant.
- **Tool results are `unknown` at the event boundary** -- the agent decodes
  them against each tool's own schema, and that type does not survive into a
  generic event. So `bodyOfToolResult` narrows structurally and falls back to
  text rather than dropping anything: an unknown tool still renders.

Also factored out `store.ts`, so the app and the smoke test share one `Sink`
and the test drives exactly the state the real UI does.

### V2 — Scrollback (~1,080 lines: `shared` + `surface` + `writer` + `entry.body`)

The single biggest gap, and the reason to do this port at all. Our transcript is
a `<For>` in a `scrollbox`, which is fine for ten entries and wrong for a
thousand. Theirs writes entries into a scrollback surface.

Highest-risk milestone for 0.4.5 → 0.5.8 drift, since this is where the
scrollback APIs are used most heavily. Do it second, not last, so the drift is
discovered while the port is small.

**V2: landed (2026-08-24).** `src/App.tsx` split into a committed region and a
live one; `src/store.ts` gained `settled`/`drainSettled`; `src/bench.tsx` added.
The smoke test now asserts 12 things across both surfaces and passes.

**The architecture was the thing worth porting, and it is not a scroll box.**
Their transcript is not held in the UI at all: a finished entry is written to
the *terminal's own scrollback* through `renderer.writeToScrollback`, and only
unfinished work stays in the live tree. The terminal then owns scrolling,
searching and history, and a thousand-entry session costs nothing to keep.

Ours now does the same. `writeSolidToScrollback(renderer, () => <EntryView …/>)`
renders a Solid component straight into the scrollback, so entries are drawn by
exactly the same component whether they are live or committed.

Measured, because this is the milestone's entire justification
(`bun src/bench.tsx`, 500 entries):

```
entries   flush(ms)   live tree
     50       20.05           0
    250       29.98           0
    500       18.12           0
```

Flush time is flat and the live tree stays at zero. The bench asserts the *live
tree* rather than the timing: the tree not growing is the property, the timing
is a consequence, and timing alone is too noisy to assert on.

Three things the port turned up:

- **Scrollback is write-once.** A committed line cannot be repainted, so only a
  *settled* entry may be handed over -- and it must be a settled **prefix**. A
  running tool holds back everything after it, or an ordered transcript would
  print out of order.
- **`writeToScrollback` requires `screenMode: "split-footer"` and
  `externalOutputMode: "capture-stdout"`.** It throws a clear error saying so.
  Both `render` and `testRender` take them, since `TestRendererOptions extends
  CliRendererConfig`.
- **Entries must be unwrapped before committing.** What is handed to scrollback
  has left the store, and reading a removed proxy afterwards is a bug waiting
  to happen.

No 0.4.5 -> 0.5.8 drift on this path at all: `createScrollbackSurface`,
`writeToScrollback`, `ScrollbackSurface.commitRows/settle` and
`createScrollbackWriter` all match the signatures their code uses.

A test-only lesson worth keeping: waiting for `status() === "working"` to
observe a submission starting is a race -- a session is idle *before* its
submission starts, and the transition can pass entirely between two render
passes. The smoke test counts completions instead, which is monotonic and
cannot be missed.

### V3 — `turn-summary.ts` + `footer.width.ts` (74 lines)

Small, self-contained, useful. Cheap once V1 lands.

**V3: landed (2026-08-24).** `src/width.ts`, a `summary` entry kind, turn
timing in the harness, and a footer that degrades by width. 20 smoke checks
pass.

```
● That is what the workspace holds.

▣ 40ms · 1 tool
```

- **Turn summary.** Their `turnSummaryCommit` closes a turn with
  `▣ agent · model · duration` as a dim, final entry. Ours reports what we can
  actually measure -- duration and tool count -- because our events carry no
  usage. The timing is closed over in the projection rather than kept in the
  store: it is bookkeeping for one submission, not something the UI should see
  half-finished. It is appended *before* going idle, so anything waiting on
  idle already sees the whole turn.
- **Width policy.** Their `footerWidthPolicy` returns named booleans from one
  place rather than letting each component invent its own `width > 80`. That is
  why their footer degrades coherently instead of one part vanishing while
  another overflows. Ours has three breakpoints to their four, with different
  numbers -- the names are the portable part, not the values.

The width tests assert both directions, which matters for a policy: the hints
render at 100 columns and `widthPolicy(50).hints` is false. A responsive rule
tested only where it is on is not tested.

### V4 — `footer.view.tsx` (945 lines)

The footer: prompt, status, menus. Needs a keymap substitute — theirs imports
`@opencode-ai/tui/keymap`, an internal package. `@opentui/keymap` is published
and is the intended replacement. Their prompt editor (`@opencode-ai/tui/editor`)
is *not* published; keep our plain `input` unless the footer genuinely needs
more, and record that as a divergence.

**V4: landed (2026-08-24), but not as planned.** 25 smoke checks pass.

**The plan was wrong about what V4 was.** `footer.view.tsx` is not a footer
library: it is *one* 800-line component that composes five files I did not
vendor (`footer.menu`, `footer.subagent`, `footer.prompt`, `footer.permission`,
`footer.question`) and two unpublished internal packages
(`@opencode-ai/tui/component/register-spinner`, `@opencode-ai/tui/ui/spinner`).
Porting it as written would have meant vendoring five more files to render
surfaces we do not have.

What is portable is the **idea inside it**, which their own `types.ts` comment
states: *"Only one view is active at a time. The reducer drives transitions:
when a permission arrives the view switches to permission, and when the
permission resolves it falls back to prompt."*

So V4 became: take that state machine, and wire it to the approval system this
library already has.

```
 ◐ bash rm -rf /

 ◐ working   ctrl+c interrupt

 ┌──────────────────────────────────────────────────────────────┐
 │ ? bash wants to shell: rm -rf /  (runs a command)            │
 │   y allow · n refuse                                         │
 └──────────────────────────────────────────────────────────────┘
```

The whole feature is existing parts meeting: a `Permission.rules` policy that
asks on `write` and `shell`, `Elicitation.memory` as the session's elicitor,
`ElicitationRequested`/`Resolved` projected onto a `FooterView` union, and
`AgentSession.respond` behind a `y`/`n` keypress. **No library change.** The
permission *projection* is what makes the prompt readable -- the policy gates
`shell` on `rm -rf /` without knowing anything about `bash`'s parameters.

`FooterView` is a union rather than a pair of booleans so that "asking for
approval while also accepting a prompt" is unrepresentable rather than merely
avoided, and the prompt is *replaced* rather than decorated: there is no way to
type a message when the only meaningful input is yes or no.

Three things the port turned up, all found by looking at frames rather than by
reasoning:

- **Adjacent `<text>` nodes paint over one another** rather than laying out as
  rows. Five of them on one line rendered as `? runs aacommandshell echo hi`.
  One `<text>` per line, and each line one whole string.
- **`captureCharFrame()` returns the last *painted* frame.** Reading it straight
  after a state change shows the previous one, which looks exactly like a
  broken update. `flush()` first.
- **A policy that asks changes what "wait for the turn to finish" means.** The
  smoke test's `ask` helper hung, because a turn needing approval cannot
  complete on its own. It now answers approvals as a user would, and the
  refusal path is exercised deliberately instead.

Not ported, and worth naming: their spinner (internal package), the command
menu, the subagent tabs, and `footer.prompt`'s editor
(`@opencode-ai/tui/editor`, also unpublished -- we keep the plain `input`).

### V5 — `tool.ts` (1,486 lines), selectively

Nearly a third of the cluster, and the most adaptation per line: it renders
*opencode's* tools, keyed to their names and result shapes. Ours differ — our
`list_files` returns a structured array, our `search` returns grouped text, our
`bash` returns `{exit_code, stdout, stderr}`.

Port **per tool, as we need it**, taking the presentation ideas (diff rendering,
truncation, collapsed output) and not the dispatch table. Wholesale porting
would leave dead branches for tools we do not have and no branch for tools we
do.

**Planned separately in [plan-tui-tool-views.md](./plan-tui-tool-views.md).**
Reading the file changed the shape of the work: `tool.ts` is a *registry*
(`ToolRule = { view, run, scroll?, permission?, snap? }` keyed by tool name),
and the registry is the portable part -- not the eighteen rules inside it. Two
findings that plan turns on:

- **Theirs is closed (`ToolName = keyof ToolDefs`); ours must be open.** The
  coding toolkit is built to be extended, so a user adding a tool must be able
  to add its rendering without editing our files.
- **The most valuable renderer cannot be ported yet.** `snapEdit` reads
  `p.metadata.diff`; their edit tool returns a diff and ours returns prose.
  That is a library decision, not a UI one.

## Streaming, and the two bugs it exposed (2026-08-24)

The `Not done yet` list said streaming deltas rendered but were untested,
because the scripted model emitted whole messages. Turning it on --
`session.prompt(text, { stream: true })` and a `chunks` script -- found **two
latent bugs that no other path could reach**. 35 smoke checks now pass, and
the delta path is exercised rather than assumed.

**1. Draining the array `<For>` is rendering, from inside the effect that
renders it.** V2 committed settled entries to scrollback from a
`createEffect`, splicing them off the front of the store. That was invisible
while every entry settled immediately -- the live tree was always empty. The
moment a message streams, an entry lingers, and the splice tears the list out
from under the row callbacks:

```
TypeError: undefined is not an object (evaluating 'e.title')
```

Reproduced in isolation before fixing, then fixed by deferring the drain to a
microtask so the mutation lands after the render completes. The isolation
mattered: the first two reproductions (three static entries; a body added
dynamically) both *passed*, which is what ruled out layout and pointed at the
mutation.

**2. An empty assistant bubble that never settles.** The projection created an
assistant entry on `MessageStarted`. But a turn that only calls a tool still
starts a message, so that entry stayed empty and streaming for ever -- and
because it never settled, it blocked every later entry from reaching the
scrollback. A deadlock that presents as "the transcript stopped updating".

Fixed by creating the entry from the first thing that gives it content, a
delta or a completion, rather than from the announcement that one is coming.
`MessageCompleted` with empty text is now understood as a tool-only turn and
renders nothing.

Both are worth stating as a general lesson: **the live tree being usually
empty hid a whole class of bug.** V2's architecture is what made the
transcript fast, and it is also what kept these two from surfacing until
something lingered on screen.

## The backend seam (2026-08-24)

The port was complete and the application was a demo: `harness.ts` hard-wired
`TestLanguageModel.script` and a memory sandbox whose `exec` always returned
`hi`, so the TUI rendered faithfully and could not do any work. That was right
for V0-V5 -- it is what made the smoke suite deterministic and keyless -- and
wrong to leave as the only option.

`backend.ts` now owns the choice, and owns **both halves of it**. A model and a
workspace are one decision, not two: a live model over a memory sandbox would
describe a workspace that does not exist, and the transcript would read as real
work. Typing the seam as `Layer<LanguageModel | Sandbox.Current, unknown,
Scope>` rather than `Layer<any, any, any>` is what keeps the two
interchangeable -- a loose type lets one of them quietly stop providing
something the other does, discovered at runtime in a terminal as an unhandled
fibre failure.

**Two defaults that are safety properties, each broken once to confirm the
test bites:**

- `--live` requires `--workspace <dir>` explicitly. Defaulting it to the
  current directory makes the dangerous case the easy one.
- `--live` is never inferred from the presence of `ANTHROPIC_API_KEY`, because
  then an exported variable silently changes what a demo does.

**The footer names the running backend**, and that is not decoration. A
scripted run and a live one produce transcripts that look identical; which one
is behind it changes what the transcript *means*. It is the last thing dropped
as the terminal narrows.

## V6-V8: from a port to an application (2026-08-24)

V0-V5 finished the *port*. What was left was that the result could not do any
work, and that the session tree it was wired to was invisible.

**A model and a workspace, chosen together** (`backend.ts`). Together, because
they have to agree about what is real: a live model over a memory sandbox would
describe three seeded files that do not exist, and the transcript would read as
work. Scripted is still the default -- no key, no network -- and the footer
names whichever is running, because a scripted transcript and a live one look
identical and which is behind it changes what the transcript *means*.

Two defaults are safety properties, each broken once to confirm its test bites:
`--live` requires `--workspace` explicitly, since defaulting it to the current
directory makes the dangerous case the easy one; and live is never inferred
from the presence of an API key, since then an exported variable silently
changes what a demo does.

**The tree, surfaced.** `/branches` lists every leaf via `summary` -- the
operation that exists so listing twenty branch points does not mean holding
twenty conversations -- and marks the active one, because a selector that hides
where you are makes "switch" read as "leave". `/branch` forks *here* and keeps
the line it forked from, which is the difference from ctrl+r: exploring an
alternative should not cost a turn.

That last one needed a small library change. Naming a lane was only possible on
`branch`, which builds a session -- and activation builds its own, so forking
meant creating a session purely to register a name and then discarding it.
`activate` takes a lane now, because a lane is a name for the line the user is
*on*, and activation is how that line is chosen.

**The footer is a four-state machine** -- prompt, approval, palette, branches --
so two surfaces at once stays unrepresentable rather than merely avoided.

**Edits render as a diff**, and the plan was wrong that this was blocked.
`snapEdit` reads `p.metadata.diff` because opencode's edit tool returns one and
ours returns prose -- but `edit_file` reports `matched`, the span it actually
replaced, and the call carries `new_string`. Both sides were already here; only
the diff was missing, and it is thirty lines. Computing it in the UI is also
correct: a diff is a *presentation*, and the library reports what changed more
precisely than a diff can.

**Approvals can be remembered.** `a` allows and asks the policy to keep the
grant -- the kernel already supported this through `Permission.ApprovalValue`
and nothing surfaced it. Separate from `y` rather than a modifier on it,
because "just this once" should be answerable without thinking about policy.

**Input history** is up/down, and deliberately does not follow the transcript's
rule that a line is drawn only once the kernel accepted it: a refused prompt is
still something the user typed and will want back.

### Syntax highlighting: tried, and not shipped

OpenTUI ships a `<code>` renderable, and it renders headlessly. It does not
highlight: with a populated `SyntaxStyle` and `filetype="typescript"`,
`captureSpans` returns **one span, white** -- the tree-sitter parsers are not
wired, so the machinery runs and produces no colour.

Shipping it would look like highlighting and deliver none, which is worse than
not shipping it. Recorded here rather than left for someone to rediscover; it
becomes cheap the moment the parsers are available.

### Review findings addressed (2026-08-24)

R14, R15, R25 and R30, from
[review-recent-commits-2026-08-24.md](./review-recent-commits-2026-08-24.md).
The first three share one root cause and one shape: **a terminal event must
terminalise everything transient that belonged to it.** `drainSettled` takes a
*prefix*, so any entry left unsettled holds itself and everything after it out
of scrollback for the rest of the session -- the transcript simply stops
growing, several screens after the cause.

- **R14.** `MessageFailed` and `MessageInterrupted` were ignored, so a streamed
  reply that died after its first delta stayed `streaming: true` forever. Both
  are handled now, and so is the case core does not report at all: a stream
  abandoned because the submission ended under it. The text so far is kept
  rather than blanked -- it is what the user watched arrive, and erasing it
  would be a different lie from leaving it unfinished.
- **R25.** Interrupting a run that was waiting for approval left an
  unanswerable question on screen: core removes the elicitation but emits no
  `ElicitationResolved`, so a footer cleared only on resolution never cleared.
  The screen read idle while offering a choice that did nothing -- `respond`
  returns false and emits nothing, so there was not even a way back to the
  prompt.

  Testing this found a second gap the suite could not see: with the terminal
  clear in place, *removing the resolution clear entirely* still passed,
  because the footer came back either way -- just a whole submission late.
  There is now an assertion for each path.
- **R15.** Ctrl+R was live during a running submission although the footer only
  ever advertised it while idle. `tree.active` points at the last completed
  boundary, so rewinding mid-run abandoned the in-flight branch *and* stepped
  back further than the user was looking -- leaving the abandoned branch's
  entries streaming. Gated on idle rather than turned into an
  interrupt-and-rewind transaction: the affordance already said idle-only, so
  the honest fix is to mean it.
- **R30.** `npm run check` did not verify the TUI at all, so a commit could
  report the repository green while the app it drives was broken. `check` now
  runs the TUI's typecheck and its smoke suite.

  The smoke needed `scripts/tui-smoke.mjs` to be runnable from npm. `npm run`
  prepends every ancestor `node_modules/.bin` to PATH up to the drive root, and
  a stray `bun.exe` in one of them shadows the real binary -- bun then exits
  with "failed to remap this bin". Nothing in the repository causes that and
  nothing in it can prevent it, so the script looks past PATH instead of
  through it.

### Two more of the same class, found by looking (2026-08-24)

R14, R15 and R25 all had one shape -- something transient outliving what it
belonged to -- so the sensible next step was to look for the shape rather than
wait for another review. Two more:

**`stop()` closed only the most recently started harness.** The disposer lived
in a single module-level `let` that every `start` overwrote, so an earlier
harness kept its fibre, its session and its store for the life of the process.
One harness per process is the ordinary case, which is exactly why this
survived: a second only appears in a test, or in a UI that reopens a session.
There is a registry now, and `Handle.stop` closes the one you hold.

**`switchTo` and `/branch` were not gated on idle** -- R15's defect on the two
other paths that change which branch is active. `tree.active` points at the
last *completed* boundary, so moving mid-run abandons the in-flight branch and
steps somewhere the user was not looking, leaving the abandoned entries
streaming. Refused with a notice rather than queued: the user asked to be
somewhere else *now*, and silently doing it later is worse than saying no.

Two things the tests themselves taught, both worth keeping:

- **An approval is the only deterministic way to hold a run open.** The
  scripted model answers faster than a test can observe `status() === "working"`,
  but an elicitation waits exactly as long as nobody answers it.
- **`entries.length === 0` is not a latch outside the App.** Draining is the
  App's job, so a store with no App renders never drains and the count only
  reads zero before anything starts. The turn summary is the latch.

### Keys that were advertised and not bound (2026-08-24)

`ctrl+d quit` had sat in the footer since V3 bound to nothing, and `ctrl+c`
reached the app only through `process.on("SIGINT")` -- which a terminal in raw
mode need not deliver, because the renderer owns the keyboard. An affordance
that does nothing teaches the user the app is broken, which is worse than not
offering it.

Finding this took a test that checks the advertisement against the binding
rather than each separately, and writing that turned up a genuine platform
detail worth recording:

**A focused `<input>` consumes printable keys; control keys are broadcast.** A
`useKeyboard` binding for `/` therefore never fired, while one for `ctrl+d`
does. The palette opens from the input's own `onInput` instead, clearing the
slash as it goes so dismissing does not leave one behind. This is exactly the
sort of thing that reads as a state bug for an hour.

Two consequences for the tests, both recorded because they will recur:

- Control keys can be tested against a second, isolated renderer. Printable
  keys cannot: with two renderers alive, the key goes to whichever focused
  input owns the keyboard, not to whichever `mockInput` was called. `/` is
  tested against the real App, at the very end.
- A check that reads live state at assertion time depends on everything that
  ran after it. Two footer assertions had to be snapshotted before the key
  section, having silently started measuring the wrong moment.

Escape-to-dismiss is asserted through `dismiss` rather than the keystroke:
routing a key inside a focused `<select>` is OpenTUI's to get right, and
pinning it here would be testing their widget.

### Still not implemented

- **No scrolling inside the live region.** Finished entries go to the
  terminal's own scrollback, so history is the terminal's to scroll; what is
  not reachable is a tool body clipped at twelve lines while it is still in
  flight. Expanding a clipped body would be worth more than scrolling.
- **No syntax highlighting**, for the reason above.
- **No session switching across processes.** The tree is per-run; nothing is
  persisted between launches, though `NodeStore.keyValue` now exists and would
  make it a wiring change.
- SV1-SV4 all hold. SV4's answer is `vendor/opencode/PORTED.md`, which accounts
  for every upstream file rather than pretending a `diff` would be legible.

## Invariants

**VT1 — `vendor/` is never compiled.** It sits outside `src/`; nothing imports
it. Every shipped file is ours, with its own attribution header naming the
upstream file and commit, and its divergences recorded.

**VT2 — The harness seam holds.** No ported file imports Effect, or knows that a
session, an agent or a tool call exists as anything but an `Entry`. If a port
needs something the view model lacks, the view model grows — the renderer does
not reach through it.

**VT3 — Every ported piece is proven to render.** The headless smoke test gains
an assertion per milestone. A port that typechecks and paints nothing is the
characteristic failure of UI work, and it is invisible without this.

**VT4 — Divergences are deliberate and written down.** Same rule as the tools
port: an undocumented difference from upstream is a defect regardless of which
behaviour is better.

## Success conditions

- **SV1:** A 500-entry transcript scrolls without the frame time collapsing —
  measured, since this is V2's entire justification.
- **SV2:** Each of our six tools renders through the ported tool view, with a
  smoke assertion naming it.
- **SV3:** The smoke suite still passes end to end with a real session behind
  it, not fixtures.
- **SV4:** `vendor/` and `src/` can be diffed file-by-file to answer "what did
  we change?" for every ported file.

## Risks

- **Scope.** 4,625 lines is a lot of someone else's code. V1 + V2 is ~1,770 and
  delivers the main win; V5 is a third of the total and can be deferred
  indefinitely. Treat V0–V2 as the plan and the rest as optional.
- **UI ports rot differently from algorithm ports.** `replace.ts` was worth
  vendoring because it is pure and its correctness is testable. A renderer's
  "correctness" is partly taste, and upstream will keep changing theirs. Take
  the layout and the hard-won terminal details; do not plan to track their UI.
- **Their theme carries terminal-detection behaviour**, not just colours. Read
  it before adopting it wholesale, or we inherit environment handling we have
  not thought about.
- **`bun` is imported directly** by some of their files. We are on Bun already,
  so this is fine — but it is worth noticing rather than discovering.

## Non-goals

`runtime.*`, `stream.*`, `session-data.ts`, `session-replay.ts`, their SDK,
their session schema, their plugin and config systems, and the full `tui`
application. Our harness stays ours.
