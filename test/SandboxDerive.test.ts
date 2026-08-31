import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Scope } from "effect"
import * as fsSync from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as LocalSandbox from "../src/sandbox/local.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { SandboxConformance } from "../src/testing/index.js"

/**
 * `docs/plan-integrations.md` §6.2/§6.3 and §10's third and fourth boxes: a
 * provider is one `exec` function, the whole `Sandbox` surface derives from
 * POSIX commands over it, and the derivation is validated by rebuilding a
 * provider we already have -- the local sandbox -- from its `exec` alone and
 * passing `SandboxConformance`. `fromOperations` then overrides one
 * operation natively and the derivation must actually stand aside.
 *
 * The derived commands assume a POSIX-ish userland (`sh`, `stat -c`,
 * `readlink -f`, `base64`, `find`) -- the stated tier-0 cost. On this
 * repository's hosts that userland exists (Git's coreutils on Windows,
 * coreutils on Linux CI).
 */
const promise = <A>(evaluate: () => PromiseLike<A>) => Effect.promise(evaluate)

/** Programs for a Node host, as the conformance suite wants them. */
const nodePrograms: SandboxConformance.Programs = {
  echo: (text) => Sandbox.command(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)})`]),
  stderr: (text) => Sandbox.command(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(text)})`]),
  exit: (code) => Sandbox.command(process.execPath, ["-e", `process.exit(${code})`]),
  argv: (args) => Sandbox.command(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args]),
  sleep: (millis) => Sandbox.command(process.execPath, ["-e", `setTimeout(() => {}, ${millis})`]),
  emit: (bytes) => Sandbox.command(process.execPath, ["-e", `process.stdout.write('x'.repeat(${bytes}))`])
}

/**
 * The validation the plan names: the local provider's `exec`, and nothing
 * else of it. One local sandbox per derived workspace; every derived file
 * operation must arrive as a command through this function.
 */

/**
 * The host's `sh`, resolvable by Node's own spawn. On Windows, Git's
 * coreutils provide the POSIX userland the tier-0 derivation assumes, but
 * they are not on the Windows-side PATH -- so the adapter (a stand-in for a
 * remote provider, which would have its own shell) names it explicitly.
 */
const shExecutable = (() => {
  if (process.platform !== "win32") return "sh"
  for (const candidate of [
    "C:/Program Files/Git/usr/bin/sh.exe",
    "C:/Program Files/Git/bin/sh.exe"
  ]) {
    try {
      fsSync.accessSync(candidate)
      return candidate
    } catch {
      // try the next
    }
  }
  return "sh"
})()

const withResolvedShell = (command: Sandbox.Command): Sandbox.Command =>
  command.executable === "sh" ? { ...command, executable: shExecutable } : command

const execOverLocal = Effect.fn("SandboxDerive.execOverLocal")(function* () {
  // Acquisitions live as long as the fixture: a per-call scope would tear
  // the sandbox directory down after the first command.
  const scope = yield* Effect.scope
  const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "sandbox-derive-")))
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  )
  const provider = yield* Layer.build(LocalSandbox.layer({ root }))
  const inner = yield* Effect.provide(Effect.service(Sandbox.SandboxProvider), provider)
  const sandboxes = new Map<string, Sandbox.Sandbox>()
  const commands: Array<string> = []
  const exec: Sandbox.Operations["exec"] = (command, options) =>
    Effect.gen(function* () {
      commands.push(command.executable === "sh" ? command.args[1] ?? "" : command.executable)
      const key = options.cwd
      let sandbox = sandboxes.get(key)
      if (sandbox === undefined) {
        // The local sandbox pins its own working directory, which is what a
        // remote provider's exec does too; the derivation's `cwd` names the
        // workspace and the adapter maps it to one acquisition.
        sandbox = yield* Scope.provide(
          Effect.provide(Sandbox.acquire(Sandbox.workspace(key)), provider),
          scope
        ).pipe(Effect.orDie)
        sandboxes.set(key, sandbox)
      }
      return yield* sandbox.exec(withResolvedShell(command), options)
    })
  return { exec, commands, inner }
})

