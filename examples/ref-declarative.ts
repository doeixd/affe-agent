/**
 * Reference declarative agent — `plan-primitives.md` §4.
 *
 * The third reference, and the one that argues rather than demonstrates.
 * The plan's §2 conclusion about framework ergonomics is that nothing is
 * *missing* -- "the difference is cohesion, not power" -- and that what a
 * user faces is assembling fifteen pieces correctly to get what a
 * declarative framework hands them in one declaration. This file is that
 * claim made checkable: everything below is **declared as data** --
 * state, how state reaches the model, which capabilities exist, and what
 * reacts to what -- and the harness does the assembling.
 *
 * Built only from the public surface, no casts, and it runs in CI.
 *
 * Run: `npx tsx examples/ref-declarative.ts`
 */

import { Console, Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { Agent, AgentLoop, AgentSession, Permission, ToolExecution } from "affe-agent"
import { Hooks } from "affe-agent/hooks"
import { AgentState } from "affe-agent/state"
import { TestLanguageModel } from "affe-agent/testing"

// ---------------------------------------------------------------------------
// 1. State, declared once: its shape, its initial value, how it is rendered
// ---------------------------------------------------------------------------

interface Plan {
  readonly mode: "planning" | "executing"
  readonly steps: ReadonlyArray<string>
  readonly done: ReadonlyArray<string>
}

/** A tag's id is its runtime identity, so it is made once and exported. */
const CurrentPlan = AgentState.Tag<Plan>("example/ref-declarative/plan")

const initialPlan: Plan = { mode: "planning", steps: [], done: [] }

/**
 * How the state reaches the model: declared, not wired per turn.
 *
 * `AgentState.transform` is a `ContextTransform`, so the rendering is
 * recomputed every turn from the current value and appended to what the
 * model sees -- while canonical history is never touched. Declaring this
 * once is the difference the plan is talking about: the alternative is
 * remembering to re-inject state on every prompt, and finding out you
 * forgot when the model contradicts itself.
 */
const planInPrompt = AgentState.transform(CurrentPlan, (plan) =>
  [
    `Mode: ${plan.mode}.`,
    plan.steps.length === 0 ? "No steps yet." : `Steps: ${plan.steps.join(", ")}.`,
    plan.done.length === 0 ? "Nothing done." : `Done: ${plan.done.join(", ")}.`
  ].join(" "))

// ---------------------------------------------------------------------------
// 2. Capabilities, declared as data and resolved against live state
// ---------------------------------------------------------------------------

const AddStep = Permission.annotate(
  Tool.make("add_step", {
    description: "Add a step to the plan",
    parameters: Schema.Struct({ step: Schema.String }),
    success: Schema.String,
    // Declared, both of them, and the declaration is the ergonomics
    // point: a tool that touches state says so in its type, so the
    // handler below simply reads and writes -- and a store that cannot
    // be written is the tool's own declared failure rather than a
    // surprise at runtime.
    failure: Schema.String,
    dependencies: [CurrentPlan]
  }),
  { action: "plan", resource: (params) => params.step }
)

const RunStep = Permission.annotate(
  Tool.make("run_step", {
    description: "Carry out the next step",
    parameters: Schema.Struct({ step: Schema.String }),
    success: Schema.String,
    failure: Schema.String,
    dependencies: [CurrentPlan]
  }),
  { action: "execute", resource: (params) => params.step }
)

/**
 * Which capabilities apply in which mode -- a declaration, not a branch
 * buried in a handler.
 */
const capabilities: Readonly<Record<Plan["mode"], ReadonlyArray<string>>> = {
  planning: ["plan"],
  executing: ["execute"]
}

/**
 * Capability resolution, per call, against the state as it is *now*.
 *
 * This is the dynamic half of the claim. The toolkit is fixed at
 * construction -- a model needs a stable list of what exists -- but what
 * the agent may *do* follows the state, so a mode change takes effect on
 * the next call without rebuilding the agent or the session. A policy is
 * an ordinary Effect, which is what makes reading live state here
 * unremarkable rather than a special mechanism.
 */
const modePolicy = Permission.make((request) =>
  Effect.map(AgentState.get(CurrentPlan), (plan) =>
    capabilities[plan.mode].includes(request.action)
      ? Permission.allow
      : Permission.deny(`${request.action} is not available while ${plan.mode}`)))

// ---------------------------------------------------------------------------
// 3. Reactions, declared as a record of handlers
// ---------------------------------------------------------------------------

/**
 * What happens when the agent does things, as data.
 *
 * `Hooks.on` dispatches each event to its handler, isolating failures --
 * a hook that throws does not end the run or the observer. Each handler
 * gets its own event type from its key, so `event.name` below is typed
 * without a cast or an annotation.
 */
const reactions = {
  ToolCallSucceeded: (event) =>
    event.name === "add_step"
      ? Console.log(`  + planned: ${String(event.result)}`)
      : Console.log(`  > did: ${String(event.result)}`),
  ToolCallFailed: (event) => Console.log(`  ! refused: ${event.name}`)
} satisfies Hooks.Handlers<never, never>

// ---------------------------------------------------------------------------
// The assembly the harness does for you
// ---------------------------------------------------------------------------

const program = Effect.gen(function*() {
  const toolkit = yield* Agent.toolkit([AddStep, RunStep], {
    add_step: ({ step }) =>
      AgentState.update(CurrentPlan, (plan): Plan => ({
        ...plan,
        steps: [...plan.steps, step]
      })).pipe(Effect.as(step), Effect.mapError((error) => error.message)),
    run_step: ({ step }) =>
      AgentState.update(CurrentPlan, (plan): Plan => ({
        ...plan,
        done: [...plan.done, step]
      })).pipe(Effect.as(step), Effect.mapError((error) => error.message))
  })

  const assistant = Agent.make({
    instructions: "You plan first, then execute. The current plan is in your context.",
    toolkit,
    permission: modePolicy,
    // State reaches the model here, once.
    contextTransform: planInPrompt,
    // A refusal is information the model can act on, not a dead run.
    toolDenialPolicy: ToolExecution.ReturnToModel,
    loop: AgentLoop.bounded(6)
  })

  const { layer: model } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "p1", name: "add_step", params: { step: "read the file" } }] },
    { toolCalls: [{ id: "p2", name: "run_step", params: { step: "read the file" } }] },
    { text: "I cannot execute while planning." },
    { toolCalls: [{ id: "e1", name: "run_step", params: { step: "read the file" } }] },
    { text: "Read the file." }
  ])

  return yield* Effect.gen(function*() {
    const session = yield* AgentSession.make(assistant)

    // The declared reactions, attached once and running beside the agent.
    yield* Effect.forkScoped(Hooks.on(AgentSession.events(session), reactions))

    yield* Console.log("--- planning ---")
    const planned = yield* session.prompt("plan reading the file, then do it")
    yield* Console.log(`assistant: ${planned.text}`)

    // A mode change is a state write. Nothing is rebuilt, and the next
    // call resolves its capabilities against the new value.
    yield* AgentState.update(CurrentPlan, (plan): Plan => ({ ...plan, mode: "executing" }))
    yield* Console.log("\n--- executing (same session, same agent) ---")
    const executed = yield* session.prompt("now do it")
    yield* Console.log(`assistant: ${executed.text}`)

    const finalPlan = yield* AgentState.get(CurrentPlan)
    yield* Console.log(
      `\nplan: mode=${finalPlan.mode} steps=[${finalPlan.steps.join(", ")}] done=[${
        finalPlan.done.join(", ")
      }]`
    )
    return finalPlan
  }).pipe(Effect.provide(model), Effect.scoped)
})

