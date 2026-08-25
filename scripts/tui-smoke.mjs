#!/usr/bin/env node
/**
 * Run the TUI smoke suite, finding a working `bun`.
 *
 * The indirection exists because `npm run` prepends every ancestor
 * `node_modules/.bin` to PATH, all the way to the drive root. A stray shim in
 * one of those -- `C:\\Users\\<name>\\node_modules\\.bin\\bun.exe` on the
 * machine this was written on -- then shadows the real binary, and bun exits
 * with "failed to remap this bin to its proper location". Nothing about the
 * repository is wrong in that case, and nothing in the repository can be fixed
 * to avoid it, so this looks past PATH instead.
 *
 * Order: `BUN` if the caller set it, then the standard install location, then
 * PATH. The last is what works on a machine with no stray shim, which is most
 * of them.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const app = join(root, "apps", "tui")

const candidates = [
  process.env.BUN,
  process.env.BUN_INSTALL === undefined
    ? undefined
    : join(process.env.BUN_INSTALL, "bin", process.platform === "win32" ? "bun.exe" : "bun"),
  join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun"),
  "bun"
].filter((candidate) => candidate !== undefined)

const runner = candidates.find((candidate) =>
  candidate === "bun" || existsSync(candidate)
)

if (runner === undefined) {
  console.error(
    "Could not find bun. The TUI needs it: OpenTUI's core is a native library\n" +
      "loaded through Bun's FFI, so this suite cannot run on Node.\n" +
      "Install it (https://bun.sh) or set BUN to its path."
  )
  process.exit(1)
}

/**
 * How long the suite may take before it is killed.
 *
 * A failed assertion inside the suite has twice left the child printing its
 * error and then never exiting -- long-lived render and harness fibers keep
 * the loop alive -- and `spawnSync` waits forever, so the root check and any
 * CI job hung after the useful output had already been produced. A gate that
 * hangs on failure is worse than one that fails: nobody learns anything and
 * the machine stays busy.
 *
 * Generous, because it is a backstop and not a performance budget. The suite
 * takes a couple of seconds.
 */
const TIMEOUT_MILLIS = Number(process.env.TUI_SMOKE_TIMEOUT_MS ?? 180_000)

const result = spawnSync(runner, ["src/smoke.tsx"], {
  cwd: app,
  stdio: "inherit",
  // Not `shell: true`: the whole point is to bypass PATH resolution, and a
  // shell would put it straight back.
  shell: false,
  timeout: TIMEOUT_MILLIS,
  // SIGKILL rather than SIGTERM: the case this exists for is a child that is
  // not responding to its own shutdown path. On Windows `spawnSync` kills the
  // process directly, so the signal name is advisory there.
  killSignal: "SIGKILL"
})

if (result.error !== undefined && result.error !== null) {
  // `ETIMEDOUT` is this script's own doing; anything else is a spawn failure.
  if (result.error.code === "ETIMEDOUT") {
    console.error(
      `
TUI smoke exceeded ${TIMEOUT_MILLIS}ms and was killed.` +
        ` Any output above is what it managed to print first.`
    )
    process.exit(124)
  }
  console.error(`Could not run ${runner}: ${result.error.message}`)
  process.exit(1)
}

// A child killed by a signal reports `status: null`; that is a failure, not a
// missing result.
if (result.signal !== null && result.signal !== undefined) {
  console.error(`
TUI smoke was terminated by ${result.signal}.`)
  process.exit(1)
}

process.exit(result.status ?? 1)