describe("Sandbox.fromExec", () => {
  it.live("a provider derived from exec alone passes the whole conformance suite", () =>
    Effect.gen(function* () {
      const { exec, commands } = yield* execOverLocal()
      const { layer, derived } = Sandbox.fromExec(exec)
      // Everything but exec itself is derived, and the report says so --
      // including `execStream`, which a provider given only a buffered `exec`
      // cannot honestly stream: it delivers the whole run at exit.
      assert.deepStrictEqual(derived, ["canonical", "execStream", "list", "read", "stat", "write"])
      const report = yield* SandboxConformance.run(layer, { programs: nodePrograms })
      assert.deepStrictEqual(report.failed, [])
      // No `drip` above: a provider derived from a buffered `exec` does not
      // claim to stream, and the report agrees rather than flattering it.
      assert.deepStrictEqual(report.capabilities, {
        exec: true,
        separateStderr: true,
        timeout: true,
        outputBound: true,
        streamsIncrementally: false
      })
      // The file cases really did travel as commands.
      assert.isTrue(commands.some((script) => script.includes("base64")), "reads/writes did not go through the shell")
      assert.isTrue(commands.some((script) => script.includes("find ")), "list did not go through the shell")
    }).pipe(Effect.scoped),
    120_000
  )

  it.live("fromOperations: a native override stands in for the derivation, everything omitted still derives", () =>
    Effect.gen(function* () {
      const { exec } = yield* execOverLocal()
      const reads: Array<string> = []
      const files = new Map<string, Uint8Array>()
      const { layer, derived } = Sandbox.fromOperations({
        exec,
        readFile: (absolute) =>
          Effect.sync(() => {
            reads.push(absolute)
            return files.get(absolute)
          }).pipe(
            Effect.flatMap((held) =>
              held === undefined
                ? Effect.fail(new Sandbox.FileMissingError({ path: absolute }))
                : Effect.succeed(held)
            )
          ),
        writeFile: (absolute, content) => Effect.sync(() => void files.set(absolute, content))
      })
      assert.deepStrictEqual(derived, ["canonical", "execStream", "list", "stat"])
      const sandbox = yield* Effect.provide(Sandbox.acquire(Sandbox.workspace("override")), layer)
      const file = yield* Effect.orDie(Sandbox.path("held/inside.txt"))
      yield* sandbox.write(file, "kept natively")
      const back = yield* sandbox.read(file)
      assert.strictEqual(new TextDecoder().decode(back), "kept natively")
      assert.strictEqual(reads.length, 1)
      // A derived operation still works beside the overrides.
      const identity = yield* sandbox.canonical(file)
      assert.isAbove(identity.length, 0)
    }).pipe(Effect.scoped),
    60_000
  )

  it.live("errors classify from the shell's own words, and a custom classifier is consulted first", () =>
    Effect.gen(function* () {
      const { exec } = yield* execOverLocal()
      const { layer } = Sandbox.fromExec(exec)
      const sandbox = yield* Effect.provide(Sandbox.acquire(Sandbox.workspace("classify")), layer)
      const missing = yield* Effect.flip(sandbox.read(yield* Effect.orDie(Sandbox.path("not/there.txt"))))
      assert.strictEqual(missing._tag, "@doeixd/effect-agent/sandbox/FileMissingError")

      const custom = Sandbox.fromExec(exec, {
        classify: ({ result }) =>
          result.stderr.includes("No such file")
            ? new Sandbox.PermissionDeniedError({ path: "everything", operation: "read" })
            : undefined
      })
      const overridden = yield* Effect.provide(Sandbox.acquire(Sandbox.workspace("classify-2")), custom.layer)
      const refused = yield* Effect.flip(overridden.read(yield* Effect.orDie(Sandbox.path("still/not/there.txt"))))
      assert.strictEqual(refused._tag, "@doeixd/effect-agent/sandbox/PermissionDeniedError")
      void promise
    }).pipe(Effect.scoped),
    60_000
  )
})
