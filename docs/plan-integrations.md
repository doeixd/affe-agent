# Plan: integrations — sandboxes, channels, stores, deployment

Written 2026-08-27. Flue ships ~39 provider integrations and almost no
integration code. This plan works out what they actually built, what is worth
keeping, and how to offer the same reach with typed, composable, testable
providers and **no code generation at all**.

**Status: specified, not implemented.**

### Implementation audit (2026-08-27)

Sequence step 1 is not implementable against the current public contract as
written. The proposed conformance suite requires `rm`, `mkdir`, symlink `stat`
and capability declarations, while `Sandbox` exposes only `read`, `write`,
`list`, `stat`, `canonical` and `exec`; writes create parents and there is no
public remove operation. Adding methods solely so a draft test can call them
would expand the seam without two features needing them. Likewise, a derived
`separateStderr` report has no current consumer in `/coding` or `/pi`.

A useful conformance slice must first be restated over the actual contract:
byte round-trip, root/child listing shape and order, missing-file errors,
canonical identity, exact argv, ordinary non-zero exits, typed timeout/output
limits, and interruption. Provider-specific symlink and stderr probes may be
reported by the test runner, but they must not become public capability fields
until runtime behavior consumes them. Only after that narrower suite catches a
deliberately broken provider should `fromExec` be designed; its proposed POSIX
file derivation otherwise invents operations the seam does not have.

## 1. What Flue actually ships

`withastro/flue` (8k stars, "The sandbox agent framework") has a `blueprints/`
directory of ~39 Markdown files. Its README is unusually direct about what they
are:

> A blueprint is a Markdown guide for an AI coding agent, not an npm package or
> runtime abstraction. The CLI fetches and prints the guide; the coding agent
> edits the user's project.

`flue add sandbox daytona` prints a guide; a coding agent writes
`src/sandboxes/daytona.ts` into your repo. Four kinds:

| kind | result |
| --- | --- |
| `sandbox` | an adapter for a remote execution provider |
| `channel` | verified provider ingress, a client, and application-owned tools |
| `database` | an adapter implementing Flue's `PersistenceAdapter` |
| `tooling` | a developer-tool integration — observability, evals |

Named blueprints exist for boxd, cloudflare, cloudflare-computer, daytona, e2b,
exedev, islo, mirage, modal and vercel (sandboxes); discord, github, google-chat,
intercom, linear, messenger, notion, resend, salesforce-marketing-cloud, shopify,
slack, stripe, teams, telegram, twilio, whatsapp and zendesk (channels); libsql,
mongodb, mysql, postgres, redis, supabase, turso and valkey (databases);
braintrust, sentry and vitest-evals (tooling).

There is also a **generic guide per kind** — `sandbox.md` — invoked as
`flue add sandbox <url>`, where the URL is the provider's docs and the coding
agent works the rest out. Its own framing: *"There's no fixed procedure for
getting there — your provider's shape will dictate most of how you implement
it."*

Each generated file carries a version marker (`// flue-blueprint: sandbox/daytona@1`),
and `flue update` re-fetches the guide, diffs intent, and asks the agent to
apply only the relevant changes while preserving customisations.

## 2. What is genuinely good about this

Worth stating plainly, because the design below has to keep it.

- **Near-zero maintenance for the framework.** Thirty-nine integrations, no
  runtime code to keep working when a provider changes an SDK. Nothing in
  `packages/` breaks when Daytona ships a major version.
- **The long tail is covered.** `flue add sandbox <url>` handles a provider
  nobody has heard of. A curated adapter list can never do this, and any design
  that drops the capability is worse for the user who has the unusual provider.
- **The adapter is the user's.** It lives in their repo, they can edit it, and
  nobody waits on a PR to a framework they do not own.
- **An update path exists.** The marker plus a refreshed guide is a real
  mechanism, not a hand-wave.

## 3. Where it costs

