# Plan: an honest, dialect-aware `shell` tool

Written 2026-08-26. This plan replaces the model-facing `bash` identity in the
two built-in coding toolkits with `shell`, while keeping the sandbox at the
lower, portable argv boundary.

**Status: specified, not implemented.**

## Outcome

The public story becomes:

```text
model calls `shell`
        |
        v
configured Shell translates one script to argv
        |
        v
Sandbox.exec executes argv inside the selected sandbox
```

That split is deliberate:

- `CodingToolkit` and `PiToolkit` each expose a model-facing tool named
  `shell`, bound through `handlers.shell`.
- `Shell` owns script dialect and argv construction.
- `Sandbox.command` and `Sandbox.exec` remain shell-agnostic. A sandbox does
  not choose, parse, or advertise a command language.

The work is complete only when the model sees both the truthful tool name
`shell` and the actual configured dialect before it writes a command. Renaming
the handler while retaining the static sentence “with bash” is not completion.

## Why change it

Today both batteries expose a tool named `bash`:

- `CodingToolkit.Bash`, `CodingToolkit.handlers.bash`;
- `PiToolkit.Bash`, `PiToolkit.handlers.bash`;
- `Prompts.BASH` says “Run a command in the workspace with bash.”

Execution no longer necessarily means Bash. `src/shell/Shell.ts` can translate
scripts for Bash, POSIX sh, zsh, fish, Windows PowerShell, PowerShell 7,
Nushell, or an application-defined shell. Both handlers ultimately call
`Sandbox.exec(shell.toCommand(command))`.

That leaves an API lie: an application can configure PowerShell while the
model is given a tool called `bash` whose description explicitly asks for Bash
syntax. The argv plumbing works, but the model is encouraged to produce the
wrong program.

## Decisions

### 1. Rename the built-in model tool, not the sandbox primitive

The tool name is `shell`, its handler key is `shell`, and its named export is
`Shell` under each toolkit namespace:

```ts
CodingToolkit.Shell
CodingToolkit.handlers.shell

PiToolkit.Shell
PiToolkit.handlers.shell
```

Inside those modules, import the runtime module as `ShellRuntime` so the public
`Shell` tool value does not collide with the module namespace.

The following remain unchanged:

```ts
Sandbox.command(executable, args)
sandbox.exec(command, options)
```

There will be no `Sandbox.shell`, `Sandbox.bash`, or implicit shell selection
inside a sandbox provider. A remote/container/memory sandbox receives argv and
executes it; the `Shell` capability is the only place that interprets a script
as belonging to a dialect.

### 2. Construction-time shell selection is authoritative

A tool description is static once an `Agent` is built. A `Shell` Layer looked
up only when the handler executes can change the executable without changing
the description the model already saw. Therefore runtime override precedence
is removed from the built-in toolkit handlers.

Both toolkits take the same options shape:

```ts
interface ToolkitOptions {
  readonly shell?: ShellRuntime.Kind | ShellRuntime.Service
}
```

Resolution happens once while building the toolkit:

```text
options.shell supplied  -> that exact Service
options.shell absent    -> ShellRuntime.bash
```

The selected service supplies both:

1. the name rendered into the tool description; and
2. the `toCommand` function captured by the handler.

There is no second precedence rule. An unrelated `Shell.layer(...)` in the run
environment does not silently alter an already-built toolkit.

Applications that want Layer-based selection read the service before building
the agent, making the requirement visible in the Effect type:

```ts
const makeAgent = Effect.gen(function* () {
  const shell = yield* ShellRuntime.Shell
  return Agent.make({
    toolkit: CodingToolkit.toolkit({ shell })
  })
})

const agent = yield* makeAgent.pipe(
  Effect.provide(ShellRuntime.layer("pwsh"))
)
```

This preserves Effect-native application wiring without allowing model-facing
metadata and runtime behavior to drift apart. `ShellRuntime.current` may remain
available for application-authored dynamic tools, but the built-in toolkits do
not call it during execution.

### 3. Default raw exports remain the Bash configuration

The common source-compatible shape stays convenient:

```ts
CodingToolkit.tools
CodingToolkit.handlers
CodingToolkit.toolkit()
```

