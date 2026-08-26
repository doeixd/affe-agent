# Evaluation: should `sandbox/local` use Effect platform services?

**Decision (2026-08-26): retain the current narrow Node adapter. Re-evaluate
after the two semantic gaps below close; do not add a second adapter today.**

This closes E9/A-5 from
[audit-effect-ecosystem.md](./audit-effect-ecosystem.md). The question was
whether `effect/FileSystem`, `effect/Path` and `effect/unstable/process` could
replace the Node-specific implementation in `src/sandbox/local.ts`, or cheaply
support a second provider behind the portable `Sandbox` seam.

## What fits

Effect's platform surface covers most of the ordinary mechanics:

- `FileSystem` reads, writes, lists, stats, resolves real paths and owns
  temporary directories through a scope;
- `Path` supplies portable path manipulation;
- `ChildProcessSpawner` starts argv commands without a shell, exposes stdout
  and stderr as streams, waits for exit and kills on scope interruption;
- the Node spawner creates POSIX process groups and uses `taskkill /T` on
  Windows, with an optional force-kill delay.

Those are real overlaps. They are not enough to preserve the sandbox contract.

## Gap 1: a successful parent can leave inherited pipes open

`sandbox/local` treats the direct child exiting and its stdio closing as two
different observations. After the child exits it gives the streams a short
grace period, then kills the process tree and returns the captured result. This
handles a successful command that starts a detached descendant which inherits
stdout or stderr: the descendant cannot keep `exec` open or outlive the
sandbox. `test/Sandbox.test.ts`, “a descendant holding the pipes cannot keep a
finished command open”, pins this behavior.

The current Node `ChildProcessSpawner` cleans the process group after a
non-zero exit and when a live handle's scope closes. If the direct child has
already exited successfully, its release path does not kill the remaining
group. Collecting a pipe can therefore wait on the descendant indefinitely.
The public handle also reports an exit code, not the terminating signal, while
`Sandbox.CommandResult` deliberately distinguishes those observations.

Replacing the implementation would either regress a tested ownership guarantee
or require another host-specific wrapper around the process service. The latter
would add the ecosystem primitive beside the code it was meant to delete,
violating audit invariant A1.

## Gap 2: the portable filesystem surface cannot express the path proof

The workspace boundary walks to the deepest existing ancestor with `lstat`,
stops on a symlink (including a dangling one), resolves that anchor with
`realpath.native`, verifies it is inside the canonical root, and performs the
operation through that checked canonical spelling.

`FileSystem` exposes `stat`, `readLink` and `realPath`, but not `lstat`.
`stat` follows a symlink, which is exactly the wrong operation for detecting a
dangling link before a write. The Node implementation of `FileSystem.realPath`
also uses `fs.realpath`, not `fs.realpath.native`; the native form is required
here to normalize Windows case and 8.3 short-name aliases before containment
and canonical-lock comparisons.

A platform-backed rewrite would therefore need a new capability for these two
operations or would weaken the symlink-escape and one-file-one-identity
invariants. Neither is acceptable merely to remove imports from an entry that
is intentionally host-specific.

## Why there is no second adapter

A second provider is useful only if it implements the same `Sandbox` contract.
An adapter that is portable across process implementations but differs on
descendant cleanup or workspace containment would make the provider choice a
hidden correctness policy. Keeping one honest host adapter is cheaper and
safer than publishing two adapters with different guarantees.

## Revisit trigger

Re-evaluate when both are available through Effect's public services:

1. process-group cleanup after a successful direct child exits while a
   descendant still owns its pipes, including the terminating signal; and
2. filesystem operations equivalent to `lstat` and native canonicalization on
   Windows.

Any future spike starts by running the existing `test/Sandbox.test.ts` contract
unchanged against the candidate provider. Adoption lands only if it deletes the
manual process/filesystem machinery while keeping that suite green.
