import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Scope } from "effect"
import { Tool } from "effect/unstable/ai"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as LocalSandbox from "../src/sandbox/local.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as FakeModel from "./FakeModel.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends
        (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false
type Assert<T extends true> = T

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Validated paths for call sites that are visibly well-formed. */
const p = (value: string): Sandbox.SandboxPath => {
  const effect = Sandbox.path(value)
  const result = Effect.runSyncExit(effect)
  if (!Exit.isSuccess(result)) {
    throw new Error(`test path "${value}" was refused`)
  }
  return result.value
}

describe("sandbox paths", () => {
  it.effect("accepts relative paths and normalises them", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* Sandbox.path("docs\\a.txt"), "docs/a.txt")
      assert.strictEqual(yield* Sandbox.path("./a/b//c.txt"), "a/b/c.txt")
      // Any `..` segment is refused outright, even when it would stay inside
      // the workspace: the policy is "no traversal", not "no escape".
      const traversal = yield* Effect.exit(Sandbox.path("docs/../notes/a.txt"))
      assert.isTrue(Exit.isFailure(traversal))
    })
  )

  it.effect("refuses absolute paths, drives and traversal", () =>
    Effect.gen(function* () {
      for (const candidate of [
        "/etc/passwd",
        "C:/Windows",
        "C:\\Windows",
        "../outside",
        "a/../../outside",
        ""
      ]) {
        const refused = yield* Effect.exit(Sandbox.path(candidate))
        if (!Exit.isFailure(refused)) {
          assert.fail(`expected "${candidate}" to be refused`)
        }
        const error = Cause.findErrorOption(refused.cause)
        assert.isTrue(
          error._tag === "Some" &&
            error.value instanceof Sandbox.InvalidPathError,
          `expected a typed InvalidPathError for "${candidate}"`
        )
      }
    })
  )
})

describe("in-memory sandbox", () => {
  const provider = MemorySandbox.layer({ seed: { "seeded.txt": "planted" } })

  it.effect("round-trips files and lists implicit directories", () =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.acquire(Sandbox.workspace("w"))
      yield* sandbox.write(p("docs/a.txt"), bytes("alpha"))
      yield* sandbox.write(p("docs/b.md"), bytes("beta"))
      yield* sandbox.write(p("top.txt"), bytes("top"))

      assert.strictEqual(
        new TextDecoder().decode(yield* sandbox.read(p("docs/a.txt"))),
        "alpha"
      )

      const docs = yield* sandbox.list(p("docs"))
      assert.deepStrictEqual(
        docs.map((entry) => entry.path),
        ["docs/a.txt", "docs/b.md"]
      )

      const root = yield* sandbox.list()
      assert.deepStrictEqual(
        root.map((entry) => `${entry.path}:${entry.type}`),
        // `seeded.txt` comes from the provider-level seed.
        ["docs:directory", "seeded.txt:file", "top.txt:file"]
      )
    }).pipe(Effect.provide(provider), Effect.scoped)
  )

  it.effect("sees the seed and shares one world across acquisitions", () =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.acquire(Sandbox.workspace("w"))
      assert.strictEqual(
        new TextDecoder().decode(yield* sandbox.read(p("seeded.txt"))),
        "planted"
      )
      yield* sandbox.write(p("shared.txt"), bytes("one"))

      const second = yield* Sandbox.acquire(Sandbox.workspace("w"))
      assert.strictEqual(
        new TextDecoder().decode(yield* second.read(p("shared.txt"))),
        "one"
      )
    }).pipe(Effect.provide(provider), Effect.scoped)
  )

  it.effect("reports missing files through the typed channel", () =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.acquire(Sandbox.workspace("w"))
      const failed = yield* Effect.exit(sandbox.read(p("nope.txt")))
      assert.isTrue(Exit.isFailure(failed))

      const listed = yield* Effect.exit(sandbox.list(p("nope")))
      assert.isTrue(Exit.isFailure(listed))
    }).pipe(Effect.provide(provider), Effect.scoped)
  )

  it.effect("refuses writes that would fork the namespace", () =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.acquire(Sandbox.workspace("w"))
      yield* sandbox.write(p("docs/a.txt"), bytes("x"))

      // A file cannot replace an existing directory…
      const overDirectory = yield* Effect.exit(sandbox.write(p("docs"), bytes("y")))
      assert.isTrue(Exit.isFailure(overDirectory))

      // …nor land inside an existing file…
      const insideFile = yield* Effect.exit(
        sandbox.write(p("docs/a.txt/deeper.txt"), bytes("z"))
      )
      assert.isTrue(Exit.isFailure(insideFile))

      // …and a file cannot be listed as a directory.
      const listed = yield* Effect.exit(sandbox.list(p("docs/a.txt")))
      assert.isTrue(Exit.isFailure(listed))

      // Nothing was written by the refused operations.
      assert.deepStrictEqual((yield* sandbox.list()).map((e) => e.path), [
        "docs",
        "seeded.txt"
      ])
    }).pipe(Effect.provide(provider), Effect.scoped)
  )

  it.effect("hands the exact command to a scripted executor", () =>
    Effect.gen(function* () {
      const seen: Array<Sandbox.Command> = []
      const scripted = MemorySandbox.layer({
        exec: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return { exitCode: 0, stdout: "ok", stderr: "" }
          })
      })

      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("w"))
        const result = yield* sandbox.exec(
          Sandbox.command("tool", ["--flag", "value"])
        )
        assert.strictEqual(result.stdout, "ok")
      }).pipe(Effect.provide(scripted), Effect.scoped)

      assert.deepStrictEqual(seen, [
        { executable: "tool", args: ["--flag", "value"] }
      ])
    })
  )

  it.effect("refuses to run processes without an executor", () =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.acquire(Sandbox.workspace("w"))
      assert.isTrue(Exit.isFailure(yield* Effect.exit(
        sandbox.exec(Sandbox.command("anything"))
      )))
    }).pipe(Effect.provide(provider), Effect.scoped)
  )
})