// The claims, enforced. A violated claim is a defect: it means this
// reference's statement about the library is false.
/**
 * The state service, provided once around everything.
 *
 * It has to wrap the *toolkit build* as well as the run: the tools
 * declare `CurrentPlan` as a dependency, so building them asks for it --
 * which is the declaration doing its job.
 */
const state = AgentState.layer(CurrentPlan, { initial: initialPlan })

const main = Effect.gen(function*() {
  const plan = yield* program.pipe(Effect.provide(state))
  const expect = (claim: string, held: boolean) =>
    held ? Effect.void : Effect.die(new Error(`ref-declarative: ${claim}`))

  yield* expect(
    "a tool handler's state write is visible to the next turn",
    plan.steps.length === 1 && plan.steps[0] === "read the file"
  )
  yield* expect(
    "capability resolution follows live state: executing was refused while planning, and ran after the mode changed",
    plan.done.length === 1 && plan.done[0] === "read the file"
  )
  yield* expect(
    "the mode change took effect without rebuilding the agent or the session",
    plan.mode === "executing"
  )
  return plan
})

void Effect.runPromise(Effect.scoped(main)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})

// ---------------------------------------------------------------------------
// Compile-time assertions — break once to confirm enforcement, then restore.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

/** A hook handler gets its own event type from its key, with no annotation. */
type SucceededHook = NonNullable<typeof reactions["ToolCallSucceeded"]>
type SucceededEvent = Parameters<SucceededHook>[0]
export type _HookEventIsNotAny = Assert<IsAny<SucceededEvent> extends true ? false : true>
export type _HookEventIsItsOwnTag = Assert<
  SucceededEvent extends { readonly _tag: "ToolCallSucceeded"; readonly name: string } ? true
    : false
>

/** State reads are typed by the tag, not by the caller. */
type PlanRead = Effect.Success<ReturnType<typeof AgentState.get<Plan>>>
export type _StateIsTyped = Assert<PlanRead extends Plan ? true : false>

/** The transform is an ordinary `ContextTransform`, reachable and typed. */
export type _TransformIsNotAny = Assert<IsAny<typeof planInPrompt> extends true ? false : true>
