import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { CodingToolkit } from "../src/coding/index.js"
import { PiToolkit } from "../src/pi/index.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { Shell } from "../src/shell/index.js"

const ws = Sandbox.workspace("shell-test")
const ctx = { preliminary: () => Effect.void }

const withSandbox = <A, E, R>(
  use: Effect.Effect<A, E, R | Sandbox.Current>,
  exec?: Sandbox.Sandbox["exec"]
) =>
  use.pipe(
    Effect.provide(
      Layer.provideMerge(
        Sandbox.currentLayer(ws),
        MemorySandbox.layer({ seed: {}, ...(exec === undefined ? {} : { exec }) })
      )
    ),
    Effect.scoped
  )

describe("Shell", () => {
  it("fromKind builds the expected argv", () => {
    assert.deepStrictEqual(Shell.fromKind("bash").toCommand("echo hi"), {
      executable: "bash",
      args: ["-c", "echo hi"]
    })
    assert.deepStrictEqual(Shell.fromKind("zsh").toCommand("echo hi"), {
      executable: "zsh",
      args: ["-c", "echo hi"]
    })
    assert.deepStrictEqual(Shell.fromKind("nushell").toCommand("echo hi"), {
      executable: "nu",
      args: ["-c", "echo hi"]
    })
    assert.deepStrictEqual(Shell.fromKind("powershell").toCommand("echo hi"), {
      executable: "powershell",
      args: ["-NoProfile", "-Command", "echo hi"]
    })
    assert.deepStrictEqual(Shell.fromKind("pwsh").toCommand("echo hi"), {
      executable: "pwsh",
      args: ["-NoProfile", "-Command", "echo hi"]
    })
    assert.strictEqual(Shell.fromKind("bash").name, "bash")
  })

  it.effect("current falls back to bash when no Layer is provided", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.current()
      assert.strictEqual(shell.name, "bash")
    }))

  it.effect("a Layer wins over the bash fallback", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.current().pipe(Effect.provide(Shell.layer("nushell")))
      assert.strictEqual(shell.name, "nushell")
      assert.strictEqual(shell.toCommand("ls").executable, "nu")
    }))

  it.effect("CodingToolkit.bash uses the provided Shell", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{ executable: string; args: ReadonlyArray<string> } | undefined>(
        undefined
      )
      const result = yield* withSandbox(
        CodingToolkit.handlers.bash({ command: "echo hi" }, ctx).pipe(
          Effect.provide(Shell.layer("zsh"))
        ),
        (cmd) =>
          Ref.set(seen, { executable: cmd.executable, args: cmd.args }).pipe(
            Effect.as({ exitCode: 0, stdout: "hi\n", stderr: "" })
          )
      )
      assert.deepStrictEqual(result, { exit_code: 0, stdout: "hi\n", stderr: "" })
      assert.deepStrictEqual(yield* Ref.get(seen), {
        executable: "zsh",
        args: ["-c", "echo hi"]
      })
    }))

  it.effect("CodingToolkit.bash stays bash with no Shell Layer", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{ executable: string; args: ReadonlyArray<string> } | undefined>(
        undefined
      )
      yield* withSandbox(
        CodingToolkit.handlers.bash({ command: "echo hi" }, ctx),
        (cmd) =>
          Ref.set(seen, { executable: cmd.executable, args: cmd.args }).pipe(
            Effect.as({ exitCode: 0, stdout: "", stderr: "" })
          )
      )
      assert.deepStrictEqual(yield* Ref.get(seen), {
        executable: "bash",
        args: ["-c", "echo hi"]
      })
    }))

  it.effect("a Layer overrides PiToolkit.handlersFor construction fallback", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{ executable: string; args: ReadonlyArray<string> } | undefined>(
        undefined
      )
      const H = PiToolkit.handlersFor({ shell: "powershell" })
      yield* withSandbox(
        H.bash({ command: "echo hi" }, ctx).pipe(Effect.provide(Shell.layer("fish"))),
        (cmd) =>
          Ref.set(seen, { executable: cmd.executable, args: cmd.args }).pipe(
            Effect.as({ exitCode: 0, stdout: "", stderr: "" })
          )
      )
      assert.deepStrictEqual(yield* Ref.get(seen), {
        executable: "fish",
        args: ["-c", "echo hi"]
      })
    }))

  it.effect("a custom Shell is an ordinary Layer", () =>
    Effect.gen(function* () {
      const custom = Shell.make("xonsh", (script) => Sandbox.command("xonsh", ["-c", script]))
      const seen = yield* Ref.make<string | undefined>(undefined)
      yield* withSandbox(
        CodingToolkit.handlers.bash({ command: "echo hi" }, ctx).pipe(
          Effect.provide(Shell.layer(custom))
        ),
        (cmd) =>
          Ref.set(seen, cmd.executable).pipe(
            Effect.as({ exitCode: 0, stdout: "", stderr: "" })
          )
      )
      assert.strictEqual(yield* Ref.get(seen), "xonsh")
    }))

  /**
   * No built-in shell loads the invoking user's environment.
   *
   * `bash` was the only one built with `-l`, which sources `/etc/profile` and
   * `~/.bash_profile` -- so the same script behaved differently depending on
   * whose dotfiles were on the machine, and it was the default. `zsh` and
   * `fish` have the same dotfile story and never had it, so the difference was
   * accidental rather than decided.
   */
  it("no built-in shell is a login shell", () => {
    const kinds = ["bash", "sh", "zsh", "fish", "nushell"] as const
    for (const kind of kinds) {
      const command = Shell.fromKind(kind).toCommand("echo hi")
      assert.notInclude(
        command.args,
        "-l",
        `${kind} must not source the user's profile`
      )
      assert.notInclude(command.args, "-lc", `${kind} must not be a login shell`)
    }
  })

  it("an application that wants a login shell can still build one", () => {
    const login = Shell.make(
      "bash-login",
      (script) => Sandbox.command("bash", ["-lc", script])
    )
    assert.deepStrictEqual(login.toCommand("echo hi"), {
      executable: "bash",
      args: ["-lc", "echo hi"]
    })
  })
})