**The generated adapter is only as good as one LLM pass over provider docs, and
nothing checks it.** Their own worked example shows the failure mode:

```ts
// Daytona adapter, from the blueprint, written verbatim into the user's project
return { stdout: response.result ?? '', stderr: '', exitCode: response.exitCode ?? 0 }
```

`stderr` is hard-coded empty, because Daytona's SDK merges the streams. That is
an honest limitation honestly commented — but it is invisible to the contract.
Nothing in Flue can tell a user that their sandbox silently discards stderr, and
no test anywhere asserts otherwise. A tool that reports "command failed" with an
empty reason is a genuinely bad day, and the loss is one line inside a file the
user was told to *"write verbatim. Do not 'improve' it."*

The rest follows from the same root:

- **Bug fixes do not propagate.** Every user has their own copy. A fix to the
  Daytona adapter helps whoever regenerates.
- **No conformance test exists.** `implements SandboxDriver` gets you shape, not
  semantics: does `rm` on a missing path throw or succeed? does `exec` honour
  the timeout? does `readdir` return names or paths? The contract is prose.
- **The contract is Promise-shaped.** Errors are thrown and untyped,
  cancellation is an `AbortSignal` the adapter forwards *if the provider has a
  real primitive*, and lifetime is informal — `createSandbox()` returns a
  sandbox and the docs say the user owns the lifecycle.
- **`exec` takes a shell string.** `exec(command: string, …)`, with Flue's
  default being an in-memory "just-bash". Composing a command therefore means
  composing a string, with every quoting hazard that implies.

## 4. The asymmetry that changes the answer

**Two of Flue's four blueprint kinds do not need adapters here at all**, because
the platform layer is Effect rather than a bespoke runtime.

| Flue kind | providers | our position |
| --- | --- | --- |
| `database` | postgres, mysql, libsql, turso, supabase | **Effect ships these.** `@effect/sql-pg`, `-mysql2`, `-libsql`, `-d1`, `-sqlite-node`, `-sqlite-bun`, `-clickhouse`, `-mssql`, all at `4.0.0-rc.112`. Turso is libsql; Supabase is Postgres. A store speaks `SqlClient`; the driver is a dependency, not an adapter. |
| `database` | mongodb, redis, valkey | genuinely absent — not SQL, would need real adapters, and both are plausibly out of scope for a session store |
| `tooling` | sentry, braintrust, vitest-evals | **mostly free.** `/observability` is built on Effect's tracer and `Metric`; any OTLP backend is configuration. Evals are `/evals`. |
| `sandbox` | 10 providers | a real seam — `SandboxProvider` — with two implementations (`local`, `memory`) |
| `channel` | 17 providers | a real seam — `/connectors`, one implementation (Slack) |

So the surface that actually needs an integration story is **sandboxes and
channels**, roughly 27 of the 39, and both already have a typed seam here.

## 5. The seam is already better; that is the thing to build on

`Sandbox` (`src/sandbox/Sandbox.ts:227`) against Flue's `SandboxDriver`:

| | Flue | here |
| --- | --- | --- |
| errors | thrown, untyped | `FileError` / `ExecError` — unions of `Schema.TaggedError` (`FileMissingError`, `PermissionDeniedError`, `CommandLaunchError`, `ExitStatusError`, `TimeoutError`, `OutputLimitError`, `ProviderError`) |
| paths | `string` | `SandboxPath`, branded, constructed through `path()` which rejects escapes |
| commands | `exec(command: string, …)` | `Command { executable, args }` — *"never interpreted by a shell"* |
| cancellation | `AbortSignal`, forwarded when the provider supports it | fiber interruption, uniformly |
| lifetime | `createSandbox()`; the user owns it | `acquire(workspace)` is `Scope`-bound — closing the scope releases everything |
| output bounds | none | `maxOutputBytes`, default 1 MiB, `OutputLimitError` when exceeded |
| file identity | none | `canonical(path)` — the identity a write lock keys on, so two spellings of one file cannot race |
| signals | not represented | `CommandResult.signal`, because a `-1` exit code alone cannot say what happened |

