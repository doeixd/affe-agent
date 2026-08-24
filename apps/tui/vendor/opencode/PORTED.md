# What we took, and what we changed

SV4 asks that `vendor/` and `src/` be diffable file by file to answer "what did
we change?". They are not line-for-line ports and a `diff` would say nothing
useful, so this is the answer instead: per upstream file, what came across and
what did not.

Upstream is [sst/opencode](https://github.com/sst/opencode) at commit
`2a6be0a03b93a6734070e10a6c3b56863475f214`, MIT — see `LICENSE.opencode`.
Nothing in `vendor/` is compiled; it is here to be read against `src/`.

| Upstream | Ours | Lines | What happened |
| --- | --- | --- | --- |
| `types.ts` (364) | `src/view.ts` (229) | 63% | Shape taken, types not |
| `theme.ts` (704) | `src/theme.ts` (129) | 18% | Palette taken, terminal detection not |
| `footer.width.ts` (41) + `turn-summary.ts` (61) | `src/width.ts` (49) | 48% | Both, merged |
| `tool.ts` (1,500) | `src/tools.ts` (329) | 22% | The registry, not the rules |
| `entry.body.ts` (219) | — | — | Folded into `App.tsx` |
| `footer.view.tsx` (959) | — | — | Idea only; see below |
| `scrollback.*` (917) | — | — | Replaced by OpenTUI's own |

## Per file

**`types.ts` → `view.ts`.** Taken: separating an entry's *kind* from its
*body*, so one body renderer serves a tool result and an assistant message
alike. Not taken: their concrete types, which derive from `OpencodeClient`
(`Awaited<ReturnType<...>>` of SDK calls) and would have pulled opencode's
session model into our UI through the back door. Their `ToolSnapshot` variants
are their tools — task, todo, question; ours are ours.

**`theme.ts` → `theme.ts`.** Taken: the colour relationships and the idea of an
entry kind selecting a tone. Not taken: their terminal-detection behaviour,
which is most of the file's length. The plan flagged this as a risk — "their
theme carries terminal-detection behaviour, not just colours" — and the answer
was to read it and decline it rather than inherit environment handling we had
not thought about.

**`footer.width.ts` + `turn-summary.ts` → `width.ts`.** Both, essentially
whole, merged because they are one idea: one policy decides what a width
affords, so parts of the footer disappear in a considered order instead of
overflowing.

**`tool.ts` → `tools.ts`.** Taken: the registry, which is the portable fifth of
it — `ToolRule = { view, run, scroll?, permission?, snap? }` keyed by tool name,
of which we keep the three that mean anything here. Their narrowing helpers
(`dict`, `text`, `num`, `list`) came too, and for the reason they exist there.
Not taken: the eighteen rules, which render *their* tools.

Two deliberate divergences:

- **Theirs is closed, ours is open.** `type ToolName = keyof ToolDefs` fixes
  eighteen tools at compile time, which is right for a fixed tool set. Ours is
  a record with a fallback, because the coding toolkit is built to be extended
  and a user who adds a tool must not have to edit our files to make it render.
- **Ours is typed at registration.** `withViews(tools, rules)` infers each
  rule's parameter and result types from the toolkit, so a rule reads its
  tool's fields without a cast. Theirs narrows inside each rule.

**`entry.body.ts`.** Not a file here. Its job — dispatch on body type — is
twelve lines in `App.tsx`, and a separate module for it would be indirection
without a second caller.

**`footer.view.tsx`.** The largest file, and the least ported. Taken: one idea,
which is that the footer is a state machine with exactly one active surface —
"when a permission arrives the view switches to permission, and when the
permission resolves it falls back to prompt". Ours is a four-state union
(prompt, approval, palette, branches) so that two surfaces at once is
unrepresentable rather than merely avoided. Not taken: 959 lines of their
prompt editor, attachments, model picker and session list.

**`scrollback.*` (917 lines).** Not ported at all, and this is the happiest
outcome of the port. Their surface, writer and shared helpers implement
committing finished entries to the terminal's own scrollback; OpenTUI ships
`createScrollbackSurface` and `writeSolidToScrollback`, which do it natively.
We took the *architecture* — a finished entry leaves the reactive tree — and
none of the code. `src/bench.tsx` measures that it works: flat frame time from
50 entries to 500, live tree at zero.

## What we have that they do not

`diff.ts` computes a unified diff from `matched` and `new_string`. Upstream's
`snapEdit` reads `p.metadata.diff` because their edit tool returns one; ours
returns the span it actually replaced, which is strictly more information — a
fuzzy match means what changed is not what was asked for, and the diff shows
that difference.
