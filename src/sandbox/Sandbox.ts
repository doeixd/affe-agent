import { Cause, Context, Duration, Effect, Encoding, Layer, Option, Result, Schema, Scope, Stream } from "effect"

/**
 * A scoped filesystem-and-process capability, acquired through a provider.
 *
 * This package exists to prove the composition the whole design bets on: an
 * application defines its own tools, those tools demand `Sandbox` through the
 * ordinary requirement channel, and swapping the in-memory provider for the
 * local one is layer wiring — the agent core never learns sandboxes exist. It
 * is deliberately *not* a coding-agent framework: no first-party
 * `read_file`/`run_command` tools are exported, because the example below is
 * what user code looks like.
 */

/** Identifies a sandbox root. Providers decide what the label means. */
export const Workspace = Schema.String.pipe(
  Schema.brand("affe-agent/sandbox/Workspace")
)
export type Workspace = typeof Workspace.Type

export const workspace = (label: string): Workspace => label as Workspace

/**
 * A path relative to the sandbox root.
 *
 * Absolute paths, drive letters and any `..` segment are refused, and segments
 * are normalised to "/" so the value is portable across providers. Every handle
 * that reaches a sandbox has therefore already passed the check.
 *
 * **The refinement is on the brand, not only in `path()`.** A bare
 * `Schema.brand` would let `SandboxPath.makeUnsafe("../etc/passwd")` produce a
 * value the type says is safe and the constructor would have refused, and two
 * features now sit downstream of that promise: `internal/fileLock.ts` keys
 * mutual exclusion on these, and `Shell` builds argv from them. A type that
 * means "somebody branded a string" is not the same claim as "this cannot
 * escape the workspace", and only the second is worth having here.
 *
 * `path()` remains the constructor to reach for -- it normalises as well as
 * validates, and reports why in an `InvalidPathError` rather than a schema
 * issue. The refinement is what makes every *other* route agree with it.
 *
 * The rules live in `isSandboxPath` so the schema and `path()` cannot drift:
 * two checks that are supposed to agree and are written separately do not stay
 * agreeing.
 */
