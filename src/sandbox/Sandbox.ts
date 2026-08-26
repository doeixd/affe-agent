import { Context, Duration, Effect, Layer, Option, Schema, Scope } from "effect"

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
  Schema.brand("@doeixd/effect-agent/sandbox/Workspace")
)
export type Workspace = typeof Workspace.Type

export const workspace = (label: string): Workspace => label as Workspace

/**
 * A path relative to the sandbox root.
 *
 * Validation is runtime work a schema cannot express: absolute paths and any
 * `..` segment are refused at construction, so every handle that reaches a
 * sandbox has already passed the check. Segments are normalised to "/" so the
 * value is portable across providers.
 */
export const SandboxPath = Schema.String.pipe(
  Schema.brand("@doeixd/effect-agent/sandbox/SandboxPath")
)
export type SandboxPath = typeof SandboxPath.Type

export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()(
  "@doeixd/effect-agent/sandbox/InvalidPathError",
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
  "@doeixd/effect-agent/sandbox/FileMissingError",
  { path: Schema.String }
) {
  override get message() {
    return `No such file or directory in the sandbox: ${this.path}`
  }
}

/** The provider refused the operation on its own authority. */
export class PermissionDeniedError extends
  Schema.TaggedError<PermissionDeniedError>()(
    "@doeixd/effect-agent/sandbox/PermissionDeniedError",
    { path: Schema.String, operation: Schema.Literals(["read", "write", "list", "stat", "execute"]) }
  ) {
  override get message() {
    return `Permission denied (${this.operation}): ${this.path}`
  }
}

/** The process could not be started at all. */
export class CommandLaunchError extends Schema.TaggedError<CommandLaunchError>()(
  "@doeixd/effect-agent/sandbox/CommandLaunchError",
  { executable: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `Failed to launch "${this.executable}": ${this.detail}`
  }
}

/** The process ran but exited non-zero; only `execChecked` raises this. */
export class ExitStatusError extends Schema.TaggedError<ExitStatusError>()(
  "@doeixd/effect-agent/sandbox/ExitStatusError",
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
  "@doeixd/effect-agent/sandbox/TimeoutError",
  { executable: Schema.String, timeoutMillis: Schema.Number }
) {
  override get message() {
    return `"${this.executable}" exceeded ${this.timeoutMillis}ms and was killed`
  }
}

/** The process produced more output than allowed and was killed. */
export class OutputLimitError extends Schema.TaggedError<OutputLimitError>()(
  "@doeixd/effect-agent/sandbox/OutputLimitError",
  { executable: Schema.String, maxOutputBytes: Schema.Number }
) {
  override get message() {
    return `"${this.executable}" exceeded the ${this.maxOutputBytes}-byte output limit and was killed`
  }
}

/** The provider itself failed, in a way none of the above describe. */
export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "@doeixd/effect-agent/sandbox/ProviderError",
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

export interface ExecOptions {
  /** Kill the process if it runs longer. Default 10 seconds. */
  readonly timeout?: Duration.Input | undefined
  /** Kill the process if it emits more combined output. Default 1 MiB. */
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
  "@doeixd/effect-agent/sandbox/SandboxProvider"
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
  "@doeixd/effect-agent/sandbox/Current"
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
