import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as nodePath from "node:path"
import { Cause, Effect, Layer, Option, Queue, Scope, Stream } from "effect"
import * as Sandbox from "./Sandbox.js"

/** What the scope holds while a command runs, and how it ends it. */
interface Running {
  readonly kill: (signal: "SIGTERM" | "SIGKILL") => void
  readonly exited: () => boolean
  readonly child?: ReturnType<typeof spawn> | undefined
  readonly clear?: (() => void) | undefined
}

/**
 * A real directory on this machine.
 *
 * **This is not a security boundary.** It is a convenience for running
 * against actual files. Path resolution refuses anything that would escape
 * the workspace — absolute paths and `..` are already refused at
 * `Sandbox.path`, and a symlink that resolves outside the root is refused
 * here — commands run without a shell, and output is bounded. But the process
 * runs with this program's full privileges. Do not point it at an untrusted
 * workspace or hand untrusted parties command choice over it.
 *
 * Each acquired sandbox gets its own temporary directory under `root`
 * (default: the OS temp dir), removed when the acquiring scope closes. Pass
 * `workspaceRoot` to use an existing directory instead; nothing under it is
 * removed at close, because the scope only owns sandboxes it created.
 */
export const layer = (options?: {
  /** Parent of the per-acquisition temporary directories. Default: OS temp dir. */
  readonly root?: string | undefined
  /** Use this existing directory as every acquisition's workspace. */
  readonly workspaceRoot?: string | undefined
}): Layer.Layer<Sandbox.SandboxProvider> =>
  Layer.effect(
    Sandbox.SandboxProvider,
    Effect.gen(function* () {
      const base = options?.root ?? tmpdir()
      const existingRoot = options?.workspaceRoot

      const acquireDir = (
        workspace: Sandbox.Workspace
      ): Effect.Effect<
        string,
        Sandbox.ProviderError,
        Scope.Scope
      > =>
        existingRoot === undefined
          ? Effect.acquireRelease(
            Effect.tryPromise({
              try: () => fs.mkdtemp(nodePath.join(base, `sandbox-`)),
              catch: (cause) =>
                new Sandbox.ProviderError({
                  detail: `could not create the sandbox directory: ${String(cause)}`
                })
            }),
            (dir) =>
              // Windows releases a just-exited child's handles asynchronously,
              // so the first attempt can meet EBUSY; `rm` retries for exactly
              // that. A failure after that is logged rather than swallowed --
              // a silently accumulating temp directory is a leak nobody sees.
              Effect.promise(() =>
                fs.rm(dir, {
                  recursive: true,
                  force: true,
                  maxRetries: 5,
                  retryDelay: 100
                })
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("sandbox directory was not removed", {
                    dir,
                    cause
                  })
                )
              )
          )
          : // A root handed in is checked once: a missing one would otherwise
            // surface as a permission refusal on every operation, since its
            // `realpath` falls back to the raw string.
            Effect.try({
              try: () => realpathSync.native(existingRoot),
              catch: (cause) =>
                new Sandbox.ProviderError({
                  detail: `workspaceRoot is not usable: ${String(cause)}`
                })
            })

      const toFileError = (
        cause: unknown,
        target: string,
        operation: "read" | "write" | "list" | "stat"
      ): Sandbox.FileError => {
        const code = (cause as { code?: unknown }).code
        if (code === "ENOENT") {
          return new Sandbox.FileMissingError({ path: target })
        }
        if (code === "EACCES" || code === "EPERM") {
          return new Sandbox.PermissionDeniedError({
            path: target,
            operation
          })
        }
        return new Sandbox.ProviderError({ detail: String(cause) })
      }

      /**
       * One process implementation, streaming.
       *
       * `exec` used to spawn and buffer; now it is `collect` over this, so the
       * kill-the-whole-tree, timeout and output-limit machinery below has one
       * home instead of two that drift. Everything the buffered version
       * guaranteed still holds -- the differences are that output is delivered
       * as it arrives, and that the caller now decides whether to keep it.
       */
      const runProcessStream = (
        root: string
      ): Sandbox.Sandbox["execStream"] =>
        (input, execOptions) =>
          Stream.callback<Sandbox.ExecEvent, Sandbox.ExecError>((queue) =>
            Effect.acquireRelease(
              Effect.sync((): Running => {
                const timeoutMs = Sandbox.timeoutMillis(execOptions)
                const maxOutputBytes = execOptions?.maxOutputBytes ?? 1024 * 1024

                const fail = (error: Sandbox.ExecError) => {
                  Queue.failCauseUnsafe(queue, Cause.fail(error))
                }

                let child: ReturnType<typeof spawn>
                try {
                  child = spawn(input.executable, [...input.args], {
                    cwd: root,
                    shell: false,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                    // Its own process group on POSIX, so that ending the command
                    // ends everything it started. Killing only the direct child
                    // leaves a grandchild holding the stdio pipes -- `npm`, a
                    // shell with a background job -- and the command never
                    // closes. Windows has no groups; `taskkill /T` walks the tree.
                    detached: process.platform !== "win32"
                  })
                } catch (cause) {
                  fail(new Sandbox.CommandLaunchError({
                    executable: input.executable,
                    detail: String(cause)
                  }))
                  return { kill: () => {}, exited: () => true }
                }

                const started = child
                let settled = false
                let total = 0
                let terminal: Sandbox.ExecError | undefined
                const timers: Array<ReturnType<typeof setTimeout>> = []
                const later = (ms: number, run: () => void) => {
                  timers.push(setTimeout(run, ms))
                }

                const killTree = (signal: "SIGTERM" | "SIGKILL") => {
                  if (started.pid === undefined) return
                  if (process.platform === "win32") {
                    // No graceful signal exists on Windows; both phases end the
                    // whole tree. Two calls, in this order, and the order is
                    // the point.
                    //
                    // `taskkill /T` is the only way to reach *descendants*
                    // here, but it is a separate process this module spawns
                    // and cannot await, and it is not dependable: on a loaded
                    // machine it has been measured emitting neither `exit` nor
                    // `error` for more than eight seconds, and returning "this
                    // operation returned because the timeout period expired"
                    // when run synchronously. Leaving it as the only kill is
                    // what let a terminated command keep running for its full
                    // lifetime, holding its workspace open behind it
                    // (`docs/remaining-work.md` 26n).
                    //
                    // So end the command itself first, with the direct kill
                    // that is immediate and dependable (measured ~60ms), and
                    // then ask `taskkill` to reap whatever it started. A
                    // childless command -- almost all of them -- is now gone
                    // before `taskkill` has finished loading.
                    try {
                      started.kill()
                    } catch {
                      // Already gone; the tree sweep below still runs.
                    }
                    try {
                      spawn("taskkill", ["/pid", String(started.pid), "/T", "/F"], {
                        stdio: "ignore",
                        windowsHide: true
                      }).on("error", () => {})
                    } catch {
                      // `taskkill` missing or refused: the direct kill above
                      // already ended the command, and a descendant that
                      // outlives it is the documented Windows limitation.
                    }
                    return
                  }
                  try {
                    process.kill(-started.pid, signal)
                  } catch {
                    started.kill(signal)
                  }
                }

                const teardown = () => {
                  settled = true
                  for (const timer of timers) clearTimeout(timer)
                  started.stdout?.destroy()
                  started.stderr?.destroy()
                }

                const finish = (end: () => void) => {
                  if (settled) return
                  teardown()
                  end()
                }

                // A bound that is enforced, not merely reported: the failure is
                // delivered once the process is gone -- or, failing that, once a
                // hard deadline has passed. Ending the stream on the signal alone
                // would hand control back while the process still ran; waiting on
                // `close` alone could wait forever on a descendant that kept the
                // pipes open after the child died. So: SIGTERM, SIGKILL to the
                // tree after a grace period, and a deadline after which the
                // failure is delivered regardless, with the streams torn down.
                const terminate = (failure: Sandbox.ExecError) => {
                  if (terminal !== undefined || settled) return
                  terminal = failure
                  // Nothing more is emitted: a process ignoring its signal while
                  // flooding stdout must not turn the output bound into a memory
                  // bound that is not one.
                  started.stdout?.destroy()
                  started.stderr?.destroy()
                  killTree("SIGTERM")
                  later(1000, () => killTree("SIGKILL"))
                  later(2500, () => finish(() => fail(failure)))
                }

                later(timeoutMs, () => {
                  terminate(new Sandbox.TimeoutError({
                    executable: input.executable,
                    timeoutMillis: timeoutMs
                  }))
                })

                const append = (chunk: Buffer, isStdout: boolean) => {
                  if (terminal !== undefined || settled) return
                  Queue.offerUnsafe(
                    queue,
                    Sandbox.outputEvent(
                      isStdout ? "stdout" : "stderr",
                      new Uint8Array(chunk)
                    )
                  )
                  total += chunk.byteLength
                  if (total > maxOutputBytes) {
                    terminate(new Sandbox.OutputLimitError({
                      executable: input.executable,
                      maxOutputBytes
                    }))
                  }
                }
                started.stdout?.on("data", (chunk: Buffer) => append(chunk, true))
                started.stderr?.on("data", (chunk: Buffer) => append(chunk, false))

                started.on("error", (cause) =>
                  finish(() =>
                    fail(new Sandbox.CommandLaunchError({
                      executable: input.executable,
                      detail: String(cause)
                    }))
                  ))

                const done = (
                  code: number | null,
                  signal: NodeJS.Signals | null
                ) =>
                  () => {
                    if (terminal !== undefined) {
                      fail(terminal)
                      return
                    }
                    // A process ended by a signal the sandbox did not send -- the
                    // OOM killer, a kill from elsewhere -- is reported as such,
                    // not as an exit code a tool might have chosen.
                    Queue.offerUnsafe(
                      queue,
                      Sandbox.exitEvent(code ?? -1, signal ?? undefined)
                    )
                    Queue.endUnsafe(queue)
                  }

                // `exit` is the process being gone. `close` -- the streams ending
                // too -- normally follows within a tick; a descendant keeping the
                // pipes open is given a short grace, then the stream is ended
                // with whatever was read.
                started.on("exit", (code, signal) => {
                  later(250, () => {
                    // Something the command started is still holding its pipes
                    // after the command itself is gone. It belongs to nobody now
                    // and would outlive the sandbox -- and keep this process's
                    // own stdio alive with it. The command is over; so is its
                    // tree.
                    killTree("SIGKILL")
                    finish(done(code, signal))
                  })
                })
                started.on("close", (code, signal) => finish(done(code, signal)))

                return {
                  kill: killTree,
                  exited: () => settled,
                  child: started,
                  clear: teardown
                }
              }),
              // Scope closing -- the consumer stopped reading, its fibre was
              // interrupted, the run was interrupted mid-tool -- must not strand
              // the child. The tree is ended and release completes once the
              // process is gone or the deadline has passed, the same guarantee
              // the timeout path gives.
              (running) =>
                Effect.callback<void>((resume) => {
                  const child = running.child
                  if (running.exited() || child === undefined) {
                    resume(Effect.void)
                    return
                  }
                  running.clear?.()
                  let finished = false
                  const complete = () => {
                    if (finished) return
                    finished = true
                    clearTimeout(force)
                    clearTimeout(deadline)
                    resume(Effect.void)
                  }
                  child.once("exit", complete)
                  running.kill("SIGTERM")
                  const force = setTimeout(() => running.kill("SIGKILL"), 1000)
                  const deadline = setTimeout(complete, 2500)
                })
            )
          )

      const makeSandbox = (
        workspace: Sandbox.Workspace,
        root: string
      ): Sandbox.Sandbox => {
        // Resolve a validated relative path against the workspace, refusing a
        // symlink that anchors outside it. Walking up to the deepest existing
        // ancestor lets writes create new files while still checking escapes.
        const resolveWithin = (
          target: Sandbox.SandboxPath,
          operation: "read" | "write" | "list" | "stat"
        ): Effect.Effect<string, Sandbox.FileError> =>
          Effect.gen(function* () {
            const resolved = nodePath.resolve(root, target)
            // `lstat`, not `stat`: the walk must stop at a symlink itself,
            // including a dangling one. `stat` follows the link, and a link
            // whose target does not exist yet looks like a missing path —
            // the walk would step past it to its parent, the check would
            // pass, and the write would then follow the link out of the
            // workspace and create the target.
            let anchor = resolved
            for (;;) {
              const exists = yield* Effect.promise(() =>
                fs.lstat(anchor).then(() => true, () => false)
              )
              if (exists) break
              const parent = nodePath.dirname(anchor)
              if (parent === anchor) break
              anchor = parent
            }
            // `realpath.native` on both sides: the JS implementation does not
            // canonicalise case or 8.3 short names on Windows, and a
            // workspace under `PATRIC~1` compared against a link target
            // spelled `Patrick` was refused as an escape it was not.
            const anchorReal = yield* Effect.sync(() => {
              try {
                return realpathSync.native(anchor)
              } catch {
                return null
              }
            })
            if (anchorReal === null) {
              // Either the anchor was removed since the walk, or it is a
              // dangling link. Neither is a path this workspace can vouch
              // for, and a dangling link is exactly the escape above.
              return yield* new Sandbox.PermissionDeniedError({
                path: target,
                operation
              })
            }
            const rootReal = yield* Effect.sync(() => {
              try {
                return realpathSync.native(root)
              } catch {
                return root
              }
            })
            const inside = anchorReal === rootReal ||
              anchorReal.startsWith(`${rootReal}${nodePath.sep}`)
            if (!inside) {
              return yield* new Sandbox.PermissionDeniedError({
                path: target,
                operation
              })
            }
            // The operation runs on the path that was checked — the real
            // anchor plus whatever does not exist yet — not on the original
            // spelling, so a link swapped in under the checked prefix after
            // this point is not followed by the check's authority.
            const remainder = nodePath.relative(anchor, resolved)
            return remainder === "" ? anchorReal : nodePath.join(anchorReal, remainder)
          })

        return {
          workspace,
          read: (target) =>
            resolveWithin(target, "read").pipe(
              Effect.flatMap((resolved) =>
                Effect.tryPromise({
                  try: () => fs.readFile(resolved),
                  catch: (cause) => toFileError(cause, target, "read")
                })
              )
            ),
          write: (target, content) =>
            resolveWithin(target, "write").pipe(
              Effect.flatMap((resolved) =>
                Effect.tryPromise({
                  try: async () => {
                    await fs.mkdir(nodePath.dirname(resolved), { recursive: true })
                    await fs.writeFile(resolved, content)
                  },
                  catch: (cause) => toFileError(cause, target, "write")
                })
              )
            ),
          list: (target) =>
            (target === undefined
              ? Effect.succeed(root)
              : resolveWithin(target, "list")
            ).pipe(
              Effect.flatMap((resolved) =>
                Effect.tryPromise({
                  try: async () => {
                    const dirents = await fs.readdir(resolved, {
                      withFileTypes: true,
                      ...(target === undefined ? {} : {})
                    })
                    const prefix =
                      target === undefined ? "" : `${target}/`
                    const entries: Array<Sandbox.Entry> = []
                    for (const dirent of dirents.sort((a, b) =>
                      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
                    )) {
                      const relative = `${prefix}${dirent.name}`
                      if (dirent.isDirectory()) {
                        entries.push({
                          path: relative as Sandbox.SandboxPath,
                          type: "directory",
                          size: Option.none()
                        })
                        continue
                      }
                      // A symlink is listed by name and nothing more. Sizing
                      // it with `stat` would follow the link and report the
                      // target's metadata -- for a link pointing outside the
                      // workspace, the size of a file `read` will refuse.
                      const info = dirent.isSymbolicLink()
                        ? null
                        : await fs.stat(
                          nodePath.join(resolved, dirent.name)
                        ).then(
                          (value) => value.size,
                          () => null
                        )
                      entries.push({
                        path: relative as Sandbox.SandboxPath,
                        type: "file",
                        size: info === null ? Option.none() : Option.some(info)
                      })
                    }
                    return entries
                  },
                  catch: (cause) =>
                    toFileError(
                      cause,
                      // The workspace root, which is not a `SandboxPath` -- that type
                      // names a file, and this names the directory being listed.
                      target ?? "(workspace root)",
                      "list"
                    )
                })
              )
            ),
          stat: (target) =>
            resolveWithin(target, "stat").pipe(
              Effect.flatMap((resolved) =>
                Effect.tryPromise({
                  try: async () => {
                    const info = await fs.stat(resolved)
                    return {
                      path: target,
                      type: info.isDirectory()
                        ? ("directory" as const)
                        : ("file" as const),
                      size: info.isDirectory()
                        ? Option.none<number>()
                        : Option.some(info.size)
                    }
                  },
                  catch: (cause) => toFileError(cause, target, "stat")
                })
              )
            ),
          // `resolveWithin` already is the canonical name: the real path of
          // the deepest existing ancestor plus whatever does not exist yet.
          canonical: (target) => resolveWithin(target, "stat"),
          exec: (input, execOptions) =>
            Sandbox.collect(runProcessStream(root)(input, execOptions)),
          execStream: runProcessStream(root)
        }
      }

      return {
        acquire: (workspace) =>
          Effect.map(acquireDir(workspace), (dir) =>
            makeSandbox(workspace, dir)
          )
      }
    })
  )
