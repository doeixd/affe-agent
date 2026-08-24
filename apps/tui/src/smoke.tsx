import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { start, stop } from "./harness.ts"
import { makeStore } from "./store.ts"
import type { Sink } from "./view.ts"
import { duration, widthPolicy } from "./width.ts"

/**
 * A headless smoke test: render the real UI against the real harness, drive
 * prompts through it, and assert on what the terminal would show.
 *
 * Two surfaces now, because V2 split them. A finished entry is committed to the
 * terminal's scrollback and leaves the live tree, so the transcript is asserted
 * through `externalOutput` while the live region (status, input, unfinished
 * work) is asserted through `captureCharFrame`.
 *
 * `waitForFrame` rather than a sleep: if the pipeline breaks this times out
 * instead of printing a stale frame and passing.
 */

const { drainSettled, entries, footer, sink, status } = makeStore()
/**
 * Count completed submissions.
 *
 * A latch, not a poll. `status()` goes working -> idle, but the transition can
 * pass entirely between two render passes, so waiting to *observe* "working"
 * misses it and hangs. Counting completions is monotonic and cannot be missed.
 */
let completed = 0
let working = false
const counting: Sink = {
  ...sink,
  setStatus: (next) => {
    if (next === "working") working = true
    if (next === "idle" && working) {
      working = false
      completed++
    }
    sink.setStatus(next)
  }
}

const handle = await start(counting)

const { captureCharFrame, externalOutput, flush, waitForFrame } = await testRender(
  () => (
    <App entries={entries} status={status()} handle={handle} drainSettled={drainSettled} footer={footer()} />
  ),
  {
    width: 100,
    height: 20,
    // Scrollback commits require these two: the live UI is pinned to a footer
    // region and everything above it is written to the terminal proper.
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout"
  }
)

await flush()
const before = captureCharFrame()
console.log("--- live region, before any prompt ---")
console.log(before)

/**
 * Run one prompt to completion.
 *
 * Waiting for `status() === "idle"` alone is a race: a session is idle *before*
 * its submission starts, so the predicate passes immediately and the next
 * prompt lands on a busy session. Wait for the transition into work first.
 */
const ask = async (text: string) => {
  const target = completed + 1
  handle.submit(text)
  // The policy asks before any shell or write, so a turn that needs approval
  // never completes on its own. Approving here is what a user would do; the
  // refusal path is exercised deliberately further down.
  await waitForFrame(
    () => {
      const view = footer()
      if (view.type === "approval") handle.respond(view.request.id, true)
      return completed >= target && entries.length === 0
    },
    { maxPasses: 400 }
  )
}

// One prompt is one submission: the loop stops when the model answers without
// asking for a tool, so the second scripted tool call needs a second prompt.
await ask("what is in this workspace?")
await ask("now run something")

// V4: a run that pauses on approval. `ask` waits for the submission to end,
// which never happens while the footer is asking, so drive it explicitly.
const beforeApproval = completed
handle.submit("delete everything")
await waitForFrame(() => footer().type === "approval", { maxPasses: 400 })
const asking = captureCharFrame()

handle.respond(
  footer().type === "approval"
    ? (footer() as { type: "approval"; request: { id: string } }).request.id
    : "",
  false
)
await waitForFrame(() => completed > beforeApproval && entries.length === 0, {
  maxPasses: 400
})

// Capture only after a flush: `captureCharFrame` returns the last *painted*
// frame, so reading it straight after a state change shows the previous one.
await flush()
const transcript = externalOutput.takeText()
const live = captureCharFrame()

console.log("--- committed to terminal scrollback ---")
console.log(transcript)
console.log("--- live region, after ---")
console.log(live)

const checks: ReadonlyArray<readonly [string, boolean]> = [
  ["user message committed", transcript.includes("what is in this workspace?")],
  ["tool call committed with argument", transcript.includes("bash echo hi")],
  ["tool marked succeeded", transcript.includes("✓")],
  ["listing body committed", transcript.includes("README.md")],
  ["directory marked with slash", transcript.includes("src/")],
  ["command stdout committed", transcript.includes("hi")],
  ["assistant reply committed", transcript.includes("That is what the workspace holds.")],
  ["second turn committed", transcript.includes("The command ran.")],
  ["transcript left the live tree", entries.length === 0],
  ["live region keeps the input", live.includes("message")],
  ["live region is not the transcript", !live.includes("That is what the workspace holds.")],
  ["status returned to idle", live.includes("idle")],

  // V3
  ["turn summary committed", transcript.includes("▣")],
  ["summary reports a tool count", transcript.includes("1 tool")],
  ["summary reports a duration", /▣ \d+(\.\d+)?(ms|s)/.test(transcript)],
  ["hints shown at this width", live.includes("enter send")],
  ["hints hidden when narrow", widthPolicy(50).hints === false],
  ["compact below its breakpoint", widthPolicy(50).compact === true],
  ["spacious only when wide", widthPolicy(80).spacious === false && widthPolicy(120).spacious],
  ["approval surface replaces the prompt", asking.includes("y allow") && !asking.includes("message")],
  ["approval names the tool and action", asking.includes("bash wants to shell")],
  ["approval names the resource", asking.includes("rm -rf")],
  ["refusal is recorded", transcript.includes("refused")],
  ["footer returned to the prompt", footer().type === "prompt"],
  ["durations read at each magnitude", duration(340) === "340ms" && duration(1234) === "1.2s" && duration(125_000) === "2m 05s"]
]

console.log("--- checks ---")
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
}

stop()
console.log(failed === 0 ? "\nsmoke: OK" : `\nsmoke: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
