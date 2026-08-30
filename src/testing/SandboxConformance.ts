import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import * as Sandbox from "../sandbox/Sandbox.js"

/**
 * The conformance suite every `SandboxProvider` must pass.
 *
 * `docs/plan-integrations.md` §6.1: the semantics prose cannot pin --
 * whether `list` returns paths or names, whether a non-zero exit is a
 * result or a failure, whether stderr is genuinely separate from stdout,
 * whether `timeout` produces `TimeoutError` rather than a hang -- asserted
 * against the real `Sandbox` contract, so a remote provider is validated by
 * the same cases as the in-memory and local ones.
 *
 * Framework-agnostic on purpose: `@effect/vitest` is a development
 * dependency of this package and must not be imported from `/testing`. A
 * case is a named Effect over `SandboxProvider`; a test runner wires them
 * with one line each (`for (const c of cases) it.effect(c.name, () =>
 * c.run.pipe(Effect.provide(layer)))`), and `run` executes them all and
 * returns a report with the derived capabilities.
 *
 * **Capabilities are probed, not declared.** Whether a provider can run
 * processes at all, keep stderr apart, honour a timeout or bound its output
 * is what the exec cases find out; the report says which held.
 */

export class Failure extends Schema.TaggedError<Failure>()(
  "SandboxConformanceFailure",
  {
    /** The case that failed. */
    case: Schema.String,
    detail: Schema.String
  }
) {
  override get message() {
    return `sandbox conformance: ${this.case}: ${this.detail}`
  }
}

/**
 * Commands the suite can ask the provider to run.
 *
 * A sandbox runs *programs*, and which program prints its arguments back
 * is the host's business -- `node -e` on one, `sh -c` on another, a
 * scripted executor in memory. The suite asks for the behaviour and the
 * caller says how to get it. Without `programs` every exec case is skipped
 * and the report says `exec: false`.
 */
export interface Programs {
  /** Print `text` to stdout, nothing to stderr, exit 0. */
  readonly echo: (text: string) => Sandbox.Command
  /** Print `text` to stderr, nothing to stdout, exit 0. */
  readonly stderr: (text: string) => Sandbox.Command
  /** Exit with `code`, printing nothing. */
  readonly exit: (code: number) => Sandbox.Command
  /** Print the received arguments as a JSON array of strings, exit 0. */
  readonly argv: (args: ReadonlyArray<string>) => Sandbox.Command
  /** Keep running for at least `millis`. */
  readonly sleep: (millis: number) => Sandbox.Command
  /** Write `bytes` bytes to stdout. */
  readonly emit: (bytes: number) => Sandbox.Command
}

export interface Options {
  readonly programs?: Programs | undefined
  /** The workspace label acquired for every case. Default `conformance`. */
  readonly workspace?: string | undefined
}

export type Area = "files" | "identity" | "exec"

export interface Case {
  readonly name: string
  readonly area: Area
  readonly run: Effect.Effect<void, Failure, Sandbox.SandboxProvider>
}

/** What the exec probes established, when they ran. */
export interface Capabilities {
  /** `programs` were supplied and a plain command ran. */
  readonly exec: boolean
  readonly separateStderr: boolean
  readonly timeout: boolean
  readonly outputBound: boolean
}

export interface Report {
  readonly passed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<{ readonly name: string; readonly detail: string }>
  readonly capabilities: Capabilities
}

// ---------------------------------------------------------------------------
// Helpers

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const check = (name: string) => (condition: boolean, detail: string): Effect.Effect<void, Failure> =>
  condition ? Effect.void : Effect.fail(new Failure({ case: name, detail }))

/** A validated path; the suite's own paths are well-formed by construction. */
const at = (value: string): Effect.Effect<Sandbox.SandboxPath, Failure> =>
  Effect.mapError(
    Sandbox.path(value),
    (error) => new Failure({ case: "path", detail: `suite path ${JSON.stringify(value)} refused: ${error.message}` })
  )

const describeExit = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isSuccess(exit)
    ? `succeeded with ${JSON.stringify(exit.value)}`
    : `failed with ${Cause.pretty(exit.cause)}`

