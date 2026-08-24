# Vendored opencode source (reference only)

Unmodified source from [opencode](https://github.com/sst/opencode), copied here
as the reference for the TUI port.

- **Origin:** `packages/opencode/src/cli/cmd/run/` — the minimal UI behind the
  `run` command, not the full `tui` application.
- **Commit:** `2a6be0a03b93a6734070e10a6c3b56863475f214`
- **Licence:** MIT. The full text and copyright notice are in
  [`LICENSE.opencode`](./LICENSE.opencode), retained as the licence requires.
  Each file also carries a header naming its upstream path and commit.

## This directory is never compiled

It sits outside `src/`, and `tsconfig.json` includes only `src`. Nothing here is
built, imported or shipped. It exists to be read.

The workflow is deliberate: **port, do not import.** Adapted code lives in
`src/`, carries its own attribution header, and records where it diverges — the
same discipline `src/coding/internal/replace.ts` follows in the main library.
Keeping the pristine copy alongside is what makes "did we change this, and why?"
answerable later.

## What is here, and why

| File | Lines | Why it was taken |
| --- | --- | --- |
| `theme.ts` | 690 | Colour tokens and terminal colour handling. Self-contained. |
| `scrollback.shared.ts` | 92 | Scrollback types and helpers. |
| `scrollback.surface.ts` | 431 | The scrollback surface — our single biggest gap. |
| `scrollback.writer.tsx` | 352 | Renders entries into the surface. Imports nothing from opencode. |
| `entry.body.ts` | 205 | Entry body layout. |
| `turn-summary.ts` | 47 | Per-turn summary line. |
| `types.ts` | 350 | Their session/message view model — the adapter seam. |
| `tool.ts` | 1486 | Per-tool result rendering (diffs, listings, previews). |
| `footer.view.tsx` | 945 | The footer: prompt, status, menus. |
| `footer.width.ts` | 27 | Width helpers. |

Deliberately **not** taken: `runtime.*`, `stream.*`, `session-data.ts`,
`session-replay.ts`. Those are opencode's harness — they talk to an opencode
server through `@opencode-ai/sdk/v2` and their session schema. We have our own
harness (`src/harness.ts`) which talks to an in-process `AgentSession`, and it
is the half we should keep.

## A note on naming

opencode asks that third-party projects using their work make clear they are not
built by the opencode team. This is a port, not a distribution of opencode, and
nothing here is presented as theirs.