Those three are one coherent Bash-default configuration, except for the
intentional public rename from `bash` to `shell`.

Each toolkit also exposes one coherent configuration factory for custom
composition:

```ts
const configured = CodingToolkit.configure({ shell: "powershell" })
configured.tools
configured.handlers
CodingToolkit.toolkit({ shell: "powershell" })
```

The same shape exists on `PiToolkit`. A single `configure` result is necessary
because independent `toolsFor` and `handlersFor` calls could be made with
different shells and recreate the metadata/runtime mismatch in user code.
`toolkit` delegates to `configure`, which resolves once and constructs its
tools and handlers from that same service. The default `tools` and `handlers`
exports are taken from one module-level Bash configuration, not from separate
factory calls.

All factory result types retain the literal tool name `"shell"`; a different
dialect changes values, not generic parameters. End-user code must not need a
cast or a hand-written handler parameter annotation.

### 4. The description is rendered from the selected shell

Replace `Prompts.BASH` with a renderer:

```ts
Prompts.shell(shellName)
```

The first sentence names the actual dialect, for example:

```text
Run a command in the workspace using PowerShell 7 (pwsh).
```

Built-in display labels are fixed and tested:

| Kind | Model-facing label | Executable |
| --- | --- | --- |
| `bash` | Bash | `bash` |
| `sh` | POSIX sh | `sh` |
| `zsh` | zsh | `zsh` |
| `fish` | fish | `fish` |
| `powershell` | Windows PowerShell | `powershell` |
| `pwsh` | PowerShell 7 (`pwsh`) | `pwsh` |
| `nushell` | Nushell | `nu` |

`ShellRuntime.Service` gains a model-facing `displayName` beside its stable
programmatic `name`. `ShellRuntime.make` accepts the display name so a custom
shell does not masquerade as a built-in:

```ts
ShellRuntime.make({
  name: "xonsh",
  displayName: "Xonsh",
  toCommand: (script) => Sandbox.command("xonsh", ["-c", script])
})
```

`name` and `displayName` are application configuration, not model input. They
must be non-empty single-line strings; construction rejects line breaks and
control characters so a custom label cannot turn into extra prompt
instructions. `ShellRuntime.make` is a pure configuration constructor, like
`AgentLoop.maxTurns`; an invalid value throws immediately with
`Shell.make: name must be a non-empty single-line string` or the corresponding
`displayName` message. No Effect has begun and there is no runtime error channel
to widen.

The remainder of the current shell prompt stays shared: use dedicated file
tools, timeout behavior, bounded output, and Git/GitHub safety. It must not
claim that a Unix-only command or quoting rule is universal. Dialect-specific
guidance belongs in the selected shell's description, not in `Sandbox`.

### 5. Permission semantics do not change

The tool remains annotated as:

```ts
{
  action: "shell",
  resource: ({ command }) => command
}
```

Only `detail.toolName` changes from `bash` to `shell`. Remembered grants keyed
by semantic action/resource continue to mean the same thing. Permission tests
must prove Allow, Ask, Deny, and intrinsic policy behavior are unchanged.

### 6. This is an intentional protocol break

The model tool name, handler record key, exported constant, lifecycle events,
snapshots, and approval detail all change. At `0.0.1`, make the rename cleanly
rather than maintaining two executable names for one capability:

| Before | After |
| --- | --- |
| `CodingToolkit.Bash` | `CodingToolkit.Shell` |
| `CodingToolkit.handlers.bash` | `CodingToolkit.handlers.shell` |
| `PiToolkit.Bash` | `PiToolkit.Shell` |
| `PiToolkit.handlers.bash` | `PiToolkit.handlers.shell` |
| tool call name `bash` | tool call name `shell` |
| `Prompts.BASH` | `Prompts.shell(name)` |

Do not include `Bash` or `handlers.bash` aliases in either built-in toolkit.
An alias would keep source code compiling while model/tool-call fixtures still
use the obsolete protocol name, producing a half-migration that is harder to
detect than a compile error.

Applications must drain or version durable workflows containing an unfinished
built-in `bash` tool call before deploying the rename. Completed historical
events and exported transcripts remain readable because their tool names are
data, but an unfinished call cannot be dispatched to a toolkit that no longer
declares `bash`. Record this release note in the README and STATUS entry.

