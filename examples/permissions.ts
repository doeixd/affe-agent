/**
 * Permissions: allow, ask, deny -- between the model's request and the tool.
 *
 * A coding agent with a shell. Read-only git commands run; pushes are asked
 * about, and the person at the keyboard can answer "always"; anything
 * destructive is refused and the model is told so it can take another route.
 *
 * Run: `npx tsx examples/permissions.ts`
 */
import { Console, Effect, Fiber, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { TestLanguageModel } from "../src/testing/index.js"

// The tool describes what it is, for policy purposes. The policy never
// looks at `command`; it looks at the `shell` action on a resource.
const Bash = Permission.annotate(
  Tool.make("bash", {
    parameters: Schema.Struct({ command: Schema.String }),
    success: Schema.String
  }),
  { action: "shell", resource: ({ command }) => command }
)

const policy = Permission.rules(
  [
    { action: "shell", resource: /^git (status|diff|log)/, decision: Permission.allow },
    { action: "shell", resource: /^git push/, decision: Permission.ask("writes to the remote") },
    { action: "shell", resource: /rm -rf|--force/, decision: Permission.deny("destructive") }
  ],
  { otherwise: Permission.ask() }
)

const agent = Agent.make({
  instructions: "You help with git.",
  toolkit: Agent.toolkit([Bash], {
    bash: ({ command }) => Effect.succeed(`$ ${command}\n(ok)`)
  }),
  loop: AgentLoop.bounded(8),
  toolDenialPolicy: ToolExecution.ReturnToModel
})

const program = Effect.gen(function* () {
  // Grants made with "always" are kept for the life of this policy.
  const remembering = yield* Permission.remembered(policy)
  const { layer } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "c1", name: "bash", params: { command: "git status" } }] },
    { toolCalls: [{ id: "c2", name: "bash", params: { command: "git push origin main" } }] },
    { toolCalls: [{ id: "c3", name: "bash", params: { command: "git push origin main" } }] },
    { toolCalls: [{ id: "c4", name: "bash", params: { command: "git push --force" } }] },
    TestLanguageModel.text("Pushed. The force-push was refused, so I left it.")
  ])

  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* AgentSession.make(
        agent.pipe(Agent.withPermission(remembering)),
        { elicitation: Elicitation.memory }
      )
      // Answer every question "yes, and remember it" -- a stand-in for the
      // person at the keyboard.
      const answering = yield* Effect.forkChild(
        Stream.runForEach(session.events, (envelope) =>
          AgentEvent.is("ElicitationRequested")(envelope)
            ? Console.log(`  ? ${JSON.stringify(envelope.event.detail)}`).pipe(
                Effect.andThen(
                  AgentSession.respond(session, {
                    id: envelope.event.id,
                    granted: true,
                    value: { remember: true }
                  })
                )
              )
            : AgentEvent.is("ToolCallFailed")(envelope)
              ? Console.log(`  x ${envelope.event.failure.message}`)
              : AgentEvent.is("ToolCallSucceeded")(envelope)
                ? Console.log(`  > ${envelope.event.name} ${JSON.stringify(envelope.event.result)}`)
                : Effect.void
        )
      )
      const result = yield* session.prompt("check the repo and push")
      yield* Console.log(result.text)
      yield* Fiber.interrupt(answering)
    })
  ).pipe(Effect.provide(layer))
})

Effect.runPromise(program)
