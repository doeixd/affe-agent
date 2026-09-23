/**
 * Reference — background delegation from parts that already exist
 * (`plan-subagent-execution-forms.md`, decision 4).
 *
 * The plan's question was whether a `Subagent.background` battery earns a new
 * exported concept. This file answers it the repository's way: build the
 * composition from the public surface only and measure it. It is not a
 * package and must not be imported.
 *
 * What it composes, and where each part comes from:
 *
 *   - a parent (`Coordinator`) whose tool *starts* a child session and returns
 *     a worker id, so the parent's run ends without waiting;
 *   - the child (`Researcher`) running to completion in the application scope,
 *     so it outlives the parent's run;
 *   - the completion delivered back to the parent as a new submission through
 *     `/sessions`' `SessionInbox` — the durable, idempotent ping-back.
 *
 * What it found (the measure) is written at the bottom of the file.
 *
 * Run: `npx tsx examples/ref-subagent-forms.ts`
 */
import { Context, Effect, Layer, Option, Queue, Ref, Schedule, Schema, Scope } from "effect"
import { PersistedQueue } from "effect/unstable/persistence"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as SessionInbox from "../src/sessions/SessionInbox.js"
import { TestLanguageModel } from "../src/testing/index.js"

// ---------------------------------------------------------------------------
// The runtime handles a background tool needs. A tool cannot close over the
// clients (the client is built from the agent, which is built from the tool),
// so they arrive through the environment — the same shape `Scheduling` uses.
// ---------------------------------------------------------------------------

interface BackgroundShape {
  readonly start: (question: string) => Effect.Effect<string>
  readonly followUp: (worker: string, question: string) => Effect.Effect<string>
}

class Background extends Context.Service<Background, BackgroundShape>()(
  "example/ref-subagent-forms/Background"
) {}

// ---------------------------------------------------------------------------
// The two agents. The child is an ordinary agent; the parent's tools hand work
// off and return.
// ---------------------------------------------------------------------------

const Researcher = Agent.make({
  instructions: "Answer the research question in one short sentence."
})

const StartResearch = Tool.make("start_research", {
  description: "Start a background researcher and return its worker id.",
  parameters: Schema.Struct({ question: Schema.String }),
  success: Schema.String,
  dependencies: [Background]
})

const FollowUpResearch = Tool.make("follow_up_research", {
  description: "Send more input to an existing background researcher.",
  parameters: Schema.Struct({ worker: Schema.String, question: Schema.String }),
  success: Schema.String,
  dependencies: [Background]
})

/**
 * Stop the parent's run once it has handed work off. Without this the run
 * would keep going to a closing remark, and the report — which may arrive at
 * any moment — would land while the parent was still busy.
 */
const stopAfterDelegation = AgentLoop.make((state) =>
  Effect.succeed(
    state.toolCalls.some((call) => call.name === "start_research" || call.name === "follow_up_research")
      ? AgentLoop.Stop
      : AgentLoop.Continue
  )
)

const Coordinator = Agent.make({
  instructions: "Start research for the user, remember the worker id, and send follow-ups when asked.",
  tools: [
    Agent.tool(StartResearch, ({ question }) => Effect.flatMap(Background, (background) => background.start(question))),
    Agent.tool(FollowUpResearch, ({ worker, question }) =>
      Effect.flatMap(Background, (background) => background.followUp(worker, question)))
  ],
  loop: AgentLoop.and(stopAfterDelegation, AgentLoop.untilIdle())
})

// ---------------------------------------------------------------------------
// The program: one client per agent, and one inbox for the report back.
// ---------------------------------------------------------------------------

const PARENT_SESSION = "coordinator"

const report = (worker: string, sequence: number, text: string): SessionInbox.Item => ({
  // The idempotency key is the item's whole identity, so a second observation
  // of one completion is one report. The sequence keeps two completions of the
  // same worker distinct.
  id: `worker:${worker}:done:${sequence}`,
  sessionId: PARENT_SESSION,
  input: Prompt.make(`Background worker ${worker} finished. Findings: ${text}`),
  source: { kind: "worker", id: worker },
  createdAt: 0
})