Nothing here needs redesigning. What is missing is everything *around* the seam:
a way to prove an adapter honours it, a cheap way to write one, and a story for
providers we will never ship.

## 6. Design — shrink the residue until codegen is ceremony

Flue generates because their per-provider residue is ~300 lines. Nothing forces
that number. The Daytona adapter is long because the *author* must supply a
class, error guarding (`this.guarded(...)`), path handling, lifecycle, timeout
conversion and abort plumbing — all of it identical across providers, none of it
provided by the framework.

If the library absorbs everything that is the same, what is left is a mapping
from eight operations onto one SDK. At twenty lines, the whole blueprint
apparatus — a guide index, version markers, an `update` command diffing intent,
a per-provider Markdown file to maintain — is machinery for managing generated
code that no longer exists.

So: **no generator, no blueprints, no markers.** Three ways to supply a
provider, each smaller than the last, all validated by one suite.

### 6.1 A shipped conformance suite

The load-bearing piece, and the one Flue has no counterpart to. `/testing`
exports a suite any `SandboxProvider` must pass:

```ts
import { SandboxConformance } from "@doeixd/effect-agent/testing"

SandboxConformance.suite("daytona", DaytonaProviderLayer)
```

It asserts the semantics prose cannot: `rm` on a missing path with and without
`force`; `mkdir` non-recursive on a missing parent; `stat` on a symlink;
`readdir` ordering, and whether entries are names or paths; `exec` honouring
`timeout` and producing `TimeoutError` rather than hanging; `maxOutputBytes`
producing `OutputLimitError` with output preserved up to the bound; a non-zero
exit being an ordinary result, not a failure; `canonical` agreeing across two
spellings of one file; interruption actually stopping a running command;
arguments containing spaces, quotes and `$` surviving intact; and — the Daytona
case — whether stderr is genuinely separate from stdout.

**Capabilities are probed, not declared.** My first sketch had the author write
`{ separateStderr: false }`. That is a claim, and claims are exactly what failed
in Flue's Daytona adapter. Instead the suite *derives* a capability report by
running probes — write to stderr and see whether it arrives separately — and a
provider that also declares its capabilities must agree with what the probe
found, or the suite fails. Declaration becomes checked metadata rather than
trusted metadata.

The derived report is a value the harness can read, so `/coding` can say "this
sandbox does not separate stderr" instead of a tool returning a failure with an
empty reason.

### 6.2 Tier 0 — `fromExec`: a provider is one function

Most file operations are expressible as commands. So the minimum viable
provider is **one function**:

```ts
const provider = Sandbox.fromExec((cmd, opts) => Effect<CommandResult, ...>)
```

`fromExec` derives `read`, `write`, `list`, `stat`, `mkdir`, `rm` and
`canonical` from POSIX commands over that one primitive, and hands back a
provider that passes the suite. Any provider that can run a command — an SSH
host, a container `exec`, a CI runner, a remote agent — becomes a sandbox in one
expression, with no file written to the user's repo.

The costs are real and must be stated rather than discovered:

- **Binary content needs base64 framing**, so reads and writes cost extra bytes
  and a round trip through the shell.
- **It assumes a POSIX-ish userland** — `cat`, `ls`, `mkdir`, `rm`, `stat`,
  `readlink`. A Windows container needs tier 1.
- **Errors arrive as exit codes and stderr text**, so `FileMissingError` versus
  `PermissionDeniedError` is a classification of strings. `fromExec` takes a
  `classify` function with a sane POSIX default.
- **It is slower** — one process per file operation.
- **Large files should not go through it.**

