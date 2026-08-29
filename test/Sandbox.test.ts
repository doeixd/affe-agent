import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, Option, Ref, Schema } from "effect"
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
    }),
    // Several real processes with timed bounds: under a loaded machine the
    // aggregate can exceed the default budget without anything being wrong.
    20_000
  )

  it.effect("output bounds are exact, counted in bytes, and stderr counts too", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        // Exactly at the bound: allowed. One byte over: refused. The bound is
        // on bytes, so a multi-byte character that crosses it is over.
        const exact = yield* sandbox.exec(
          node("process.stdout.write('x'.repeat(100))"),
          { maxOutputBytes: 100 }
        )
        assert.strictEqual(exact.stdout.length, 100)
        const over = yield* Effect.exit(
          sandbox.exec(node("process.stdout.write('x'.repeat(101))"), { maxOutputBytes: 100 })
        )
        assert.isTrue(Exit.isFailure(over))
        const multibyte = yield* Effect.exit(
          // 99 ASCII bytes plus a 3-byte character: 102 bytes, 100 chars.
          sandbox.exec(node("process.stdout.write('x'.repeat(99) + '€')"), {
            maxOutputBytes: 100
          })
        )
        assert.isTrue(Exit.isFailure(multibyte), "the bound is bytes, not characters")
        const stderrToo = yield* Effect.exit(
          sandbox.exec(
            node("process.stdout.write('x'.repeat(60)); process.stderr.write('y'.repeat(60))"),
            { maxOutputBytes: 100 }
          )
        )
        assert.isTrue(Exit.isFailure(stderrToo), "stderr counts toward the bound")
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)
    }),
    20_000
  )

  it.effect("arguments reach the process exactly, with no shell in between", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        const args = ["with space", "\"quoted\"", "$HOME", "a;b&&c|d", "unicode é€", ""]
        const result = yield* sandbox.exec(
          Sandbox.command(process.execPath, [
            "-e",
            "console.log(JSON.stringify(process.argv.slice(1)))",
            ...args
          ])
        )
        assert.strictEqual(result.exitCode, 0)
        assert.deepStrictEqual(JSON.parse(result.stdout), args)
        // Exit codes and stderr pass through untouched.
        const failing = yield* sandbox.exec(
          node("process.stderr.write('bad'); process.exit(7)")
        )
        assert.strictEqual(failing.exitCode, 7)
        assert.strictEqual(failing.stderr, "bad")
        assert.strictEqual(failing.stdout, "")
        // A command that cannot be launched is a launch error, not a result.
        const missing = yield* Effect.exit(
          sandbox.exec(Sandbox.command("definitely-not-a-real-executable-xyz", []))
        )
        assert.isTrue(Exit.isFailure(missing))
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)
    }),
    20_000
  )

  it.effect("files: nested writes create parents, directories are not files, and paths normalise", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        yield* sandbox.write(p("a/b/c.txt"), bytes("deep"))
        assert.strictEqual(
          new TextDecoder().decode(yield* sandbox.read(p("./a/b/c.txt"))),
          "deep"
        )
        // Reading a directory is a provider error, not bytes.
        const dir = yield* Effect.exit(sandbox.read(p("a/b")))
        assert.isTrue(Exit.isFailure(dir))
        // Writing over a directory is refused.
        const overDir = yield* Effect.exit(sandbox.write(p("a"), bytes("x")))
        assert.isTrue(Exit.isFailure(overDir))
        // Writing under a file is refused.
        const underFile = yield* Effect.exit(sandbox.write(p("a/b/c.txt/d.txt"), bytes("x")))
        assert.isTrue(Exit.isFailure(underFile))
        // A missing file is the typed missing error, and so is stat.
        const missing = yield* Effect.exit(sandbox.stat(p("a/nope")))
        const error = Cause.findErrorOption(missing._tag === "Failure" ? missing.cause : Cause.empty)
        assert.isTrue(error._tag === "Some" && error.value instanceof Sandbox.FileMissingError)
        // An empty file round-trips as empty.
        yield* sandbox.write(p("empty"), new Uint8Array())
        assert.strictEqual((yield* sandbox.read(p("empty"))).byteLength, 0)
        const listed = (yield* sandbox.list(p("a"))).map((e) => e.path)
        assert.deepStrictEqual(listed, ["a/b"])
      }).pipe(Effect.provide(fixture.layer), Effect.scoped)
    })
  )

  it.effect("canonical: one identity per file, whatever it is called", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture()
      yield* Effect.promise(() => fs.writeFile(path.join(fixture.managed, "real.txt"), "x"))
      const linked = yield* Effect.exit(Effect.promise(() =>
        fs.symlink(path.join(fixture.managed, "real.txt"), path.join(fixture.managed, "link.txt"), "file")
      ))
      yield* Effect.gen(function* () {
        const sandbox = yield* Sandbox.acquire(Sandbox.workspace("local"))
        const real = yield* sandbox.canonical(p("real.txt"))
        // A spelling that differs only in redundant segments is the same file.
        assert.strictEqual(yield* sandbox.canonical(p("./real.txt")), real)
        // A different file is a different identity.
        assert.notStrictEqual(yield* sandbox.canonical(p("other.txt")), real)
        // A file that does not exist yet still has one, so a write can lock it.
        assert.strictEqual(
          yield* sandbox.canonical(p("new/deep/file.txt")),
          yield* sandbox.canonical(p("new/deep/file.txt"))
        )
        if (Exit.isSuccess(linked)) {
          assert.strictEqual(yield* sandbox.canonical(p("link.txt")), real)
        }
      }).pipe(Effect.provide(LocalSandbox.layer({ workspaceRoot: fixture.managed })))
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
        /**
         * The command starts a grandchild that inherits stdout and outlives
         * it, then exits itself. Waiting for the streams to close would wait
         * on the grandchild; the command is over when the child is.
         *
         * The margin between the grandchild's life and the budget is the whole
         * assertion, so it is generous on purpose. It used to be a 1,500ms
         * grandchild against a 1,200ms budget, which failed this suite at
         * 1,476ms -- and the alarming part is not the failure but how it
         * nearly passed: 24ms from reporting success while the command had in
         * fact waited almost the full lifetime. Spawning node under a loaded
         * parallel suite costs most of a second by itself, so a threshold that
         * close measures the machine rather than the behaviour.
         *
         * The grandchild's cwd is the OS temp directory, not the workspace.
         * That is what lets it outlive the command by a wide margin: on POSIX
         * the sandbox ends the process group, but Windows cannot reach an
         * orphan through its dead parent, and an orphan sitting in the
         * fixture's directory would hold it open against cleanup.
         */
        const began = Date.now()
        const result = yield* sandbox.exec(
          node(
            "const { spawn } = require('child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit', detached: true, cwd: require('os').tmpdir() }).unref(); console.log('parent done')"
          ),
          { timeout: "5 seconds" }
        )
        assert.strictEqual(result.exitCode, 0)
        assert.include(result.stdout, "parent done")
        assert.isBelow(Date.now() - began, 3000, "waited on the grandchild")
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
    // The Node-backed provider is its own entry (`sandbox/local`): the
    // portable surface must not pull in `node:*` by being imported.
    const surface = await import("../src/sandbox/index.js")
    assert.deepStrictEqual(Object.keys(surface).sort(), [
      "MemorySandbox",
      "Sandbox"
    ])
    const local = await import("../src/sandbox/local.js")
    assert.include(Object.keys(local), "layer")
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
      /**
       * Forgetting to provide the workspace cannot compile: the tool's
       * dependency is carried into the session's requirements.
       *
       * The `Equal` guard is not decoration. `X extends any` is `true`, so had
       * inference collapsed `Requirements` to `any` this assertion would have
       * passed while proving nothing -- which is the whole reason the codebase
       * insists that compiling is not evidence. `Equal` is mutual
       * assignability, and only `any` is mutually assignable with `any`, so
       * asking for it first turns the vacuous pass into a failure.
       *
       * Equality with `Sandbox.Current` is deliberately *not* asserted:
       * `Requirements` legitimately carries the model service too, so the
       * claim being made is containment, and containment is all it says.
       */
      const required: Assert<
        Equal<Requirements, any> extends true ? false
          : Sandbox.Current extends Requirements ? true
          : false
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

  /**
   * The brand carries the rule, not just a name.
   *
   * `SandboxPath` used to be a bare `Schema.brand`, so the validation lived
   * only in `path()` and anything else could mint one -- including values
   * `path()` itself refuses. Two things depend on the promise:
   * `internal/fileLock.ts` keys mutual exclusion on these, and `Shell` builds
   * argv from them. "Somebody branded a string" is not the same claim as
   * "this cannot escape the workspace".
   */
  describe("SandboxPath is refined, not just branded", () => {
    const refused = [
      "",
      "/etc/passwd",
      "C:/Windows",
      "c:/windows",
      "../secret",
      "a/../../secret",
      "a/..",
      "..",
      ".",
      "./",
      // A NUL byte truncates the name for any C API underneath: a check
      // written in JavaScript sees the whole string, the filesystem sees only
      // what precedes the NUL. It never escaped the workspace -- the local
      // provider raised a `ProviderError` from `fs` -- but a value the brand
      // calls validated must not be one a provider then refuses, and the
      // wrong error class is the observable half of that.
      "a.txt\u0000.png",
      "\u0000"
    ]

    it.effect("a NUL byte is an InvalidPathError, not a provider failure", () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(Sandbox.path("notes/a.txt\u0000.png"))
        assert.isTrue(Exit.isFailure(outcome))
        if (!Exit.isFailure(outcome)) return
        const error = Cause.findErrorOption(outcome.cause)
        assert.strictEqual(error._tag, "Some")
        if (error._tag !== "Some") return
        assert.isTrue(error.value instanceof Sandbox.InvalidPathError)
        if (!(error.value instanceof Sandbox.InvalidPathError)) return
        assert.strictEqual(error.value.reason, "a NUL byte is not a filename character")
        assert.strictEqual(error.value.path, "notes/a.txt\u0000.png")
      }))

    it("the schema refuses what path() refuses", () => {
      for (const value of refused) {
        assert.throws(
          () => Schema.decodeUnknownSync(Sandbox.SandboxPath)(value),
          undefined,
          undefined,
          `${JSON.stringify(value)} must not decode to a SandboxPath`
        )
      }
    })

    /**
     * A backslash is valid *input* and not a valid *value*.
     *
     * `path()` normalises separators, so `a\b` is something a caller may hand
     * it and `a/b` is what comes back. The brand describes the normalised
     * form, so it refuses the unnormalised one -- the two are not in conflict,
     * they are describing different ends of the same function.
     */
    it("a backslash is normalised by path() and refused by the schema", () =>
      Effect.runSync(Effect.gen(function* () {
        const built = yield* Sandbox.path("a\\b.ts")
        assert.strictEqual(built, "a/b.ts")
        assert.throws(
          () => Schema.decodeUnknownSync(Sandbox.SandboxPath)("a\\b.ts"),
          undefined,
          undefined,
          "an unnormalised separator is not a SandboxPath value"
        )
        assert.isFalse(Sandbox.isSandboxPath("a\\b.ts"))
      })))

    it.effect("path() and the schema agree, in both directions", () =>
      Effect.gen(function* () {
        for (const value of refused) {
          const viaConstructor = yield* Effect.exit(Sandbox.path(value))
          assert.isTrue(
            Exit.isFailure(viaConstructor),
            `path(${JSON.stringify(value)}) must fail`
          )
          assert.isFalse(
            Sandbox.isSandboxPath(value),
            `isSandboxPath(${JSON.stringify(value)}) must be false`
          )
        }

        for (const value of ["a.ts", "src/a.ts", "a/b/c.ts", "a.b.c"]) {
          const built = yield* Sandbox.path(value)
          assert.strictEqual(built, value)
          assert.isTrue(Sandbox.isSandboxPath(value))
          assert.strictEqual(
            Schema.decodeUnknownSync(Sandbox.SandboxPath)(built),
            built
          )
        }
      }))

    it.effect("everything path() produces satisfies the schema", () =>
      Effect.gen(function* () {
        // `path()` normalises as well as validates, so its *output* is the
        // interesting input -- `a/./b` becomes `a/b`, which must pass.
        for (const value of ["a/./b.ts", "a//b.ts", "./a.ts"]) {
          const built = yield* Sandbox.path(value)
          assert.doesNotThrow(
            () => Schema.decodeUnknownSync(Sandbox.SandboxPath)(built),
            `path(${JSON.stringify(value)}) produced ${
              JSON.stringify(built)
            }, which the schema rejected`
          )
        }
      }))
  })
})
