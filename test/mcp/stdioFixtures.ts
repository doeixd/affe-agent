import { Effect } from "effect"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { watch } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type ServerGeneration = "v1" | "v2"

export interface StdioFixture {
  readonly server: {
    readonly command: string
    readonly args: Array<string>
    readonly stderr: "pipe"
  }
  readonly events: Effect.Effect<ReadonlyArray<string>>
  readonly waitFor: (
    predicate: (events: ReadonlyArray<string>) => boolean
  ) => Effect.Effect<ReadonlyArray<string>>
}

export interface LifecycleFixture {
  readonly directory: string
  readonly events: Effect.Effect<ReadonlyArray<string>>
  readonly waitFor: (
    predicate: (events: ReadonlyArray<string>) => boolean
  ) => Effect.Effect<ReadonlyArray<string>>
}

const fixtureDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url))

const loadEvents = async (directory: string): Promise<ReadonlyArray<string>> => {
  const files = await readdir(directory)
  const logs = await Promise.all(
    files
      .filter((file) => file.endsWith(".log"))
      .sort()
      .map((file) => readFile(join(directory, file), "utf8"))
  )
  return logs.flatMap((log) =>
    log.split("\n").filter((event) => event.length > 0)
  )
}

const readEvents = Effect.fn("McpStdioFixture.readEvents")(function* (
  directory: string
) {
  return yield* Effect.tryPromise(() => loadEvents(directory)).pipe(
    Effect.orDie
  )
})

const waitFor = Effect.fn("McpStdioFixture.waitFor")(function* (
  directory: string,
  predicate: (events: ReadonlyArray<string>) => boolean
) {
  const current = yield* readEvents(directory)
  if (predicate(current)) return current

  return yield* Effect.callback<ReadonlyArray<string>>((resume) => {
    let settled = false
    const finish = (effect: Effect.Effect<ReadonlyArray<string>>) => {
      if (settled) return
      settled = true
      watcher.close()
      resume(effect)
    }
    const check = () => {
      loadEvents(directory).then(
        (events) => {
          if (predicate(events)) finish(Effect.succeed(events))
        },
        (error) => finish(Effect.die(error))
      )
    }
    const watcher = watch(directory, check)
    watcher.once("error", (error) => finish(Effect.die(error)))
    check()
    return Effect.sync(() => watcher.close())
  })
})

export const lifecycle = Effect.fn("McpStdioFixture.lifecycle")(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      mkdtemp(join(tmpdir(), "effect-harness-mcp-stdio-"))
    ).pipe(Effect.orDie),
    (path) => Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
      Effect.ignore
    )
  )
  return {
    directory,
    events: readEvents(directory),
    waitFor: (predicate) => waitFor(directory, predicate)
  } satisfies LifecycleFixture
})

export const make = Effect.fn("McpStdioFixture.make")(function* (
  generation: ServerGeneration
) {
  const observation = yield* lifecycle()
  const script = join(fixtureDirectory, `${generation}-stdio-server.mjs`)
  return {
    server: {
      command: process.execPath,
      args: [script, observation.directory],
      stderr: "pipe"
    },
    events: observation.events,
    waitFor: observation.waitFor
  } satisfies StdioFixture
})

export const includes = (expected: string) =>
  (events: ReadonlyArray<string>): boolean => events.includes(expected)

export const sessionExited = includes("session:exited")
