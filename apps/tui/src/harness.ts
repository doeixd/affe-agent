import { Cause, Effect, Fiber, Layer, Stream } from "effect"
import * as Agent from "../../../src/Agent.js"
import * as AgentEvent from "../../../src/AgentEvent.js"
import * as AgentLoop from "../../../src/AgentLoop.js"
import * as AgentSession from "../../../src/AgentSession.js"
import * as Elicitation from "../../../src/Elicitation.js"
import * as Permission from "../../../src/Permission.js"
import { CodingToolkit } from "../../../src/coding/index.js"
import * as MemorySandbox from "../../../src/sandbox/memory.js"
import * as Sandbox from "../../../src/sandbox/Sandbox.js"
import { TestLanguageModel } from "../../../src/testing/index.js"
import { bodyOf, defaultViews, titleOf, type ToolView } from "./tools.ts"
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
      TestLanguageModel.text("That is what the workspace holds."),
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
      { toolCalls: [{ id: "t4", name: "bash", params: { command: "rm -rf /" } }] },
      TestLanguageModel.text("I did not run that."),
      TestLanguageModel.text(
        "I am a scripted model. Edit harness.ts to point at a real provider."
      )
    ]),
    ({ layer }) => layer
  )
)

const sandboxLayer = Sandbox.currentLayer(Sandbox.workspace("tui")).pipe(
  Layer.provide(
    MemorySandbox.layer({
      seed: {
        "README.md": "# demo workspace\n\nSeeded so the tools have something to find.\n",
        "src/index.ts": "export const hello = () => \"hello\"\n"
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
const project = (sink: Sink, views: Readonly<Record<string, ToolView>>) => {
  let assistant: string | undefined
  // Closed over rather than kept in the store: this is bookkeeping for one
  // submission, not something the UI should be able to see half-finished.
  let startedAt = 0
  let tools = 0
  return (event: AgentEvent.AgentEventEnvelope["event"]): void => {
    switch (event._tag) {
      case "SubmissionStarted":
        startedAt = Date.now()
        tools = 0
        sink.setStatus("working")
        return

      case "MessageStarted": {
        const id = nextId("assistant")
        assistant = id
        sink.append({
          id,
          kind: "assistant",
          title: "",
          body: { type: "none" },
          streaming: true
        })
        return
      }

      case "MessageDelta": {
        if (assistant === undefined || event.kind !== "text") return
        sink.appendTitle(assistant, event.delta)
        return
      }

      case "MessageCompleted": {
        if (assistant === undefined) {
          sink.append({
            id: nextId("assistant"),
            kind: "assistant",
            title: event.text,
            body: { type: "none" }
          })
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
          body: bodyOf(views, event.name, event.result)
        })
        return

      case "ToolCallFailed":
        sink.patch(`tool-${event.id}`, { status: "failed" })
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
  views: Readonly<Record<string, ToolView>> = defaultViews
): Promise<Handle> =>
  new Promise<Handle>((resolve, reject) => {
    const program = Effect.gen(function*() {
      const session = yield* AgentSession.make(agent, {
        // Without this a run needing approval is refused rather than asked.
        elicitation: Elicitation.memory
      })
      const onEvent = project(sink, views)

      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (envelope) =>
          Effect.sync(() => onEvent(envelope.event)))
      )

      resolve({
        submit: (text) => {
          sink.append({
            id: nextId("user"),
            kind: "user",
            title: text,
            body: { type: "none" }
          })
          Effect.runFork(
            session.prompt(text).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  sink.append({
                    id: nextId("notice"),
                    kind: "notice",
                    title: `prompt failed: ${Cause.pretty(cause)}`,
                    body: { type: "none" }
                  })
                )
              ),
              Effect.asVoid
            )
          )
        },
        // Idle is the ordinary case for a stray Ctrl+C, not a failure.
        interrupt: () => Effect.runFork(Effect.ignore(session.interrupt())),

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
