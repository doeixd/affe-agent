import { Context, Effect, Layer, Option } from "effect"
import * as Sandbox from "../sandbox/Sandbox.js"

/**
 * How a one-line script becomes a sandbox `Command`.
 *
 * Isolation stays on `Sandbox`; this only constructs argv. A Layer supplies
 * bash, zsh, PowerShell, Nushell, or a four-line custom shell — the toolkit
 * never names a binary.
 */
export interface Service {
  /** Stable programmatic identity: the `Kind` for a built-in. */
  readonly name: string
  /**
   * What the model is told it is writing for -- "PowerShell 7 (pwsh)", not
   * "pwsh". Rendered into a tool description, so it is configuration, never
   * model input, and `make` refuses a value with a line break in it.
   */
  readonly displayName: string
  readonly toCommand: (script: string) => Sandbox.Command
}

export class Shell extends Context.Service<Shell, Service>()(
  "affe-agent/shell/Shell"
) {}

/**
 * A name is configuration, not model input, and it ends up inside a prompt.
 * A line break or control character in it would turn a label into a second
 * line of instructions, so both are refused at construction -- a pure
 * constructor like `AgentLoop.maxTurns`, throwing before any Effect exists.
 */
const singleLine = (label: "name" | "displayName", value: string): string => {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RangeError(`Shell.make: ${label} must be a non-empty single-line string`)
  }
  return value
}

/**
 * A shell of the application's own.
 *
 * ```ts
 * Shell.make({
 *   name: "xonsh",
 *   displayName: "Xonsh",
 *   toCommand: (script) => Sandbox.command("xonsh", ["-c", script])
 * })
 * ```
 */
export const make = (options: {
  readonly name: string
  readonly displayName: string
  readonly toCommand: (script: string) => Sandbox.Command
}): Service => ({
  name: singleLine("name", options.name),
  displayName: singleLine("displayName", options.displayName),
  toCommand: options.toCommand
})

/**
 * `-c`, not `-lc`.
 *
 * `-l` makes bash a login shell, so it sources `/etc/profile` and
 * `~/.bash_profile`. For an agent that means the same script behaves
 * differently depending on whose dotfiles are on the machine -- a different
 * `PATH`, different aliases, different `set -e` defaults -- and pays that cost
 * on every tool call. It was also the only shell here with login semantics,
 * while `zsh` and `fish` have the same dotfile story and did not get them, so
 * the difference read as accidental rather than decided.
 *
 * This module's job is to construct argv; isolation is `Sandbox`'s. Loading
 * the invoking user's environment is neither, and an agent that needs it can
 * say so:
 *
 * ```ts
 * Shell.make({
 *   name: "bash-login",
 *   displayName: "Bash (login shell)",
 *   toCommand: (script) => Sandbox.command("bash", ["-lc", script])
 * })
 * ```
 */
export const bash: Service = make({
  name: "bash",
  displayName: "Bash",
  toCommand: (script) => Sandbox.command("bash", ["-c", script])
})
export const sh: Service = make({
  name: "sh",
  displayName: "POSIX sh",
  toCommand: (script) => Sandbox.command("sh", ["-c", script])
})
export const zsh: Service = make({
  name: "zsh",
  displayName: "zsh",
  toCommand: (script) => Sandbox.command("zsh", ["-c", script])
})
export const fish: Service = make({
  name: "fish",
  displayName: "fish",
  toCommand: (script) => Sandbox.command("fish", ["-c", script])
})
export const powershell: Service = make({
  name: "powershell",
  displayName: "Windows PowerShell",
  toCommand: (script) => Sandbox.command("powershell", ["-NoProfile", "-Command", script])
})
export const pwsh: Service = make({
  name: "pwsh",
  displayName: "PowerShell 7 (pwsh)",
  toCommand: (script) => Sandbox.command("pwsh", ["-NoProfile", "-Command", script])
})
export const nushell: Service = make({
  name: "nushell",
  displayName: "Nushell",
  toCommand: (script) => Sandbox.command("nu", ["-c", script])
})

export type Kind = "bash" | "sh" | "zsh" | "fish" | "powershell" | "pwsh" | "nushell"

const byKind: Record<Kind, Service> = {
  bash,
  sh,
  zsh,
  fish,
  powershell,
  pwsh,
  nushell
}

export const fromKind = (kind: Kind): Service => byKind[kind]

export const layer = (shell: Service | Kind): Layer.Layer<Shell> =>
  Layer.succeed(Shell, typeof shell === "string" ? fromKind(shell) : shell)

/**
 * The Shell in the environment, or `fallback` (default bash).
 *
 * For application-authored dynamic tools. The built-in toolkits do *not*
 * call this: they resolve their shell once, when constructed, so that the
 * dialect the model was told about is the one that runs (`SH2`/`SH4` in
 * `docs/plan-shell-tool.md`). An application that wants Layer-sourced
 * selection reads the service before building the agent:
 *
 * ```ts
 * const shell = yield* Shell.Shell
 * Agent.make({ toolkit: CodingToolkit.toolkit({ shell }) })
 * ```
 */
export const current = (fallback: Service = bash): Effect.Effect<Service> =>
  Effect.map(Effect.serviceOption(Shell), (opt) => Option.getOrElse(opt, () => fallback))