That is a deliberate trade: correct and immediate, with a documented path to
faster. The suite proves the correctness half; the notes above are the honest
other half, and `fromExec`'s derived capability report says which operations are
shell-derived so nothing pretends otherwise.

### 6.3 Tier 1 — `fromOperations`: override what the provider does natively

Most SDKs have real file APIs, and using them is both faster and better-typed
than shelling out. So tier 1 is tier 0 with overrides:

```ts
const provider = Sandbox.fromOperations({
  exec:      (cmd, o) => daytona.process.executeCommand(render(cmd), o.cwd, o.env, seconds(o.timeout)),
  readFile:  (p)      => daytona.fs.downloadFile(p),
  writeFile: (p, c)   => daytona.fs.uploadFile(c, p),
  readdir:   (p)      => daytona.fs.listFiles(p),
  // stat, mkdir, rm, canonical: omitted, derived from exec
}, { classify })
```

Everything omitted falls back to the tier-0 derivation. The library owns `Scope`
binding, `timeout` → `TimeoutError`, output bounding → `OutputLimitError`,
interruption wired to the provider's `AbortSignal` when it has one, path
branding, and error classification. **The residue is the object literal above.**

That is the whole argument against codegen: twenty lines a person writes in five
minutes, or an LLM writes in one message without any blueprint infrastructure,
because a mistake in twenty lines is caught by a suite that already exists.

Compare Flue's Daytona adapter — ~250 lines of class, guard wrapper, and
lifecycle — for the same provider.

### 6.4 Tier 2 — declarative bindings, where they actually apply

Where a provider's exec and filesystem surface *is* plain HTTP, it can be a
value rather than code, reusing the request-binding machinery
[research-tool-sources.md](./research-tool-sources.md) §6.3 already needs for
OpenAPI tools. One binder serves both; a provider becomes a config object.

**This applies less often than it first appears, and the plan should not
oversell it.** E2B publishes a 126 KB OpenAPI spec, and its paths are
`/sandboxes`, `/sandboxes/{id}/pause`, `/resume`, `/fork`, `/snapshots` —
**control plane only**. The actual exec and filesystem surface runs over a
separate in-sandbox protocol the spec does not describe. Daytona publishes no
spec at that path at all.

So tier 2 is opportunistic: worth building *after* the tool-source binder exists
and only for providers whose relevant surface is genuinely REST. Tiers 0 and 1
are what remove codegen.

### 6.5 First-party providers only where CI proves them

`local` and `memory` ship. Beyond that, a provider belongs in `src/` only when
CI exercises it against the real service. Anything else lives in the user's
project as twenty lines — not because we cannot write it, but because an
untested provider in `src/` is a *worse* promise than one the user owns: it
looks maintained.

What we ship instead of adapters is **documentation plus types**: a page per
known provider with the tier-1 object literal, kept honest by the same suite.
A snippet in a doc that goes stale is a five-line fix; a generated file in a
thousand user repos is not.
## 7. Channels, the same shape

`/connectors` has one implementation (Slack) and Flue has seventeen. The
structure is the same but the conformance suite asserts different things:
signature verification with a known-good and a known-bad payload, replay-window
rejection, idempotency on redelivery, ordering, threading identity, and
attachment handling.

Two properties are worth designing for explicitly, because they are where
channel adapters actually break:

- **Verification is not optional and not pluggable-away.** The Slack verifier is
  already Web Crypto and portable; a generated adapter must not be able to
  satisfy the seam without implementing it. Make it a required member, not a
  hook.
- **Ingress is untrusted input.** Everything arriving from a channel is
  attacker-influenced text, and the conformance suite should include a
  hostile-payload case.

## 8. Deployment is not an adapter

Flue has no `deployment` blueprint kind, and that is correct: their deployment
story is that the runtime is host-agnostic and the CLI builds for Node,
Cloudflare, GitHub Actions and so on.

