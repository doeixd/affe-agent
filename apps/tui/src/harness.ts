import { Cause, Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import * as Agent from "../../../src/Agent.js"
import * as AgentEvent from "../../../src/AgentEvent.js"
import * as AgentLoop from "../../../src/AgentLoop.js"
import * as AgentSession from "../../../src/AgentSession.js"
import * as Elicitation from "../../../src/Elicitation.js"
import * as Permission from "../../../src/Permission.js"
import { CodingToolkit } from "../../../src/coding/index.js"
import * as Export from "../../../src/export/Export.js"
import * as Redaction from "../../../src/redaction/Redaction.js"
import * as Sandbox from "../../../src/sandbox/Sandbox.js"
import type * as NodeStore from "../../../src/tree/NodeStore.js"
import * as SessionTree from "../../../src/tree/SessionTree.js"
import * as TreeExport from "../../../src/tree/TreeExport.js"
import { type Backend, scripted } from "./backend.ts"
import { entriesOf } from "./restore.ts"
import { bodyOf, defaultViews, titleOf, type Views } from "./tools.ts"
import { type Approval, type BranchItem, type Command, type Handle, type Sink } from "./view.ts"
import { duration } from "./width.ts"

/**
 * The harness half of the TUI: everything Effect-shaped, behind one imperative
 * surface.
 *
 * The renderer never sees an `Effect`. It gets `submit`, `interrupt` and a sink
 * that is called as things happen. That boundary is the whole design: swapping
 * the model, the toolkit or the sandbox changes this file and nothing in the
 * UI.
 *
 * A session captures its environment when it is built, so once
 * `AgentSession.make` has returned, `prompt` and `interrupt` need no services
 * and can be run straight from a keypress handler.
 */

export type { Entry, Handle, Sink, Status } from "./view.ts"

// ---------------------------------------------------------------------------
// Wiring: the policy and the toolkit. The model and the workspace are chosen
// together in `backend.ts`, because they have to agree about what is real.
// ---------------------------------------------------------------------------

/**
 * Ask before anything that changes the world; allow the rest.
 *
 * The projection is what makes this readable: the policy gates on `write` and
 * `shell` without knowing that `edit_file` takes an `old_string`. An `Ask`
 * pauses the run on an elicitation, which is what the footer answers.
 */
const permission = Permission.rules(
  [
    { action: "write", decision: Permission.ask("changes a file") },
    { action: "shell", decision: Permission.ask("runs a command") }
  ],
  { otherwise: Permission.allow }
)

const agent = Agent.make({
  instructions: "You are a terminal coding assistant. Be brief.",
  toolkit: CodingToolkit.toolkit(),
  loop: AgentLoop.bounded(10),
  permission
})

/**
 * What `/` offers.
 *
 * A list rather than a lookup, because the renderer filters it as the user
 * types and needs the descriptions to do that usefully. Deliberately short:
 * a palette whose entries a reader has to scroll is a menu, and a menu is
 * where features go to be forgotten.
 */
export const commands: ReadonlyArray<Command> = [
  { name: "branch", description: "fork here, and keep this line too" },
  { name: "branches", description: "switch to another line of work" },
  { name: "rewind", description: "take back the last turn (ctrl+r)" },
  { name: "export", description: "write this conversation to a file" },
  { name: "export-redacted", description: "the same, with secrets removed" },
  { name: "help", description: "what these do" }
]

// ---------------------------------------------------------------------------
// Event projection
// ---------------------------------------------------------------------------

let counter = 0
const nextId = (prefix: string): string => `${prefix}-${++counter}`

/**
 * Turn the agent's events into view entries.
 *
 * `assistant` holds the id of the message currently streaming, because deltas
 * arrive without one: the harness owns that correlation so the renderer does
 * not have to.
 */
/**
 * Exported for the smoke test.
 *
 * Some event shapes are impractical to reach through a real run -- an
 * interrupt landing precisely while a tool is in flight is a race, and a test
 * that has to win a race is a test that fails for the wrong reason. Driving
 * the projection directly makes those cases ordinary.
 */
export const project = (
  sink: Sink,
  views: Views,
  /**
   * The text of the submission that is starting, if one was offered.
   *
   * The user's line is drawn from `SubmissionStarted` rather than from
   * `submit`, because only the kernel knows whether it accepted the input. A
   * prompt refused as busy never starts, so it never draws -- see `submit`.
   */
  takeOffered: () => string | undefined = () => undefined
) => {
  let assistant: string | undefined
  /**
   * R128 -- the row a tool call is drawn in, by the call's id.
   *
   * The row id used to *be* the provider's tool-call id, which is correlation
   * within one response and not a session-global identity. A later turn or a
   * different branch may reuse one, and `Sink.patch` takes the *first* row
   * with a matching id -- so a reused id updated the older row instead. The
   * new row then stayed `running` forever, and scrollback drains only a
   * settled prefix, so the transcript stopped there.
   *
   * A fresh view id per `ToolCallStarted`, dropped when the call reaches a
   * terminal event, so a reused id after that maps to a new row rather than
   * an old one.
   */
  const rows = new Map<string, string>()

  // A call's parameters, kept until its result arrives: a body renderer often
  // needs both sides, and the success event carries only one. Keyed by view id
  // for the same reason as `rows` -- two calls sharing a provider id must not
  // share arguments.
  const params = new Map<string, unknown>()
  // Closed over rather than kept in the store: this is bookkeeping for one
  // submission, not something the UI should be able to see half-finished.
  let startedAt = 0
  let tools = 0

  /**
   * Forget the in-flight correlation.
   *
   * Called when the active branch changes. The ids being tracked here belong
   * to the session that was: a delta arriving for an assistant message on the
   * old branch must not be appended to an entry on the new one, and a tool
   * call that never resolves must not leave `params` growing forever.
   */
  const forget = (): void => {
    assistant = undefined
    params.clear()
    rows.clear()
  }

  const onEvent = (event: AgentEvent.AgentEventEnvelope["event"]): void => {
    switch (event._tag) {
      case "SubmissionStarted": {
        // Admitted: now, and only now, is it true that the agent received it.
        const offered = takeOffered()
        if (offered !== undefined) {
          sink.append({
            id: nextId("user"),
            kind: "user",
            title: offered,
            body: { type: "none" }
          })
        }
        startedAt = Date.now()
        tools = 0
        sink.setStatus("working")
        return
      }

      /**
       * Deliberately nothing on `MessageStarted`.
       *
       * A turn that only calls a tool still starts a message, so creating the
       * entry here leaves an empty assistant bubble that never completes --
       * and, because it never stops streaming, never settles, so it blocks
       * every later entry from reaching the scrollback. The entry is created
       * by the first thing that gives it content instead.
       */
      case "MessageDelta": {
        if (event.kind !== "text") return
        if (assistant === undefined) {
          assistant = nextId("assistant")
          sink.append({
            id: assistant,
            kind: "assistant",
            title: "",
            body: { type: "none" },
            streaming: true
          })
        }
        sink.appendTitle(assistant, event.delta)
        return
      }

      /**
       * R14 -- a message that failed or was interrupted is still finished.
       *
       * The message analogue of `ToolCallInterrupted`. An assistant entry
       * created by the first delta stays `streaming: true` until something
       * says otherwise, and `drainSettled` takes a *prefix* -- so one message
       * that died mid-stream holds itself and every later entry out of
       * scrollback for the rest of the session. The transcript simply stops
       * growing, three screens after the cause.
       *
       * The text so far is kept rather than cleared: it is what the user
       * watched arrive, and blanking it would be a different lie from leaving
       * it unfinished.
       */
      case "MessageFailed":
      case "MessageInterrupted": {
        if (assistant === undefined) return
        sink.patch(assistant, { streaming: false })
        assistant = undefined
        return
      }

      case "MessageCompleted": {
        // Empty text is a tool-only turn: there is no message to show.
        if (assistant === undefined) {
          if (event.text !== "") {
            sink.append({
              id: nextId("assistant"),
              kind: "assistant",
              title: event.text,
              body: { type: "none" }
            })
          }
          return
        }
        sink.patch(assistant, { title: event.text, streaming: false })
        assistant = undefined
        return
      }

      // A paused run: the footer stops being a prompt and becomes a question.
      // `detail` is `unknown` by design -- the harness does not know what an
      // application's elicitation kinds mean -- so it is narrowed here.
      case "ElicitationRequested": {
        if (event.kind !== "tool-approval") return
        const detail = event.detail
        if (typeof detail !== "object" || detail === null) return
        const fields = detail as Record<string, unknown>
        sink.setApproval({
          id: event.id,
          toolName: String(fields.toolName ?? "tool"),
          action: String(fields.action ?? ""),
          resource: String(fields.resource ?? ""),
          ...(typeof fields.reason === "string" ? { reason: fields.reason } : {})
        })
        return
      }

      case "ElicitationResolved":
        sink.setApproval(undefined)
        if (!event.granted) {
          sink.append({
            id: nextId("notice"),
            kind: "notice",
            title: "refused",
            body: { type: "none" }
          })
        }
        return

      case "ToolCallStarted": {
        tools++
        const row = nextId("tool")
        rows.set(event.id, row)
        params.set(row, event.params)
        sink.append({
          id: row,
          kind: "tool",
          title: titleOf(views, event.name, event.params),
          body: { type: "none" },
          status: "running"
        })
        return
      }

      case "ToolCallSucceeded": {
        const row = rows.get(event.id)
        if (row === undefined) return
        sink.patch(row, {
          status: "ok",
          body: bodyOf(views, event.name, event.result, params.get(row))
        })
        params.delete(row)
        rows.delete(event.id)
        return
      }

      case "ToolCallFailed": {
        const row = rows.get(event.id)
        if (row === undefined) return
        sink.patch(row, { status: "failed" })
        params.delete(row)
        rows.delete(event.id)
        return
      }

      /**
       * Interruption is terminal, and saying so is load-bearing.
       *
       * An entry left `running` is never settled, and `drainSettled` takes a
       * *prefix* -- so one interrupted tool holds itself and every later entry
       * out of scrollback for the rest of the session. The transcript stops
       * growing and the cause is three screens back.
       *
       * Marked `failed` rather than given a status of its own: the run went
       * away, and a reader needs to know the tool did not finish. A distinct
       * "interrupted" marker would be a nicer story and a wider change to the
       * view model than this fix should make.
       */
      case "ToolCallInterrupted": {
        const row = rows.get(event.id)
        if (row === undefined) return
        sink.patch(row, { status: "failed" })
        params.delete(row)
        rows.delete(event.id)
        return
      }

      case "SubmissionCompleted":
      case "SubmissionFailed":
      case "SubmissionInterrupted":
        /**
         * R25 -- and whatever the footer was asking about is now dead.
         *
         * Interrupting a run that is waiting for approval removes the
         * elicitation, but no `ElicitationResolved` is emitted for it -- so a
         * footer cleared only on resolution keeps showing a question that can
         * no longer be answered. The screen reads idle while offering a choice
         * that does nothing: `respond` returns false and emits nothing, so
         * there is not even a way back to the prompt.
         *
         * A submission ending is the moment every transient surface belonging
         * to it stops being about anything.
         */
        sink.setApproval(undefined)

        /**
         * R14, again -- a streamed message that never reached a terminal event.
         *
         * The cases above cover the ones core reports. This covers the rest by
         * construction: if the submission is over, nothing will finish this
         * entry, so leaving it streaming blocks the transcript forever.
         */
        if (assistant !== undefined) sink.patch(assistant, { streaming: false })
        assistant = undefined

        /**
         * Any tool still open belongs to a submission that is over.
         *
         * Core reports a terminal event for each call it started, but a row
         * left running blocks the whole transcript -- so this closes the loop
         * by construction rather than by trusting that every path emits.
         */
        for (const row of rows.values()) sink.patch(row, { status: "failed" })
        rows.clear()
        params.clear()
        if (event._tag === "SubmissionInterrupted") {
          sink.append({
            id: nextId("notice"),
            kind: "notice",
            title: "interrupted",
            body: { type: "none" }
          })
        }
        // The turn's footnote: what it cost. Appended before going idle, so a
        // consumer waiting on idle already sees the whole turn.
        sink.append({
          id: nextId("summary"),
          kind: "summary",
          title: [
            duration(Date.now() - startedAt),
            tools === 0 ? undefined : `${tools} tool${tools === 1 ? "" : "s"}`
          ].filter((part) => part !== undefined).join(" · "),
          body: { type: "none" }
        })
        sink.setStatus("idle")
        return

      default:
        return
    }
  }

  return { onEvent, forget }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Every harness started in this process.
 *
 * A single `let` here was a leak with a plausible-looking shape: each `start`
 * overwrote the previous disposer, so `stop` killed only the most recent one
 * and every earlier harness kept its fibre, its session and its store. One
 * harness per process is the ordinary case, which is exactly why it survived
 * -- the second one only appears in a test, or in a UI that reopens a session.
 */
const running = new Set<() => void>()

/**
 * Build a session and bridge it to `sink`.
 *
 * The root program stays alive until `stop`, which closes its scope and with it
 * the session -- interrupting any run in flight.
 */
export const start = (
  sink: Sink,
  options?: {
    /** Rendering rules. An application adds its own tools' rules here. */
    readonly views?: Views | undefined
    /**
     * The model and workspace. Scripted unless asked otherwise.
     *
     * Defaulted rather than required, because the default is what makes this
     * runnable with no key and no network -- which every test depends on.
     */
    readonly backend?: Backend | undefined
    /**
     * Where the conversation lives between launches.
     *
     * In memory by default, which is what makes a run leave nothing behind --
     * and what keeps the smoke suite from accumulating state across runs. A
     * persistent store makes the tree survive the process, and the harness
     * then *resumes* rather than starting empty.
     */
    readonly store?: Effect.Effect<NodeStore.NodeStore<any>, unknown, Scope.Scope> | undefined
  }
): Promise<Handle> =>
  new Promise<Handle>((resolve, reject) => {
    // Assigned once the fibre exists; `Handle.stop` closes over the binding.
    let dispose: () => void = () => {}
    const backend = options?.backend ?? scripted
    sink.setBackend(backend.label)
    const program = Effect.gen(function*() {
      /**
       * A tree, not a session.
       *
       * The tree captures a node at every turn boundary, which is what makes
       * rewind possible at all -- and it hands back a session per branch, so
       * the rest of this file is unchanged by the fact that there is now more
       * than one conversation.
       */
      /**
       * Acquired in the program's own scope, so the store lives exactly as
       * long as the tree that reads it. Building it outside and handing over
       * the result would mean a finalizer that has already run by the time the
       * first node is written.
       */
      const store = options?.store === undefined
        ? undefined
        : yield* Effect.orDie(options.store)

      const tree = yield* SessionTree.make(agent, {
        // Without this a run needing approval is refused rather than asked.
        session: { elicitation: Elicitation.memory },
        ...(store === undefined ? {} : { store })
      })

      /**
       * Where to pick up.
       *
       * The newest node by capture time, across every line of work -- which is
       * where the user was when the process ended, whichever branch they were
       * on. A leaf would be wrong: after a rewind the tip of the line is not
       * the newest thing recorded.
       *
       * `None` means an empty store, which is a first launch.
       */
      const resumeTarget = Effect.map(tree.nodes, (nodes) =>
        nodes.reduce(
          (newest: Option.Option<SessionTree.Node>, node) =>
            Option.isNone(newest) || node.at >= newest.value.at
              ? Option.some(node)
              : newest,
          Option.none<SessionTree.Node>()
        ))

      const resuming = yield* resumeTarget
      const start = Option.isSome(resuming)
        ? resuming.value
        : yield* tree.commit(
          yield* AgentSession.make(agent, { elicitation: Elicitation.memory }),
          { cause: "root", label: "start" }
        )

      /**
       * Prompts offered but not yet admitted, oldest first.
       *
       * A ticket per call rather than a plain queue of strings, so a rejected
       * prompt can withdraw *its own* offer. Withdrawing by position would
       * remove somebody else's when two are outstanding.
       */
      const offered: Array<{ readonly text: string }> = []
      // Captured once, so every command below has `R = never` and can be run
      // straight from a keypress. The same reason `AgentSession` captures its
      // environment at construction.
      const sandbox = yield* Sandbox.Current

      const projection = project(
        sink,
        options?.views ?? defaultViews,
        () => offered.shift()?.text
      )

      /**
       * Subscribed once, to the tree rather than to a session.
       *
       * This is the part a branch switch would otherwise break. `tree.events`
       * follows whichever branch is active, so switching does not mean
       * tearing down a subscription and building another -- and does not mean
       * a window where events go nowhere.
       */
      yield* Effect.forkScoped(
        Stream.runForEach(tree.events, (envelope) =>
          Effect.sync(() => projection.onEvent(envelope.event)))
      )

      // The branch the user starts on. `session` is reassigned on rewind; the
      // handle closes over this binding rather than over a value.
      const opened = yield* tree.activate(start)
      let session = opened.session
      let taken = 0
      let forks = 0

      /**
       * Repaint a recovered conversation.
       *
       * Only on resume, and that asymmetry is deliberate. A rewind leaves the
       * transcript alone because scrollback is write-once and what the user
       * saw is still true; a *restart* has nothing above, so painting is the
       * only way the conversation exists at all.
       *
       * Painted from history rather than replayed from events, because the
       * events are gone -- see `restore.ts` for why the two are not
       * interchangeable.
       */
      if (backend.warning !== undefined) {
        sink.append({
          id: nextId("notice"),
          kind: "notice",
          title: backend.warning,
          body: { type: "none" }
        })
      }

      if (Option.isSome(resuming)) {
        for (const entry of entriesOf(opened.history, options?.views ?? defaultViews)) {
          sink.append(entry)
        }
        sink.append({
          id: nextId("notice"),
          kind: "notice",
          title: `resumed ${resuming.value.id}`
            + ` · ${opened.history.content.length} messages`,
          body: { type: "none" }
        })
      }

      const publishDepth = () =>
        Effect.gen(function*() {
          const node = yield* tree.active
          const depth = Option.isNone(node) ? 0 : (yield* tree.path(node.value)).length
          sink.setRewind({ depth, taken })
        })

      yield* publishDepth()

      /**
       * Step back one turn boundary and continue from there.
       *
       * Rewinding to the *parent* of the active node, so "undo that last
       * exchange" is what it means. Activation does the rest: the old branch
       * is released, the new one becomes what `tree.events` follows, and the
       * projection forgets the correlation it was holding for the old one.
       */
      const rewind = Effect.gen(function*() {
        const node = yield* tree.active
        if (Option.isNone(node)) return
        const parent = node.value.parent
        if (Option.isNone(parent)) {
          sink.append({
            id: nextId("notice"),
            kind: "notice",
            title: "nothing to rewind to",
            body: { type: "none" }
          })
          return
        }
        const target = yield* tree.node(parent.value)
        if (Option.isNone(target)) return

        const activation = yield* tree.activate(target.value)
        session = activation.session
        projection.forget()
        taken++
        sink.setStatus("idle")
        sink.setApproval(undefined)
        // Marked rather than erased: see `Handle.rewind`. What the user saw is
        // still what the log says they saw.
        sink.append({
          id: nextId("notice"),
          kind: "notice",
          title: `rewound to ${
            Option.getOrElse(target.value.label, () => target.value.id)
          } · ${activation.history.content.length} messages`,
          body: { type: "none" }
        })
        yield* publishDepth()
      })

      /**
       * The branch selector's contents.
       *
       * Built from `summary`, which is the operation that exists so a list of
       * twenty branch points does not mean holding twenty conversations. A
       * lane's name wins over the preview when it has one: a name is what the
       * user chose to call this, and the preview is a guess at it.
       */
      const branchItems = Effect.gen(function*() {
        const active = yield* tree.active
        const lanes = yield* tree.lanes
        const named = new Map(lanes.map((lane) => [lane.leaf.id, lane.name]))
        /**
         * Leaves from one pass over the nodes.
         *
         * Was a `children` call per node, which is quadratic in the tree and,
         * on the persistent store, decodes every conversation to answer a
         * question about metadata -- so opening a selector read the whole
         * history of every branch. A node is a leaf when nothing names it as
         * a parent, and that is one set.
         *
         * The remaining half of the cost is the store's: `nodes` decodes each
         * entry, history included, because a node and its conversation share
         * one record. Splitting those is a library change, not a UI one.
         */
        const all = yield* tree.nodes
        const parents = new Set(
          all.flatMap((node) => Option.isSome(node.parent) ? [node.parent.value] : [])
        )
        const leaves = all.filter((node) => !parents.has(node.id))
        return yield* Effect.forEach(leaves, (node) =>
          Effect.map(tree.summary(node), (summary): BranchItem => ({
            id: node.id,
            label: named.get(node.id)
              ?? Option.getOrElse(summary.preview, () => node.id),
            detail: `${summary.depth} turn${summary.depth === 1 ? "" : "s"}`
              + ` · ${summary.messages} messages`,
            active: Option.isSome(active) && active.value.id === node.id
          })))
      })

      const notice = (title: string) =>
        Effect.sync(() =>
          sink.append({ id: nextId("notice"), kind: "notice", title, body: { type: "none" } })
        )

      /**
       * Write the active branch to a file.
       *
       * The path is relative and inside the workspace, so the sandbox seam
       * decides where it can land -- an exporter that could write anywhere
       * would be a way around the boundary the whole toolkit rests on.
       */
      const exportBranch = (redact: boolean) =>
        Effect.gen(function*() {
          const node = yield* tree.active
          if (Option.isNone(node)) return yield* notice("nothing to export yet")
          const exported = yield* TreeExport.path(tree, node.value, {
            harnessVersion: "tui",
            tools: Object.keys(options?.views ?? defaultViews)
          })
          const text = yield* Export.encode(exported, {
            // Two matchers, and they miss almost everything -- see
            // `Redaction`. Naming the file `.redacted.json` and saying so in
            // the notice is the honest version of this feature.
            ...(redact
              ? {
                redact: Redaction.make(
                  Redaction.bearerTokens,
                  Redaction.environmentSecrets
                )
              }
              : {})
          })
          const path = redact
            ? `.effect-agent/export-${node.value.id}.redacted.json`
            : `.effect-agent/export-${node.value.id}.json`
          yield* sandbox.write(yield* Sandbox.path(path), text)
          yield* notice(
            redact
              ? `wrote ${path} — two matchers only, read it before sharing`
              : `wrote ${path} — unredacted`
          )
        })

      /**
       * Fork the conversation and continue on the fork.
       *
       * The difference from `rewind`: rewind moves *back* and continues from
       * an earlier point, this stays where it is and starts a second line from
       * here. Without it the only way to get a branch is to undo something,
       * which makes exploring an alternative cost a turn.
       *
       * The new lane is named after the branch point so it can be found again;
       * `branches` prefers a lane's name over the preview for exactly this.
       */
      /**
       * Refuse to move while a turn is in flight.
       *
       * The same defect R15 found in ctrl+r, on the two other paths that change
       * which branch is active. `tree.active` points at the last *completed*
       * boundary, so moving mid-run abandons the in-flight branch and steps to
       * a point the user was not looking at -- and the abandoned branch's
       * entries stay streaming, which blocks scrollback for the rest of the
       * session.
       *
       * Refused with a notice rather than queued: the user asked to be
       * somewhere else *now*, and silently doing it later is worse than saying
       * no.
       */
      const whileIdle = (
        what: string,
        action: Effect.Effect<void>
      ): Effect.Effect<void> =>
        Effect.flatMap(session.status, (status) =>
          status === "idle"
            ? action
            : notice(`cannot ${what} while a turn is running — interrupt it first`))

      const forkHere = Effect.gen(function*() {
        const node = yield* tree.active
        if (Option.isNone(node)) return yield* notice("nothing to fork yet")
        const lane = `fork-${++forks}`
        // Named on activation: a lane is a name for the line the user is on,
        // and `branch` here would build a session only to register the name
        // and then be discarded, since activation makes its own.
        const activation = yield* tree.activate(node.value, { lane })
        session = activation.session
        projection.forget()
        sink.setStatus("idle")
        yield* notice(
          `forked at ${node.value.id} as ${lane} — the other line is still there`
        )
        yield* publishDepth()
      })

      const run = (name: string): Effect.Effect<void> => {
        switch (name) {
          case "branch":
            return whileIdle(
              "fork",
              Effect.catchCause(forkHere, (cause) =>
                notice(`fork failed: ${Cause.pretty(cause)}`))
            )
          case "branches":
            return Effect.ignore(
              Effect.flatMap(branchItems, (items) =>
                Effect.sync(() => sink.setBranches(items)))
            )
          case "rewind":
            return whileIdle("rewind", Effect.ignore(rewind))
          case "export":
            return Effect.catchCause(exportBranch(false), (cause) =>
              notice(`export failed: ${Cause.pretty(cause)}`))
          case "export-redacted":
            return Effect.catchCause(exportBranch(true), (cause) =>
              notice(`export failed: ${Cause.pretty(cause)}`))
          case "help":
            return Effect.forEach(
              commands,
              (command) => notice(`/${command.name} — ${command.description}`),
              { discard: true }
            )
          default:
            // Reported rather than ignored: a command that silently does
            // nothing is indistinguishable from one that is broken.
            return notice(`no such command: /${name}`)
        }
      }

      resolve({
        commands,

        stop: () => dispose(),

        command: (name) => {
          sink.setPalette(undefined)
          Effect.runFork(Effect.ignore(run(name)))
        },

        switchTo: (id) => {
          sink.setBranches(undefined)
          Effect.runFork(
            Effect.ignore(
              whileIdle("switch", Effect.orDie(Effect.gen(function*() {
                const found = yield* tree.node(id as never)
                if (Option.isNone(found)) return yield* notice("that branch is gone")
                const activation = yield* tree.activate(found.value)
                session = activation.session
                projection.forget()
                sink.setStatus("idle")
                sink.setApproval(undefined)
                yield* notice(
                  `switched to ${id} · ${activation.history.content.length} messages`
                )
                yield* publishDepth()
              })))
            )
          )
        },

        submit: (text) => {
          /**
           * Offered, not yet shown.
           *
           * Drawing the user's line here would claim the agent received input
           * it may refuse -- a prompt arriving while a submission is running
           * fails with `AgentBusyError`, and the line would sit in the
           * transcript describing something that never entered history.
           * Scrollback is write-once, so it could not be taken back either.
           */
          const ticket = { text }
          offered.push(ticket)
          Effect.runFork(
            // Streamed, so `MessageDelta` arrives and the reply builds up a
            // token at a time. Whether a call streams is the caller's choice,
            // not the agent's -- and a UI is exactly the caller that wants it.
            // `session`, not a captured value: after a rewind this is a
            // different branch, and a prompt must go to the one on screen.
            session.prompt(text, { stream: true }).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  // Withdraw the offer if it never started. If it did start,
                  // the projection already claimed the ticket and the failure
                  // belongs to a turn the user can see.
                  const index = offered.indexOf(ticket)
                  if (index !== -1) offered.splice(index, 1)
                  sink.append({
                    id: nextId("notice"),
                    kind: "notice",
                    title: `prompt failed: ${Cause.pretty(cause)}`,
                    body: { type: "none" }
                  })
                })
              ),
              Effect.andThen(publishDepth()),
              Effect.asVoid
            )
          )
        },
        // Idle is the ordinary case for a stray Ctrl+C, not a failure.
        interrupt: () => Effect.runFork(Effect.ignore(session.interrupt())),

        /**
         * Gated here as well as in the view.
         *
         * A renderer check is not enough: the palette reaches this through
         * `command`, and a test or any other caller reaches it directly. The
         * guard belongs where the state is.
         *
         * It is a check-then-act and says so -- a submission admitted between
         * the read and the switch would still be abandoned. Closing that
         * needs the session to refuse the switch itself, which is a kernel
         * change; this removes the reachable cases, not the race.
         */
        rewind: () => Effect.runFork(whileIdle("rewind", Effect.ignore(rewind))),

        respond: (id, granted, respondOptions) => {
          // `respond` reports `false` for an answer nothing was waiting on --
          // a late keypress after the run moved on. Not an error, and not
          // worth interrupting the user over.
          Effect.runFork(
            Effect.ignore(
              AgentSession.respond(session, {
                id,
                granted,
                // Only when asked. Sending `{ remember: false }` unconditionally
                // would be a policy instruction the user never gave.
                ...(respondOptions?.remember === true
                  ? { value: { remember: true } }
                  : {})
              })
            )
          )
        }
      })

      yield* Effect.never
    })

    const fiber = Effect.runFork(
      program.pipe(
        Effect.provide(backend.layer),
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.sync(() => reject(new Error(Cause.pretty(cause))))
        )
      )
    )

    dispose = () => {
      running.delete(dispose)
      Effect.runFork(Fiber.interrupt(fiber))
    }
    running.add(dispose)
  })

/**
 * Stop every harness, closing their scopes and with them their sessions.
 *
 * All of them rather than the last, because "stop" from a process shutting
 * down means all of them, and a caller holding one harness has `Handle.stop`.
 */
export const stop = (): void => {
  for (const dispose of [...running]) dispose()
}
