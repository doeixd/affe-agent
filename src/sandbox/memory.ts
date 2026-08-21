import { Effect, Layer, Option, Ref } from "effect"
import * as Sandbox from "./Sandbox.js"

/**
 * A deterministic in-memory provider.
 *
 * Files live in a map keyed by workspace, shared by every sandbox acquired
 * from this layer instance — the same model as a real filesystem, so tests
 * that acquire twice see one world. There is no process runner: `exec` fails
 * with a provider error unless an executor is supplied, which is how tests
 * script command results without touching a real process.
 */
export const layer = (options?: {
  /** Files present in every workspace at acquisition. */
  readonly seed?: Readonly<Record<string, string | Uint8Array>> | undefined
  /**
   * Scripted command execution. Receives the exact command value; returning
   * its result verbatim is what lets tests assert executable and arguments.
   */
  readonly exec?: Sandbox.Sandbox["exec"] | undefined
}): Layer.Layer<Sandbox.SandboxProvider> =>
  Layer.effect(
    Sandbox.SandboxProvider,
    Effect.gen(function* () {
      const worlds = yield* Ref.make(
        new Map<string, Map<string, Uint8Array>>()
      )

      const worldFor = (workspace: Sandbox.Workspace) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(worlds)).get(workspace)
          if (existing !== undefined) return existing
          const fresh = new Map<string, Uint8Array>()
          for (const [key, value] of Object.entries(options?.seed ?? {})) {
            fresh.set(
              key.replaceAll("\\", "/"),
              typeof value === "string" ? new TextEncoder().encode(value) : value
            )
          }
          yield* Ref.update(worlds, (all) => new Map(all).set(workspace, fresh))
          return fresh
        })

      const parentDirectories = (path: string): Array<string> => {
        const segments = path.split("/").slice(0, -1)
        return segments.map((_, index) =>
          segments.slice(0, index + 1).join("/")
        )
      }

      const entryFor = (
        world: Map<string, Uint8Array>,
        path: string
      ): Sandbox.Entry | undefined => {
        const file = world.get(path)
        if (file !== undefined) {
          return {
            path: path as Sandbox.SandboxPath,
            type: "file",
            size: Option.some(file.byteLength)
          }
        }
        for (const key of world.keys()) {
          if (key.startsWith(`${path}/`)) {
            return {
              path: path as Sandbox.SandboxPath,
              type: "directory",
              size: Option.none()
            }
          }
        }
        return undefined
      }

      const sandboxFor = (workspace: Sandbox.Workspace): Sandbox.Sandbox => ({
        workspace,
        read: (path) =>
          Effect.flatMap(worldFor(workspace), (world) =>
            Effect.suspend(() => {
              const file = world.get(path)
              return file === undefined
                ? Effect.fail(new Sandbox.FileMissingError({ path }))
                : Effect.succeed(file)
            })
          ),
        write: (path, content) =>
          Effect.flatMap(worldFor(workspace), (world) =>
            Effect.sync(() => {
              world.set(
                path,
                typeof content === "string"
                  ? new TextEncoder().encode(content)
                  : content
              )
              for (const directory of parentDirectories(path)) {
                // Directories are implicit; nothing to record.
                void directory
              }
            })
          ),
        list: (path) =>
          Effect.flatMap(worldFor(workspace), (world) =>
            Effect.gen(function* () {
              if (path !== undefined) {
                const target = entryFor(world, path)
                if (target === undefined) {
                  return yield* new Sandbox.FileMissingError({ path })
                }
              }
              const prefix = path === undefined ? "" : `${path}/`
              const entries = new Map<string, Sandbox.Entry>()
              for (const [key, bytes] of world) {
                if (!key.startsWith(prefix)) continue
                const rest = key.slice(prefix.length)
                const first = rest.split("/")[0]
                if (first === undefined) continue
                const full = prefix === "" ? first : `${prefix}${first}`
                if (rest.includes("/")) {
                  entries.set(full, {
                    path: full as Sandbox.SandboxPath,
                    type: "directory",
                    size: Option.none()
                  })
                } else {
                  entries.set(key, {
                    path: key as Sandbox.SandboxPath,
                    type: "file",
                    size: Option.some(bytes.byteLength)
                  })
                }
              }
              return Array.from(entries.values()).sort((a, b) =>
                a.path < b.path ? -1 : a.path > b.path ? 1 : 0
              )
            })
          ),
        stat: (path) =>
          Effect.flatMap(worldFor(workspace), (world) =>
            Effect.suspend(() => {
              const found = entryFor(world, path)
              return found === undefined
                ? Effect.fail(new Sandbox.FileMissingError({ path }))
                : Effect.succeed(found)
            })
          ),
        exec: options?.exec ?? ((input) =>
          Effect.fail(new Sandbox.ProviderError({
            detail:
              `the in-memory sandbox does not run processes; supply an exec script to run "${input.executable}"`
          })))
      })

      return {
        acquire: (workspace) =>
          Effect.map(worldFor(workspace), () => sandboxFor(workspace))
      }
    })
  )