export const isSandboxPath = (value: string): boolean => {
  if (value.length === 0) return false
  // A NUL byte is not a filename character on any supported host, and it is
  // the classic truncation trick: `a.txt<NUL>.png` names one file to a check
  // written in JavaScript and another to a C API that stops at the NUL.
  // Nothing was escaping the workspace -- the local provider surfaced it as a
  // `ProviderError` from `fs` -- but that is the provider refusing an input
  // this type already claims to have validated, reported in the wrong error
  // class. Refusing it here makes the brand's promise true and gives `path()`
  // an `InvalidPathError` to report instead.
  if (value.includes("\u0000")) return false
  if (value.includes("\\")) return false
  if (/^([a-zA-Z]:)?\//.test(value)) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  const segments = value.split("/")
  if (segments.includes("..")) return false
  return segments.some((segment) => segment !== "" && segment !== ".")
}

export const SandboxPath = Schema.String.check(
  Schema.makeFilter((value) =>
    isSandboxPath(value)
      ? undefined
      : "not a workspace-relative path: no leading '/', no drive letter, no '..' segment, '/' separators"
  )
).pipe(Schema.brand("affe-agent/sandbox/SandboxPath"))
export type SandboxPath = typeof SandboxPath.Type

export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()(
  "affe-agent/sandbox/InvalidPathError",
  { path: Schema.String, reason: Schema.String }
) {
  override get message() {
    return `Invalid sandbox path "${this.path}": ${this.reason}`
  }
}

export const path = (
  value: string
): Effect.Effect<SandboxPath, InvalidPathError> => {
  const normalised = value.replaceAll("\\", "/")
  if (normalised.length === 0) {
    return Effect.fail(
      new InvalidPathError({ path: value, reason: "the path is empty" })
    )
  }
  // Kept in step with `isSandboxPath`, which refuses the same byte: the two
  // checks agree or the brand stops meaning what it says.
  if (normalised.includes("\u0000")) {
    return Effect.fail(
      new InvalidPathError({
        path: value,
        reason: "a NUL byte is not a filename character"
      })
    )
  }
  if (/^([a-zA-Z]:)?\//.test(normalised)) {
    return Effect.fail(
      new InvalidPathError({
        path: value,
        reason: "absolute paths are refused; paths are relative to the workspace"
      })
    )
  }
  if (/^[a-zA-Z]:/.test(normalised)) {
    return Effect.fail(
      new InvalidPathError({
        path: value,
        reason: "drive-qualified paths are refused"
      })
    )
  }
  const segments = normalised.split("/")
  for (const segment of segments) {
    if (segment === "..") {
      return Effect.fail(
        new InvalidPathError({
          path: value,
          reason: "\"..\" segments are refused; the path cannot escape the workspace"
        })
      )
    }
  }
  const clean = segments.filter((segment) => segment !== "" && segment !== ".")
  if (clean.length === 0) {
    return Effect.fail(
      new InvalidPathError({ path: value, reason: "the path names no file" })
    )
  }
  return Effect.succeed(clean.join("/") as SandboxPath)
}

// ---------------------------------------------------------------------------
// Errors

/** The file or directory does not exist in the sandbox. */
export class FileMissingError extends Schema.TaggedError<FileMissingError>()(
  "affe-agent/sandbox/FileMissingError",
  { path: Schema.String }
) {
  override get message() {
    return `No such file or directory in the sandbox: ${this.path}`
  }
}

/** The provider refused the operation on its own authority. */
export class PermissionDeniedError extends
  Schema.TaggedError<PermissionDeniedError>()(
    "affe-agent/sandbox/PermissionDeniedError",
    { path: Schema.String, operation: Schema.Literals(["read", "write", "list", "stat", "execute"]) }
  ) {
  override get message() {
    return `Permission denied (${this.operation}): ${this.path}`
  }
}

/** The process could not be started at all. */
export class CommandLaunchError extends Schema.TaggedError<CommandLaunchError>()(
  "affe-agent/sandbox/CommandLaunchError",
  { executable: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `Failed to launch "${this.executable}": ${this.detail}`
  }
}

/** The process ran but exited non-zero; only `execChecked` raises this. */
export class ExitStatusError extends Schema.TaggedError<ExitStatusError>()(
  "affe-agent/sandbox/ExitStatusError",
  {
    executable: Schema.String,
    exitCode: Schema.Number,
    stderrTail: Schema.optional(Schema.String)
  }
) {
  override get message() {
    const tail = this.stderrTail === undefined ? "" : `: ${this.stderrTail}`
    return `"${this.executable}" exited with code ${this.exitCode}${tail}`
  }
}

/** The process exceeded its time budget and was killed. */
export class TimeoutError extends Schema.TaggedError<TimeoutError>()(
  "affe-agent/sandbox/TimeoutError",
  { executable: Schema.String, timeoutMillis: Schema.Number }
) {
  override get message() {
    return `"${this.executable}" exceeded ${this.timeoutMillis}ms and was killed`
  }
}

/** The process produced more output than allowed and was killed. */
export class OutputLimitError extends Schema.TaggedError<OutputLimitError>()(
  "affe-agent/sandbox/OutputLimitError",
  { executable: Schema.String, maxOutputBytes: Schema.Number }
) {
  override get message() {
    return `"${this.executable}" exceeded the ${this.maxOutputBytes}-byte output limit and was killed`
  }
}

/** The provider itself failed, in a way none of the above describe. */
export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "affe-agent/sandbox/ProviderError",
  { detail: Schema.String }
) {
  override get message() {
    return `Sandbox provider failure: ${this.detail}`
  }
}

export type FileError =
  | FileMissingError
  | InvalidPathError
  | PermissionDeniedError
  | ProviderError

