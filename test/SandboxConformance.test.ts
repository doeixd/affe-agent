import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as LocalSandbox from "../src/sandbox/local.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { SandboxConformance } from "../src/testing/index.js"

/**
 * `docs/plan-integrations.md` §6.1 / §10: the suite runs against `memory`
 * and `local`, and fails against a deliberately broken provider -- one that
 * merges stderr into stdout, ignores `timeout`, returns names where paths
 * are expected. Confirmed failing here before anything depends on it.
 */

/** Programs for a Node host: `node -e`, arguments after `--`. */
const nodePrograms: SandboxConformance.Programs = {
  echo: (text) => Sandbox.command(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)})`]),
  stderr: (text) => Sandbox.command(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(text)})`]),
  exit: (code) => Sandbox.command(process.execPath, ["-e", `process.exit(${code})`]),
  argv: (args) => Sandbox.command(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args]),
  sleep: (millis) => Sandbox.command(process.execPath, ["-e", `setTimeout(() => {}, ${millis})`]),
  emit: (bytes) => Sandbox.command(process.execPath, ["-e", `process.stdout.write('x'.repeat(${bytes}))`]),
  // Supplied because the local provider does stream natively; the suite holds
  // it to that. `unref` on nothing -- the interval is cleared at the end -- so
  // the process exits on its own after the last line.
  drip: (count, millis) =>
    Sandbox.command(process.execPath, [
      "-e",
      `let n = 0; const t = setInterval(() => { process.stdout.write('line ' + n + '\\n'); if (++n === ${count}) clearInterval(t) }, ${millis})`
    ])
}

/**
 * Programs for the in-memory sandbox: a scripted executor that interprets
 * a tiny command vocabulary, honouring the bounds the contract requires.
 */
const memoryPrograms: SandboxConformance.Programs = {
  echo: (text) => Sandbox.command("mem", ["echo", text]),
  stderr: (text) => Sandbox.command("mem", ["stderr", text]),
  exit: (code) => Sandbox.command("mem", ["exit", String(code)]),
  argv: (args) => Sandbox.command("mem", ["argv", ...args]),
  sleep: (millis) => Sandbox.command("mem", ["sleep", String(millis)]),
  emit: (bytes) => Sandbox.command("mem", ["emit", String(bytes)]),
  drip: (count, millis) => Sandbox.command("mem", ["drip", String(count), String(millis)])
}

const memoryExecutor: Sandbox.Sandbox["exec"] = (command, options): Effect.Effect<Sandbox.CommandResult, Sandbox.ExecError> => {
  const [op, ...rest] = command.args
  const done = (result: Sandbox.CommandResult): Effect.Effect<Sandbox.CommandResult, Sandbox.ExecError> => {
    const limit = options?.maxOutputBytes ?? 1024 * 1024
    return result.stdout.length + result.stderr.length > limit
      ? Effect.fail(new Sandbox.OutputLimitError({ executable: command.executable, maxOutputBytes: limit }))
      : Effect.succeed(result)
  }
  switch (op) {
    case "echo":
      return done({ exitCode: 0, stdout: rest[0] ?? "", stderr: "" })
    case "stderr":
      return done({ exitCode: 0, stdout: "", stderr: rest[0] ?? "" })
    case "exit":
      return done({ exitCode: Number(rest[0]), stdout: "", stderr: "" })
    case "argv":
      return done({ exitCode: 0, stdout: JSON.stringify(rest), stderr: "" })
    case "emit":
      return done({ exitCode: 0, stdout: "x".repeat(Number(rest[0])), stderr: "" })
    case "sleep":
      return Effect.sleep(`${Number(rest[0])} millis`).pipe(
        Effect.timeoutOrElse({
          duration: Sandbox.timeoutMillis(options),
          orElse: () => Effect.fail(new Sandbox.TimeoutError({ executable: command.executable, timeoutMillis: Sandbox.timeoutMillis(options) }))
        }),
        Effect.as({ exitCode: 0, stdout: "", stderr: "" })
      )
    default:
      return Effect.fail(new Sandbox.CommandLaunchError({ executable: command.executable, detail: `unknown op ${op}` }))
  }
}

const withTempRoot = Effect.fn("SandboxConformance.test.tempRoot")(function* () {
  const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "sandbox-conformance-")))
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  )
  return root
})

/** A bare name is itself a well-formed path, which is exactly how the fault hides. */
const asPath = Schema.decodeUnknownSync(Sandbox.SandboxPath)

/** A provider wrapped so specific promises are broken on purpose. */
const broken = (
  inner: Layer.Layer<Sandbox.SandboxProvider>,
  faults: { readonly mergeStderr?: boolean; readonly ignoreTimeout?: boolean; readonly namesNotPaths?: boolean }
): Layer.Layer<Sandbox.SandboxProvider> =>
  Layer.effect(
    Sandbox.SandboxProvider,
    Effect.map(Effect.service(Sandbox.SandboxProvider), (provider) => ({
      acquire: (workspace) =>
        Effect.map(provider.acquire(workspace), (sandbox): Sandbox.Sandbox => ({
          ...sandbox,
          list: (at) =>
            faults.namesNotPaths
              ? Effect.map(sandbox.list(at), (entries) =>
                entries.map((entry) => ({ ...entry, path: asPath(entry.path.split("/").pop() ?? "") })))
              : sandbox.list(at),
          exec: (command, options) =>
            Effect.map(
              sandbox.exec(command, faults.ignoreTimeout ? { ...options, timeout: "1 hour" } : options),
              (result) =>
                faults.mergeStderr
                  ? { ...result, stdout: result.stdout + result.stderr, stderr: "" }
                  : result
            )
        }))
    }))
  ).pipe(Layer.provide(inner))

