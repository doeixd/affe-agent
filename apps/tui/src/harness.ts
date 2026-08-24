import { Cause, Effect, Fiber, Layer, Option, Stream } from "effect"
import * as Agent from "../../../src/Agent.js"
import * as AgentEvent from "../../../src/AgentEvent.js"
import * as AgentLoop from "../../../src/AgentLoop.js"
import * as AgentSession from "../../../src/AgentSession.js"
import * as Elicitation from "../../../src/Elicitation.js"
import * as Permission from "../../../src/Permission.js"
import { CodingToolkit } from "../../../src/coding/index.js"
import * as MemorySandbox from "../../../src/sandbox/memory.js"
import * as Sandbox from "../../../src/sandbox/Sandbox.js"
import * as SessionTree from "../../../src/tree/SessionTree.js"
import { TestLanguageModel } from "../../../src/testing/index.js"
import { bodyOf, defaultViews, titleOf, type Views } from "./tools.ts"
import { type Approval, type Handle, type Sink } from "./view.ts"
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
// Wiring: the only place that names a model, a toolkit or a sandbox
// ---------------------------------------------------------------------------

/**
 * A scripted model, so the TUI runs with no API key and no network -- which is
 * also what makes it testable. A real provider is a different `Layer` here and
 * no change anywhere else.
 */
const modelLayer = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      { toolCalls: [{ id: "t1", name: "list_files", params: {} }] },
      // Chunked, so the streaming path is exercised rather than assumed.
      { text: "That is what the workspace holds.", chunks: ["That is ", "what the ", "workspace holds."] },
      { toolCalls: [{ id: "t2", name: "bash", params: { command: "echo hi" } }] },
      TestLanguageModel.text("The command ran."),
      {
        toolCalls: [{
          id: "t3",
          name: "edit_file",
          params: {
            path: "src/index.ts",
            old_string: "hello",
            new_string: "greetings",
            replace_all: true
          }
        }]
      },
      TestLanguageModel.text("Renamed it."),
      {
        toolCalls: [{
          id: "t5",
          name: "edit_file",
          params: {
            path: "src/drift.ts",
            old_string: "const value = 1;\n",
            new_string: "const value = 2;\n"
          }
        }]
      },
      TestLanguageModel.text("Bumped it."),
      { toolCalls: [{ id: "t4", name: "bash", params: { command: "rm -rf /" } }] },
      TestLanguageModel.text("I did not run that."),
      TestLanguageModel.text(
        "I am a scripted model. Edit harness.ts to point at a real provider."
      ),
      // Headroom, so a prompt after a rewind has something to answer with.
      // The script is a flat sequence and a rewind does not rewind it, which
      // is a property of this stub rather than of the tree.
      TestLanguageModel.text("Answering from the rewound branch."),
      TestLanguageModel.text("And again.")
    ]),
    ({ layer }) => layer
  )
)

const sandboxLayer = Sandbox.currentLayer(Sandbox.workspace("tui")).pipe(
  Layer.provide(
    MemorySandbox.layer({
      seed: {
        "README.md": "# demo workspace\n\nSeeded so the tools have something to find.\n",
        "src/index.ts": "export const hello = () => \"hello\"\n",
        // Trailing spaces the scripted model will not reproduce, so the
        // second edit matches fuzzily and `matched` differs from what was
        // asked for -- which is the case the two-sided body exists to show.
        "src/drift.ts": "const value = 1;   \n"
      },
      exec: () => Effect.succeed({ exitCode: 0, stdout: "hi\n", stderr: "" })
    })
  )
)

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
  // A call's parameters, kept until its result arrives: a body renderer often
  // needs both sides, and the success event carries only one.
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

      case "ToolCallStarted":
        tools++
        params.set(event.id, event.params)
        sink.append({
          id: `tool-${event.id}`,
          kind: "tool",
          title: titleOf(views, event.name, event.params),
          body: { type: "none" },
          status: "running"
        })
        return

      case "ToolCallSucceeded":
        sink.patch(`tool-${event.id}`, {
          status: "ok",
          body: bodyOf(views, event.name, event.result, params.get(event.id))
        })
        params.delete(event.id)
        return

      case "ToolCallFailed":
        sink.patch(`tool-${event.id}`, { status: "failed" })
        params.delete(event.id)
        return

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
      case "ToolCallInterrupted":
        sink.patch(`tool-${event.id}`, { status: "failed" })
        params.delete(event.id)
        return

      case "SubmissionCompleted":
      case "SubmissionFailed":
      case "SubmissionInterrupted":
        assistant = undefined
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

let disposeFiber: () => void = () => {}

/**
 * Build a session and bridge it to `sink`.
 *
 * The root program stays alive until `stop`, which closes its scope and with it
 * the session -- interrupting any run in flight.
 */
export const start = (
  sink: Sink,
  /** Rendering rules. An application adds its own tools' rules here. */
  views: Views = defaultViews
): Promise<Handle> =>
  new Promise<Handle>((resolve, reject) => {
    const program = Effect.gen(function*() {
      /**
       * A tree, not a session.
       *
       * The tree captures a node at every turn boundary, which is what makes
       * rewind possible at all -- and it hands back a session per branch, so
       * the rest of this file is unchanged by the fact that there is now more
       * than one conversation.
       */
      const tree = yield* SessionTree.make(agent, {
        // Without this a run needing approval is refused rather than asked.
        session: { elicitation: Elicitation.memory }
      })

      const root = yield* AgentSession.make(agent, {
        elicitation: Elicitation.memory
      })
      const start = yield* tree.commit(root, { cause: "root", label: "start" })

      /**
       * Prompts offered but not yet admitted, oldest first.
       *
       * A ticket per call rather than a plain queue of strings, so a rejected
       * prompt can withdraw *its own* offer. Withdrawing by position would
       * remove somebody else's when two are outstanding.
       */
      const offered: Array<{ readonly text: string }> = []
      const projection = project(sink, views, () => offered.shift()?.text)

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
      let session = (yield* tree.activate(start)).session
      let taken = 0

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

      resolve({
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

        rewind: () => Effect.runFork(Effect.ignore(rewind)),

        respond: (id, granted) => {
          // `respond` reports `false` for an answer nothing was waiting on --
          // a late keypress after the run moved on. Not an error, and not
          // worth interrupting the user over.
          Effect.runFork(
            Effect.ignore(AgentSession.respond(session, { id, granted }))
          )
        }
      })

      yield* Effect.never
    })

    const fiber = Effect.runFork(
      program.pipe(
        Effect.provide(Layer.mergeAll(modelLayer, sandboxLayer)),
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.sync(() => reject(new Error(Cause.pretty(cause))))
        )
      )
    )

    disposeFiber = () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  })

/** Stop the harness, closing the session's scope. */
export const stop = (): void => disposeFiber()