/** The assistant's text, read back from a history. */
const assistantTexts = (history: Prompt.Prompt): Array<string> =>
  history.content.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : []
  )

const program = Effect.gen(function* () {
  // Workers are forked here, not into a tool's scope, so they outlive the run
  // that started them. This is the whole of "background".
  const appScope = yield* Effect.scope

  const { layer: parentModel } = yield* TestLanguageModel.script([
    { toolCalls: [{ id: "p1", name: "start_research", params: { question: "food and walking in Lisbon" } }] },
    { toolCalls: [{ id: "p2", name: "follow_up_research", params: { worker: "worker-1", question: "add indoor options" } }] },
    TestLanguageModel.text("Itinerary: riverside walk, food market, tram museum.")
  ])
  const { layer: childModel } = yield* TestLanguageModel.script([
    TestLanguageModel.text("Riverside walk and the food market."),
    TestLanguageModel.text("Add the tram museum for a rainy day.")
  ])

  // One client per agent: a client serves the agent it was built for, and only
  // the sessions it created. There is no portable multi-agent client.
  //
  // The child direction does not use an inbox: the tool that starts a worker
  // holds the child's session handle, and the inbox exists for a producer that
  // does not (a process, a monitor). The *report* is that producer.
  const backgroundRef = yield* Ref.make<Option.Option<BackgroundShape>>(Option.none())
  const lazyBackground = Layer.succeed(Background, {
    start: (question) =>
      Effect.flatMap(Ref.get(backgroundRef), (found) =>
        Option.match(found, {
          onNone: () => Effect.die("the background service was used before it was wired"),
          onSome: (background) => background.start(question)
        })),
    followUp: (worker, question) =>
      Effect.flatMap(Ref.get(backgroundRef), (found) =>
        Option.match(found, {
          onNone: () => Effect.die("the background service was used before it was wired"),
          onSome: (background) => background.followUp(worker, question)
        }))
  })

  const parentContext = yield* Layer.build(
    AgentClient.layer(Coordinator).pipe(
      Layer.provide(parentModel),
      Layer.provide(lazyBackground)
    )
  )
  const childContext = yield* Layer.build(AgentClient.layer(Researcher).pipe(Layer.provide(childModel)))
  const parentClient = Context.get(parentContext, AgentClient.AgentClient)
  const childClient = Context.get(childContext, AgentClient.AgentClient)

  const parentInbox = yield* SessionInbox.make({ name: "example/reports", maxAttempts: 1000 }).pipe(
    Effect.provideService(AgentClient.AgentClient, parentClient)
  )

  // Reports ready to deliver. A real application runs a `deliver` loop; this
  // one drives it by hand so the sequence is deterministic.
  const reports = yield* Queue.unbounded<SessionInbox.Item>()
  const nextWorker = yield* Ref.make(0)
  const nextReport = yield* Ref.make(0)

  const submitAndReport = (child: AgentClient.RemoteSession, worker: string, input: string) =>
    Effect.gen(function* () {
      const receipt = yield* child.submit(input)
      const result = yield* child.awaitSubmission(receipt.submissionId)
      const sequence = yield* Ref.updateAndGet(nextReport, (n) => n + 1)
      const item = report(worker, sequence, result.text)
      yield* parentInbox.enqueue(item)
      yield* Queue.offer(reports, item)
    })

  const background: BackgroundShape = {
    start: (question) =>
      Effect.gen(function* () {
        const worker = `worker-${yield* Ref.updateAndGet(nextWorker, (n) => n + 1)}`
        yield* Effect.forkIn(appScope)(
          Effect.gen(function* () {
            // The application scope, explicitly: a session created in the
            // tool's own scope would die with the run, which is the opposite
            // of background.
            const child = yield* childClient.createSession({ sessionId: worker }).pipe(
              Effect.provideService(Scope.Scope, appScope)
            )
            yield* submitAndReport(child, worker, question)
          }).pipe(Effect.orDie)
        )
        return worker
      }),
    followUp: (worker, question) =>
      Effect.gen(function* () {
        yield* Effect.forkIn(appScope)(
          Effect.gen(function* () {
            const child = yield* childClient.session(worker)
            yield* submitAndReport(child, worker, question)
          }).pipe(Effect.orDie)
        )
        return `sent to ${worker}`
      })
  }
  yield* Ref.set(backgroundRef, Option.some(background))

  const parent = yield* parentClient.createSession({ sessionId: PARENT_SESSION })

  // The application's report delivery: the inbox waits for an idle session, so
  // a busy parent is retried rather than interrupted.
  const deliverReport = parentInbox.deliver.pipe(
    Effect.retry({
      while: (error) => error._tag === "SessionBusyError",
      schedule: Schedule.spaced("1 millis")
    })
  )

  /**
   * Wait until the parent has settled *and* has committed at least
   * `expectedUserTexts` messages. `deliver` returns at admission, not at
   * settlement (item 97), so this is how the application knows a delivered
   * report has been processed. The two conditions together are race-free:
   * the report commits when the submission *starts*, so the count proves it
   * started, and `idle` proves it finished.
   */
  const settled = (session: AgentClient.RemoteSession, expectedUserTexts: number) =>
    Effect.repeat(
      Effect.all({ status: session.status, history: session.history }),
      {
        until: ({ history, status }) =>
          status === "idle" && TestLanguageModel.userTexts(history).length >= expectedUserTexts,
        schedule: Schedule.spaced("1 millis")
      }
    )

  // --- the conversation ------------------------------------------------------

  // Run 1: the parent hands work off and returns. The worker outlives it.
  const first = yield* parent.prompt("Plan a day in Lisbon.")
  // The worker's completion arrives as a report, delivered as a new submission.
  yield* Queue.take(reports)
  const delivered1 = yield* deliverReport
  yield* settled(parent, 2)

  // Run 2: the parent reads the report and sends a follow-up to the same worker.
  yield* Queue.take(reports)
  const delivered2 = yield* deliverReport
  yield* settled(parent, 3)

  // Run 3: the parent answers with the follow-up's findings.
  const history = yield* parent.history
  const child = yield* childClient.session("worker-1")
  const childHistory = yield* child.history

  return {
    // Run 1 stops at the hand-off, so it has no text: the point is that the
    // parent did not wait for the worker.
    handOffRunText: first.text,
    deliveries: [delivered1._tag, delivered2._tag],
    // Both reports, plus the original prompt. The reports arrive as *user*
    // messages -- the finding below.
    parentUserTexts: TestLanguageModel.userTexts(history),
    parentAssistantTexts: assistantTexts(history),
    childUserTexts: TestLanguageModel.userTexts(childHistory)
  }
})

