import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { Effect } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as NodeStore from "../../../src/tree/NodeStore.js"
import { Prompt } from "effect/unstable/ai"
import { TestLanguageModel } from "../../../src/testing/index.js"
import { entriesOf } from "./restore.ts"
import { VERSION } from "./version.ts"
import { fromArgv, scripted, scriptedWith } from "./backend.ts"
import * as Diff from "./diff.ts"
import { project, provenanceOf, start, stop } from "./harness.ts"
import { makeStore } from "./store.ts"
import type { Handle, Sink } from "./view.ts"
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { CodingToolkit } from "../../../src/coding/index.js"
import { bodyOf, defaultViews, titleOf, withViews } from "./tools.ts"
import { duration, fit, widthPolicy } from "./width.ts"

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

/**
 * Any throw ends the process, having stopped what it started.
 *
 * The suite runs at module top level, so a failed `until` rejects a top-level
 * await -- and by then a renderer and one or more harnesses are alive, holding
 * the loop open. The useful error was printed and the process then sat there
 * until something outside killed it, which happened twice during review.
 * `scripts/tui-smoke.mjs` now bounds the child as a backstop; this is the
 * suite exiting on its own, with its own message and its own cleanup.
 */
const abort = (cause: unknown): void => {
  const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  console.error(`
smoke: ${detail}`)
  try {
    stop()
  } catch {
    // Already broken; a failure to clean up must not replace the real error.
  }
  process.exit(1)
}
process.on("uncaughtException", abort)
process.on("unhandledRejection", abort)

const { backend, commitSettled, drainSettled, entries, footer, rewind, sink, status } = makeStore()
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