describe("local sandbox", () => {
  interface Fixture {
    readonly layer: Layer.Layer<Sandbox.SandboxProvider>
    /** Parent of per-acquisition temp directories. */
    readonly base: string
    /** A directory outside every sandbox, holding an unreadable secret. */
    readonly external: string
    /** A fixture-managed directory handed to the provider as the workspace. */
    readonly managed: string
  }

  const makeFixture = Effect.fn("Sandbox.test.localFixture")(function* () {
    const base = yield* Effect.promise(() =>
      fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"))
    )
    const external = yield* Effect.promise(() =>
      fs.mkdtemp(path.join(os.tmpdir(), "sandbox-outside-"))
    )
    const managed = path.join(base, "managed")
    yield* Effect.promise(() => fs.mkdir(managed))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      )
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        fs.rm(external, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      )
    )
    return {
      base,
      external,
      managed,
      // The temporary-directory mode is what most tests use; the symlink and
      // workspaceRoot assertions use `managed`.
      layer: LocalSandbox.layer({ root: base })
    } satisfies Fixture
  })

  const node = (script: string): Sandbox.Command =>
    Sandbox.command(process.execPath, ["-e", script])

  it.effect("writes, reads, lists and stats real files in its own directory", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))

        yield* sandbox.write(p("nested/deep/file.txt"), bytes("content"))
        assert.strictEqual(
          new TextDecoder().decode(yield* sandbox.read(p("nested/deep/file.txt"))),
          "content"
        )

        // A real directory lists only its immediate children.
        const entries = yield* sandbox.list()
        assert.deepStrictEqual(
          entries.map((entry) => entry.path),
          ["nested"]
        )

        const fileStat = yield* sandbox.stat(p("nested/deep/file.txt"))
        assert.strictEqual(fileStat.type, "file")
        assert.isTrue(Option.isSome(fileStat.size))

        const dirStat = yield* sandbox.stat(p("nested"))
        assert.strictEqual(dirStat.type, "directory")
        assert.isTrue(Option.isNone(dirStat.size))
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)
    })
  )

  it.effect("runs real processes with exact arguments and bounded behaviour", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))

        const hello = yield* sandbox.exec(node("console.log('hello stdout')"))
        assert.strictEqual(hello.exitCode, 0)
        assert.strictEqual(hello.stdout.trim(), "hello stdout")

        const failing = yield* sandbox.exec(
          node("console.error('boom'); process.exit(3)")
        )
        assert.strictEqual(failing.exitCode, 3)
        assert.include(failing.stderr, "boom")

        const checked = yield* Effect.exit(
          Sandbox.execChecked(sandbox, node("process.exit(3)"))
        )
        if (!Exit.isFailure(checked)) {
          assert.fail("execChecked must fail on a non-zero exit")
        }
        const error = Cause.findErrorOption(checked.cause)
        assert.isTrue(
          error._tag === "Some" && error.value instanceof Sandbox.ExitStatusError
        )

        const timedOut = yield* Effect.exit(
          sandbox.exec(node("setInterval(() => {}, 500)"), {
            timeout: "300 millis"
          })
        )
        if (!Exit.isFailure(timedOut)) {
          assert.fail("expected a timeout failure")
        }
        const timeout = Cause.findErrorOption(timedOut.cause)
        assert.isTrue(
          timeout._tag === "Some" && timeout.value instanceof Sandbox.TimeoutError
        )

        // The bound is on the work, not the wait: a timed-out exec returns
        // only once the child is gone. This child keeps growing a file for as
        // long as it lives; once control is back the file must have stopped
        // growing. (A SIGTERM handler would be the tidier witness, but on
        // Windows the signal is a hard kill and no handler runs.)
        const lingering = yield* Effect.exit(
          sandbox.exec(
            node(
              "const fs = require('fs'); setInterval(() => fs.appendFileSync('alive.txt', 'x'), 20)"
            ),
            { timeout: "300 millis" }
          )
        )
        assert.isTrue(Exit.isFailure(lingering))
        // Under load the child may be killed before it ever wrote: a file
        // that stays absent is as stable as one that stays the same size.
        const size = Effect.map(
          Effect.option(sandbox.stat(p("alive.txt"))),
          Option.map((s) => s.size)
        )
        const sizeNow = yield* size
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 300)))
        assert.deepStrictEqual(yield* size, sizeNow)

        // The caller going away — a timeout on the effect itself rather than
        // the sandbox's bound — must take the child with it. Until it did,
        // the process ran on unowned, still writing.
        const abandoned = yield* Effect.forkChild(
          sandbox.exec(
            node(
              "const fs = require('fs'); setInterval(() => fs.appendFileSync('orphan.txt', 'x'), 20)"
            )
          )
        )
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 300)))
        yield* Fiber.interrupt(abandoned)
        const orphanSize = Effect.map(
          Effect.option(sandbox.stat(p("orphan.txt"))),
          Option.map((s) => s.size)
        )
        const orphanNow = yield* orphanSize
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 300)))
        assert.deepStrictEqual(yield* orphanSize, orphanNow)

        const flooded = yield* Effect.exit(
          sandbox.exec(
            node("process.stdout.write('x'.repeat(5 * 1024 * 1024))"),
            { maxOutputBytes: 64 * 1024 }
          )
        )
        if (!Exit.isFailure(flooded)) {
          assert.fail("expected the output limit to fire")
        }

        const missing = yield* Effect.exit(
          sandbox.exec(Sandbox.command("definitely-not-a-real-executable-xyz"))
        )
        if (!Exit.isFailure(missing)) {
          assert.fail("expected a launch failure")
        }
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)
    })
  )

  it.effect("refuses reads that resolve outside the workspace", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.promise(() =>
        fs.writeFile(path.join(fixture.external, "secret.txt"), "s3cret")
      )

      const linkInside = path.join(fixture.managed, "link.txt")
      const linked = yield* Effect.exit(Effect.promise(() =>
        fs.symlink(path.join(fixture.external, "secret.txt"), linkInside, "file")
      ))
      if (Exit.isFailure(linked)) {
        // Creating symlinks needs privileges on some platforms; the policy is
        // still covered wherever they exist. Say so instead of pretending.
        return
      }

      const managedLayer = LocalSandbox.layer({
        workspaceRoot: fixture.managed
      })
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        const escaped = yield* Effect.exit(sandbox.read(p("link.txt")))
        if (!Exit.isFailure(escaped)) {
          assert.fail("reading through an escaping symlink must fail")
        }
        const error = Cause.findErrorOption(escaped.cause)
        assert.isTrue(
          error._tag === "Some" &&
            error.value instanceof Sandbox.PermissionDeniedError
        )
      }).pipe(Effect.provide(managedLayer), Effect.scoped)
    })
  )

  it.live("a descendant holding the pipes cannot keep a finished command open", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        // The command starts a grandchild that inherits stdout and outlives
        // it, then exits itself. Waiting for the streams to close would wait
        // on the grandchild; the command is over when the child is. (The
        // grandchild is given a short life of its own: on POSIX the sandbox
        // ends the process group, but Windows cannot reach an orphan through
        // its dead parent, and the fixture's cleanup needs the directory
        // back.)
        const began = Date.now()
        const result = yield* sandbox.exec(
          node(
            "const { spawn } = require('child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'inherit', detached: true }).unref(); console.log('parent done')"
          ),
          { timeout: "5 seconds" }
        )
        assert.strictEqual(result.exitCode, 0)
        assert.include(result.stdout, "parent done")
        assert.isBelow(Date.now() - began, 1200, "waited on the grandchild")
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)
    })
  )

  it.effect("reports a process ended by a signal as such", () =>
    Effect.gen(function* () {
      // Windows has no signals: a self-kill there is an ordinary exit code.
      if (process.platform === "win32") return
      const fixture = yield* makeFixture()
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        const result = yield* sandbox.exec(
          node("process.kill(process.pid, 'SIGKILL')")
        )
        // Not an exit code a tool chose: the signal is named.
        assert.strictEqual(result.exitCode, -1)
        assert.strictEqual(result.signal, "SIGKILL")
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)
    })
  )

  it.effect("a workspaceRoot that does not exist is refused at acquire, not per operation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const missing = LocalSandbox.layer({
        workspaceRoot: path.join(fixture.base, "nowhere")
      })
      const failed = yield* Effect.exit(
        Sandbox.acquire(Sandbox.workspace("local")).pipe(
          Effect.provide(missing),
          Effect.scoped
        )
      )
      if (!Exit.isFailure(failed)) {
        assert.fail("acquiring a missing root must fail")
      }
      const error = Cause.findErrorOption(failed.cause)
      assert.isTrue(
        error._tag === "Some" && error.value instanceof Sandbox.ProviderError
      )
    })
  )

  it.effect("refuses to write through a dangling symlink that points outside", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const outside = path.join(fixture.external, "planted.txt")
      // The target does not exist yet — which is the whole trick: a check
      // that follows the link sees "missing", walks up to the workspace, and
      // lets the write create the target on the far side.
      const linkInside = path.join(fixture.managed, "dangling.txt")
      const linked = yield* Effect.exit(Effect.promise(() =>
        fs.symlink(outside, linkInside, "file")
      ))
      if (Exit.isFailure(linked)) {
        return
      }

      const managedLayer = LocalSandbox.layer({
        workspaceRoot: fixture.managed
      })
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        const escaped = yield* Effect.exit(
          sandbox.write(p("dangling.txt"), bytes("planted"))
        )
        if (!Exit.isFailure(escaped)) {
          assert.fail("writing through an escaping dangling symlink must fail")
        }
        const error = Cause.findErrorOption(escaped.cause)
        assert.isTrue(
          error._tag === "Some" &&
            error.value instanceof Sandbox.PermissionDeniedError
        )
      }).pipe(Effect.provide(managedLayer), Effect.scoped)

      const planted = yield* Effect.promise(() =>
        fs.stat(outside).then(() => true, () => false)
      )
      assert.isFalse(planted, "nothing may be created outside the workspace")
    })
  )

  it.effect("removes its own temporary directories when scopes close", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      const before = yield* Effect.promise(() => fs.readdir(fixture.base))

      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        yield* sandbox.write(p("keep.txt"), bytes("x"))
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)

      const after = yield* Effect.promise(() => fs.readdir(fixture.base))
      const created = after.filter((name) => !before.includes(name))
      assert.deepStrictEqual(created, [])
    })
  )
})