export const main = Effect.scoped(program).pipe(
  Effect.provide(PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory)))
)

Effect.runPromise(main).then(
  (summary) => {
    console.log(JSON.stringify(summary, null, 2))
  },
  (error) => {
    console.error(error)
    process.exitCode = 1
  }
)

// ---------------------------------------------------------------------------
// What it found — the measure the plan asked for.
//
// It composes, but it is not a thin wrapper, and three things are missing that
// a `Subagent.background` would have to supply:
//
//   1. No portable multi-agent client. `AgentClient` serves one agent and only
//      the sessions it created, so parent and child need two clients wired by
//      hand. A host that serves a list of agents does not exist outside the
//      workbench and `apps/worker`.
//   2. The client/agent circularity. The client is built from the agent, whose
//      tool needs the client. Breaking it took a service plus a lazy `Ref`,
//      because the tool cannot close over a value that does not exist yet.
//   3. A report is application input. `SessionInbox.Item.input` is a prompt,
//      so the completion lands in the parent's history as a *user* message —
//      indistinguishable from something the person typed. A real report needs
//      a framework message kind that bypasses `AgentInput`, which is the
//      missing primitive the plan named.
//
// So the composition is real but it is not a dozen lines: it needs a service,
// a lazy binding, two clients, an inbox and an application scope. That is the
// caller's evidence, and it names exactly what the battery would remove.
// ---------------------------------------------------------------------------