Here the equivalent already exists and is more precise: concrete hosts arrive as
**Layers at the application edge**, and `verify-portability.mjs` enforces that
portable source never couples to one. So "deployment integrations" reduce to two
things that are not adapters:

1. **An entry point per host** — what `apps/cli` is for Node. A Cloudflare
   Worker entry and a GitHub Action entry are small, and each is a genuine
   compatibility test of the portability guardrail: if a host entry cannot be
   written without reaching into `node:*`, the guardrail found something.
2. **Configuration** — `Config` / `Redacted`, plus whatever the host uses for
   secrets.

Worth stating as a non-goal: **no hosted runtime, no control plane, no deploy
command that provisions infrastructure.** That is a product, per
[plan-primitives.md](./plan-primitives.md) §2.

## 9. Invariants

1. **A seam member is required or it does not exist.** Optional-by-convention
   members (Flue's `signal`) become adapters that silently do nothing.
2. **Capabilities are probed, not claimed.** A provider's capability report is
   derived by the suite. A provider may declare its capabilities, but a
   declaration that disagrees with the probe is a test failure. `stderr: ''`
   must be impossible to hide.
3. **Every provider passes the same suite** — first-party, hand-written,
   `fromExec`-derived, declaratively bound. Indistinguishable to the tests.
4. **The residue stays small enough not to need generating.** If supplying a
   provider grows past a screenful, the library has stopped absorbing something
   it should. That is a bug in `fromOperations`, not a reason to add a
   generator.
5. **The typed contract does not soften to make providers easier.** The lifts
   absorb the friction — per `AGENTS.md`, the library absorbs type friction so
   callers never see it. Widening `Sandbox` to fit an awkward provider is the
   wrong direction.
6. **Derived operations say they are derived.** A `fromExec` file read is
   slower, base64-framed and POSIX-dependent; the capability report records
   that, so nothing silently assumes native behaviour.
7. **Providers needing a host live behind their own entry point**, as
   `sandbox/local.ts` does.
8. **No provider in `src/` that CI does not exercise.** Document it instead.

## 10. Success conditions

- [x] `SandboxConformance` exists (2026-08-30; `cases` + `run` rather than a
      vitest-bound `suite`, because `@effect/vitest` is a dev dependency), runs
      against `memory` and `local` in CI, and **fails against a deliberately
      broken provider** — `test/SandboxConformance.test.ts` breaks stderr
      separation, `timeout` and path-vs-name at once and asserts exactly those
      three cases fail, with the diagnosis each names.
- [x] The suite emits a **derived capability report**
      (`Report.capabilities`), taken from which exec probes held; the broken
      provider's report reads `separateStderr: false, timeout: false`.
- [ ] `Sandbox.fromExec` turns a single `exec` function into a provider that
      passes the suite, with its derived operations marked as derived.
- [ ] `Sandbox.fromOperations` expresses a real remote provider (E2B or Daytona)
      in **under 30 lines**, with no casts at the call site, passing the suite.
      If it cannot, invariant 4 has been violated and the lift needs work — that
      finding is more valuable than the adapter.
- [ ] Flue's ~250-line Daytona adapter is reproduced in tier 1, and the
      line-count difference is recorded in `STATUS.md`.
- [ ] `ChannelConformance.suite` exists with the hostile-payload and
      replay-window cases, and Slack passes it.
- [ ] A Cloudflare Worker entry point runs an agent, or the attempt produces a
      written finding about the portability guardrail.
- [ ] `npm run check` stays green; `lint:portability` unchanged.

## 11. Sequence

1. **`SandboxConformance`**, against `memory` and `local`, with the derived
   capability report. Break it once against a deliberately wrong provider.
   Everything else depends on it existing.
2. **`Sandbox.fromExec`**, validated by building a provider from `local`'s
   `exec` alone and passing the suite. If the derivation cannot reproduce a
   provider we already have, it is wrong.
3. **`Sandbox.fromOperations`**, then rebuild `local` on top of it — the same
   test, one layer up.
4. **One real remote provider in tier 1.** This is where invariant 4 gets
   measured against reality, and where the residue's true size is discovered
   rather than assumed.
5. **`ChannelConformance`**, and a second channel to prove the suite generalises
   past Slack.
6. **A non-Node entry point**, as a portability test.
7. **Tier 2**, only after the tool-source request binder exists
   ([research-tool-sources.md](./research-tool-sources.md) §6.3) and only for a
   provider whose exec/filesystem surface is genuinely REST.

Steps 1–3 are independent of the tool-source work and can run alongside it.

## 12. Notes and open questions

- **The conformance suite is the whole bet.** It is what lets us match Flue's
  reach without matching its maintenance burden, and what makes a hand-written
  twenty-line provider trustworthy. If it is thin, this plan degrades into "Flue
  with more types".
- **The anti-codegen claim is falsifiable, and step 4 falsifies it.** If a real
  provider cannot be expressed in tier 1 in a screenful, then Flue's ~300-line
  residue was not an artefact of their framework and a generator becomes worth
  reconsidering. Measure before concluding.
- **`exec` takes argv and providers take strings.** Most remote sandbox SDKs
  accept a shell string, so the lifts must render `Command` into one. That
  rendering is `/shell`'s job, it is already dialect-aware, and it must be
  quoting-correct rather than a `join(" ")`. It is also the single most likely
  place to introduce an injection bug, which is why the suite carries a case
  with arguments containing spaces, quotes and `$`. `fromExec` compounds this:
  every derived file operation is a rendered command, so a quoting bug there
  becomes a path-injection bug.
- **Capability flags will want to grow.** `separateStderr` is obvious; then
  someone wants `supportsSymlinks`, `supportsSignals`, `preservesMtime`. The
  bar: a capability exists when the harness or a toolkit **changes behaviour**
  because of it, not merely to document a difference.
- **Tier 2 is narrower than it looks.** E2B's published OpenAPI spec is control
  plane only — `/sandboxes`, `/pause`, `/resume`, `/fork`, `/snapshots` — and
  the exec/filesystem surface runs over a separate in-sandbox protocol. Daytona
  publishes no spec at the obvious path. Provisioning may be declaratively
  bindable long before the operations `Sandbox` needs are.
- **What we ship instead of adapters is documentation.** That has its own
  failure mode — a stale snippet — but a stale doc is a five-line fix, whereas a
  wrong generated file in a thousand repos is not.
- **Mongo and Redis have no Effect SQL story**, so §4's "already solved" claim
  covers five of the eight database blueprints, not all of them. Whether a
  non-SQL store is in scope at all is a separate question.
- **Flue's providers will drift.** Their blueprint list changed while these
  documents were written. Mirror the *shape* — sandbox, channel, store, tooling
  — and never track their provider list.

## Related

- [plan-primitives.md](./plan-primitives.md) — the three axes, and why hosted
  products are out of scope.
- [research-tool-sources.md](./research-tool-sources.md) — the other integration
  axis: tools, not infrastructure. §7's credential layers apply to provider
  secrets here too.
- `flue.md` — the capability correspondence this builds on.

## Sources

- [withastro/flue](https://github.com/withastro/flue) — `blueprints/README.md`
  (the blueprint contract and the four kinds), `blueprints/sandbox.md` (the
  generic guide), `blueprints/sandbox--daytona.md` (the worked example,
  including the `stderr: ''` line), `packages/` (the 27 provider packages), read
  2026-08-27.
- [Flue docs](https://flueframework.com) — `flue add` / `flue update` and the
  blueprint routes.
- npm — `@effect/sql-*` at `4.0.0-rc.112`, verified 2026-08-27.
- This repo: `src/sandbox/Sandbox.ts`, `src/connectors/`, `src/shell/Shell.ts`,
  `scripts/verify-portability.mjs`.