/** Any error the sandbox itself raised inside a case is that case's failure. */
const asFailure = (name: string) =>
  <A, R>(effect: Effect.Effect<A, Failure | Sandbox.FileError | Sandbox.ExecError, R>): Effect.Effect<A, Failure, R> =>
    Effect.catch(effect, (error) =>
      Effect.fail(error._tag === "SandboxConformanceFailure" ? error : new Failure({ case: name, detail: error.message })))

const tagOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.findErrorOption(exit.cause)
  return Option.isSome(error) && typeof error.value === "object" && error.value !== null && "_tag" in error.value
    ? String((error.value as { _tag: unknown })._tag)
    : undefined
}

/** The sandbox's errors carry namespaced tags; a case names the bare one. */
const hasTag = (exit: Exit.Exit<unknown, unknown>, name: string): boolean => {
  const tag = tagOf(exit)
  return tag === name || (tag !== undefined && tag.endsWith("/" + name))
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const named = (
  name: string,
  area: Area,
  workspace: string,
  body: (sandbox: Sandbox.Sandbox, expect: ReturnType<typeof check>) => Effect.Effect<void, Failure>
): Case => ({
  name,
  area,
  run: Effect.scoped(
    Effect.flatMap(
      Effect.mapError(
        Sandbox.acquire(Sandbox.workspace(workspace)),
        (error) => new Failure({ case: name, detail: `acquire failed: ${String(error)}` })
      ),
      (sandbox) => body(sandbox, check(name))
    )
  )
})

// ---------------------------------------------------------------------------
// The cases

const fileCases = (workspace: string): ReadonlyArray<Case> => [
  named("files: bytes written are the bytes read back", "files", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const file = yield* at("conformance/bytes.bin")
      const payload = new Uint8Array([0, 1, 2, 255, 254, 10, 13])
      yield* sandbox.write(file, payload)
      const back = yield* sandbox.read(file)
      yield* expect(
        back.length === payload.length && back.every((byte, index) => byte === payload[index]),
        `read back ${JSON.stringify(Array.from(back))}, wrote ${JSON.stringify(Array.from(payload))}`
      )
      // Text goes in as UTF-8 and comes out as the same bytes.
      const text = yield* at("conformance/text.txt")
      yield* sandbox.write(text, "héllo — 日本")
      yield* expect(decode(yield* sandbox.read(text)) === "héllo — 日本", "text did not round-trip as UTF-8")
    }).pipe(asFailure("files: bytes written are the bytes read back"))
  ),
  named("files: a write replaces, and a nested write creates its parents", "files", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const deep = yield* at("conformance/a/b/c/deep.txt")
      yield* sandbox.write(deep, "first")
      yield* sandbox.write(deep, "second")
      yield* expect(decode(yield* sandbox.read(deep)) === "second", "the second write did not replace the first")
      const parent = yield* sandbox.stat(yield* at("conformance/a/b"))
      yield* expect(parent.type === "directory", `parent of a nested write is ${parent.type}, not a directory`)
    }).pipe(asFailure("files: a write replaces, and a nested write creates its parents"))
  ),
  named("files: list returns workspace paths, one level, sorted, typed", "files", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      yield* sandbox.write(yield* at("conformance/list/b.txt"), "b")
      yield* sandbox.write(yield* at("conformance/list/a.txt"), "a")
      yield* sandbox.write(yield* at("conformance/list/sub/inner.txt"), "i")
      const entries = yield* sandbox.list(yield* at("conformance/list"))
      const paths = entries.map((entry) => entry.path)
      yield* expect(
        paths.every((path) => path.startsWith("conformance/list/")),
        `entries are not workspace paths: ${JSON.stringify(paths)} (names instead of paths?)`
      )
      yield* expect(
        !paths.includes("conformance/list/sub/inner.txt" as Sandbox.SandboxPath),
        "list descended into a subdirectory; it must be one level"
      )
      yield* expect(
        JSON.stringify(paths) === JSON.stringify([...paths].sort()),
        `entries are not sorted: ${JSON.stringify(paths)}`
      )
      const types = Object.fromEntries(entries.map((entry) => [entry.path, entry.type]))
      yield* expect(types["conformance/list/a.txt"] === "file", "a.txt is not typed as a file")
      yield* expect(types["conformance/list/sub"] === "directory", "sub is not typed as a directory")
    }).pipe(asFailure("files: list returns workspace paths, one level, sorted, typed"))
  ),
  named("files: stat reports type and size; a directory is not a file", "files", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const file = yield* at("conformance/stat/five.txt")
      yield* sandbox.write(file, "12345")
      const entry = yield* sandbox.stat(file)
      yield* expect(entry.type === "file", `a file stats as ${entry.type}`)
      yield* expect(entry.path === file, `stat returned path ${entry.path}, asked for ${file}`)
      yield* expect(
        Option.isSome(entry.size) && entry.size.value === 5,
        `size of a five-byte file reported as ${JSON.stringify(entry.size)}`
      )
      const dir = yield* sandbox.stat(yield* at("conformance/stat"))
      yield* expect(dir.type === "directory", `a directory stats as ${dir.type}`)
      const reading = yield* Effect.exit(sandbox.read(yield* at("conformance/stat")))
      yield* expect(Exit.isFailure(reading), "reading a directory as a file succeeded")
    }).pipe(asFailure("files: stat reports type and size; a directory is not a file"))
  ),
  named("files: a missing path is FileMissingError on read, stat and list", "files", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const missing = yield* at("conformance/nowhere/none.txt")
      for (const [operation, exit] of [
        ["read", yield* Effect.exit(sandbox.read(missing))],
        ["stat", yield* Effect.exit(sandbox.stat(missing))],
        ["list", yield* Effect.exit(sandbox.list(missing))]
      ] as const) {
        yield* expect(
          hasTag(exit, "FileMissingError"),
          `${operation} of a missing path ${describeExit(exit)}; expected FileMissingError`
        )
      }
    })
  )
]

