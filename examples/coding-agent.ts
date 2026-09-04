import { Effect, Layer } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as Permission from "../src/Permission.js"
import * as LocalSandbox from "../src/sandbox/local.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"

/**
 * A coding agent built from the shipped battery, `affe-agent/coding`.
 *
 * The point of this example is how little there is. Unlike `sandbox.ts`, which
 * hand-writes the tools to show the seam, here the tools arrive whole from
 * `CodingToolkit.toolkit()` -- read_file, write_file, edit_file, list_files,
 * search and bash -- and nothing about the agent core changes to accept them.
 * Which sandbox runs, and what a policy lets through, is all layer wiring.
 */

const Coder = Agent.make({
  instructions:
    "You edit code inside a workspace. Read before you write, and prefer edit_file over rewriting a whole file.",
  toolkit: CodingToolkit.toolkit(),
  // The battery projects every tool for policy: files to read/write on the
  // path, bash to shell on the command. So a policy speaks in those terms
  // without knowing the tools. Here: reads run, writes and shell ask first.
  permission: Permission.rules(
    [
      { action: "read", decision: Permission.allow },
      { action: "write", decision: Permission.ask("about to modify the workspace") },
      { action: "shell", decision: Permission.ask("about to run a shell command") }
    ],
    { otherwise: Permission.ask("unclassified action") }
  )
})

const program = Effect.gen(function* () {
  const session = yield* AgentSession.make(Coder)
  return yield* AgentSession.prompt(session, "Fix the failing test in src/add.test.ts.")
})

// Deterministic by default: the same agent runs against an in-memory world.
const memoryWired = program.pipe(
  Effect.provide(Layer.provideMerge(
    Sandbox.currentLayer(Sandbox.workspace("coding-agent")),
    MemorySandbox.layer({ seed: { "src/add.test.ts": "assert(1 + 1 === 3)" } })
  )),
  Effect.scoped
)

// Against real files, only this wiring changes -- the agent is untouched. The
// local provider is a convenience, not a security boundary.
const localWired = program.pipe(
  Effect.provide(Layer.provideMerge(
    Sandbox.currentLayer(Sandbox.workspace("coding-agent")),
    LocalSandbox.layer()
  )),
  Effect.scoped
)

void memoryWired
void localWired