export type ExecError =
  | CommandLaunchError
  | TimeoutError
  | OutputLimitError
  | PermissionDeniedError
  | InvalidPathError
  | ProviderError

// ---------------------------------------------------------------------------
// Values

export interface Command {
  /** The program to run. Never interpreted by a shell. */
  readonly executable: string
  /** Arguments passed verbatim, separately from the executable. */
  readonly args: ReadonlyArray<string>
}

export const command = (
  executable: string,
  args: ReadonlyArray<string> = []
): Command => ({ executable, args })

export interface CommandResult {
  /** The process exit code, or -1 when it was ended by a signal. */
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  /**
   * The signal that ended the process, when one did -- the OOM killer, a
   * kill from outside the sandbox. Absent for a process that exited on its
   * own. A `-1` exit code alone cannot say which happened.
   */
  readonly signal?: string | undefined
}

/**
 * One thing that happened while a command ran.
 *
 * `exec` hands back a `CommandResult` when the process is already over, which
 * is the right shape for `git status` and the wrong one for anything you want
 * to *watch*: a build's progress, a long test run, or an external agent
 * emitting `stream-json` whose permission prompts have to be answered while it
 * is still running. Those need the output as it arrives.
 *
 * The exit is an event rather than a separate channel because it keeps the
 * ordering honest -- output that arrived before the process ended is delivered
 * before it, and there is exactly one way to learn the code. A stream that
 * ends without an `Exit` is a provider bug, and `collect` says so rather than
 * inventing a zero.
 */
export type ExecEvent =
  | {
    readonly _tag: "Output"
    readonly stream: "stdout" | "stderr"
    /**
     * Bytes exactly as the process wrote them, not text.
     *
     * A chunk boundary can fall inside a multi-byte character, so decoding
     * each chunk on its own corrupts it. `lines` does the decoding across
     * boundaries, in one place; anything else that needs text should go
     * through `Stream.decodeText` rather than per-chunk `TextDecoder`.
     */
    readonly bytes: Uint8Array
  }
  | {
    readonly _tag: "Exit"
    /** The process exit code, or -1 when it was ended by a signal. */
    readonly exitCode: number
    readonly signal?: string | undefined
  }

export const outputEvent = (
  stream: "stdout" | "stderr",
  bytes: Uint8Array
): ExecEvent => ({ _tag: "Output", stream, bytes })

export const exitEvent = (
  exitCode: number,
  signal?: string | undefined
): ExecEvent => ({
  _tag: "Exit",
  exitCode,
  ...(signal === undefined ? {} : { signal })
})

/**
 * One stream's output as complete lines, decoded across chunk boundaries.
 *
 * This is the shape line-delimited protocols want -- `stream-json`, NDJSON, a
 * progress log -- and it is the reason `ExecEvent` carries bytes: the split
 * and the decode both have to happen after reassembly, and doing them here
 * means every caller gets it right once.
 */
export const lines = <E, R>(
  events: Stream.Stream<ExecEvent, E, R>,
  stream: "stdout" | "stderr" = "stdout"
): Stream.Stream<string, E, R> =>
  events.pipe(
    Stream.filter((event): event is Extract<ExecEvent, { _tag: "Output" }> =>
      event._tag === "Output" && event.stream === stream
    ),
    Stream.map((event) => event.bytes),
    Stream.decodeText(),
    Stream.splitLines
  )

/**
 * Run a stream of events to the `CommandResult` `exec` would have returned.
 *
 * Two things make this worth exporting rather than inlining. It is how a
 * provider that streams natively also satisfies `exec` -- one process
 * implementation, not two that drift -- and it is what lets the conformance
 * suite assert the two surfaces agree on the same command.
 */
