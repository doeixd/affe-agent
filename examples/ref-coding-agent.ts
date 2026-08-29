/**
 * Reference coding agent — `plan-primitives.md` §4.
 *
 * Built **only** from the public surface (`@doeixd/effect-agent/*`) the
 * way a user would. No `../src/internal`, no casts, miniature not a fork.
 * Exercises: sessions, turns, CodingToolkit tools, Permission HITL,
 * Sandbox (memory), Compaction as ContextTransform, and an event-stream
 * front end. Runs deterministically under TestLanguageModel so it is CI-runnable.
 *
 * `examples/full-stack-agent.ts` is the closest prior art; this starts from
 * it rather than from blank and strips to the coding-agent axis.
 *
 * Run: `npx tsx examples/ref-coding-agent.ts`
 */

import { Console, Effect, Fiber, Layer, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

// Public surface only — same import paths a user gets. If this file needs a
// private import, that's a missing primitive and belongs in STATUS.md.
import { Agent, AgentLoop, AgentSession, Elicitation, Permission } from "@doeixd/effect-agent"
import { CodingToolkit } from "@doeixd/effect-agent/coding"
import { Compaction } from "@doeixd/effect-agent/compaction"
import { MemorySandbox, Sandbox } from "@doeixd/effect-agent/sandbox"
import { TestLanguageModel } from "@doeixd/effect-agent/testing"

// ---------------------------------------------------------------------------
// Policy: reads/search run, writes/shell ask (HITL via Elicitation.memory)
// ---------------------------------------------------------------------------

const policy = Permission.rules(
  [
    { action: "read", decision: Permission.allow },
    { action: "search", decision: Permission.allow },
    { action: "write", decision: Permission.ask("about to modify the workspace") },
    { action: "shell", decision: Permission.ask("about to run a shell command") }
  ],
  { otherwise: Permission.ask("unclassified action") }
)

// ---------------------------------------------------------------------------
// Program: compaction + coding toolkit + permission + sandbox + elicitation
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  // Compaction is a pure ContextTransform over the canonical transcript.
  // Threshold 2 ensures the 4-turn script actually compacts so the composition
  // is exercised, not merely wired. Canonical history stays complete.
  const compaction = yield* Compaction.make({
    policy: Compaction.whenLongerThan(2, { retain: 2 }),
    summarise: ({ messages, previous }) =>
      Effect.succeed(
        previous._tag === "Some"
          ? `Prior summary; now +${messages.content.length} msgs`
          : `Summary of ${messages.content.length} early messages`
      )
  })

  const Coder = Agent.make({
    instructions:
      "You edit code inside a workspace. Read before you write, prefer edit_file over write_file, and run tests with bash.",
    toolkit: CodingToolkit.toolkit(),
    permission: policy,
    contextTransform: compaction,
    loop: AgentLoop.bounded(10)
  })

  // Scripted model: search → read → edit → bash → done.
  const { layer: modelLayer } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "c1", name: "search", params: { pattern: "TODO", path: "." } }] },
    { toolCalls: [{ id: "c2", name: "read_file", params: { path: "src/app.ts" } }] },
    {
      toolCalls: [
        {
          id: "c3",
          name: "edit_file",
          params: { path: "src/app.ts", old_string: "// TODO: fix", new_string: "// fixed" }
        }
      ]
    },
    { toolCalls: [{ id: "c4", name: "shell", params: { command: "npm test" } }] },
    TestLanguageModel.text("Done. Fixed TODO, edit applied, tests pass.")
  ])

  const sandboxProvider = MemorySandbox.layer({
    seed: {
      "src/app.ts": "// TODO: fix\nconst x = 1\n",
      "README.md": "# workspace\n"
    }
  })

  const workspaceLayer = Sandbox.currentLayer(Sandbox.workspace("ref-coding-agent")).pipe(
    Layer.provide(sandboxProvider)
  )

  const env = Layer.mergeAll(modelLayer, workspaceLayer)

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* AgentSession.make(Coder, { elicitation: Elicitation.memory })

      // Minimal front end: log lifecycle as it happens, and auto-answer asks.
      const ui = yield* Effect.forkScoped(
        Stream.runForEach(session.events, (envelope) => {
          if (envelope.event._tag === "ElicitationRequested") {
            return Console.log(`? ${envelope.event.kind}: ${String(envelope.event.detail)}`).pipe(
              Effect.andThen(
                AgentSession.respond(session, {
                  id: envelope.event.id,
                  granted: true,
                  value: { remember: false }
                })
              )
            )
          }
          if (envelope.event._tag === "ToolCallStarted") {
            return Console.log(`> ${envelope.event.name}`)
          }
          if (envelope.event._tag === "ToolCallSucceeded") {
            return Console.log(`  ✓ ${envelope.event.name}`)
          }
          if (envelope.event._tag === "TurnCompleted") {
            return Console.log(`  — turn done`)
          }
          return Effect.void
        })
      )

      const outcome = yield* session.prompt("Fix TODO in src/app.ts and verify with tests.")

      yield* Fiber.interrupt(ui)

      const history = yield* session.history

      return { text: outcome.text, historyLen: history.content.length, status: outcome.status }
    })
  ).pipe(Effect.provide(env))

  yield* Console.log(`\nResult: ${result.text}`)
  yield* Console.log(`History messages: ${result.historyLen}, status: ${result.status}`)

  // Sanity: history is canonical and complete — truncation banners are derived.
  if (result.historyLen < 8) {
    yield* Console.error(`history too short: ${result.historyLen}`)
  }

  return result
})

void Effect.runPromise(Effect.scoped(program))

// ---------------------------------------------------------------------------
// Compile-time assertions — break once to confirm enforcement, then restore.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

// The CodingToolkit tools must retain their literal names and inferred param types
// through Agent.make — no cast, no annotation on handlers. `any` would satisfy the
// runtime but erase the promise AGENTS.md makes.
type ReadToolName = typeof CodingToolkit.ReadFile extends Tool.Tool<infer N, any, any> ? N : never
export type _ReadNameIsLiteral = Assert<ReadToolName extends "read_file" ? true : false>

type ReadParams = Tool.Parameters<typeof CodingToolkit.ReadFile>
export type _ReadParamsNotAny = Assert<IsAny<ReadParams> extends false ? true : false>
export type _ReadParamsHasPath = Assert<ReadParams extends { path: string } ? true : false>

// `AgentSession.prompt` error channel must stay typed (tools' failures + E), not `unknown`.
// Instantiate with the toolkit's tool set so the inference is exercised, not widened.
type PromptEffect = ReturnType<
  typeof AgentSession.prompt<{ readonly read_file: typeof CodingToolkit.ReadFile }, never>
>
type PromptErr = PromptEffect extends Effect.Effect<any, infer E, any> ? E : never
export type _PromptErrorNotUnknown = Assert<unknown extends PromptErr ? false : true>

// Compaction's summarise receives a typed previous summary (Option<string>) — not `any`.
type SummariseArg = Parameters<Parameters<typeof Compaction.make>[0]["summarise"]>[0]
export type _SummarisePreviousIsOption = Assert<
  SummariseArg extends { previous: { _tag: "Some" | "None" } } ? true : false
>
