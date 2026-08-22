import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as nodePath from "node:path"
import { Effect, Layer, Option, Scope } from "effect"
import * as Sandbox from "./Sandbox.js"

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
            (dir) => Effect.ignore(Effect.promise(() =>
              fs.rm(dir, { recursive: true, force: true })
            ))
          )
          : Effect.succeed(existingRoot)

      const toFileError = (
        cause: unknown,
        target: Sandbox.SandboxPath,
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

      const runProcess = (
        root: string
      ): Sandbox.Sandbox["exec"] =>
        (input, execOptions) =>
          Effect.callback((resume) => {
            const timeoutMs = Sandbox.timeoutMillis(execOptions)
            const maxOutputBytes =
              execOptions?.maxOutputBytes ?? 1024 * 1024

            let child: ReturnType<typeof spawn>
            try {
              child = spawn(input.executable, [...input.args], {
                cwd: root,
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
              })
            } catch (cause) {
              resume(Effect.fail(new Sandbox.CommandLaunchError({
                executable: input.executable,
                detail: String(cause)
              })))
              return
            }

            let settled = false
            let stdout = Buffer.alloc(0)
            let stderr = Buffer.alloc(0)

            const finish = (result: Effect.Effect<
              Sandbox.CommandResult,
              Sandbox.ExecError
            >) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resume(result)
            }

            // A bound that is enforced, not merely reported: the failure is
            // delivered only once the child has actually gone. Settling on
            // the kill signal alone would hand control back while the process
            // still runs — still writing, still holding its working
            // directory — and "bounded" would describe the wait, not the
            // work. A child that ignores SIGTERM is killed outright after a
            // grace period.
            let terminal: Effect.Effect<never, Sandbox.ExecError> | undefined
            let escalation: ReturnType<typeof setTimeout> | undefined
            const terminate = (failure: Sandbox.ExecError) => {
              if (terminal !== undefined || settled) return
              terminal = Effect.fail(failure)
              child.kill("SIGTERM")
              escalation = setTimeout(() => child.kill("SIGKILL"), 1000)
            }

            const timer = setTimeout(() => {
              terminate(new Sandbox.TimeoutError({
                executable: input.executable,
                timeoutMillis: timeoutMs
              }))
            }, timeoutMs)

            const append = (chunk: Buffer, isStdout: boolean) => {
              const next = Buffer.concat([isStdout ? stdout : stderr, chunk])
              if (isStdout) stdout = next
              else stderr = next
              if (
                stdout.byteLength + stderr.byteLength > maxOutputBytes &&
                !settled
              ) {
                terminate(new Sandbox.OutputLimitError({
                  executable: input.executable,
                  maxOutputBytes
                }))
              }
            }
            child.stdout?.on("data", (chunk: Buffer) => append(chunk, true))
            child.stderr?.on("data", (chunk: Buffer) => append(chunk, false))

            child.on("error", (cause) =>
              finish(Effect.fail(new Sandbox.CommandLaunchError({
                executable: input.executable,
                detail: String(cause)
              }))))
            child.on("close", (code) => {
              if (escalation !== undefined) clearTimeout(escalation)
              finish(
                terminal ??
                  Effect.succeed({
                    exitCode: code ?? -1,
                    stdout: stdout.toString("utf8"),
                    stderr: stderr.toString("utf8")
                  })
              )
            })
          })

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
            let anchor = resolved
            for (;;) {
              const exists = yield* Effect.promise(() =>
                fs.stat(anchor).then(() => true, () => false)
              )
              if (exists) break
              const parent = nodePath.dirname(anchor)
              if (parent === anchor) break
              anchor = parent
            }
            const anchorReal = yield* Effect.promise(() =>
              fs.realpath(anchor).catch(() => null)
            )
            if (anchorReal === null) {
              // The anchor existed moments ago; it has since been removed.
              return yield* new Sandbox.FileMissingError({ path: target })
            }
            const rootReal = yield* Effect.promise(() =>
              fs.realpath(root).catch(() => root)
            )
            const inside = anchorReal === rootReal ||
              anchorReal.startsWith(`${rootReal}${nodePath.sep}`)
            if (!inside) {
              return yield* new Sandbox.PermissionDeniedError({
                path: target,
                operation
              })
            }
            return resolved
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
                      const info = await fs.stat(
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
                      target ?? ("." as Sandbox.SandboxPath),
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
          exec: runProcess(root)
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