The TUI is the sole compatibility exception: its renderer keeps a display-only
view for historical `bash` events while registering `shell` for all new calls.
That alias never reaches toolkit dispatch and cannot execute a command.

## Invariants

**SH1 — One abstraction owns each decision.** `Shell` chooses script dialect
and argv; `Sandbox` executes argv. No sandbox provider imports a toolkit or
selects a shell.

**SH2 — The advertised dialect is the executed dialect.** The same resolved
`ShellRuntime.Service` builds the tool description and handler.

**SH3 — Tool identity is honest.** The built-in coding batteries expose
exactly one command tool named `shell`; neither exposes a tool named `bash`.

**SH4 — Selection is stable.** Once a toolkit is constructed, later Layer
wiring cannot change its shell implementation behind the model's description.

**SH5 — Defaults remain useful.** With no option, both toolkits describe Bash
and execute `bash -c <script>` (no built-in is a login shell since #39).

**SH6 — Every built-in mapping is exact.** Bash uses `-lc`; sh, zsh, fish, and
Nushell use their declared `-c` form; both PowerShell variants use
`-NoProfile -Command`; executable names match the table above.

**SH7 — Permission remains semantic.** Every command projects to action
`shell` and resource equal to the exact script string, independent of dialect.

**SH8 — Sandbox portability is unchanged.** `/sandbox` remains argv-based and
portable; `/shell`, `/coding`, and `/pi` add no host imports or direct process
access.

**SH9 — Public inference remains exact.** Tool names, parameter/result types,
failure strings, and handler requirements infer without casts or manual
annotations in examples and tests.

**SH10 — Historical display is not execution compatibility.** The TUI can
render an old `bash` event, but no built-in toolkit dispatches new `bash` calls.

## Public API target

Default Bash:

```ts
const agent = Agent.make({
  toolkit: CodingToolkit.toolkit()
})
```

Explicit PowerShell:

```ts
const agent = Agent.make({
  toolkit: CodingToolkit.toolkit({ shell: "pwsh" })
})
```

Custom shell:

```ts
const xonsh = ShellRuntime.make({
  name: "xonsh",
  displayName: "Xonsh",
  toCommand: (script) => Sandbox.command("xonsh", ["-c", script])
})

const agent = Agent.make({
  toolkit: PiToolkit.toolkit({ shell: xonsh })
})
```

Custom toolkit composition:

```ts
const configured = CodingToolkit.configure({ shell: "powershell" })

const toolkit = Agent.toolkit(configured.tools, {
  ...configured.handlers,
  read_file: myAuditedReadHandler
})
```

The compiler must infer the `shell` parameter as `{ command: string;
timeout_ms?: number }`, its structured result, the sandbox requirement, and
all errors. The example contains no cast and no parameter annotation.

## Implementation map

### `/shell`

Files:

- `src/shell/Shell.ts`
- `src/shell/index.ts`
- `test/Shell.test.ts`

Work:

1. Add `displayName` to `Service` and all seven built-ins.
2. Update `make` to its options-object form and migrate callers.
3. Retain `Kind`, `fromKind`, `layer`, and `current` as the public capability
   API; document that built-in toolkits resolve the service at construction.
4. Add the missing `sh` and `fish` exact-argv cases.
5. Test custom-name validation and custom argv translation.

### `/coding`

Files:

- `src/coding/CodingToolkit.ts`
- `src/coding/internal/prompts.ts`
- `src/coding/index.ts`
- `test/CodingToolkit.test.ts`
- `test/CodingPrompts.test.ts`
- `test/CodingComposition.test.ts`

Work:

1. Rename `Bash` to `Shell`, `bash` handler to `shell`, and tool name to
   `"shell"`.
2. Add `ToolkitOptions` and the coherent `configure` factory.
3. Make `toolkit(options)` share one resolved service between its tool and
   handler.
4. Replace `Prompts.BASH` with the dialect renderer.
5. Keep output bounds, timeout mapping, result schema, dependencies, and
   permission projection unchanged.

### `/pi`

Files:

- `src/pi/PiToolkit.ts`
- `src/pi/index.ts`
- `test/PiToolkit.test.ts`

Work mirrors `/coding`. Delete the current split where `handlersFor` changes
execution but `tools` retains the static Bash description. Remove the existing
`as unknown as` assertion in `test/PiToolkit.test.ts`; test code is user code,
and public tool metadata must be inspectable without an erasing cast.

### TUI and repository consumers

Files to audit include:

- `apps/tui/src/backend.ts`
- `apps/tui/src/tools.ts`
- `apps/tui/src/smoke.tsx`
- `examples/coding-agent.ts`
- `examples/full-stack-agent.ts`
- `examples/web-agent.ts`
- `test/PublicApi.test.ts`

New scripted model calls and the built-in view registry use `shell`. The view
registry also retains a render-only `bash` rule for old persisted transcripts.
The TUI's tool inventory, help copy, approvals, reuse-by-call-id cases, and
smoke assertions all change together.

Do not mechanically rename unrelated generic fixtures merely because they use
a user-defined tool called `bash`. `AgentSugar`, permission, export, plugin
frontmatter, and durable-permission tests are allowed to keep such a tool when
the point of the test is the generic core rather than either built-in battery.
Each surviving occurrence must be classified during review.

### Documentation

Update:

- `README.md`: batteries list, `/shell` section, default/PowerShell/custom
  examples, and the durable in-flight migration note;
- `STATUS.md`: implementation decision, tested paths, and verification count;
- `docs/plan-pi-toolkit.md`: P5 points to this completed follow-up rather than
  claiming handler-only selection is the final shape;
- `docs/remaining-work.md`: add this plan until complete, then mark it done;
- source docstrings that currently say a toolkit “provides bash.”

Historical plans and research may retain “Bash” when describing the upstream
tool or the state at the time. Current API guidance must use `shell`.

## Test plan

### Shared shell contract

Create a small shared contract exercised by both `CodingToolkit` and
`PiToolkit`:

1. default configuration exposes `shell`, not `bash`;
2. default description names Bash and execution is `bash -c`;
3. each of the seven `Kind`s renders the expected display name and exact argv;
4. a custom service renders its display name and exact custom argv;
5. tool success and timeout/failure shapes are unchanged;
6. a conflicting `Shell.layer("fish")` around a toolkit constructed with
   `{ shell: "powershell" }` does not change execution;
7. the permission projection is `{ action: "shell", resource: command }`;
8. direct `configure` composition has exact inferred types and cannot select
   separate description and execution services.

The conflicting-Layer test is load-bearing. Without it, a later refactor can
quietly reintroduce the original metadata/runtime disagreement.

### Prompt assertions

For every built-in shell:

- the first sentence contains its display name;
- a non-Bash configuration does not say it runs “with bash”;
- output limits and spill-file location stay synchronized with constants;
- dedicated file-tool and Git safety instructions remain present;
- a custom display name cannot insert a second line of instructions.

### End-to-end agent assertions

Use `TestLanguageModel` with a real `Agent` and scripted `Sandbox.exec`:

- the model receives a tool named `shell` with the configured description;
- a PowerShell-only sandbox receives `powershell -NoProfile -Command` and no
  attempt to execute `bash`;
- lifecycle events name `shell`;
- Allow executes once, Ask exposes `toolName: "shell"`, and Deny executes zero
  sandbox work;
- the result reaches the model with the existing structured schema.

### TUI compatibility assertions

- a new `shell` call uses the specialized command renderer;
- an old recorded `bash` call renders with the same legacy view;
- the scripted backend advertises only `shell`;
- overriding the `shell` view does not replace unrelated views;
- approval and interrupted/failed/succeeded rows retain their current output.

### Type and cast assertions

Add compile-time assertions in the existing public API/type test locations:

- toolkit key union includes `shell` and excludes `bash`;
- tool-call params and results are not `any`;
- `toolkit({ shell: custom })` adds no `ShellRuntime.Shell` requirement to run
  the already-constructed agent;
- constructing an agent from `yield* ShellRuntime.Shell` carries that
  requirement until a Layer is supplied;
- no user/test cast is needed.

Break each critical assertion once and restore it. `test/Casts.test.ts` and the
repository no-cast rule remain authoritative.

## Milestones

### S0 — Freeze the contract

- Land SH1-SH10 and the migration table in this document.
- Inventory every current built-in `bash` occurrence.
- Classify generic user-defined Bash fixtures so later search results are not
  mistaken for incomplete migration.

### S1 — Make `Shell` descriptive and complete

- Add `displayName` and options-object `make`.
- Cover all seven exact argv mappings, including missing `sh` and `fish`.
- Keep `/shell` portable and independently usable.

### S2 — Migrate `/coding`

- Rename the tool, export, handler, and prompt.
- Add construction-time configuration factories.
- Prove metadata/runtime agreement, inference, permission, timeout, and bounds.

### S3 — Migrate `/pi`

- Apply the same public/configuration contract.
- Delete handler-only shell selection.
- Remove the cast from its metadata test.
- Run the shared toolkit contract against both batteries.

### S4 — Migrate consumers and preserve historical display

- Update TUI backend, views, smoke fixtures, examples, and public API pins.
- Retain only the TUI's non-executable legacy renderer.
- Classify every remaining `bash` occurrence.

### S5 — Document and falsify

- Update README, STATUS, P5, and remaining-work.
- Deliberately break SH2, SH3, SH4, SH6, SH7, and SH9 and confirm a test fails
  for each mechanism.
- Record the falsification results in this plan as done milestones land.

## Acceptance criteria

- **AC1:** `CodingToolkit.tools` and `PiToolkit.tools` contain `shell` and no
  `bash`; their handlers have `shell` and no `bash`.
- **AC2:** Bash default, all six other built-ins, and a custom service execute
  exact expected argv under both toolkits.
- **AC3:** The description seen by the model names the service captured by the
  handler; a conflicting runtime Layer cannot change it.
- **AC4:** `/sandbox` has no shell-selection API and remains argv-based.
- **AC5:** Permission action/resource semantics are byte-for-byte unchanged
  apart from `toolName` becoming `shell`.
- **AC6:** PowerShell-only end-to-end execution succeeds without Bash being
  installed or attempted.
- **AC7:** New TUI traffic uses `shell`; historical `bash` events still render
  but cannot dispatch.
- **AC8:** README and public examples document default, explicit, Layer-sourced,
  and custom shell construction plus the in-flight durable migration boundary.
- **AC9:** No cast or inferred-`any` regression appears in source, tests, or
  examples.
- **AC10:** Every surviving repository occurrence of built-in `bash` is either
  an implementation/default dialect reference, a historical document, a
  generic user-defined-tool fixture, or the TUI legacy renderer. There is no
  current built-in API or model prompt under that name.

## Verification

Focused while implementing:

```bash
npx vitest run test/Shell.test.ts test/CodingToolkit.test.ts \
  test/CodingPrompts.test.ts test/CodingComposition.test.ts \
  test/PiToolkit.test.ts test/PublicApi.test.ts
```

Final gate:

```bash
npm run typecheck
npm run lint
npm run lint:portability
npm test
npm run check
```

The full gate, including TUI typecheck/lint/smoke, must pass. A green `tsc` is
not sufficient; Effect language-service diagnostics must remain zero.

## Explicit non-goals

- No shell parser, AST, command allowlist DSL, or shell-specific permission
  decomposition. Permission continues to see the exact script string.
- No host-shell autodetection. A hidden `process.platform` default would make
  behavior depend on the machine and violate portability.
- No command rewriting from one dialect to another.
- No shell execution outside `Sandbox.exec`.
- No change to output truncation, timeouts, filesystem tools, or sandbox
  isolation guarantees.
- No `Agent.make` parameter. Shell choice belongs to toolkit construction and
  application Layer wiring, not the nine-parameter core agent signature.
- No executable compatibility alias for `bash` in the built-in toolkits.

## Known migration risk

Models and integrations have strong priors around a tool called `bash`, so the
rename may initially change tool-selection behavior even though `shell` is more
truthful. The dialect-specific description and end-to-end model fixture are the
mitigation. Do not retain the misleading name merely for that prior: a model
choosing a familiar tool and then writing syntax for the wrong interpreter is
worse than a visible protocol migration.

Durable in-flight calls are the operational risk. Release notes must tell
deployers to drain or version them; the library must not pretend it can safely
reinterpret an unfinished `bash` call as `shell` across an arbitrary upgrade.