export const collect = <R>(
  events: Stream.Stream<ExecEvent, ExecError, R>
): Effect.Effect<CommandResult, ExecError, R> =>
  Stream.runFold(
    events,
    () => ({
      stdout: [] as Array<Uint8Array>,
      stderr: [] as Array<Uint8Array>,
      exit: undefined as { readonly exitCode: number; readonly signal?: string | undefined } | undefined
    }),
    (state, event) => {
      if (event._tag === "Exit") return { ...state, exit: event }
      ;(event.stream === "stdout" ? state.stdout : state.stderr).push(event.bytes)
      return state
    }
  ).pipe(
    Effect.flatMap((state) =>
      // No `Exit` event means nobody can say how the command ended, and a
      // fabricated zero would be the worst possible guess. This is also what
      // makes `collect` refuse a truncated stream rather than report a
      // partial run as a finished one.
      state.exit === undefined
        ? Effect.fail(
          new ProviderError({
            detail: "the command's event stream ended without an exit event"
          })
        )
        : Effect.succeed<CommandResult>({
          exitCode: state.exit.exitCode,
          stdout: decodeAll(state.stdout),
          stderr: decodeAll(state.stderr),
          ...(state.exit.signal === undefined ? {} : { signal: state.exit.signal })
        })
    )
  )

const decodeAll = (chunks: ReadonlyArray<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let text = ""
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

export interface ExecOptions {
  /**
   * Kill the process if it runs longer. Default 10 seconds.
   *
   * The default suits a command you wait on. A command you *watch* through
   * `execStream` -- a build, a test run, an external agent -- normally needs a
   * much larger one, and gets a `TimeoutError` mid-stream without it.
   */
  readonly timeout?: Duration.Input | undefined
  /**
   * Kill the process if it emits more combined output. Default 1 MiB.
   *
   * Counted as the bytes the process produced, whether or not a streaming
   * consumer keeps them -- so it bounds a runaway process rather than this
   * program's memory, and a long watch should raise it.
   */
  readonly maxOutputBytes?: number | undefined
}

export interface Entry {
  readonly path: SandboxPath
  readonly type: "file" | "directory"
  readonly size: Option.Option<number>
}

// ---------------------------------------------------------------------------
// The sandbox handle

export interface Sandbox {
  readonly workspace: Workspace
  readonly read: (path: SandboxPath) => Effect.Effect<Uint8Array, FileError>
  readonly write: (
    path: SandboxPath,
    content: Uint8Array | string
  ) => Effect.Effect<void, FileError>
  readonly list: (
    path?: SandboxPath | undefined
  ) => Effect.Effect<ReadonlyArray<Entry>, FileError>
  readonly stat: (path: SandboxPath) => Effect.Effect<Entry, FileError>
  /**
   * A string that is equal for every name of the same file, and different for
   * different files -- the identity a lock should key on.
   *
   * On a real filesystem two spellings can reach one file (a symlink, a
   * differently-cased path, an 8.3 short name), and a lock keyed on the
   * spelling lets them race. The path need not exist: a name that is about
   * to be created resolves through its deepest existing ancestor, so a write
   * can take the lock before the file does. The result is opaque -- compare
   * it, never parse it.
   */
  readonly canonical: (path: SandboxPath) => Effect.Effect<string, FileError>
  /**
   * Run a command inside the workspace. A non-zero exit is an ordinary
   * result; use `execChecked` when it must be an error instead.
   */
  readonly exec: (
    command: Command,
    options?: ExecOptions | undefined
  ) => Effect.Effect<CommandResult, ExecError>
  /**
   * The same command, watched while it runs.
   *
   * Required on the handle, and optional on `Operations`: a consumer must be
   * able to rely on it existing, while a provider that cannot stream gets a
   * derivation (buffer, then emit once at exit) and is reported as derived.
   * `collect(execStream(...))` is `exec` -- the conformance suite asserts it.
   *
   * **The `ExecOptions` defaults are `exec`'s, and a watcher usually wants
   * neither.** They are 10 seconds and 1 MiB, chosen for a command you wait
   * on; the things worth watching -- a build, a test run, an external agent --
   * outlive and outprint both, and would be killed mid-stream with a
   * `TimeoutError` or an `OutputLimitError`. Set them deliberately. They are
   * still enforced, and still worth having: an unbounded watch on a process
   * that never ends is a leak with a nicer name.
   */
  readonly execStream: (
    command: Command,
    options?: ExecOptions | undefined
  ) => Stream.Stream<ExecEvent, ExecError>
}

/** Text conveniences over the byte-level surface. */
export const readText = (sandbox: Sandbox) =>
  (path: SandboxPath): Effect.Effect<string, FileError> =>
    Effect.map(sandbox.read(path), (bytes) => new TextDecoder().decode(bytes))

export const writeText = (sandbox: Sandbox) =>
  (path: SandboxPath, text: string): Effect.Effect<void, FileError> =>
    sandbox.write(path, text)

/**
 * Like `exec`, but a non-zero exit is `ExitStatusError` carrying the tail of
 * stderr — for pipelines where continuing on bad state would be wrong.
 */
export const execChecked = (
  sandbox: Sandbox,
  command: Command,
  options?: ExecOptions | undefined
): Effect.Effect<
  CommandResult,
  ExecError | ExitStatusError
> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode === 0
      ? Effect.succeed(result)
      : Effect.fail(new ExitStatusError({
        executable: command.executable,
        exitCode: result.exitCode,
        ...(result.stderr.length > 0 ? { stderrTail: result.stderr.slice(-500) } : {})
      })))