describe("sandbox composition", () => {
  it("exports the sandbox vocabulary and nothing beyond it", async () => {
    const surface = await import("../src/sandbox/index.js")
    assert.deepStrictEqual(Object.keys(surface).sort(), [
      "LocalSandbox",
      "MemorySandbox",
      "Sandbox"
    ])
  })

  it.effect("tools demanding the sandbox run against either provider", () =>
    Effect.gen(function* () {
      const ReadFile = Tool.make("read_file", {
        parameters: Schema.Struct({ file: Schema.String }),
        success: Schema.String,
        failure: Schema.String,
        dependencies: [Sandbox.Current]
      })

      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const toolkit = Agent.toolkit([ReadFile], {
        read_file: ({ file }) =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox.Current
            const text = new TextDecoder().decode(
              yield* sandbox.read(p(file))
            )
            yield* Ref.update(seen, (all) => [...all, text])
            return text
          }).pipe(
            Effect.mapError((error: Sandbox.FileError) => error.message)
          )
      })

      const agent = Agent.make({ toolkit })

      const program = Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        return yield* AgentSession.prompt(session, "go")
      })

      type Requirements = typeof program extends Effect.Effect<
        any,
        any,
        infer R
      >
        ? R
        : never
      // Forgetting to provide the workspace cannot compile: the tool's
      // dependency is carried into the session's requirements.
      const required: Assert<
        Sandbox.Current extends Requirements ? true : false
      > = true
      void required

      // The same agent and wiring run against either provider; swapping is a
      // change of one layer, not of the tools. Each run builds a *fresh*
      // scripted model, because one script instance replays its turns once.
      const runWith = (providerLayer: Layer.Layer<Sandbox.SandboxProvider>) =>
        Effect.flatMap(
          FakeModel.layer([
            {
              toolCalls: [{
                id: "r1",
                name: "read_file",
                params: { file: "notes/a.txt" }
              }]
            },
            { text: "done" }
          ]),
          ({ layer: model }) =>
            Effect.scoped(
              program.pipe(
                Effect.provide(Layer.mergeAll(
                  model,
                  Sandbox.currentLayer(Sandbox.workspace("agent")).pipe(
                    Layer.provide(providerLayer)
                  )
                ))
              )
            )
        )

      const viaMemory = yield* Effect.exit(runWith(MemorySandbox.layer({
        seed: { "notes/a.txt": "from memory" }
      })))
      if (!Exit.isSuccess(viaMemory)) {
        assert.fail("expected the memory provider to serve the tool")
      }
      assert.strictEqual(viaMemory.value.text, "done")
      assert.deepStrictEqual(yield* Ref.get(seen), ["from memory"])

      const base = yield* Effect.promise(() =>
        fs.mkdtemp(path.join(os.tmpdir(), "sandbox-compose-"))
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
      )
      yield* Effect.promise(() =>
        fs.mkdir(path.join(base, "notes"))
      )
      yield* Effect.promise(() =>
        fs.writeFile(path.join(base, "notes", "a.txt"), "from disk")
      )

      const viaDisk = yield* Effect.exit(runWith(LocalSandbox.layer({
        workspaceRoot: base
      })))
      if (!Exit.isSuccess(viaDisk)) {
        assert.fail("expected the local provider to serve the same tool")
      }
      // The identical agent read a real file through the other provider.
      assert.deepStrictEqual(yield* Ref.get(seen), [
        "from memory",
        "from disk"
      ])
    })
  )
})