/**
 * A scripted `execStream` for the in-memory provider: everything but `drip`
 * falls back to the derivation over the scripted `exec`, and `drip` emits its
 * lines on a real clock. This is what a test that cares *when* output arrives
 * looks like without a process.
 */
const memoryDripStream: Sandbox.Sandbox["execStream"] = (command, options) => {
  const [op, count, millis] = command.args
  if (op !== "drip") {
    return Stream.unwrap(Effect.map(
      memoryExecutor(command, options),
      (result) => Stream.fromArray(Sandbox.eventsOf(result))
    ))
  }
  const encoder = new TextEncoder()
  return Stream.fromIterable(Array.from({ length: Number(count) }, (_, index) => index)).pipe(
    Stream.mapEffect((index) =>
      Effect.as(
        Effect.sleep(`${Number(millis)} millis`),
        Sandbox.outputEvent("stdout", encoder.encode(`line ${index}\n`))
      )
    ),
    Stream.concat(Stream.succeed(Sandbox.exitEvent(0)))
  )
}

describe("SandboxConformance", () => {
  it.live("a scripted execStream satisfies the streaming claim without a process", () =>
    Effect.gen(function* () {
      const report = yield* SandboxConformance.run(
        MemorySandbox.layer({ exec: memoryExecutor, execStream: memoryDripStream }),
        { programs: memoryPrograms }
      )
      assert.deepStrictEqual(report.failed, [])
      // The point of the case: the same suite that reports `false` for the
      // derivation reports `true` here, so it is measuring the timeline and
      // not the provider's name.
      assert.isTrue(report.capabilities.streamsIncrementally)
    }),
    30_000
  )

  it.live("the in-memory provider passes every case, with exec probed through its scripted executor", () =>
    Effect.gen(function* () {
      // No `drip`: a scripted executor buffers, and does not claim otherwise.
      const { drip: _drip, ...buffered } = memoryPrograms
      const report = yield* SandboxConformance.run(MemorySandbox.layer({ exec: memoryExecutor }), { programs: buffered })
      assert.deepStrictEqual(report.failed, [])
      assert.deepStrictEqual(report.capabilities, {
        exec: true,
        separateStderr: true,
        timeout: true,
        outputBound: true,
        streamsIncrementally: false
      })
      assert.strictEqual(report.passed.length, SandboxConformance.cases({ programs: buffered }).length)
    })
  )

  it.live("without programs the exec cases are skipped and the report says so", () =>
    Effect.gen(function* () {
      const report = yield* SandboxConformance.run(MemorySandbox.layer())
      assert.deepStrictEqual(report.failed, [])
      assert.deepStrictEqual(report.capabilities, {
        exec: false,
        separateStderr: false,
        timeout: false,
        outputBound: false,
        streamsIncrementally: false
      })
      assert.isTrue(report.passed.every((name) => !name.startsWith("exec:")))
    })
  )

  it.live("the local provider passes every case against real files and processes", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot()
      const report = yield* SandboxConformance.run(LocalSandbox.layer({ root }), { programs: nodePrograms })
      assert.deepStrictEqual(report.failed, [])
      // The local provider spawns, so it is held to the streaming claim too.
      assert.deepStrictEqual(report.capabilities, {
        exec: true,
        separateStderr: true,
        timeout: true,
        outputBound: true,
        streamsIncrementally: true
      })
    }).pipe(Effect.scoped),
    60_000
  )

  it.live("a deliberately wrong provider fails exactly the promises it breaks", () =>
    Effect.gen(function* () {
      const root = yield* withTempRoot()
      const report = yield* SandboxConformance.run(
        broken(LocalSandbox.layer({ root }), { mergeStderr: true, ignoreTimeout: true, namesNotPaths: true }),
        { programs: nodePrograms }
      )
      assert.deepStrictEqual(
        report.failed.map((entry) => entry.name).sort(),
        [
          "exec: stderr is separate from stdout",
          "exec: timeout is TimeoutError, not a hang",
          "files: list returns workspace paths, one level, sorted, typed"
        ]
      )
      const byName = Object.fromEntries(report.failed.map((entry) => [entry.name, entry.detail]))
      assert.include(byName["exec: stderr is separate from stdout"], "merged")
      assert.include(byName["exec: timeout is TimeoutError, not a hang"], "ignored `timeout`")
      assert.include(byName["files: list returns workspace paths, one level, sorted, typed"], "names instead of paths")
      // The derived capability report contradicts what such a provider would claim.
      assert.deepStrictEqual(report.capabilities, {
        exec: true,
        separateStderr: false,
        timeout: false,
        outputBound: true,
        streamsIncrementally: true
      })
    }).pipe(Effect.scoped),
    60_000
  )

  it("every case is a named Effect a test runner can wire on its own", () => {
    const all = SandboxConformance.cases({ programs: nodePrograms })
    assert.isAbove(all.length, 8)
    assert.deepStrictEqual(new Set(all.map((entry) => entry.area)), new Set(["files", "identity", "exec"]))
    assert.strictEqual(new Set(all.map((entry) => entry.name)).size, all.length)
  })
})