// ---------------------------------------------------------------------------
// The provider service

export type SandboxProviderService = {
  /**
   * Acquire a sandbox bound to the caller's scope: closing the scope releases
   * everything the provider created for it.
   */
  readonly acquire: (
    workspace: Workspace
  ) => Effect.Effect<Sandbox, ProviderError, Scope.Scope>
}

export class SandboxProvider extends Context.Service<SandboxProvider, SandboxProviderService>()(
  "affe-agent/sandbox/SandboxProvider"
) {}

/**
 * Demand the `Sandbox` service directly, having acquired it for a workspace.
 *
 * Tools declare this as their dependency; applications provide a
 * `SandboxProvider` layer underneath. Which provider runs is invisible here —
 * that is the entire point of the seam.
 */
export const acquire = (
  workspace: Workspace
): Effect.Effect<Sandbox, ProviderError, Scope.Scope | SandboxProvider> =>
  Effect.flatMap(SandboxProvider, (provider) => provider.acquire(workspace))

/**
 * A specific workspace's sandbox, acquired once and served as an ordinary
 * service.
 *
 * Tool handlers cannot demand the caller's `Scope`, so a tool that wants the
 * sandbox depends on this instead of on `SandboxProvider` directly; the
 * application wires `currentLayer` over whichever provider it is running,
 * and the acquisition lives in that wiring rather than in every handler.
 */
export class Current extends Context.Service<Current, Sandbox>()(
  "affe-agent/sandbox/Current"
) {}

export const currentLayer = (
  workspace: Workspace
): Layer.Layer<
  Current,
  ProviderError,
  Scope.Scope | SandboxProvider
> =>
  Layer.effect(Current, acquire(workspace))

/** Millis for an `ExecOptions.timeout`, applying the default. */
export const timeoutMillis = (options: ExecOptions | undefined): number =>
  Duration.toMillis(options?.timeout ?? "10 seconds")

// ---------------------------------------------------------------------------
// Tier 0 and tier 1 providers: exec is enough

