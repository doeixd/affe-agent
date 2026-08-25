#!/usr/bin/env node
/**
 * Run the Effect language-service diagnostics over a project, and fail when
 * the run checked nothing.
 *
 * The CLI exits 0 after reporting "Checked 0 files out of 14 files" -- which
 * is how the TUI sat behind a green gate that had never read a line of it.
 * A check that inspects no files is not a passing check; it is a broken one,
 * and the difference has to be visible in the exit code.
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const project = process.argv[2]
if (project === undefined) {
  console.error("usage: effect-diagnostics.mjs <tsconfig path>")
  process.exit(2)
}

// The package's own entry point rather than a `.bin` shim: the shims are
// platform-specific wrappers, and spawning one without a shell produces no
// output at all on Windows.
const cli = fileURLToPath(
  import.meta.resolve("@effect/language-service/cli.js")
)

const run = spawnSync(
  process.execPath,
  [cli, "diagnostics", "--project", project],
  { encoding: "utf8" }
)

const output = `${run.stdout ?? ""}${run.stderr ?? ""}`
process.stdout.write(output)

if (run.status !== 0) process.exit(run.status ?? 1)

// Written without ANSI escapes by the reporter's summary line.
const counted = /Checked (\d+) files? out of (\d+) files?/.exec(output)
if (counted === null) {
  console.error(`\n${project}: no coverage summary in the diagnostics output.`)
  process.exit(1)
}
const [, checked, total] = counted
if (Number(checked) < Number(total) || Number(total) === 0) {
  console.error(
    `\n${project}: diagnostics checked ${checked} of ${total} files.`
      + ` A project the service skips is unchecked, not clean --`
      + ` the usual cause is a missing "@effect/language-service" plugin entry.`
  )
  process.exit(1)
}
