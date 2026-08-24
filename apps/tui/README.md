# effect-agent TUI

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

## The model

A **scripted model** by default (`TestLanguageModel`), so the TUI runs with no
API key and no network — and so the smoke test is deterministic. Point
`modelLayer` in `harness.ts` at a real provider to make it a real assistant;
nothing else changes.

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

History navigation, elicitation/approval prompts, session switching and the
`/`-command palette are all absent, as is syntax highlighting for code
bodies (opencode uses `CodeRenderable` with tree-sitter; we render plain
lines). The session tree in
`docs/plan-session-tree.md` is the natural next thing to hang off this.