/**
 * What `fromOperations` needs, and what it will use natively when offered.
 *
 * `exec` is the one required primitive: run a command with a working
 * directory. Everything else is derived from POSIX commands over it --
 * `sh`, `base64`, `find`, `stat -c`, `readlink -f` -- which is tier 0 of
 * `docs/plan-integrations.md` §6: any host that can run a command is a
 * sandbox in one expression. The costs are stated there and are real:
 * binary content rides base64 through argv, errors arrive as exit codes and
 * stderr text, a Windows-only userland needs overrides, one process per
 * file operation, and large files should not travel this way.
 *
 * Each optional operation, when present, replaces its derivation. Paths
 * handed to overrides are `directory(workspace)` + the sandbox path -- the
 * provider's own name for the file.
 */
export interface Operations {
  readonly exec: (
    command: Command,
    options: ExecOptions & { readonly cwd: string }
  ) => Effect.Effect<CommandResult, ExecError>
  /**
   * Incremental output, when the host can give it.
   *
   * Omit it and `execStream` is derived from `exec`: the whole run is buffered
   * and delivered as one output event per stream followed by the exit. That is
   * a faithful *result* and a false *timeline*, so it is listed in `derived`
   * -- a caller watching for progress can ask whether it will actually get
   * any, instead of discovering it does not.
   */
  readonly execStream?:
    | ((
      command: Command,
      options: ExecOptions & { readonly cwd: string }
    ) => Stream.Stream<ExecEvent, ExecError>)
    | undefined
  readonly readFile?:
    | ((absolute: string) => Effect.Effect<Uint8Array, FileError>)
    | undefined
  readonly writeFile?:
    | ((absolute: string, content: Uint8Array) => Effect.Effect<void, FileError>)
    | undefined
  readonly readdir?:
    | ((absolute: string) => Effect.Effect<ReadonlyArray<{
      readonly name: string
      readonly type: "file" | "directory"
      readonly size: Option.Option<number>
    }>, FileError>)
    | undefined
  readonly stat?:
    | ((absolute: string) => Effect.Effect<{
      readonly type: "file" | "directory"
      readonly size: Option.Option<number>
    }, FileError>)
    | undefined
  readonly canonical?:
    | ((absolute: string) => Effect.Effect<string, FileError>)
    | undefined
}

/** What a failed derived command looked like, for classification. */
export interface ClassifyContext {
  readonly operation: "read" | "write" | "list" | "stat" | "canonical"
  readonly path: string
  readonly result: CommandResult
}

export interface DeriveOptions {
  /**
   * The working directory a workspace maps to; every derived command runs
   * with this as `cwd` and file paths are relative to it. Defaults to
   * `/tmp/affe-agent/<workspace>`, created at acquire. A provider whose
   * `exec` cannot start in a directory that does not exist yet should
   * pre-create it or supply one that does.
   */
  readonly directory?: ((workspace: Workspace) => string) | undefined
  /**
   * Turn a failed command into a typed file error. Consulted before the
   * POSIX default ("No such file" and "not a directory" are
   * `FileMissingError`, "Permission denied" is `PermissionDeniedError`);
   * return `undefined` to fall through to it.
   */
  readonly classify?:
    | ((context: ClassifyContext) => FileError | undefined)
    | undefined
}

const DERIVABLE = ["canonical", "execStream", "list", "read", "stat", "write"] as const
export type DerivedOperation = (typeof DERIVABLE)[number]

const utf8Encoder = new TextEncoder()

/**
 * A finished result as the events it would have produced, in order, with
 * empty streams omitted -- the derivation behind a non-streaming provider.
 */
export const eventsOf = (result: CommandResult): ReadonlyArray<ExecEvent> => [
  ...(result.stdout.length > 0 ? [outputEvent("stdout", utf8Encoder.encode(result.stdout))] : []),
  ...(result.stderr.length > 0 ? [outputEvent("stderr", utf8Encoder.encode(result.stderr))] : []),
  exitEvent(result.exitCode, result.signal)
]

