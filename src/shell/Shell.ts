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
  readonly name: string
  readonly toCommand: (script: string) => Sandbox.Command
}

export class Shell extends Context.Service<Shell, Service>()(
  "@doeixd/effect-agent/shell/Shell"
) {}

export const make = (name: string, toCommand: (script: string) => Sandbox.Command): Service => ({
  name,
  toCommand
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
 * Shell.make("bash-login", (script) => Sandbox.command("bash", ["-lc", script]))
 * ```
 */
export const bash: Service = make("bash", (script) => Sandbox.command("bash", ["-c", script]))
export const sh: Service = make("sh", (script) => Sandbox.command("sh", ["-c", script]))
export const zsh: Service = make("zsh", (script) => Sandbox.command("zsh", ["-c", script]))
export const fish: Service = make("fish", (script) => Sandbox.command("fish", ["-c", script]))
export const powershell: Service = make("powershell", (script) =>
  Sandbox.command("powershell", ["-NoProfile", "-Command", script])
)
export const pwsh: Service = make("pwsh", (script) =>
  Sandbox.command("pwsh", ["-NoProfile", "-Command", script])
)
export const nushell: Service = make("nushell", (script) => Sandbox.command("nu", ["-c", script]))

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
 * Tools do not declare `Shell` in `dependencies`, so existing agents that
 * never provide one still compile and run as `bash -c` -- the default above,
 * not the login shell this line used to name. A Layer at the session wins
 * over the fallback.
 */
export const current = (fallback: Service = bash): Effect.Effect<Service> =>
  Effect.map(Effect.serviceOption(Shell), (opt) => Option.getOrElse(opt, () => fallback))