const identityCases = (workspace: string): ReadonlyArray<Case> => [
  named("identity: canonical is stable, distinct per file, and available before the file exists", "identity", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const one = yield* at("conformance/id/one.txt")
      const two = yield* at("conformance/id/two.txt")
      const future = yield* at("conformance/id/not/yet/created.txt")
      yield* sandbox.write(one, "1")
      yield* sandbox.write(two, "2")
      const a1 = yield* sandbox.canonical(one)
      const a2 = yield* sandbox.canonical(one)
      const b = yield* sandbox.canonical(two)
      yield* expect(a1 === a2, "two canonical calls on one file disagree")
      yield* expect(a1 !== b, "two different files share a canonical identity")
      const early = yield* sandbox.canonical(future)
      yield* sandbox.write(future, "now")
      const late = yield* sandbox.canonical(future)
      yield* expect(early === late, "canonical of a path changed when the file was created")
      yield* expect(early !== a1 && early !== b, "a new file's identity collides with an existing one")
    }).pipe(asFailure("identity: canonical is stable, distinct per file, and available before the file exists"))
  )
]

/** The names the report derives capabilities from. */
const EXEC_PLAIN = "exec: stdout arrives, a non-zero exit is a result"
const EXEC_STDERR = "exec: stderr is separate from stdout"
const EXEC_TIMEOUT = "exec: timeout is TimeoutError, not a hang"
const EXEC_OUTPUT = "exec: maxOutputBytes is OutputLimitError"

