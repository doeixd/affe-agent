import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { Effect } from "effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as NodeStore from "../../../src/tree/NodeStore.js"
import { fromArgv } from "./backend.ts"
import * as Diff from "./diff.ts"
import { project, start, stop } from "./harness.ts"
import { makeStore } from "./store.ts"
import type { Sink } from "./view.ts"
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { CodingToolkit } from "../../../src/coding/index.js"
import { bodyOf, defaultViews, titleOf, withViews } from "./tools.ts"
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

const { backend, drainSettled, entries, footer, rewind, sink, status } = makeStore()
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

const { captureCharFrame, externalOutput, flush } = await testRender(
  () => (
    <App entries={entries} status={status()} handle={handle} drainSettled={drainSettled} footer={footer()} rewind={rewind()} backend={backend()} dismiss={() => sink.setPalette(undefined)}
      openPalette={() => sink.setPalette(handle.commands)} />
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
const listed = footer().type === "branches"
  ? (footer() as { type: "branches"; items: ReadonlyArray<{ id: string; label: string; detail: string; active: boolean }> }).items
  : []

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
const afterFork = footer().type === "branches"
  ? (footer() as {
    type: "branches"
    items: ReadonlyArray<{ id: string; label: string; detail: string; active: boolean }>
  }).items
  : []
handle.command("branch")  // dismisses nothing; the selector is still open
await until(() => entries.length === 0, "the second fork notice")
sink.setBranches(undefined)
await until(() => footer().type === "prompt", "the footer to return")

// An unknown command is reported rather than ignored.
handle.command("nonsense")
await until(() => entries.length === 0, "the unknown-command notice")

// Export writes a real file through the sandbox seam.
handle.command("export")
await until(() => entries.length === 0, "the export notice")

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
const persistentStore = Effect.succeed(NodeStore.keyValue(persistentKv))

const firstRun = makeStore()
const firstHandle = await start(firstRun.sink, { store: persistentStore })
firstHandle.submit("remember this")
await until(
  () => firstRun.entries.some((entry) => entry.kind === "summary"),
  "the first launch to finish a turn"
)
const firstTranscript = firstRun.entries.map((entry) => entry.title).join(" | ")
stop()

// A second launch: nothing in common but the store.
const secondRun = makeStore()
await start(secondRun.sink, { store: persistentStore })
await until(
  () => secondRun.entries.some((entry) => entry.title.startsWith("resumed")),
  "the second launch to resume"
)
const resumed = secondRun.entries.map((entry) => entry.title).join(" | ")
const resumedKinds = secondRun.entries.map((entry) => entry.kind)
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

// Capture only after a flush: `captureCharFrame` returns the last *painted*
// frame, so reading it straight after a state change shows the previous one.
await flush()
const transcript = transcriptSoFar + externalOutput.takeText()
const live = captureCharFrame()

console.log("--- committed to terminal scrollback ---")
console.log(transcript)
console.log("--- live region, after ---")
console.log(live)

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
  ["footer returned to the prompt", footer().type === "prompt"],
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
const drainedAfterInterrupt = interruptStore.drainSettled().map((entry) => entry.id)

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
  ["an interrupted tool settles", drainedAfterInterrupt.includes("tool-x1")],
  // The point of the fix: it stops blocking everything behind it.
  ["and stops blocking what follows", drainedAfterInterrupt.includes("after")],

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
  ["switching returns the footer to the prompt", footer().type === "prompt"],
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

  // R25
  ["an approval is asked", askedBeforeInterrupt === "approval"],
  ["and interrupting the run takes the question away",
    askedAfterInterrupt === "prompt"],
  ["answering takes it away at once, not at the end of the run",
    afterAnswering === "prompt"],

  // The diff
  ["a replaced line shows as one removal and one addition",
    oneLine.filter((line) => line.kind === "removed").length === 1
      && oneLine.filter((line) => line.kind === "added").length === 1],
  // The whole reason to diff rather than print each side: lines that did
  // not change are shown once, in place, so a reader can see where the
  // change landed.
  ["unchanged lines survive as context",
    withContext.filter((line) => line.kind === "context")
      .map((line) => line.text).join(",") === "a,c"],
  ["an addition removes nothing",
    pureAddition.every((line) => line.kind !== "removed")],
  ["an identical edit is all context",
    unchanged.every((line) => line.kind === "context")],
  // `split` reports a phantom trailing entry for text ending in a newline,
  // which would give every whole-line edit a spurious blank line.
  ["no phantom trailing line", oneLine.length === 2],
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