const defaultClassify = (context: ClassifyContext): FileError => {
  const text = context.result.stderr + "\n" + context.result.stdout
  if (/no such file|not a directory/i.test(text)) {
    return new FileMissingError({ path: context.path })
  }
  if (/permission denied|operation not permitted/i.test(text)) {
    const operation = context.operation === "canonical" ? "stat" : context.operation
    return new PermissionDeniedError({ path: context.path, operation })
  }
  return new ProviderError({
    detail: `${context.operation} ${context.path}: exit ${context.result.exitCode}: ${context.result.stderr.slice(0, 300)}`
  })
}

/**
 * Tier 1: a provider from one `exec` plus whatever it does natively
 * (`docs/plan-integrations.md` §6.3). Everything omitted derives from POSIX
 * commands over `exec`; `derived` names exactly which operations are
 * shell-derived, so nothing pretends to be native that is not. Validated by
 * rebuilding the local provider from its own `exec` and passing
 * `SandboxConformance` (`test/SandboxDerive.test.ts`).
 */
export const fromOperations = (
  operations: Operations,
  options?: DeriveOptions
): {
  readonly layer: Layer.Layer<SandboxProvider>
  readonly derived: ReadonlyArray<DerivedOperation>
} => {
  const directoryOf = options?.directory ?? ((workspace: Workspace) => `/tmp/affe-agent/${workspace}`)
  const derived = DERIVABLE.filter((operation) => {
    switch (operation) {
      case "read":
        return operations.readFile === undefined
      case "write":
        return operations.writeFile === undefined
      case "list":
        return operations.readdir === undefined
      case "stat":
        return operations.stat === undefined
      case "canonical":
        return operations.canonical === undefined
      case "execStream":
        return operations.execStream === undefined
    }
  })

  const acquireSandbox = (workspace: Workspace): Effect.Effect<Sandbox, ProviderError> =>
    Effect.gen(function* () {
      const cwd = directoryOf(workspace)
      const absolute = (value: string) => `${cwd}/${value}`

      const shell = (
        operation: ClassifyContext["operation"],
        target: string,
        script: string,
        args: ReadonlyArray<string>
      ): Effect.Effect<CommandResult, FileError> =>
        operations.exec(command("sh", ["-c", script, "sh", ...args]), { cwd }).pipe(
          Effect.mapError((error): FileError => new ProviderError({ detail: `${operation} ${target}: ${error.message}` })),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result)
              : Effect.fail(
                options?.classify?.({ operation, path: target, result })
                  ?? defaultClassify({ operation, path: target, result })
              )
          )
        )

      // The workspace directory exists before anything else runs in it.
      yield* operations.exec(command("sh", ["-c", 'mkdir -p "$1"', "sh", cwd]), { cwd }).pipe(
        Effect.mapError((error) => new ProviderError({ detail: `could not prepare ${cwd}: ${error.message}` })),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(new ProviderError({ detail: `could not prepare ${cwd}: ${result.stderr.slice(0, 300)}` }))
        )
      )

      const decodeOut = (target: string, base64Text: string): Effect.Effect<Uint8Array, FileError> =>
        Effect.suspend(() => {
          const decoded = Encoding.decodeBase64(base64Text.replace(/\s+/g, ""))
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(new ProviderError({ detail: `read ${target}: the shell's base64 output did not decode` }))
        })

      const read = (path: SandboxPath): Effect.Effect<Uint8Array, FileError> =>
        operations.readFile !== undefined
          ? operations.readFile(absolute(path))
          : shell("read", path, 'base64 "$1"', [path]).pipe(
            Effect.flatMap((result) => decodeOut(path, result.stdout))
          )

      const write = (path: SandboxPath, content: Uint8Array | string): Effect.Effect<void, FileError> => {
        const bytes = typeof content === "string" ? utf8Encoder.encode(content) : content
        if (operations.writeFile !== undefined) return operations.writeFile(absolute(path), bytes)
        return shell(
          "write",
          path,
          'mkdir -p "$(dirname "$2")" && printf %s "$1" | base64 -d > "$2"',
          [Encoding.encodeBase64(bytes), path]
        ).pipe(Effect.asVoid)
      }

      const entryOf = (kind: string, size: string, entryPath: string): Entry => {
        const parsed = Number.parseInt(size, 10)
        return {
          path: entryPath as SandboxPath,
          type: kind.includes("directory") ? "directory" : "file",
          size: kind.includes("directory") || Number.isNaN(parsed) ? Option.none() : Option.some(parsed)
        }
      }

      const byPath = (left: Entry, right: Entry): number =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0

      const list = (path?: SandboxPath): Effect.Effect<ReadonlyArray<Entry>, FileError> => {
        const target = path ?? ("." as SandboxPath)
        if (operations.readdir !== undefined) {
          return operations.readdir(absolute(target)).pipe(
            Effect.map((entries) =>
              entries
                .map((entry): Entry => ({
                  path: (path === undefined ? entry.name : `${path}/${entry.name}`) as SandboxPath,
                  type: entry.type,
                  size: entry.size
                }))
                .sort(byPath)
            )
          )
        }
        return shell(
          "list",
          target,
          '[ -d "$1" ] || { echo "No such file or directory: $1" >&2; exit 1; }; find "$1" -mindepth 1 -maxdepth 1 -exec stat -c "%F|%s|%n" {} +',
          [target]
        ).pipe(
          Effect.map((result) =>
            result.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line !== "")
              .map((line) => {
                const [kind = "", size = "", ...rest] = line.split("|")
                const raw = rest.join("|")
                return entryOf(kind, size, raw.startsWith("./") ? raw.slice(2) : raw)
              })
              .sort(byPath)
          )
        )
      }

      const stat = (path: SandboxPath): Effect.Effect<Entry, FileError> =>
        operations.stat !== undefined
          ? operations.stat(absolute(path)).pipe(Effect.map((info) => ({ path, ...info })))
          : shell("stat", path, 'stat -c "%F|%s" "$1"', [path]).pipe(
            Effect.map((result) => {
              const [kind = "", size = ""] = result.stdout.trim().split("|")
              return entryOf(kind, size, path)
            })
          )

      const canonical = (path: SandboxPath): Effect.Effect<string, FileError> =>
        operations.canonical !== undefined
          ? operations.canonical(absolute(path))
          : shell(
            "canonical",
            path,
            'p="$1"; rest=""; while [ ! -e "$p" ] && [ "$p" != "/" ] && [ "$p" != "." ]; do rest="/$(basename "$p")$rest"; p=$(dirname "$p"); done; printf "%s%s" "$(readlink -f "$p")" "$rest"',
            [path]
          ).pipe(Effect.map((result) => result.stdout.trim()))

      return {
        workspace,
        read,
        write,
        list,
        stat,
        canonical,
        exec: (execCommand, execOptions) => operations.exec(execCommand, { ...execOptions, cwd }),
        execStream: (execCommand, execOptions) =>
          operations.execStream !== undefined
            ? operations.execStream(execCommand, { ...execOptions, cwd })
            : Stream.unwrap(Effect.map(
              operations.exec(execCommand, { ...execOptions, cwd }),
              (result) => Stream.fromArray(eventsOf(result))
            ))
      } satisfies Sandbox
    })

  const layer = Layer.succeed(SandboxProvider, {
    acquire: (workspace) => acquireSandbox(workspace)
  })
  return { layer, derived }
}

/**
 * Tier 0: the whole provider from one function
 * (`docs/plan-integrations.md` §6.2). Any host that can run a command -- an
 * SSH box, a container exec, a CI runner -- becomes a sandbox in one
 * expression, every file operation derived and reported as such.
 */
export const fromExec = (
  exec: Operations["exec"],
  options?: DeriveOptions
): {
  readonly layer: Layer.Layer<SandboxProvider>
  readonly derived: ReadonlyArray<DerivedOperation>
} => fromOperations({ exec }, options)

