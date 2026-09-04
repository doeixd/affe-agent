# affe-agent TUI

A small terminal harness on top of this library, in the shape of opencode's:
OpenTUI over a Zig core, SolidJS for components, Bun as the runtime.

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

## Running

Bun is required — OpenTUI reaches its native core through Bun's FFI.

```sh
bun install
bun src/main.tsx     # the TUI
bun src/smoke.tsx    # headless render + assertions, no TTY needed
bun src/bench.tsx    # 500-entry transcript, proves the live tree stays flat
```

Use `bun src/main.tsx`, not `bun run dev`: on Windows, `bun run <script>` where
the script itself starts with `bun` currently fails with a bin-remap error.

## The transcript lives in your terminal

A finished entry is written to the **terminal's own scrollback**, not kept in
the UI. Only unfinished work stays in the live tree, pinned below it as a
footer. So your terminal owns scrolling, searching and history, and a long
session costs nothing to keep -- `bun src/bench.tsx` walks 500 entries and
the live tree stays at zero the whole way.

This is opencode's architecture, ported; see `docs/plan-tui-port.md` and the
pristine source in `vendor/opencode/`. Two consequences worth knowing:

- It needs `screenMode: "split-footer"`, which `main.tsx` sets. Without it
  `writeToScrollback` throws, saying exactly that.
- **Scrollback is write-once.** A committed line cannot be repainted, so only a
  *settled* entry is handed over, and only as a settled **prefix** -- a running
  tool holds back everything after it, or the transcript would print out of
  order.

## How it is put together

Two files, and the split between them is the point.

**`harness.ts` — everything Effect-shaped.** It builds the agent, the model
layer, the sandbox and the toolkit, opens an `AgentSession`, and subscribes to
its event stream. It exposes exactly three things: `submit`, `interrupt`, and a
`Sink` it pushes UI entries into. Nothing above it ever sees an `Effect`.

This works because **a session captures its environment when it is built**. Once
`AgentSession.make` has returned, `session.prompt(...)` and `session.interrupt()`
require no services, so they can be run straight from a keypress handler with
`Effect.runFork`.

**`App.tsx` — everything reactive.** Entries, a status, and a handle with two
methods. It knows nothing about agents, sessions or Effect.

`main.tsx` joins them: a Solid store is the shared surface, the harness writes
into it from an Effect fibre, and Solid reads it in JSX.

Swapping the model, the toolkit or the sandbox is a change to `harness.ts` and
to nothing else — which is the library's central claim, made concrete.

## Using it

| Key | |
| --- | --- |
| `enter` | send |
| `↑` `↓` | what you typed before |
| `/` | commands (only at an empty prompt — paths contain slashes) |
| `ctrl+r` | take back the last turn |
| `ctrl+c` | interrupt a running turn |
| `ctrl+d` | quit |
| `y` `a` `n` | when asked for approval: allow, allow always, refuse |

| Command | |
| --- | --- |
| `/branch` | fork here, and keep this line too |
| `/branches` | switch to another line of work |
| `/rewind` | the same as `ctrl+r` |
| `/export` | write this conversation to a file |
| `/export-redacted` | the same, with two matchers applied — read it before sharing |
| `/help` | what these do |

`/branch` and `/rewind` are different things. Rewind moves *back* and continues
from an earlier point; branch stays where it is and starts a second line from
here, so trying an alternative does not cost a turn.

## The backend: what it is actually talking to

A **model and a workspace, chosen together** in `backend.ts`. Together, because
they have to agree about what is real: a live model pointed at a memory sandbox
would confidently describe three seeded files and a `bash` that always prints
`hi`, and the transcript would look like work while being fiction.

**Scripted by default.** No API key, no network, no filesystem — which is what
makes the smoke suite deterministic and runnable anywhere. Every reply comes
from a fixed list, so typing something else does not change the answer. The
footer says `scripted` for exactly that reason: a demo that looks like an agent
is worse than one that says it is a demo.

