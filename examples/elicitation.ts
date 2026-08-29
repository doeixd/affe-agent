/**
 * Elicitation via the published export map.
 *
 * This is the one example that imports the way a user does — through
 * `@doeixd/effect-agent` and its subpaths, not a deep `../src/*.js` path.
 * It exists so `exports` is exercised by code, not only by `verify:package`.
 *
 * Run: `npx tsx examples/elicitation.ts`
 */
import { Console, Effect, Fiber, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
// Published surface — root and subpath both resolve to the same Elicitation
import { Agent, AgentLoop, AgentSession, Elicitation, Permission } from "@doeixd/effect-agent"
import * as ElicitationViaSubpath from "@doeixd/effect-agent/elicitation"
import { TestLanguageModel } from "@doeixd/effect-agent/testing"

// Prove the two import paths agree — a subpath that drifted from the root
// would be a breaking change the type system should catch.
type _SubpathEqualsRoot = ElicitationViaSubpath.Elicitor extends Elicitation.Elicitor ? true : false
const _checkSubpath: _SubpathEqualsRoot = true
void _checkSubpath

const Bash = Permission.annotate(
  Tool.make("bash", {
    parameters: Schema.Struct({ command: Schema.String }),
    success: Schema.String
  }),
  { action: "shell", resource: ({ command }) => command }
)

const agent = Agent.make({
  instructions: "You help with git.",
  toolkit: Agent.toolkit([Bash], {
    bash: ({ command }) => Effect.succeed(`$ ${command}\n(ok)`)
  }),
  loop: AgentLoop.bounded(4)
})

const program = Effect.gen(function* () {
  const { layer } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "c1", name: "bash", params: { command: "rm -rf /tmp/x" } }] },
    TestLanguageModel.text("done")
  ])

  // Without an elicitor the `ask` policy would refuse and the model would see
  // a denial. With `Elicitation.memory` the run pauses and can be answered.
  const policy = Permission.rules(
    [{ action: "shell", resource: /rm -rf/, decision: Permission.ask("destructive") }],
    { otherwise: Permission.allow }
  )
  const remembering = yield* Permission.remembered(policy)

  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* AgentSession.make(
        agent.pipe(Agent.withPermission(remembering)),
        { elicitation: Elicitation.memory }
      )

      const answering = yield* Effect.forkChild(
        Stream.runForEach(session.events, (envelope) =>
          envelope.event._tag === "ElicitationRequested"
            ? Console.log(`? ${envelope.event.kind} ${envelope.event.id}`).pipe(
                Effect.andThen(
                  AgentSession.respond(session, {
                    id: envelope.event.id,
                    granted: true,
                    value: { remember: false }
                  })
                )
              )
            : Effect.void
        )
      )

      const result = yield* session.prompt("clean up")
      yield* Console.log(`result: ${result.text}`)
      yield* Fiber.interrupt(answering)
    })
  ).pipe(Effect.provide(layer))
})

Effect.runPromise(program)

// --- Type assertions — break once to confirm enforcement, then restore ---

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

// Handler param must infer, not `any` — would hide a wrong resource projection.
type BashParams = Tool.Parameters<typeof Bash>
export type _BashParamsNotAny = Assert<IsAny<BashParams> extends false ? true : false>
export type _BashCommandIsString = Assert<BashParams extends { command: string } ? true : false>

// `AgentSession.prompt` error channel must name the tool's failure, not `unknown`.
// `Elicitation.memory` should not add `unknown` to it.
type PromptEffect = ReturnType<
  typeof AgentSession.prompt<{ readonly bash: typeof Bash }, never>
>
type PromptErr = PromptEffect extends Effect.Effect<any, infer E, any> ? E : never
export type _ErrorNotUnknown = Assert<unknown extends PromptErr ? false : true>

// The subpath export must expose `memory` and `denied` the way the root does.
export type _SubpathHasMemory = Assert<
  typeof ElicitationViaSubpath.memory extends Elicitation.Factory ? true : false
>
export type _SubpathHasDenied = Assert<
  typeof ElicitationViaSubpath.denied extends Elicitation.Factory ? true : false
>