const execCases = (workspace: string, programs: Programs): ReadonlyArray<Case> => [
  named(EXEC_PLAIN, "exec", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const hello = yield* sandbox.exec(programs.echo("hello conformance"))
      yield* expect(hello.exitCode === 0, `echo exited ${hello.exitCode}`)
      yield* expect(hello.stdout.trim() === "hello conformance", `stdout was ${JSON.stringify(hello.stdout)}`)
      const failing = yield* sandbox.exec(programs.exit(3))
      yield* expect(failing.exitCode === 3, `exit(3) reported exit code ${failing.exitCode}`)
    }).pipe(asFailure(EXEC_PLAIN))
  ),
  named("exec: arguments with spaces, quotes and $ arrive intact, unshelled", "exec", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const args = ["two words", "it's \"quoted\"", "$HOME and %PATH%", "--flag=a b", "*"]
      const result = yield* sandbox.exec(programs.argv(args))
      yield* expect(result.exitCode === 0, `argv program exited ${result.exitCode}: ${result.stderr}`)
      const received = parseJson(result.stdout)
      yield* expect(
        JSON.stringify(received) === JSON.stringify(args),
        `arguments arrived as ${result.stdout.trim()}, sent ${JSON.stringify(args)}`
      )
    }).pipe(Effect.catch((error) => error._tag === "SandboxConformanceFailure"
      ? Effect.fail(error)
      : Effect.fail(new Failure({ case: "exec: arguments with spaces, quotes and $ arrive intact, unshelled", detail: `exec failed: ${error.message}` }))))
  ),
  named(EXEC_STDERR, "exec", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const result = yield* sandbox.exec(programs.stderr("to stderr only"))
      // Merged streams are diagnosed as such before an empty stderr is.
      yield* expect(!result.stdout.includes("to stderr only"), "stderr text appeared on stdout: the streams are merged")
      yield* expect(result.stderr.includes("to stderr only"), `stderr was ${JSON.stringify(result.stderr)}`)
      const out = yield* sandbox.exec(programs.echo("to stdout only"))
      yield* expect(!out.stderr.includes("to stdout only"), "stdout text appeared on stderr: the streams are merged")
    }).pipe(asFailure(EXEC_STDERR))
  ),
  named(EXEC_TIMEOUT, "exec", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        sandbox.exec(programs.sleep(5_000), { timeout: "250 millis" }).pipe(
          // The provider's bound must fire first; this outer one only keeps
          // a provider that ignores `timeout` from hanging the suite.
          Effect.timeoutOption("3 seconds")
        )
      )
      yield* expect(
        hasTag(exit, "TimeoutError"),
        Exit.isSuccess(exit) && Option.isNone(exit.value)
          ? "the provider ignored `timeout`: the command was still running 3 seconds later"
          : `a command past its timeout ${describeExit(exit)}; expected TimeoutError`
      )
    })
  ),
  named(EXEC_OUTPUT, "exec", workspace, (sandbox, expect) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(sandbox.exec(programs.emit(256 * 1024), { maxOutputBytes: 4 * 1024 }))
      yield* expect(
        hasTag(exit, "OutputLimitError"),
        `a command over its output bound ${describeExit(exit).slice(0, 200)}; expected OutputLimitError`
      )
      const under = yield* Effect.exit(sandbox.exec(programs.emit(1024), { maxOutputBytes: 4 * 1024 }))
      yield* expect(Exit.isSuccess(under), `a command under its output bound ${describeExit(under).slice(0, 200)}`)
    })
  )
]

/** Every case the suite holds a provider to, given what it can be asked to run. */
export const cases = (options?: Options): ReadonlyArray<Case> => {
  const workspace = options?.workspace ?? "conformance"
  return [
    ...fileCases(workspace),
    ...identityCases(workspace),
    ...(options?.programs === undefined ? [] : execCases(workspace, options.programs))
  ]
}

/**
 * Run every case against a provider and report, deriving the capabilities
 * from which exec probes held. Never fails: a failing case is a line in the
 * report, and a defect in a provider is reported as the case's failure too.
 */
export const run = <E>(
  provider: Layer.Layer<Sandbox.SandboxProvider, E>,
  options?: Options
): Effect.Effect<Report, E> =>
  Effect.gen(function* () {
    const passed: Array<string> = []
    const failed: Array<{ name: string; detail: string }> = []
    for (const entry of cases(options)) {
      const exit = yield* Effect.exit(entry.run)
      if (Exit.isSuccess(exit)) {
        passed.push(entry.name)
      } else {
        const error = Cause.findErrorOption(exit.cause)
        failed.push({
          name: entry.name,
          detail: Option.isSome(error) ? error.value.detail : `defect: ${Cause.pretty(exit.cause)}`
        })
      }
    }
    const held = (name: string) => passed.includes(name)
    return {
      passed,
      failed,
      capabilities: {
        exec: held(EXEC_PLAIN),
        separateStderr: held(EXEC_STDERR),
        timeout: held(EXEC_TIMEOUT),
        outputBound: held(EXEC_OUTPUT)
      }
    }
  }).pipe(Effect.provide(provider))