**Live, when you ask for it:**

```
bun src/main.tsx --live --workspace ../some-working-copy
bun src/main.tsx --live --workspace ../some-working-copy --model claude-opus-4-5
```

Needs `ANTHROPIC_API_KEY`. Neither half is defaulted, and that is deliberate:
defaulting the workspace to the current directory would make the dangerous case
the easy one, and inferring "live" from the presence of a key would mean an
exported variable silently changes what a demo does.

**What `--workspace` actually bounds.** Two different answers, and the
difference is the important part.

*File tools are confined to it.* `read_file`, `write_file`, `edit_file`,
`list_files` and `search` go through the sandbox seam, which requires relative,
`..`-free paths and resolves symlinks. For those, that directory is the whole
of what the agent can reach.

*`bash` is not confined to it at all.* The local sandbox runs the child with
its `cwd` set to the workspace and nothing else — the process keeps this
program's privileges. An approved `bash` call can read absolute paths, write
outside the workspace, reach the network and read credentials. It is host
execution that happens to start in a directory.

What protects you is the approval prompt: every shell call is asked about
before it runs. The directory is not a sandbox for it. Point `--workspace` at a
working copy you can throw away, and read the shell commands before allowing
them.

Swapping in a different provider is a change to `backend.ts` and to nothing
else.

## Two traps worth knowing

Both cost real debugging time here, and both fail *silently* — the UI renders
its first frame correctly and then ignores every update, which looks like a
state bug and is not.

**1. Solid's JSX needs its Babel transform.** Solid is not React: `{count()}`
must be compiled into a getter, or it is evaluated once at call time and never
re-read. Transpiling JSX with the plain automatic runtime produces a UI that
renders once and freezes. `@opentui/solid/preload` installs the transform, and
`bunfig.toml` here loads it for every run:

```toml
preload = ["@opentui/solid/preload"]
```

**2. `solid-js` resolves to its SSR build under Node conditions.** Its `"node"`
export maps to `dist/server.js`, where effects never run at all. The preload
handles this too; without it, reactivity is dead on arrival. If you ever run
without the preload, `--conditions=browser` is the manual fix.

## Testing a TUI

`src/smoke.tsx` renders the real UI against the real harness with OpenTUI's
headless test renderer, drives two prompts through it, and asserts on **both**
surfaces: the committed transcript through `externalOutput.takeText()` and the
live region through `captureCharFrame()`. No TTY, so it runs anywhere.

One race worth avoiding: waiting for `status() === "working"` to see a
submission start does not work. A session is idle *before* its submission
starts, and the transition can pass entirely between two render passes. The
smoke test counts completions instead, which is monotonic and cannot be missed.

One API detail: `renderOnce()` paints the tree as it stands and does **not**
process pending reactive updates. Capture straight after it and you get the
previous frame, which reads exactly like broken reactivity. Use `flush()`, or
better `waitForFrame(predicate)` — that turns the smoke test into a real
assertion, because a broken pipeline times out instead of quietly printing a
stale frame.

## Streaming

Prompts are sent with `{ stream: true }`, so the reply builds up a token at a
time and the smoke test drives that path with a chunked script. Whether a call
streams is the *caller's* choice rather than the agent's, which is why it is
set here and nowhere in the agent definition.

Turning it on found two bugs that no other path could reach -- a drain that
mutated the list being rendered, and an empty assistant bubble that never
settled and so blocked the whole transcript. Both are written up in
`docs/plan-tui-port.md`; the short version is that the live tree being usually
empty hid a class of bug, and only a lingering entry exposed it.

## Not done yet

History navigation, session switching and the `/`-command palette are absent,
as is syntax highlighting for code bodies (opencode uses `CodeRenderable` with
tree-sitter; we render plain lines). A full-file unified diff is deliberately
not done -- see `docs/plan-tui-tool-views.md` for why the span-level view was
the better trade.

The session tree in `docs/plan-session-tree.md` is the natural next thing to
hang off this.
