# Sandbox, coding toolkits and delegated runtimes

The execution substrate (`/sandbox`, `/sandbox/local`, `/shell`), the two
coding tool batteries (`/coding`, `/pi`), and the A2A bridges that put
Claude Code and OpenCode behind the same permission policy.

`affe-agent/sandbox` is a scoped filesystem-and-process capability
that user-defined tools demand through the ordinary requirement channel. It
exists to prove the composition the whole design bets on — nothing here
changes the agent core. A ready-made battery ships on top of it (see [Coding
toolkit](#coding-toolkit) below), but the seam is the point, and a tool is just
this:

```ts
const ReadFile = Tool.make("read_file", {
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  dependencies: [Sandbox.Current]
})

const toolkit = Agent.toolkit([ReadFile], {
  read_file: ({ path }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      return yield* Sandbox.readText(sandbox)(yield* Sandbox.path(path))
    }).pipe(Effect.mapError((error) => error.message))
})
```

`Sandbox.path` is where raw model output becomes a usable value: absolute
paths, drive qualifiers and any `..` segment are refused with a typed error,
so traversal is unrepresentable past that boundary. The workspace arrives as
a layer — deterministic in-memory worlds for tests, a real directory for
everything else — and swapping providers rewrites one line of wiring while the
agent and every handler stay untouched:

```ts
Layer.provideMerge(
  Sandbox.currentLayer(Sandbox.workspace("coding-agent")),
  MemorySandbox.layer({ seed: { "src/add.test.ts": "..." } })
)
// or, from the Node-only entry `affe-agent/sandbox/local`:
LocalSandbox.layer()
```

The local provider creates a fresh temporary directory per acquisition and
removes it when the acquiring scope closes; commands run without a shell,
with exact executable/argument separation, time limits and bounded output.
Its documentation states plainly what it is not: **a security boundary**. It
runs with your program's full privileges.

#### Watching a command run

`exec` answers *what did it print*, which is the wrong question for a build,
a long test run, or an external agent whose prompts have to be answered while
it is still working. `execStream` answers *what is it printing*:

```ts
// Act on the first line, then stop -- and the process ends with the scope.
yield* Stream.runForEach(
  Sandbox.lines(sandbox.execStream(Sandbox.command("npm", ["test"]))),
  (line) => Effect.log(line)
)
```

Events carry **bytes**, not text, because a chunk boundary can fall inside a
multi-byte character; `Sandbox.lines` decodes and splits across boundaries, in
one place, and is what line-delimited protocols (NDJSON, `stream-json`) should
go through. The exit arrives as the last event rather than on a side channel,
so ordering is unambiguous, and `Sandbox.collect` folds a stream back into the
`CommandResult` `exec` returns -- which is literally how the local provider
implements `exec`, so the two cannot drift.

`execStream` is **required on the handle and optional on a provider**: one
built from a buffered `exec` alone (`Sandbox.fromExec`) still has it, derived
by delivering everything at exit, and says so in its `derived` report. The
conformance suite probes the difference rather than trusting it —
`capabilities.streamsIncrementally` is measured by a command that prints on a
timer.

### Coding toolkit

`affe-agent/coding` is a ready-made battery of the tools a coding
agent needs — `read_file` (with line numbers and a range), `write_file`,
`edit_file` (an exact string replace that refuses an ambiguous match),
`list_files`, `search` (an in-process tree walk, so it works against any
provider) and `shell`. It is *not* a core capability: every tool is an ordinary
`Tool` whose handler demands `Sandbox.Current`, exactly like the one above. That
a serious toolkit needs no change to the agent core is the whole point.

```ts
import { CodingToolkit } from "affe-agent/coding"

const Coder = Agent.make({
  instructions: "You edit code in the workspace.",
  toolkit: CodingToolkit.toolkit()
})
```

Which sandbox runs — an in-memory world for tests, a real directory on disk —
arrives through the same one-line layer wiring, invisible to the tools. And
every tool carries a [permission](./guide-permissions.md) projection: the file tools
project to `read`/`write` on the path, `shell` to `shell` on the command, so a
policy can allow reads, ask before writes and deny `rm -rf` without knowing
anything about these tools' parameter shapes.

#### The `shell` tool and its dialect

The command tool is named `shell`, and its description tells the model which
dialect it is writing for. The dialect is chosen when the toolkit is built,
from `affe-agent/shell`: a built-in `Kind` or a `Service` of your
own. Default: Bash, executed as `bash -c <script>`.

```ts
import { Shell } from "affe-agent/shell"
import { Sandbox } from "affe-agent/sandbox"

CodingToolkit.toolkit()                       // "…using Bash."       bash -c
CodingToolkit.toolkit({ shell: "pwsh" })      // "…using PowerShell 7 (pwsh)."  pwsh -NoProfile -Command
PiToolkit.toolkit({ shell: "nushell" })       // "…using Nushell."    nu -c

// A shell of your own: `displayName` is what the model is told, and it is
// refused if it could carry a second line of instructions.
const xonsh = Shell.make({
  name: "xonsh",
  displayName: "Xonsh",
  toCommand: (script) => Sandbox.command("xonsh", ["-c", script])
})
CodingToolkit.toolkit({ shell: xonsh })

// Layer-sourced: read the service first, so the requirement is in the type.
const shell = yield* Shell.Shell
CodingToolkit.toolkit({ shell })

// Composition from the same resolved shell -- tools and handlers cannot be
// built for different dialects by accident.
const configured = CodingToolkit.configure({ shell: "powershell" })
Agent.toolkit(configured.tools, { ...configured.handlers, read_file: audited })
```

The description the model sees and the argv that runs come from the *same*
resolved service, and a `Shell.layer` provided later does not change an
already-built toolkit -- that is what keeps the advertised dialect and the
executed one from drifting apart. `Sandbox.exec` stays argv-based and never
selects a shell.

**Migration note (0.0.1 → next).** The tool used to be named `bash`
(`CodingToolkit.Bash`, `handlers.bash`, `Prompts.BASH`). There is no alias:
`shell` / `CodingToolkit.Shell` / `handlers.shell` are the only names, so
scripted model fixtures and permission `toolName` matches change with the
code, and a leftover `bash` fails to compile rather than half-migrating.
Recorded transcripts and exports remain readable -- tool names in them are
data -- but a durable workflow holding an *unfinished* built-in `bash` call
cannot dispatch it to a toolkit that no longer declares one: drain or
version those before deploying. The TUI keeps a display-only view for
historical `bash` rows; nothing executes under that name.

### Claude Code as an A2A agent

`affe-agent/a2a` also bridges an *external* agent runtime in.
`ClaudeCodeA2A.remote(sandbox)` runs Anthropic's Claude Code CLI inside a
sandbox workspace and presents it as an ordinary `RemoteAgent`:

```ts
import { AgentA2A, ClaudeCodeA2A } from "affe-agent/a2a"

const claude = yield* ClaudeCodeA2A.remote(sandbox, { allowedTools: ["Read", "Edit"] })

const Manager = Agent.make({
  instructions: "Delegate implementation work, then review it.",
  tools: [AgentA2A.tool("claude_coder", {
    description: "Delegate a coding task to Claude Code.",
    request: Schema.String,
    result: Schema.String,
    agent: claude,
    contextId: "coding"
  })]
})
```

**A coding CLI is an agent, not a model.** Putting one behind `LanguageModel`
would nest an agent loop inside another and call the inner one a model; A2A
says what it is — an autonomous peer with its own loop, tools, workspace and
session state — and costs nothing extra, because `AgentA2A.tool` already turns
any `RemoteAgent` into one of this agent's tools. The contrast is
[`examples/openrouter.ts`](../examples/openrouter.ts): a model gateway *is* a
model API, and nests under `LanguageModel` with nothing left over.

Everything goes through `Sandbox`: the CLI is spawned inside the workspace,
under its timeout and output bounds, and the module imports no `node:*` — so
the same bridge runs against a remote sandbox unchanged, and a scripted
provider is the CLI as far as the bridge can tell (which is how it is tested,
with no `claude` binary in CI). An A2A context maps to the CLI's session id, so
a second message to the same context resumes the same conversation. `delegate`
is `send` with the answer narrowed to `Task`, since this peer never replies
with a bare message. A run that ends without a `result` is reported as
*cancelled*, never completed: a caller must not read "it worked" from "it
stopped".

Two defaults worth knowing: the CLI is **not** run with `--bare` (bare mode
never reads OAuth credentials, so it needs `ANTHROPIC_API_KEY` and breaks a
subscription login), and the sandbox's own 10-second timeout is raised to 10
minutes, because a delegated coding task is not a command you wait on.

#### One policy, two runtimes

On its own the bridge does not touch Claude Code's permission model — the CLI
decides what it may do, from its own flags, and the sandbox is the only
boundary. `ClaudeCodePermissions` changes that: `--permission-prompt-tool`
routes every prompt the CLI would have shown a human to an MCP tool, and that
tool is this application's [`Permission`](./guide-permissions.md) policy plus its
`Elicitation`.

```ts
import { ClaudeCodePermissions } from "affe-agent/a2a"

// 1. Serve the decision — one tool, on your own (loopback) router.
const Permissions = ClaudeCodePermissions.layer({ policy, elicitor })

// 2. Point the CLI at it.
const claude = yield* ClaudeCodeA2A.remote(sandbox, {
  extraArgs: ClaudeCodePermissions.args({ url: "http://127.0.0.1:4599/permission" })
})
```

The default projection maps the CLI's tools onto the **same `action`
vocabulary** `/coding` annotates its own with — `shell` on the command, `read`
and `write` on the path — so a rule written as "ask before `write`, never
`git push`" governs a delegated Claude Code run and a local `CodingToolkit` run
identically, without knowing that either exists. An `ask` becomes a
`tool-approval` elicitation of the same `kind` the harness raises for its own
tools, so whatever already renders that question renders this one; "allow
always" reaches the policy's `remember`.

It fails closed. With no elicitor an `ask` is a denial (the harness's own
default), a request naming no tool is denied before the policy is consulted, and
`--strict-mcp-config` is passed by default so a delegated run's tool surface
does not depend on what the host machine happens to have configured. **The
endpoint is an authority** — anything that can reach it can be asked to approve
a tool call — so bind it to loopback and keep it off an exposed router.

### OpenCode, over its server

`OpenCodeA2A.remote({ baseUrl })` bridges an `opencode serve` the same way, and
presents the **same** `RemoteAgent` — so a manager delegating to both writes the
code once:

```ts
const opencode = yield* OpenCodeA2A.remote({
  baseUrl: "http://127.0.0.1:4096",
  permissions: { policy, elicitor }
})
```

It speaks OpenCode's HTTP API rather than its terminal: sessions, the event bus,
and first-class permission requests all come for free, and an A2A context maps
to a server session exactly as it maps to a CLI session for Claude Code. Note
what it did *not* need — `Sandbox.execStream`. The seam the Claude Code bridge
required does not appear here at all, which is the sign it was put in the right
place rather than everywhere.

Permissions are **tighter** on this side. Claude Code has to be given a prompt
tool before it will ask anything; OpenCode asks on its own bus, and its answer
has a third value: `always`. So "allow always" reaches the delegated runtime as
well as our policy, and it stops asking. Both bridges project into the same
`read` / `write` / `shell` vocabulary, so one rule set governs a local
`CodingToolkit` run, a delegated Claude Code run, and a delegated OpenCode run.

Cancellation differs for a real reason and the interface says so: there is no
process to kill, the run lives in the server, so `cancel` is a request
(`/session/{id}/abort`) rather than fiber interruption.

Both of OpenCode's HTTP APIs are spoken: `api: "v1"` (the default, and what a
released server answers) and `api: "v2"` for the `/api/...` surface. v2 is not
a rename — its prompt endpoint returns an *admission*, and the run's answer is
read from the message projection once it completes, because the `wait` endpoint
that exists for this is `503 "not available yet"` on every build that serves v2
at all. Its permission reply carries a `message`, so on v2 a policy's *reason*
reaches the delegated agent. See `docs/remaining-work.md` 26i.

