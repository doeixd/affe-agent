import { Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as LocalSandbox from "../src/sandbox/local.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"

/**
 * User-defined coding tools over the sandbox seam.
 *
 * The point of this example is what it does NOT do: nothing here changes the
 * agent core. The tools are ordinary `Tool`s whose `dependencies` demand
 * `Sandbox.Current`; the provider — deterministic in memory, or a real
 * directory on disk — arrives through layer wiring, and swapping one for the
 * other rewrites one line. Requirements flow through `Agent.make` into
 * `prompt`'s type, so forgetting to provide a provider cannot compile.
 */

const ReadFile = Tool.make("read_file", {
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  dependencies: [Sandbox.Current]
})

const WriteFile = Tool.make("write_file", {
  parameters: Schema.Struct({
    path: Schema.String,
    contents: Schema.String
  }),
  success: Schema.String,
  failure: Schema.String,
  dependencies: [Sandbox.Current]
})

const RunCommand = Tool.make("run_command", {
  parameters: Schema.Struct({
    executable: Schema.String,
    args: Schema.Array(Schema.String)
  }),
  success: Schema.Struct({
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String
  }),
  failure: Schema.String,
  dependencies: [Sandbox.Current]
})

// The handlers read like ordinary code: yield the service, validate the raw
// path the model supplied through `Sandbox.path` (the typed boundary where
// absolute paths and traversal are refused), then use it. No casts, no
// annotated parameters — `path`, `contents`, `executable` and `args` all
// infer from the tool schemas.
const toolkit = Agent.toolkit([ReadFile, WriteFile, RunCommand], {
  read_file: ({ path: file }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      const text = yield* Sandbox.readText(sandbox)(yield* Sandbox.path(file))
      return text
    }).pipe(Effect.mapError((error: Sandbox.FileError) => error.message)),
  write_file: ({ path: file, contents }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      yield* sandbox.write(yield* Sandbox.path(file), contents)
      return `wrote ${file}`
    }).pipe(Effect.mapError((error: Sandbox.FileError) => error.message)),
  run_command: ({ executable, args }) =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Current
      return yield* sandbox.exec(Sandbox.command(executable, args))
    }).pipe(Effect.mapError((error: Sandbox.ExecError) => error.message))
})

const Coder = Agent.make({
  instructions:
    "You edit code inside a workspace using read_file, write_file and run_command.",
  toolkit
})

const program = Effect.gen(function* () {
  const session = yield* AgentSession.make(Coder)
  return yield* AgentSession.prompt(
    session,
    "Fix the failing test in src/add.test.ts."
  )
})

// Deterministic by default: the same agent runs against an in-memory world.
const memoryWired = program.pipe(
  Effect.provide(Layer.provideMerge(
    Sandbox.currentLayer(Sandbox.workspace("coding-agent")),
    MemorySandbox.layer({ seed: { "src/add.test.ts": "assert(1 + 1 === 3)" } })
  )),
  Effect.scoped
)

// Against real files, only this wiring changes — the agent and every handler
// above are untouched. Note the documented caveat: the local provider is a
// convenience, not a security boundary.
const localWired = program.pipe(
  Effect.provide(Layer.provideMerge(
    Sandbox.currentLayer(Sandbox.workspace("coding-agent")),
    LocalSandbox.layer()
  )),
  Effect.scoped
)

void memoryWired
void localWired
