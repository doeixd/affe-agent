import { defineConfig } from "vitest/config"

/**
 * The suite must not assume it owns the machine.
 *
 * There was no config here at all until 2026-09-01, so vitest ran its
 * defaults: the `threads` pool with one worker per core, which is 16 on the
 * machine this was measured on. Eleven test files spawn *real* child processes
 * -- `Sandbox`, `SandboxConformance`, `SandboxDerive`, `Cli`, `Portability`,
 * `McpClients`, `McpServerConformance`, `McpStdioCompatibility`, `PluginMcp`,
 * `CodingToolkit`, `WorkerDurableObject` (esbuild + miniflare + workerd) --
 * roughly 247 tests, so the process count is a large multiple of the worker
 * count.
 *
 * `STATUS.md` recorded the symptom for a while as "the suite is flaky under
 * process pressure on Windows", with three runs giving 0, 2 and 20 failures,
 * and left it undiagnosed. It is not flakiness in the tests. Measured:
 *
 * | | solo | two suites at once |
 * | --- | --- | --- |
 * | 16 (default) | 9 consecutive clean runs | 6 and 8 files failed; one run never reported 2 files at all |
 * | 8 | +29% wall clock | 1 failure each, `ClusterMultiNode` only |
 * | 6 | +54% wall clock | 1 failure each, `ClusterMultiNode` only |
 *
 * So a single run is fine and always was; a *second concurrent* run is what
 * breaks it, and `0xC0000142` is Windows refusing to initialise a DLL under
 * handle exhaustion -- a machine-global condition, not a repository-local one.
 * `CLAUDE.md` says other agents may be working in this repository at the same
 * time, which makes two concurrent runs an ordinary Tuesday rather than
 * misuse.
 *
 * Eight is the number because it costs half what six costs and buys exactly
 * the same thing. The residual failure at both settings is
 * `ClusterMultiNode`, which runs on real time (~15s) and is already listed
 * under "deliberately left" in `STATUS.md`; H7 would move it to `TestClock`.
 * A worker cap cannot fix a test that races a wall clock, and neither can it
 * fix `DurableStreams`' "linear, not quadratic", which asserts an asymptotic
 * bound by measuring elapsed time and spawns no processes at all.
 *
 * The cost is real and is paid on every solo run: about 29%, 51s to 66s.
 * That is the trade -- a suite whose red runs mean something, against a suite
 * that is faster when nothing else is happening. It was made deliberately,
 * because break-once discipline, `scripts/falsify.mjs` and `check` all rest on
 * a failure being informative, and an ambiguous one costs more than the
 * fifteen seconds.
 *
 * Raise it with `npx vitest run --maxWorkers=16` when you know you are alone
 * on the machine.
 */
export default defineConfig({
  test: {
    maxWorkers: 8
  }
})
