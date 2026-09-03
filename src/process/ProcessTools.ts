import { Effect, Option, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as Permission from "../Permission.js"
import * as Sandbox from "../sandbox/Sandbox.js"
import * as ProcessManager from "./ProcessManager.js"

/**
 * Managed processes as tools, each projected for `Permission` as its own
 * act (`docs/effect-plan-2.txt` §21, §23).
 *
 * The projections are the point. Approving `start_process` for `npm test`
 * approves *that*: it does not approve stopping it later, and a policy that
 * allows `process:start` says nothing about `process:stop`. (The plan spells
 * them `process.start`; the colon is because `lint:portability` reads
 * `process.` as the Node global, and a rule spelling is not worth an
 * exemption.) The runtime's
 * own actions -- the timeout killing it, the manager closing -- need no
 * approval, because they are part of the execution the start approved.
 *
 * ```text
 * start_process   action "process:start"  resource: the command line
 * stop_process    action "process:stop"   resource: the process id
 * process_output  action "process:read"   resource: the process id
 * list_processes  action "process:read"   resource: "*"
 * ```
 *
 * A process starts in the sandbox the tool runs under (`Sandbox.Current`),
 * so a toolkit that is already confined to a workspace confines what it
 * starts to the same one. There is no `write_process`: `Sandbox` has no
 * stdin, and §21's process-write projection waits for that.
 */

const commandLine = (executable: string, args: ReadonlyArray<string>) =>
  [executable, ...args].join(" ")

/** Decode across chunk boundaries, as `Sandbox` does: a boundary can fall inside a character. */
const decodeAll = (chunks: ReadonlyArray<Uint8Array>): string => {
  const decoder = new TextDecoder()
  let text = ""
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

export const StartProcess = Permission.annotate(
  Tool.make("start_process", {
    description:
      "Start a command that keeps running after this call returns -- a dev server, a watcher, a long test run -- in the current workspace. " +
      "Returns its id; read its output with process_output and end it with stop_process. " +
      "It is killed when timeout_ms passes, so choose one that covers the work.",
    parameters: Schema.Struct({
      /** The program to run. Never interpreted by a shell. */
      executable: Schema.String,
      args: Schema.optional(Schema.Array(Schema.String)),
      /** Kill it after this long. Required, because a managed process has no sensible default lifetime. */
      timeout_ms: Schema.Number,
      /** A name for a person reading the process list. */
      label: Schema.optional(Schema.String)
    }),
    success: Schema.Struct({ process_id: Schema.String }),
    failure: Schema.String,
    dependencies: [ProcessManager.ProcessManager, Sandbox.Current]
  }),
  {
    action: "process:start",
    resource: (params) => commandLine(params.executable, params.args ?? [])
  }
)

export const StopProcess = Permission.annotate(
  Tool.make("stop_process", {
    description: "End a process started with start_process. Its whole process tree is ended.",
    parameters: Schema.Struct({ process_id: Schema.String }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [ProcessManager.ProcessManager]
  }),
  { action: "process:stop", resource: (params) => params.process_id }
)

export const ProcessOutput = Permission.annotate(
  Tool.make("process_output", {
    description:
      "Read what a process has written so far, and whether it is still running. " +
      "Pass the returned next_after as after on the next call to read only what is new.",
    parameters: Schema.Struct({
      process_id: Schema.String,
      /** Return only output after this sequence number. Omit for everything. */
      after: Schema.optional(Schema.Number)
    }),
    success: Schema.Struct({
      status: Schema.String,
      output: Schema.String,
      next_after: Schema.Number
    }),
    failure: Schema.String,
    dependencies: [ProcessManager.ProcessManager]
  }),
  { action: "process:read", resource: (params) => params.process_id }
)

export const ListProcesses = Permission.annotate(
  Tool.make("list_processes", {
    description: "Every process started with start_process, running or finished.",
    parameters: Schema.Struct({}),
    success: Schema.Array(
      Schema.Struct({
        process_id: Schema.String,
        label: Schema.optional(Schema.String),
        command: Schema.String,
        status: Schema.String,
        output_bytes: Schema.Number
      })
    ),
    failure: Schema.String,
    dependencies: [ProcessManager.ProcessManager]
  }),
  { action: "process:read", resource: () => "*" }
)

export const tools = [StartProcess, StopProcess, ProcessOutput, ListProcesses] as const
export type Tools = typeof tools
export type Handlers = Toolkit.HandlersFrom<Toolkit.ToolsByName<Tools>>

const statusText = (status: ProcessManager.Status): string => {
  switch (status._tag) {
    case "Running":
      return "running"
    case "Exited":
      return Option.match(status.signal, {
        onNone: () => `exited with code ${status.exitCode}`,
        onSome: (signal) => `ended by ${signal}`
      })
    case "Failed":
      return `failed: ${status.reason}`
    case "Terminated":
      return "terminated"
  }
}

/** Ids arrive from the model as strings; the brand is applied where it is checked. */
const decodeId = Schema.decodeEffect(ProcessManager.ProcessId)

const lookup = (id: string) =>
  Effect.gen(function* () {
    const manager = yield* ProcessManager.ProcessManager
    const processId = yield* decodeId(id).pipe(Effect.mapError(() => `not a process id: ${id}`))
    return yield* manager.get(processId).pipe(Effect.mapError((error) => error.message))
  })

export const handlers: Handlers = {
  start_process: ({ args, executable, label, timeout_ms }) =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.ProcessManager
      const sandbox = yield* Sandbox.Current
      const managed = yield* manager.start({
        workspace: sandbox.workspace,
        command: Sandbox.command(executable, args ?? []),
        timeout: timeout_ms,
        label
      }).pipe(Effect.mapError((error) => error.message))
      return { process_id: managed.id }
    }),

  stop_process: ({ process_id }) =>
    Effect.gen(function* () {
      const managed = yield* lookup(process_id)
      yield* managed.terminate
      return `stopped ${process_id}`
    }),

  process_output: ({ after, process_id }) =>
    Effect.gen(function* () {
      const managed = yield* lookup(process_id)
      const chunks = yield* Stream.runCollect(managed.output({ after, follow: false }))
      const last = chunks.length === 0 ? (after ?? 0) : chunks[chunks.length - 1]!.sequence
      const info = yield* managed.info
      return {
        status: statusText(info.status),
        output: decodeAll(chunks.map((chunk) => chunk.bytes)),
        next_after: last
      }
    }),

  list_processes: () =>
    Effect.gen(function* () {
      const manager = yield* ProcessManager.ProcessManager
      const all = yield* manager.list
      return all.map((info) => ({
        process_id: info.id,
        label: Option.getOrUndefined(info.label),
        command: commandLine(info.command.executable, info.command.args),
        status: statusText(info.status),
        output_bytes: info.outputBytes
      }))
    })
}

/** The four tools, handled: `Agent.make({ toolkit: ProcessTools.toolkit() })`. */
export const toolkit = () => Agent.toolkit(tools, handlers)