const { captureCharFrame, externalOutput, flush, mockInput } = await testRender(
  () => (
    <App entries={entries} status={status()} handle={handle} commitSettled={commitSettled} footer={footer()} rewind={rewind()} backend={backend()} dismiss={() => sink.setPalette(undefined)}
      openPalette={() => sink.setPalette(handle.commands)}
      quit={() => {}} />
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
 * Wait for a condition, yielding to the runtime between checks.
 *
 * Not `waitForFrame`, and the difference matters more than it looks.
 * `waitForFrame` counts render passes, so it only makes progress while the UI
 * is *painting* -- and the thing being waited for here is an Effect fibre,
 * which paints nothing until it produces something. When the two disagree the
 * predicate is polled a few times, the pass budget runs out, and the test
 * fails having never let the agent run.
 *
 * That is not hypothetical: this suite passed for a while only because
 * `submit` happened to write to the store synchronously, giving the renderer
 * something to paint on every prompt. Fixing that (a user line must not be
 * drawn before the kernel accepts it) removed the incidental repaint and every
 * wait here began timing out.
 *
 * `setTimeout` is a macrotask, so the Effect scheduler gets to run between
 * checks whether or not anything was drawn.
 */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 4000; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${what}`)
}

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
  await until(
    () => {
      const view = footer()
      if (view.type === "approval") handle.respond(view.request.id, true)
      return completed >= target && entries.length === 0
    },
    `"${text}" to complete`
  )
}

// One prompt is one submission: the loop stops when the model answers without
// asking for a tool, so the second scripted tool call needs a second prompt.
await ask("what is in this workspace?")
await ask("now run something")
await ask("rename the greeting")
await ask("bump the drifting value")

// V4: a run that pauses on approval. `ask` waits for the submission to end,
// which never happens while the footer is asking, so drive it explicitly.
const beforeApproval = completed
handle.submit("delete everything")
await until(() => footer().type === "approval", "the approval footer")
// A frame, so `captureCharFrame` below shows the footer rather than whatever
// was painted last.
await flush()
const asking = captureCharFrame()

handle.respond(
  footer().type === "approval"
    ? (footer() as { type: "approval"; request: { id: string } }).request.id
    : "",
  false
)
await until(
  () => completed > beforeApproval && entries.length === 0,
  "the refused turn to finish"
)

// V6: rewind. Every turn above was captured as a node by the session tree, so
// there is somewhere to go back to -- and going back must not disturb the one
// subscription this UI has been reading from since it started.
const depthBefore = rewind().depth
const rewoundFrom = completed
handle.rewind()
await until(() => rewind().taken === 1 && entries.length === 0, "the rewind")
const depthAfter = rewind().depth

// The branch is live, not a transcript: a prompt reaches it and it answers.
await ask("and now?")
const answeredAfterRewind = completed > rewoundFrom

// V7: the palette and the branch selector.
//
// Driven through the handle rather than through keystrokes: what is under test
// is that the commands do something, and a `<select>`'s own arrow handling is
// OpenTUI's to test, not ours.
handle.command("help")
await until(() => entries.length === 0, "the help notices to settle")
// `takeText` *drains*, so what is read here would otherwise be missing from
// the final transcript. Read early to assert on it early, and keep it.
const transcriptSoFar = externalOutput.takeText()

// `/branches` fills the footer from the tree.
handle.command("branches")
await until(() => footer().type === "branches", "the branch selector")
/**
 * Narrowed, not asserted.
 *
 * This read the footer twice and cast the second read to a hand-written shape
 * -- which is a cast in test code, and test code counts. Binding the value
 * once lets the union narrow on its own, and the items come back as real
 * `BranchItem`s, node-id brand included.
 */
const branchesView = footer()
const listed = branchesView.type === "branches" ? branchesView.items : []

// Switching to the branch already active is the identity case, and has to
// leave a working prompt behind rather than a footer nobody dismissed.
const activeBranch = listed.find((item) => item.active)
if (activeBranch !== undefined) handle.switchTo(activeBranch.id)
await until(() => footer().type === "prompt", "the footer to return to the prompt")
await until(() => entries.length === 0, "the switch notice to settle")

// `/branch` forks here and keeps the line it forked from, which is the
// difference from `/rewind`: exploring an alternative should not cost a turn.
const branchesBeforeFork = listed.length
handle.command("branch")
await until(() => entries.length === 0, "the fork notice")
handle.command("branches")
await until(() => footer().type === "branches", "the selector after forking")
const forkedView = footer()
const afterFork = forkedView.type === "branches" ? forkedView.items : []
const forkPointId = afterFork.find((item) => item.active)?.id
handle.command("branch")  // dismisses nothing; the selector is still open
await until(() => entries.length === 0, "the second fork notice")
sink.setBranches(undefined)
await until(() => footer().type === "prompt", "the footer to return")

/**
 * R110 -- the line a fork forked *from* must stay reachable.
 *
 * `/branch` says "the other line is still there", and it was, until the forked
 * session committed its first turn: the fork point stopped being a leaf and
 * vanished from the selector, leaving a rewind as the only way back -- the
 * exact operation `/branch` exists to avoid.
 *
 * The old assertion here was `afterFork.length >= branchesBeforeFork`,
 * measured *before* any prompt created a child. At that moment activating the
 * same endpoint need not change the leaf count at all, so it held whether or
 * not the fork point survived. This runs a turn first, which is what makes the
 * fork point stop being a leaf.
 */
await ask("something on the forked line")
handle.command("branches")
await until(() => footer().type === "branches", "the selector after a forked turn")
const afterChildView = footer()
const afterChild = afterChildView.type === "branches" ? afterChildView.items : []
sink.setBranches(undefined)
await until(() => footer().type === "prompt", "the footer to return again")

const forkPointStillListed = forkPointId !== undefined &&
  afterChild.some((item) => item.id === forkPointId)
// And exactly one row says where the user is, which is the selector's contract.
const exactlyOneActive = afterChild.filter((item) => item.active).length === 1

// An unknown command is reported rather than ignored.
handle.command("nonsense")
await until(() => entries.length === 0, "the unknown-command notice")

// Export writes a real file through the sandbox seam.
handle.command("export")
await until(() => entries.length === 0, "the export notice")

/**
 * R100 -- and what it claims has to be true.
 *
 * The file said `harnessVersion: "tui"`, which is not a version of anything,
 * and listed the *renderer's* view names as the agent's tools -- so
 * registering a custom view claimed a tool that never existed and omitting one
 * hid a tool that did.
 *
 * Asserted at `provenanceOf`, which is what the command passes to
 * `TreeExport`. Reading the written file back would be better still, but the
 * sandbox is a memory provider owned by the harness's layer: any other
 * runtime building the same layer gets a *different*, empty sandbox, so a
 * read-back here would be checking a file nobody wrote. The path it went to is
 * already asserted through the notice above.
 */
const scriptedProvenance = provenanceOf(scripted)

// The agent still works afterwards.
await ask("still there?")

/**
 * V9: the conversation survives the process.
 *
 * A second harness over the *same* store, with its own sink and its own
 * transcript -- which is what a relaunch is. The first one is the session that
 * has been running above; this is what someone reopening it would see.
 *
 * A memory-backed key-value store rather than a file: what is under test is
 * that the tree is recovered and repainted, and that is the same code whether
 * the map is in memory or on disk. `test/NodeStore.test.ts` covers the backing
 * itself.
 */
const persistentKv = await Effect.runPromise(
  Effect.scoped(
    KeyValueStore.KeyValueStore.use(Effect.succeed).pipe(
      Effect.provide(KeyValueStore.layerMemory)
    )
  )
)
/**
 * The store, plus a finalizer that says when it was let go.
 *
 * `stop()` promises the harness's scope has closed, and the only way to check
 * that from outside is to watch something inside it be released. Everything
 * else -- "the next prompt was refused", "sixty timers went by" -- is a
 * consequence that also happens on its own a moment later, so it cannot tell
 * an awaited close from a forked one.
 */
let released = 0
const persistentStore = Effect.andThen(
  Effect.addFinalizer(() =>
    // Deliberately slow. A finalizer that completes within a microtask cannot
    // tell an awaited close from a forked one -- both look finished by the
    // time anyone looks. This one takes long enough that only actually
    // waiting for it succeeds.
    Effect.andThen(
      Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50))),
      Effect.sync(() => {
        released = released + 1
      })
    )),
  Effect.succeed(NodeStore.keyValue(persistentKv))
)

const firstRun = makeStore()
const firstHandle = await start(firstRun.sink, { store: persistentStore })
firstHandle.submit("remember this")
await until(
  () => firstRun.entries.some((entry) => entry.kind === "summary"),
  "the first launch to finish a turn"
)
const firstTranscript = firstRun.entries.map((entry) => entry.title).join(" | ")

/**
 * Each harness closes its own.
 *
 * `stop()` used to keep a single disposer that every `start` overwrote, so it
 * closed only the most recent harness and every earlier one kept its fibre,
 * its session and its store. One harness per process is the ordinary case,
 * which is exactly why that survived -- a second only appears here, or in a UI
 * that reopens a session.
 *
 * The check below is that the *first* harness is genuinely closed. A closed
 * session refuses work, so the prompt fails -- and the transcript shows that
 * failure rather than a user line, because a line is drawn only once the
 * kernel accepts the prompt.
 */
/**
 * Awaited, because that is now the postcondition.
 *
 * This used to fire the close and then wait sixty zero-delay timers before
 * looking, so whether the next prompt was refused came down to the scheduler
 * rather than to anything `stop` promised. `stop()` resolves when the fibre
 * has exited and its finalizers have run, so afterwards the session is
 * closed -- there is nothing left to wait for.
 */
await firstHandle.stop()
// Checked with no waiting whatsoever: the finalizer has already run by the
// time the promise resolves, which is the whole claim.
const releasedOnStop = released === 1
// Twice, from two places: a second close is the same completion, not a
// forgotten disposer and an early return.
await Promise.all([firstHandle.stop(), firstHandle.stop()])
firstHandle.submit("after stopping")
await until(
  () =>
    firstRun.entries.some((entry) => entry.title.includes("prompt failed"))
    || firstRun.entries.some((entry) => entry.title.startsWith("after stopping")),
  "the prompt after stopping to be answered"
)
const afterStopping = firstRun.entries.map((entry) => `${entry.kind}:${entry.title}`)
const ranAfterStopping = afterStopping.some((entry) =>
  entry.startsWith("user:after stopping"))
const reportedFailure = afterStopping.some((entry) => entry.includes("prompt failed"))
// And closing again did not close it again.
const releasedOnce = released === 1

// A second launch: nothing in common but the store.
const secondRun = makeStore()
await start(secondRun.sink, { store: persistentStore })
await until(
  () => secondRun.entries.some((entry) => entry.title.startsWith("resumed")),
  "the second launch to resume"
)
const resumed = secondRun.entries.map((entry) => entry.title).join(" | ")
const resumedKinds = secondRun.entries.map((entry) => entry.kind)

/**
 * Moving between lines of work needs an idle session.
 *
 * The defect R15 found in ctrl+r, on the two other paths that change which
 * branch is active: `tree.active` points at the last *completed* boundary, so
 * moving mid-run abandons the in-flight branch and steps somewhere the user
 * was not looking -- leaving the abandoned entries streaming, which blocks
 * scrollback for good.
 */
const busyRun = makeStore()
const busyHandle = await start(busyRun.sink)
// An approval is the one deterministic way to hold a run open: the scripted
// model answers faster than any test can observe "working", but a paused
// elicitation waits exactly as long as nobody answers it.
busyHandle.submit("what is here?")
// A summary is appended when a submission ends, so it is the latch. Waiting
// for `status() === "idle"` alone passes immediately -- a session is idle
// *before* its submission starts -- and nothing drains this store, because
// draining is the App's job and this one has no App.
await until(
  () => busyRun.entries.some((entry) => entry.kind === "summary"),
  "the first turn to finish"
)
busyHandle.submit("now run something")
await until(() => busyRun.footer().type === "approval", "a run paused on approval")

busyHandle.command("branch")
await until(
  () => busyRun.entries.some((entry) => entry.title.includes("cannot fork")),
  "the refusal to fork mid-run"
)
const refusedFork = busyRun.entries.some((entry) => entry.title.includes("cannot fork"))
const forkedAnyway = busyRun.entries.some((entry) => entry.title.includes("forked at"))

/**
 * R148 -- a fork and a submission issued in the same breath.
 *
 * The case above had the run already paused when the fork was asked for,
 * which any status check catches. This one issues both with nothing awaited
 * between them.
 *
 * Said plainly: **this assertion passes against the check-then-act version
 * too.** The defect it belongs to is an interleaving -- a prompt admitted
 * between a branch command's status read and its activation -- and driving
 * the harness from outside cannot place a submission inside that window:
 * whichever of the two is issued first wins the scheduler by enough that the
 * second always sees a settled state. The fix is therefore structural (one
 * permit held across the check and the change, and taken by admission too),
 * and what is kept here is the weaker property that is observable: exactly
 * one of the two outcomes happens.
 *
 * Recorded rather than dressed up, because an assertion that cannot fail is
 * worse than no assertion -- it reads as coverage.
 */
const busyFooterFirst = busyRun.footer()
if (busyFooterFirst.type === "approval") {
  busyHandle.respond(busyFooterFirst.request.id, false)
}
await until(() => busyRun.footer().type !== "approval", "the refusal to be taken")

const forksBefore = busyRun.entries.filter((entry) =>
  entry.title.includes("forked at")).length
// The fork *first*: it reads the status while the session is genuinely idle,
// and the submission lands during the activation that follows. That ordering
// is the gap -- with the fork second, the status read already sees a running
// session and any check catches it.
busyHandle.command("branch")
busyHandle.submit("race the fork")
await until(
  () =>
    busyRun.entries.some((entry) => entry.title.includes("cannot fork"))
    || busyRun.entries.filter((entry) => entry.title.includes("forked at")).length
      > forksBefore,
  "the racing fork to be decided"
)
// Let the turn -- admitted or refused -- reach an answer.
await until(
  () => {
    const view = busyRun.footer()
    if (view.type === "approval") busyHandle.respond(view.request.id, false)
    return busyRun.footer().type !== "approval"
  },
  "the racing turn to settle"
)
const racedFork = busyRun.entries.filter((entry) =>
  entry.title.includes("forked at")).length > forksBefore
const racedRefusal = busyRun.entries.filter((entry) =>
  entry.title.includes("cannot fork")).length > 1
// Exactly one of the two, never both and never neither.
const raceDecidedOnce = racedFork !== racedRefusal

await busyHandle.stop()

stop()

// And a launch with no store at all starts empty, which is the default.
const thirdRun = makeStore()
await start(thirdRun.sink)
const freshCount = thirdRun.entries.length
stop()

/**
 * R14 -- a message that dies mid-stream is still finished.
 *
 * Driven through the projection: what is under test is that a terminal message
 * event settles its entry, and landing a failure precisely between two deltas
 * of a real run is a race a test should not have to win.
 *
 * The property has nothing to do with timing. An entry left `streaming: true`
 * is never settled, and `drainSettled` takes a *prefix* -- so one of them holds
 * itself and every later entry out of scrollback for the rest of the session.
 */
const streamCases: Array<readonly [string, { readonly _tag: string }]> = [
  ["failed", { _tag: "MessageFailed" }],
  ["interrupted", { _tag: "MessageInterrupted" }],
  // The case core does not report at all: a stream that simply stops because
  // the submission ended under it.
  ["abandoned", { _tag: "SubmissionInterrupted" }]
]

const streamOutcomes = streamCases.map(([name, terminal]) => {
  const store = makeStore()
  const { onEvent } = project(store.sink, defaultViews)
  onEvent({ _tag: "SubmissionStarted" })
  onEvent({ _tag: "MessageStarted" })
  onEvent({ _tag: "MessageDelta", kind: "text", delta: "half a th" })
  const blockedWhileStreaming = store.drainSettled().length
  onEvent(terminal as never)
  store.sink.append({
    id: `after-${name}`,
    kind: "notice",
    title: "later work",
    body: { type: "none" }
  })
  const drained = store.drainSettled().map((entry) => entry.id)
  return { name, blockedWhileStreaming, drained }
})

/**
 * R128 -- a reused tool-call id draws a new row, not over an old one.
 *
 * Provider tool-call ids are correlation within one response, not a
 * session-global identity, so a later turn or another branch may reuse one.
 * The row id used to *be* that id, and `Sink.patch` takes the first row with a
 * matching id -- so the second call updated the first call's row, the second
 * row stayed `running` for ever, and scrollback (a settled *prefix*) stopped
 * there.
 *
 * The setup is deliberate: a streaming assistant entry is left open *first*,
 * so the first tool row cannot drain and is still present when the id is
 * reused. That is the arrangement in which the bug is reachable.
 */
const reuseStore = makeStore()
const { onEvent: onReuse } = project(reuseStore.sink, defaultViews)
onReuse({ _tag: "SubmissionStarted" })
// Holds everything after it in the live tree.
onReuse({ _tag: "MessageStarted" })
onReuse({ _tag: "MessageDelta", kind: "text", delta: "thinking" })

onReuse({ _tag: "ToolCallStarted", id: "call_1", name: "bash", params: { command: "first" } })
onReuse({ _tag: "ToolCallSucceeded", id: "call_1", name: "bash", result: { exit_code: 0, stdout: "one", stderr: "" } } as never)
// The same id again, while the first row is still in the live tree.
onReuse({ _tag: "ToolCallStarted", id: "call_1", name: "bash", params: { command: "second" } })
onReuse({ _tag: "ToolCallSucceeded", id: "call_1", name: "bash", result: { exit_code: 0, stdout: "two", stderr: "" } } as never)

const reuseRows = reuseStore.entries.filter((entry) => entry.kind === "tool")
const reuseStatuses = reuseRows.map((entry) => entry.status)
const reuseTitles = reuseRows.map((entry) => entry.title)
const reuseBodies = reuseRows.map((entry) =>
  entry.body.type === "structured" && entry.body.snapshot.kind === "command"
    ? entry.body.snapshot.stdout
    : "")

// Now let the message finish, and the whole prefix must drain.
onReuse({ _tag: "MessageCompleted", text: "thinking" } as never)
const reuseDrained = reuseStore.drainSettled().length
const reuseLeft = reuseStore.entries.length

/**
 * R25 -- interrupting an approval does not leave a dead question on screen.
 *
 * Core removes the pending elicitation but emits no `ElicitationResolved` for
 * it, so a footer cleared only on resolution keeps offering a choice that can
 * no longer be answered.
 */
const approvalStore = makeStore()
const { onEvent: onApproval } = project(approvalStore.sink, defaultViews)
onApproval({ _tag: "SubmissionStarted" })
onApproval({
  _tag: "ElicitationRequested",
  id: "e1",
  kind: "tool-approval",
  detail: { toolName: "bash", action: "shell", resource: "rm -rf /" }
} as never)
const askedBeforeInterrupt = approvalStore.footer().type
onApproval({ _tag: "SubmissionInterrupted" })
const askedAfterInterrupt = approvalStore.footer().type

// The ordinary path, asserted separately: a question that is *answered* takes
// the footer back immediately, while the run carries on. Without this the
// terminal clear above hides a broken resolution path, because the footer
// eventually returns either way -- just a whole submission too late.
const resolvedStore = makeStore()
const { onEvent: onResolved } = project(resolvedStore.sink, defaultViews)
onResolved({ _tag: "SubmissionStarted" })
onResolved({
  _tag: "ElicitationRequested",
  id: "e2",
  kind: "tool-approval",
  detail: { toolName: "bash", action: "shell", resource: "ls" }
} as never)
onResolved({ _tag: "ElicitationResolved", id: "e2", granted: true } as never)
const afterAnswering = resolvedStore.footer().type

/**
 * R109 -- "always" has to mean always.
 *
 * The footer offers `a` and the handle sends `{ remember: true }`, but the
 * agent was wired to `Permission.rules`, which has no `remember` -- so
 * `ToolExecution` honoured the answer and skipped the persistence, making `a`
 * behave exactly like `y` while the label promised otherwise. The same shape
 * as a key bound to nothing, one layer further in.
 *
 * Scripted precisely rather than walking the default conversation to find two
 * matching calls: the same command twice, so the grant key is the same both
 * times and the second question is the thing under test.
 */
const twice: ReadonlyArray<TestLanguageModel.Turn> = [
  { toolCalls: [{ id: "r1", name: "bash", params: { command: "echo same" } }] },
  TestLanguageModel.text("once"),
  { toolCalls: [{ id: "r2", name: "bash", params: { command: "echo same" } }] },
  TestLanguageModel.text("twice")
]

const askedEachTime = async (answer: "y" | "a"): Promise<number> => {
  const run = makeStore()
  const runHandle = await start(run.sink, { backend: scriptedWith(twice) })
  let questions = 0

  const summaries = () => run.entries.filter((entry) => entry.kind === "summary").length

  /**
   * One prompt, answered if it asks.
   *
   * Counted from this turn's own baseline. A latch of "a summary exists" is
   * true from the second turn onwards, so the wait returned immediately and
   * the second question went unanswered -- the run then hung on an
   * elicitation nobody replied to.
   */
  const runTurn = async (prompt: string) => {
    const before = summaries()
    runHandle.submit(prompt)
    await until(
      () => run.footer().type === "approval" || summaries() > before,
      `a question or the end of a turn (${answer})`
    )
    const view = run.footer()
    if (view.type === "approval") {
      questions++
      if (answer === "a") runHandle.respond(view.request.id, true, { remember: true })
      else runHandle.respond(view.request.id, true)
    }
    await until(() => summaries() > before, `the turn to end (${answer})`)
  }

  await runTurn("run it")
  await runTurn("run it again")

  runHandle.stop()
  return questions
}

const askedWithY = await askedEachTime("y")
const askedWithA = await askedEachTime("a")

/**
 * R132 -- a repaint must say what history says.
 *
 * `restore.ts` reads a conversation that has no events, so every fact it shows
 * comes from the messages themselves. Status used to be inferred from whether
 * a result was present, which got both directions wrong: a recorded *failure*
 * was repainted with a success tick, and a success whose decoded value is
 * `undefined` was shown as failed. Results were also matched by call id across
 * the whole conversation, so a reused id meant both calls displayed the later
 * output.
 *
 * Built as a literal history rather than driven through a session, because
 * these are exactly the shapes a scripted run will not produce.
 */
const restored = (
  parts: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<{ kind: string; status?: string; title: string }> =>
  entriesOf(
    Prompt.fromMessages(parts.map((content) => content[0] as never)),
    defaultViews
  ).map((entry) => ({
    kind: entry.kind,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    title: entry.title
  }))

const call = (id: string, name: string, params: unknown) =>
  Prompt.assistantMessage({
    content: [Prompt.toolCallPart({ id, name, params, providerExecuted: false } as never)]
  })

const toolResult = (id: string, name: string, result: unknown, isFailure: boolean) =>
  Prompt.toolMessage({
    content: [Prompt.toolResultPart({ id, name, result, isFailure } as never)]
  })

// A failure recorded in history.
const failedRestore = restored([
  [call("c1", "bash", { command: "boom" })],
  [toolResult("c1", "bash", "it exploded", true)]
])

// A success whose value is `undefined`.
const undefinedRestore = restored([
  [call("c2", "bash", { command: "quiet" })],
  [toolResult("c2", "bash", undefined, false)]
])

// The same id in two turns.
const duplicateRestore = restored([
  [call("c3", "bash", { command: "first" })],
  [toolResult("c3", "bash", { exit_code: 0, stdout: "one", stderr: "" }, false)],
  [call("c3", "bash", { command: "second" })],
  [toolResult("c3", "bash", { exit_code: 1, stdout: "two", stderr: "" }, true)]
])

// A result recorded under this id but for a different tool.
const mismatchedRestore = restored([
  [call("c4", "bash", { command: "mine" })],
  [toolResult("c4", "read_file", "someone else's", false)]
])

// A call whose turn never finished.
const unfinishedRestore = restored([
  [call("c5", "bash", { command: "interrupted" })]
])

// Capture only after a flush: `captureCharFrame` returns the last *painted*
// frame, so reading it straight after a state change shows the previous one.
await flush()
// Snapshotted here, before the key section below presses `/` and changes the
// footer. A check that reads live state at assertion time is a check whose
// result depends on everything that ran after it.
const footerAtEnd = footer().type

const transcript = transcriptSoFar + externalOutput.takeText()
const live = captureCharFrame()

console.log("--- committed to terminal scrollback ---")
console.log(transcript)
console.log("--- live region, after ---")
console.log(live)

/**
 * Every key the footer advertises does something.
 *
 * `ctrl+d quit` sat in the footer bound to nothing, and `ctrl+c` reached the
 * app only through `process.on("SIGINT")` -- which a terminal in raw mode need
 * not deliver, because the renderer owns the keyboard. An affordance that does
 * nothing teaches the user the app is broken, so the advertisement and the
 * binding are checked against each other rather than separately.
 *
 * Driven through `mockInput`, which is the only way to test a key: the handler
 * is inside the renderer and there is nothing else to call.
 */
let quitRequests = 0
let interruptRequests = 0
const keyRun = makeStore()
const keyHandle: Handle = {
  ...handle,
  interrupt: () => {
    interruptRequests++
  }
}
const keyRender = await testRender(
  () => (
    <App
      entries={keyRun.entries}
      status={keyRun.status()}
      handle={keyHandle}
      commitSettled={keyRun.commitSettled}
      footer={keyRun.footer()}
      rewind={keyRun.rewind()}
      backend={keyRun.backend()}
      dismiss={() => keyRun.sink.setPalette(undefined)}
      openPalette={() => keyRun.sink.setPalette(keyHandle.commands)}
      quit={() => {
        quitRequests++
      }}
    />
  ),
  { width: 80, height: 12 }
)
await keyRender.flush()

keyRender.mockInput.pressKey("d", { ctrl: true })
keyRender.mockInput.pressKey("c", { ctrl: true })
await keyRender.flush()

/**
 * `/` is tested on the *main* renderer, not the one above.
 *
 * A printable key goes to whichever focused input owns the keyboard, and with
 * two renderers alive that is not necessarily the one whose `mockInput` was
 * called. Control keys broadcast, which is why ctrl+d and ctrl+c can be tested
 * in isolation and this cannot.
 */
/**
 * R106 -- what actually happens when someone types.
 *
 * Every other prompt in this suite goes through `handle.submit`, which cannot
 * see the input box at all -- so none of them could detect that
 * `InputRenderable.submit()` emits the value and *leaves it there*. The sent
 * prompt stayed on screen, the next keystroke appended to it, and `/` was
 * never at an empty prompt again.
 */
mockInput.typeText("typed by hand")
await flush()
const beforeEnter = captureCharFrame()
mockInput.pressEnter()
await flush()
const afterEnter = captureCharFrame()

// A slash mid-line is a character, not a command: paths and regexes have them.
mockInput.typeText("src/a.ts")
await flush()
const midLineSlash = footer().type
const midLineFrame = captureCharFrame()
// Clear it again for the checks below.
for (let index = 0; index < "src/a.ts".length; index++) mockInput.pressBackspace()
await flush()

mockInput.pressKey("/")
await flush()
const paletteOpened = footer().type === "palette"
// Getting out again. `dismiss` is what the escape binding calls; asserting the
// keystroke would be asserting how OpenTUI routes a key inside a focused
// `<select>`, which is theirs to get right and not ours to pin.
sink.setPalette(undefined)
const dismissed = footer().type === "prompt"


const checks: Array<readonly [string, boolean]> = [
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
  // W5: both sides of the edit, from `matched` and `new_string`.
  ["change shows the replaced text", transcript.includes("- hello")],
  ["change shows the replacement", transcript.includes("+ greetings")],
  // The fuzzy case, which is why `matched` is reported at all: the file had
  // trailing spaces the model did not reproduce, so what was replaced is not
  // what was asked for -- and the rendered line shows the real text.
  ["fuzzy match names its strategy", transcript.includes("matched by line-trimmed")],
  ["fuzzy match carries the real replaced text", (() => {
    const body = bodyOf(
      defaultViews,
      "edit_file",
      {
        path: "src/drift.ts",
        replacements: 1,
        added: 1,
        removed: 1,
        strategy: "line-trimmed",
        matched: "const value = 1;   \n"
      },
      { new_string: "const value = 2;\n" }
    )
    if (body.type !== "structured" || body.snapshot.kind !== "change") return false
    // The trailing spaces the model never typed: this is the whole
    // reason the library reports `matched` rather than echoing back
    // `old_string`.
    return body.snapshot.before === "const value = 1;   \n"
      && body.snapshot.after === "const value = 2;\n"
  })()],

  // W4: edit_file returns a record, so the change renders from fields.
  ["edit renders a change summary", /\+\d+ -\d+/.test(transcript)],
  ["change names the file", transcript.includes("src/index.ts")],
  // Streaming: the reply was chunked, so the delta path built it up.
  ["streamed reply committed whole", transcript.includes("That is what the workspace holds.")],
  ["no empty assistant bubble", !/● \s*$/m.test(transcript)],
  ["turn summary committed", transcript.includes("▣")],
  ["summary reports a tool count", transcript.includes("1 tool")],
  ["summary reports a duration", /▣ \d+(\.\d+)?(ms|s)/.test(transcript)],

  // V6: rewind, through the session tree.
  ["turns were captured as nodes", depthBefore > 1],
  ["rewind stepped back one node", depthAfter === depthBefore - 1],
  ["rewind is marked, not erased", transcript.includes("rewound to")],
  // The whole point of not erasing: scrollback is write-once, so the log has
  // to keep saying what the user actually saw.
  ["rewind kept the earlier transcript", transcript.includes("That is what the workspace holds.")],
  ["rewound branch answers prompts", answeredAfterRewind],
  // This is what `tree.events` bought. The subscription was made once, before
  // any branch existed, and survived the switch -- a per-session subscription
  // would have been left listening to the branch that was released.
  //
  // The turn summary is the proof rather than the reply text: a summary is
  // built by the projection from `SubmissionCompleted`, so one appearing after
  // the rewind marker means events from the *new* branch reached the *old*
  // subscriber. The user's own message would prove nothing -- `submit` appends
  // that directly, without going near the event stream.
  ["one subscription survived the switch", (() => {
    const marker = transcript.indexOf("rewound to")
    return marker !== -1 && transcript.indexOf("▣", marker) > marker
  })()],
  ["hints shown at this width", live.includes("enter send")],
  ["hints hidden when narrow", widthPolicy(50).hints === false],
  ["compact below its breakpoint", widthPolicy(50).compact === true],
  ["spacious only when wide", widthPolicy(80).spacious === false && widthPolicy(120).spacious],
  ["approval surface replaces the prompt", asking.includes("y allow") && !asking.includes("message")],
  ["approval uses the tool's own prose", asking.includes("? run: rm -rf /")],
  ["approval names the resource", asking.includes("rm -rf")],
  ["refusal is recorded", transcript.includes("refused")],
  ["footer returned to the prompt", footerAtEnd === "prompt"],
  ["durations read at each magnitude", duration(340) === "340ms" && duration(1234) === "1.2s" && duration(125_000) === "2m 05s"]
]

// W1/W2: the registry. Exercised directly rather than through a render, so a
// fallback and a user-supplied rule are both provable without a tool existing.
/**
 * R4: an interrupted tool is terminal.
 *
 * Driven through the projection rather than a real run, because landing an
 * interrupt precisely while a tool is in flight is a race. The property has
 * nothing to do with timing: a tool entry that never leaves `running` is never
 * settled, and `drainSettled` takes a *prefix*, so one of them holds itself
 * and every later entry out of scrollback for the rest of the session.
 */
const interruptStore = makeStore()
const { onEvent: onInterrupted } = project(interruptStore.sink, defaultViews)
onInterrupted({ _tag: "ToolCallStarted", id: "x1", name: "bash", params: { command: "sleep 9" } })
const runningEntries = interruptStore.drainSettled().length
onInterrupted({ _tag: "ToolCallInterrupted", id: "x1", name: "bash" })
interruptStore.sink.append({
  id: "after",
  kind: "notice",
  title: "later work",
  body: { type: "none" }
})
// By kind, not by id: a row's id is now minted per call rather than taken from
// the provider's tool-call id, because provider ids are correlation within one
// response and get reused (R128).
const drainedAfterInterrupt = interruptStore.drainSettled()
const drainedIds = drainedAfterInterrupt.map((entry) => entry.id)

/**
 * R13: a rejected prompt is not drawn as if it were received.
 *
 * The user's line comes from `SubmissionStarted`, so a prompt the kernel never
 * admitted leaves no trace of having been said. Driven through the projection
 * because the interesting case is the event that *does not* arrive.
 */
const rejectedStore = makeStore()
const offers: Array<string> = ["accepted"]
const { onEvent: onAdmitted } = project(
  rejectedStore.sink,
  defaultViews,
  () => offers.shift()
)
onAdmitted({ _tag: "SubmissionStarted" })
const drawnWhenAdmitted = rejectedStore.drainSettled().map((entry) => entry.title)
// Nothing offered: a submission the user did not type -- and nothing to draw.
onAdmitted({ _tag: "SubmissionStarted" })
const drawnWhenNotOffered = rejectedStore.drainSettled().length

/**
 * The backend seam.
 *
 * Checked as pure functions rather than by starting a live session, because
 * the live path needs a key and a network -- which is the whole reason the
 * default is scripted.
 */
const defaultBackend = fromArgv([])
const liveBackend = fromArgv(["--live", "--workspace", "/tmp/work", "--model", "some-model"])
const liveProvenance = provenanceOf(liveBackend)
let helpText = ""
try {
  fromArgv(["--live"])
} catch (error) {
  helpText = error instanceof Error ? error.message : String(error)
}
let refusedWithoutWorkspace = false
try {
  fromArgv(["--live"])
} catch {
  refusedWithoutWorkspace = true
}
let refusedWhenWorkspaceIsAFlag = false
try {
  fromArgv(["--live", "--workspace", "--model", "x"])
} catch {
  refusedWhenWorkspaceIsAFlag = true
}

/**
 * The diff, which the plan had recorded as blocked on a library decision.
 *
 * It was not: `edit_file` reports `matched` and the call carries
 * `new_string`, so both sides were already here and only the diff itself
 * was missing.
 */
const oneLine = Diff.of("const value = 1;\n", "const value = 2;\n")
const withContext = Diff.of("a\nb\nc\n", "a\nB\nc\n")
const pureAddition = Diff.of("a\n", "a\nb\n")
const unchanged = Diff.of("same\n", "same\n")
const unifiedText = Diff.unified("src/x.ts", "a\nb\n", "a\nc\n")

const intoEmpty = Diff.of("", "one\n")
const emptied = Diff.of("one\n", "")
const bothEmpty = Diff.of("", "")
const newlineAdded = Diff.of("a", "a\n")
const newlineRemoved = Diff.of("a\n", "a")
const crlf = Diff.of("a\nb\n", "a\r\nb\r\n")

/**
 * Past the budget, the alignment must not run at all.
 *
 * Timed rather than inspected: the failure this guards against is
 * allocating a matrix of millions of cells, which shows up as the UI
 * freezing after the file has already been written. A test that only
 * checked the output would pass against the quadratic version.
 */
const huge = Array.from({ length: 1200 }, (_, index) => `line ${index}`).join("\n") + "\n"
const hugeOther = Array.from({ length: 1200 }, (_, index) => `other ${index}`).join("\n") + "\n"
const hugeDiff = Diff.of(huge, hugeOther)

/**
 * The cases a cell budget alone lets through.
 *
 * `left.length * right.length` is **zero** when one side is empty, so
 * creating or deleting a whole file passed the check and then built a line
 * object per line -- a bounded matrix and an unbounded result. A one-line
 * side has the same shape.
 */
// Past the line budget, where 1200 deliberately is not: a file that size is
// still worth lining up, and a fixture that trips every limit proves less.
const enormous = Array.from({ length: 6000 }, (_, index) => `line ${index}`)
  .join("\n") + "\n"
const emptyToHuge = Diff.of("", enormous)
const hugeToEmpty = Diff.of(enormous, "")
const oneToHuge = Diff.of("only\n", enormous)
// A single line can itself be megabytes: a minified bundle is one line, and
// splitting it is cheap while rendering it is not.
const oneEnormousLine = Diff.of("x".repeat(3_000_000), "y")


/**
 * R129 -- a failed write loses nothing.
 *
 * The batch version removed the whole settled prefix and *then* wrote each
 * entry, so a throw partway lost every entry after it -- and retrying was
 * unsafe, because the earlier ones had already reached the terminal
 * irreversibly. Ownership now transfers one line at a time.
 */
const failStore = makeStore()
for (const id of ["one", "two", "three"]) {
  failStore.sink.append({ id, kind: "notice", title: id, body: { type: "none" } })
}
const written: Array<string> = []
let threw = false
try {
  failStore.commitSettled((entry) => {
    // Fails on the second, with the first already irreversibly written.
    if (entry.id === "two") throw new Error("terminal went away")
    written.push(entry.id)
  })
} catch {
  threw = true
}
const leftAfterFailure = failStore.entries.map((entry) => entry.id)

// A later attempt picks up exactly where it stopped.
const retried: Array<string> = []
failStore.commitSettled((entry) => {
  retried.push(entry.id)
})

/**
 * R99 -- the backend label obeys the width policy.
 *
 * The footer only ever drew a ten-character `scripted` in this suite, so a
 * live label -- a model name plus a workspace path, wider than some terminals
 * on its own -- was never rendered at all. These check the fitting directly
 * and then at three real widths.
 */
const longLabel = "claude-opus-4-5 · C:/Users/somebody/projects/a-rather-long-workspace"
const fitted = [40, 80, 120].map((width) =>
  fit(longLabel, widthPolicy(width).backendWidth))
// The middle goes, not the end: both halves identify the backend, and trimming
// the tail leaves every workspace under one parent looking identical.
const keepsBothEnds = fitted.every((text) =>
  text[0] === longLabel[0] && text[text.length - 1] === longLabel[longLabel.length - 1])

const narrowRun = makeStore()
narrowRun.sink.setBackend(longLabel)
const narrow = await testRender(
  () => (
    <App
      entries={narrowRun.entries}
      status={narrowRun.status()}
      handle={handle}
      commitSettled={narrowRun.commitSettled}
      footer={narrowRun.footer()}
      rewind={narrowRun.rewind()}
      backend={narrowRun.backend()}
      dismiss={() => narrowRun.sink.setPalette(undefined)}
      openPalette={() => narrowRun.sink.setPalette(handle.commands)}
      quit={() => {}}
    />
  ),
  { width: 40, height: 10 }
)
await narrow.flush()
const narrowFrame = narrow.captureCharFrame()
/**
 * Evidence that the label was fitted *before* rendering.
 *
 * "the frame does not overflow" cannot fail: OpenTUI clips text to its box, so
 * a captured line is never wider than the terminal whatever it is given. The
 * label would simply be silently truncated at the edge, with no ellipsis and
 * no sign that anything was lost. The ellipsis is the difference between a
 * label that was cut deliberately and one that ran off the end.
 */
// Specific to the label: the input's placeholder contains an ellipsis of its
// own, so looking for any `…` in the frame passes whatever the footer does.
const narrowShowsEllipsis = /claude…/.test(narrowFrame)
const narrowHidesFullPath = !narrowFrame.includes("a-rather-long-workspace")

const unknownTitle = titleOf(defaultViews, "deploy", { environment: "prod" })
const unknownBody = bodyOf(defaultViews, "deploy", "shipped")

/**
 * What an application adding its own tool would write.
 *
 * A real tool, not a name in a record, because the types are the thing being
 * tested: `params` below is `deploy`'s own parameters, inferred from the
 * toolkit passed alongside the rules. The previous version of this example
 * wrote `(params as { environment: string })` -- a cast, in the code that
 * advertises the extension point, in a repository whose first rule is that
 * user code must never need one.
 */
const deploy = Tool.make("deploy", {
  parameters: Schema.Struct({
    environment: Schema.String,
    replicas: Schema.Number
  }),
  success: Schema.Struct({ url: Schema.String })
})

const extended = withViews([deploy], {
  // No narrowing helpers, no cast: `environment` is a string because the
  // toolkit says so, and `replica` instead of `replicas` would not compile.
  deploy: {
    title: (params) => `deploy → ${params.environment} ×${params.replicas}`,
    body: (result) => ({ type: "text", content: `rolled out to ${result.url}` }),
    approval: (request) => `deploy to ${request.resource}`
  }
})
/**
 * Compiling is not proof that inference is precise -- `any` compiles too.
 *
 * These assert the two sides are the tool's own types and not `unknown`, and
 * are the reason the cast is gone rather than merely relocated. Break either
 * `ViewsFor` mapping and one of them stops compiling.
 */
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type DeployView = NonNullable<Parameters<typeof withViews<readonly [typeof deploy]>>[1]["deploy"]>
type DeployParams = Parameters<NonNullable<DeployView["title"]>>[0]
type DeployResult = Parameters<NonNullable<DeployView["body"]>>[0]

export type _ParamsAreNotAny = Assert<IsAny<DeployParams> extends true ? false : true>
export type _ParamsAreTheTool = Assert<
  DeployParams extends { readonly environment: string; readonly replicas: number } ? true : false
>
export type _ResultIsTheTool = Assert<
  DeployResult extends { readonly url: string } ? true : false
>

const customTitle = titleOf(extended, "deploy", { environment: "prod", replicas: 3 })
const customBody = bodyOf(extended, "deploy", { url: "https://example.test" }, {})

// Replacing one of ours, the way handlers can be replaced. Typed against our
// own toolkit, so this proves the same inference covers the built-in rules.
const replaced = withViews(CodingToolkit.tools, { bash: { title: () => "shell" } })

checks.push(
  ["unknown tool falls back to a legible title", unknownTitle === "deploy [environment=prod]"],
  ["unknown tool still renders a body", unknownBody.type === "text"],
  ["an application can register its own tool", customTitle === "deploy → prod ×3"],
  // Both sides are typed, and they are typed differently: parameters arrive
  // as the model encoded them, results as the handler returned them.
  ["a rule reads its tool's result without narrowing", customBody.type === "text"
    && customBody.content === "rolled out to https://example.test"],
  ["a registered rule can replace one of ours", titleOf(replaced, "bash", {}) === "shell"],
  ["replacing one rule keeps the others", bodyOf(replaced, "list_files", []).type === "structured"],
  ["our own titles still apply", titleOf(defaultViews, "edit_file", { path: "a.ts" }) === "edit a.ts"],

  // R4
  ["a running tool holds back the transcript", runningEntries === 0],
  ["an interrupted tool settles",
    drainedAfterInterrupt.some((entry) => entry.kind === "tool" && entry.status === "failed")],
  // The point of the fix: it stops blocking everything behind it.
  ["and stops blocking what follows", drainedIds.includes("after")],

  // R13
  ["an admitted prompt is drawn", drawnWhenAdmitted.includes("accepted")],
  ["a prompt the kernel never took is not", drawnWhenNotOffered === 0],

  // V7
  ["the palette offers commands", handle.commands.length > 0],
  ["/help explains each of them", handle.commands.every((command) =>
    transcriptSoFar.includes(`/${command.name}`))],
  ["/branches lists at least the branch in use", listed.length > 0],
  ["and marks which one that is", listed.some((item) => item.active)],
  ["a branch is described, not just named", listed.every((item) =>
    item.detail.includes("message"))],
  ["switching returns the footer to the prompt", footerAtEnd === "prompt"],
  ["an unknown command is reported", transcript.includes("no such command")],
  ["export writes a file and names it", /wrote \.effect-agent\/export-.*\.json/.test(transcript)],
  ["and says it was not redacted", transcript.includes("unredacted")],
  ["the agent still works after a command", transcript.includes("still there?")],

  // Forking
  ["a fork is named so it can be found again", /forked at .* as fork-1/.test(transcript)],
  ["and says the other line survives", transcript.includes("still there")],
  // The point of a fork rather than a rewind: the line forked from is one of
  // the choices afterwards, not something that was undone.
  ["forking adds a line of work", afterFork.length >= branchesBeforeFork],
  // R110 -- and the line it forked *from* is still selectable after the new
  // line has grown a turn, which is when it stops being a leaf.
  ["the fork point survives its first child", forkPointStillListed],
  // R101 -- one row, and only one, says where the user is. After a rewind the
  // cursor is an internal node, and a leaves-only list marked none of them.
  ["the selector always says where you are", exactlyOneActive],
  ["the fork is the one in use", afterFork.some((item) => item.active)],

  // V9: persistence
  ["a turn is recorded on the first launch", firstTranscript.includes("remember this")],
  ["a second launch recovers the conversation", resumed.includes("remember this")],
  ["and says it resumed rather than started", resumed.includes("resumed")],
  // Repainted from history, so the user's line and the model's are both there
  // and are the kinds they were -- not one undifferentiated blob.
  ["the repaint keeps who said what",
    resumedKinds.includes("user") && resumedKinds.includes("assistant")],
  // History carries no timings, so a summary would be invented. `restore.ts`
  // paints what the conversation contains and nothing else.
  ["and invents no turn summary", !resumedKinds.includes("summary")],
  ["without a store, a launch starts empty", freshCount === 0],
  // A closed harness stays closed: `stop` used to close only the most recent,
  // so an earlier one kept running and would have accepted this.
  ["a stopped harness accepts no more work", !ranAfterStopping],
  ["and says so rather than going quiet", reportedFailure],

  // Moving branches mid-run
  ["forking while a turn runs is refused", refusedFork],
  ["and does not happen anyway", !forkedAnyway],

  // Advertised keys
  ["ctrl+d quits, as the footer says", quitRequests === 1],
  // Bound in the renderer rather than left to SIGINT, which a raw-mode
  // terminal need not deliver.
  ["ctrl+c interrupts from the keyboard", interruptRequests === 1],
  // R100
  ["it names the library version, not the app",
    scriptedProvenance.harnessVersion === VERSION],
  ["it lists the agent's tools, not the renderer's views",
    scriptedProvenance.tools?.includes("edit_file") === true
      && scriptedProvenance.tools?.includes("bash") === true],
  // Every tool, so an omission from the registry cannot hide one.
  ["it lists every tool the agent has",
    CodingToolkit.tools.every((tool) =>
      scriptedProvenance.tools?.includes(tool.name) === true)],
  // The load-bearing property, and it is structural rather than a value:
  // `provenanceOf` takes a backend and *cannot see the view registry at all*.
  // A value assertion cannot show this, because today the six view names and
  // the six tool names coincide exactly -- which is precisely why the original
  // bug was invisible. Registering a custom view is what made them differ, and
  // the signature is what now makes that impossible to get wrong.
  ["and cannot see the view registry", provenanceOf.length === 1],
  ["a scripted run says so", scriptedProvenance.model?.modelId === "scripted"],
  ["and a live run names its real model",
    liveProvenance.model?.modelId === "some-model"],
  // `cwd` stays opt-in even here, where a workspace is obviously known.
  ["and neither records a path",
    scriptedProvenance.cwd === undefined && liveProvenance.cwd === undefined],

  // R132
  ["a recorded failure repaints as a failure",
    failedRestore.some((entry) => entry.kind === "tool" && entry.status === "failed")],
  // Status comes from `isFailure`, not from whether a value is present: a
  // failure has a result too, and a success may not.
  ["a success with no value is still a success",
    undefinedRestore.some((entry) => entry.kind === "tool" && entry.status === "ok")],
  // Matched within the turn, because provider ids are unique in a
  // response and not across one.
  ["a reused id does not make both calls show the same result",
    duplicateRestore.filter((entry) => entry.kind === "tool").length === 2
      && duplicateRestore.filter((entry) => entry.status === "ok").length === 1
      && duplicateRestore.filter((entry) => entry.status === "failed").length === 1],
  ["and each keeps its own arguments",
    duplicateRestore.some((entry) => entry.title.includes("first"))
      && duplicateRestore.some((entry) => entry.title.includes("second"))],
  // Better to show a call with no output than somebody else's.
  ["a result for another tool is not borrowed",
    mismatchedRestore.some((entry) => entry.kind === "tool" && entry.status === "failed")],
  ["an unfinished call is terminal, not running",
    unfinishedRestore.every((entry) => entry.status !== "running")],

  // R148
  // Weaker than it looks -- see the comment at the fixture.
  ["a fork racing a submission is decided one way, not both", raceDecidedOnce],

  // R149
  ["stop resolves only once the harness has closed", releasedOnStop],
  ["and closing twice is the same completion, not a second close", releasedOnce],

  // R109
  ["answering once asks again next time", askedWithY === 2],
  ["answering always does not", askedWithA === 1],

  // R99
  ["a long label is cut to fit", fitted.every((text, index) =>
    text.length <= widthPolicy([40, 80, 120][index]!).backendWidth)],
  ["and says it was cut", fitted.every((text) => text.includes("…"))],
  ["keeping both ends, which are what identify it", keepsBothEnds],
  // The frame nobody rendered: a live-length label in a narrow terminal.
  ["a narrow footer cuts the label deliberately", narrowShowsEllipsis],
  ["rather than letting it run off the edge", narrowHidesFullPath],

  // R129
  ["a write failure surfaces", threw],
  ["what was written is gone from the store", !leftAfterFailure.includes("one")],
  // The entry that failed is still there, so nothing was lost -- and nothing
  // after it was written twice.
  ["what failed is kept", leftAfterFailure[0] === "two"],
  ["and so is everything behind it", leftAfterFailure.includes("three")],
  ["a retry resumes where it stopped", retried.join(",") === "two,three"],
  ["and does not repeat what was already written", !retried.includes("one")],

  // R106
  ["typing reaches the input", beforeEnter.includes("typed by hand")],
  ["and enter clears it", !afterEnter.includes("typed by hand")],
  ["a slash mid-line stays a character", midLineSlash === "prompt"],
  ["and is shown as typed", midLineFrame.includes("src/a.ts")],

  ["/ opens the palette", paletteOpened],
  ["and dismissing leaves it", dismissed],

  // R14
  ["a streaming message holds back the transcript",
    streamOutcomes.every((outcome) => outcome.blockedWhileStreaming === 0)],
  ...streamOutcomes.map((outcome) =>
    [
      `a ${outcome.name} message settles`,
      outcome.drained.some((id) => id.startsWith("assistant"))
    ] as const),
  ...streamOutcomes.map((outcome) =>
    [
      `and stops blocking what follows it (${outcome.name})`,
      outcome.drained.includes(`after-${outcome.name}`)
    ] as const),

  // R128
  ["a reused call id draws two rows", reuseRows.length === 2],
  ["each keeps its own arguments",
    reuseTitles[0]?.includes("first") === true && reuseTitles[1]?.includes("second") === true],
  ["each keeps its own result",
    reuseBodies[0] === "one" && reuseBodies[1] === "two"],
  // The failure this prevents: the second row never settling, and the
  // transcript stopping there for the rest of the session.
  ["both settle", reuseStatuses.every((status) => status === "ok")],
  ["and the whole prefix drains once the message ends",
    reuseDrained > 0 && reuseLeft === 0],

  // R25
  ["an approval is asked", askedBeforeInterrupt === "approval"],
  ["and interrupting the run takes the question away",
    askedAfterInterrupt === "prompt"],
  ["answering takes it away at once, not at the end of the run",
    afterAnswering === "prompt"],

  // R107: a budget in front of the alignment
  ["an oversized edit is summarised, not aligned", hugeDiff.summarised],
  ["and it says how much changed",
    hugeDiff.lines.some((line) => line.text.includes("1200 lines"))],
  // 1200x1200 is 1.44M cells; the quadratic version took seconds and
  // allocated hundreds of megabytes to produce output clipped to twelve
  // lines.
  // The summary and the alignment are exclusive paths, so asserting the
  // summary *is* asserting the matrix was never allocated. A timing assertion
  // was here first and passed with the budget removed: 1200x1200 is fast
  // enough on this machine to hide the thing it was meant to catch.
  ["so the alignment never ran", hugeDiff.lines.length === 2],
  // R183: an empty side makes the cell product zero, so these reached the
  // aligner and produced a line object per line of the file.
  ["creating a whole file is summarised", emptyToHuge.summarised],
  ["deleting one is too", hugeToEmpty.summarised],
  ["and so is a one-line side against a file", oneToHuge.summarised],
  ["a single enormous line is summarised by size",
    oneEnormousLine.summarised
      && oneEnormousLine.lines.some((line) => line.text.includes("bytes"))],
  // The summary says the real counts rather than standing in for a patch.
  ["and the summary reports the real counts",
    emptyToHuge.lines[0]?.text === "0 lines"
      && emptyToHuge.lines[1]?.text === "6000 lines"],

  // R108: empty sides and the EOF newline
  ["inserting into an empty file removes nothing",
    intoEmpty.lines.every((line) => line.kind === "added")],
  ["emptying a file adds nothing",
    emptied.lines.every((line) => line.kind === "removed")],
  ["empty to empty is no change at all", bothEmpty.lines.length === 0],
  // Both sides have the same lines, so this change has no line to sit on;
  // without tracking it the diff showed nothing while the file had changed.
  ["adding a final newline is reported", newlineAdded.newlineChange === "added"],
  ["removing one is too", newlineRemoved.newlineChange === "removed"],
  ["and the unified form marks it",
    Diff.unified("f", "a", "a\n").includes("No newline at end of file")],
  // An empty side is `-0,0`, not `-1,0`.
  ["an empty side is zero lines in the header",
    Diff.unified("f", "", "x\n").includes("@@ -0,0 +1,1 @@")],
  // A file with Windows line endings would otherwise differ from itself on
  // every line, the carriage return riding along on the end of each.
  ["CRLF is not a change to every line",
    crlf.lines.every((line) => line.kind === "context")],
  // The diff
  ["a replaced line shows as one removal and one addition",
    oneLine.lines.filter((line) => line.kind === "removed").length === 1
      && oneLine.lines.filter((line) => line.kind === "added").length === 1],
  // The whole reason to diff rather than print each side: lines that did
  // not change are shown once, in place, so a reader can see where the
  // change landed.
  ["unchanged lines survive as context",
    withContext.lines.filter((line) => line.kind === "context")
      .map((line) => line.text).join(",") === "a,c"],
  ["an addition removes nothing",
    pureAddition.lines.every((line) => line.kind !== "removed")],
  ["an identical edit is all context",
    unchanged.lines.every((line) => line.kind === "context")],
  // `split` reports a phantom trailing entry for text ending in a newline,
  // which would give every whole-line edit a spurious blank line.
  ["no phantom trailing line", oneLine.lines.length === 2],
  ["the unified form carries real counts",
    unifiedText.includes("@@ -1,2 +1,2 @@")],
  ["and names the file on both sides",
    unifiedText.includes("--- a/src/x.ts")
      && unifiedText.includes("+++ b/src/x.ts")],
  // Through the rendered transcript, with the fuzzy edit's real `matched`
  // text: interleaved, not one list then another.
  ["the transcript shows a diff, not two lists",
    /- const value = 1;/.test(transcript) && /[+] const value = 2;/.test(transcript)],

  // The backend seam
  ["scripted unless asked otherwise", defaultBackend.kind === "scripted"],
  ["the footer names the running backend", backend() === "scripted"],
  ["--live selects a real model and workspace", liveBackend.kind === "live"],
  ["and names both, so it is never a guess",
    liveBackend.label.includes("some-model") && liveBackend.label.includes("/tmp/work")],
  // Neither half is defaulted: defaulting the workspace would make the
  // dangerous case the easy one.
  ["--live without a workspace is refused", refusedWithoutWorkspace],
  // R96: the boundary is described precisely, in both places a user meets it.
  // An earlier version said the sandbox bounded "the whole of what it can
  // reach", which was true of the file tools and false of the shell -- the
  // more dangerous half.
  ["the help says bash is not confined",
    helpText.includes("bash") && helpText.includes("anything on")],
  ["and a live run warns before anything runs",
    liveBackend.warning !== undefined
      && liveBackend.warning.includes("runs as you")],
  ["while a scripted run has nothing to warn about",
    defaultBackend.warning === undefined],
  ["and a flag is not mistaken for a directory", refusedWhenWorkspaceIsAFlag]
)

console.log("--- checks ---")
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
}

stop()
console.log(failed === 0 ? "\nsmoke: OK" : `\nsmoke: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
