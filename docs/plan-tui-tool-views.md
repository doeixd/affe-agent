# Plan: V5 — per-tool rendering

A sub-plan of [plan-tui-port.md](./plan-tui-port.md), which deferred V5 rather
than scheduling it. This is how to tackle it, and where it should stop.

- **Upstream:** opencode `packages/opencode/src/cli/cmd/run/tool.ts`, 1,486
  lines, read at commit `2a6be0a03b93a6734070e10a6c3b56863475f214`. Pristine
  copy in `apps/tui/vendor/opencode/`.

## What `tool.ts` actually is

Not a pile of renderers. It is a **registry**, and the registry is the portable
part:

```ts
type ToolRule<T> = {
  view: ToolView                                   // inline or block
  run: (props: ToolProps<T>) => ToolInline         // icon, title, description
  scroll?: Partial<Record<ToolPhase, (p) => string>>  // text per phase
  permission?: (p: ToolPermissionProps<T>) => ToolPermissionInfo
  snap?: (p: ToolProps<T>) => ToolSnapshot | undefined // structured body
}

type ToolRegistry = { [K in ToolName]: ToolRule<ToolDefs[K]> }
```

One rule per tool; each rule a record of small pure functions; each typed
against that tool's own info type. Everything about how `grep` looks lives in
one place, and a tool that wants no structured body simply omits `snap`.

We already have fragments of this, spread out and untyped: `bodyOfToolResult`
and `titleOfToolCall` in `view.ts` are two `switch` statements keyed by tool
name, which is a registry turned inside out.

## The one place ours must differ from theirs

**Their registry is closed. Ours must be open.**

`type ToolName = keyof ToolDefs` — eighteen tools, fixed at compile time. That
is right for opencode: their tool set is theirs.

It is wrong for us. `test/CodingComposition.test.ts` exists precisely to prove
that an application can **replace one tool's implementation, take a subset, or
add its own**, and the `/coding` module documents those four moves. A closed
registry would mean a user who adds a `deploy` tool must edit our files to make
it render — which contradicts the composability the toolkit is built for.

So:

```ts
export interface ToolView<Params = unknown, Result = unknown> {
  readonly title?: (params: Params) => string
  readonly body?: (result: Result) => Body | undefined
  readonly approval?: (request: Approval) => string
}

export const views: Record<string, ToolView> = { ... }   // ours
export const withViews = (extra: Record<string, ToolView>) => ...  // theirs
```

A `Record<string, …>` with a **fallback**, not a closed union. The fallback is
required rather than optional: an unknown tool must still render, and today's
`bodyOfToolResult` already ends in a text fallback for exactly that reason.
Theirs has the same instinct — `fallbackInline`, `fallbackStart`,
`fallbackFinal` — which is worth reading before writing ours.

## The precondition nobody can skip

**The most valuable renderer in their file cannot be ported yet**, and this is
the finding that shapes the whole plan.

`snapEdit` is three lines of logic over one field:

```ts
const diff = p.metadata.diff || ""
if (!file || !diff.trim()) return undefined
return { kind: "diff", items: [{ title: `# Edited ${toolPath(file)}`, diff, file }] }
```

Their edit tool **returns a diff in its metadata**. Ours returns prose:
`edited f.ts (1 replacement, +1 -1, matched by line-trimmed)`. So there is
nothing to render, and no amount of UI work changes that.

Producing a diff is a *library* decision, not a TUI one:

- It changes `edit_file`'s success payload, which is a breaking change to a
  tool contract and reaches the model as well as the UI.
- It needs a diff implementation. opencode uses `createTwoFilesPatch` from
  `diff`; `@opentui/core` already depends on `diff@9`, so the TUI could have
  one for free — but the *library* cannot, since `/coding` is portable and
  near-dependency-free (three runtime deps today).
- There is a cheaper middle: `edit_file` already computes `+A -B` and the
  matched span. Returning a **structured** result (`{ path, added, removed,
  strategy }`) rather than a sentence would let the UI render a change summary
  without any diff library, and would help the model too — a structured result
  is easier to reason about than prose.

Recommend the middle option, decided in the main plan rather than here, since
it is a toolkit change with its own tests.

## Milestones

### W1 — The registry, with what we already have

No new rendering. Move `bodyOfToolResult` and `titleOfToolCall` into a
`Record<string, ToolView>` with a fallback, and prove the fallback by rendering
a tool that has no entry. Small, and it is the refactor everything else needs.

**Done when:** the smoke test still passes unchanged, and a new test asserts an
unregistered tool renders through the fallback.

### W2 — Open it

`withViews(extra)` so an application registers rendering for its own tools, and
a test that adds a `deploy` tool with a custom view — mirroring
`CodingComposition.test.ts`, which is the shape this has to match. This is the
milestone that earns the refactor.

### W3 — Per-tool approval prose

Their `permission` hook, applied to V4's approval surface: a tool says how it
should be *asked about*, not only how it renders. `bash wants to shell:
rm -rf /` becomes whatever `bash`'s rule says, and a tool with no rule keeps
today's generic line.

### W4 — Structured `edit_file` result (gated)

Blocked on the library decision above. When `edit_file` returns
`{ path, added, removed, strategy }`, the `change` snapshot that V0 already
defined stops being speculative and gets a renderer and a test.

### W5 — Diff rendering (gated, optional)

Only if W4 goes further than a summary and a real diff is available. Their
diff renderer is worth reading at that point — line numbering, added/removed
backgrounds, the `RunBlockTheme` diff tokens V1 already ported the names of.
**Do not do this speculatively.**

## What not to port

- **Their eighteen rules.** `runGlob`, `runTodo`, `runTask`, `runSkill`,
  `runWebfetch` and friends render *their* tools. We have six, all already
  rendered by V0. Porting the rules would leave dead branches for tools we do
  not have and no branch for tools we do.
- **`ToolPhase` / `scroll`.** Their per-phase scrollback text exists because
  their runtime streams tool progress. Ours emits `ToolCallProgress` but the
  toolkit never uses it, so there is nothing to render. Revisit if a tool
  starts emitting preliminary results.
- **`toolPath`'s home-directory shortening** is a nice touch and 25 lines;
  take it with W1 if it is free, skip it otherwise.

## Recommendation

**W1 and W2 are worth doing on their own merits** — they are a small refactor
that turns two switch statements into an extension point, and the toolkit is
explicitly built to be extended. W3 is cheap once W1 exists.

**W4 and W5 should wait for a reason.** The diff is the only genuinely missing
capability, it is blocked on a library decision, and V0's structured bodies
already render all six of our tools legibly. Doing W5 speculatively would mean
porting a renderer for data we do not produce.

If V5 is never finished past W2, the TUI loses nothing it has today.
