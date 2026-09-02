import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Deferred, Effect, Layer, Option, PubSub, Ref, Stream } from "effect"
import { McpProtocol, McpServer, Prompt } from "effect/unstable/ai"
import * as AgentEvent from "../../../src/AgentEvent.js"
import * as Elicitation from "../../../src/Elicitation.js"
import { AgentClient, AgentProtocol } from "../../../src/client/index.js"
import { AgentSessionHost } from "../../../src/client/index.js"
import { AgentMcp } from "../../../src/mcp/index.js"
import { TestLanguageModel } from "../../../src/testing/index.js"
import { promptOf } from "../../helpers.js"

const lifecycleDirectory = process.argv[2]
if (lifecycleDirectory === undefined) {
  throw new Error("Expected a lifecycle directory argument")
}

const lifecyclePath = join(lifecycleDirectory, `${process.pid}.log`)
const record = (event: string) => appendFileSync(lifecyclePath, `${event}\n`)

const client = Layer.effect(
  AgentClient.AgentClient,
  Effect.gen(function* () {
    const anonymousCounter = yield* Ref.make(0)
    return AgentClient.AgentClient.of({
      createSession: (options) =>
        Effect.gen(function* () {
          const id = options?.sessionId ?? (yield* Ref.modify(
            anonymousCounter,
            (count): readonly [string, number] => [`anonymous-${count + 1}`, count + 1]
          ))
          const promptCount = yield* Ref.make(0)
          const pending = yield* Ref.make<ReadonlyArray<Elicitation.Request>>([])
          const waiting = yield* Ref.make(Option.none<{
            readonly id: string
            readonly deferred: Deferred.Deferred<Elicitation.Response>
          }>())
          const running = yield* Ref.make(false)
          const events = yield* PubSub.unbounded<AgentEvent.AgentEventEnvelope>()
          yield* Effect.sync(() => record(`opened:${id}`))
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => record(`released:${id}`)).pipe(
              Effect.ensuring(PubSub.shutdown(events))
            )
          )
          return {
            id,
            prompt: (input) =>
              Effect.gen(function* () {
                const texts = TestLanguageModel.userTexts(promptOf(input))
                const text = texts[texts.length - 1] ?? "non-text"
                const count = yield* Ref.updateAndGet(
                  promptCount,
                  (current) => current + 1
                )
                yield* Effect.sync(() => record(`call:${id}:${count}:${text}`))
                if (text === "approval") {
                  const request: Elicitation.Request = {
                    id: `${id}-approval-${count}`,
                    kind: "tool-approval",
                    detail: {
                      toolName: "dangerous",
                      toolCallId: `danger-${count}`,
                      action: "shell",
                      resource: "deploy production"
                    }
                  }
                  const deferred = yield* Deferred.make<Elicitation.Response>()
                  yield* Ref.set(pending, [request])
                  yield* Ref.set(waiting, Option.some({
                    id: request.id,
                    deferred
                  }))
                  yield* Ref.set(running, true)
                  yield* PubSub.publish(events, {
                    sessionId: AgentEvent.SessionId.make(id),
                    submissionId: Option.some(
                      AgentEvent.SubmissionId.make(`${id}-submission-${count}`)
                    ),
                    runId: Option.none(),
                    turn: Option.none(),
                    sequence: count,
                    event: {
                      _tag: "ElicitationRequested",
                      id: request.id,
                      kind: request.kind,
                      detail: request.detail
                    }
                  })
                  const answer = yield* Deferred.await(deferred).pipe(
                    Effect.ensuring(
                      Effect.all([
                        Ref.set(pending, []),
                        Ref.set(waiting, Option.none()),
                        Ref.set(running, false)
                      ], { discard: true })
                    )
                  )
                  if (!answer.granted) {
                    return yield* new AgentClient.AgentExecutionError({
                      sessionId: id,
                      tag: "ApprovalDenied",
                      detail: "fixture approval was denied",
                      isDefect: false
                    })
                  }
                  yield* Effect.sync(() => record(`approved:${id}`))
                }
                if (text === "slow") {
                  yield* Effect.sync(() => record("slow:started"))
                  return yield* Effect.never.pipe(
                    Effect.ensuring(
                      Effect.sync(() => record("slow:cancelled"))
                    )
                  )
                }
                if (text === "fail") {
                  return yield* new AgentClient.AgentExecutionError({
                    sessionId: id,
                    tag: "FixtureFailure",
                    detail: "fixture refused",
                    isDefect: false
                  })
                }
                return {
                  submissionId: AgentProtocol.SubmissionId.make(
                    `${id}-submission-${count}`
                  ),
                  status: "completed",
                  runs: 1,
                  turns: count,
                  text: `${id}:${count}:${text}`,
                  content: []
                }
              }),
            submit: () => Effect.die("submit is not part of this fixture"),
            awaitSubmission: () => Effect.die("awaitSubmission is not part of this fixture"),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            interrupt: () => Effect.void,
            respond: (response) =>
              Effect.gen(function* () {
                const current = yield* Ref.get(waiting)
                if (Option.isNone(current) || current.value.id !== response.id) {
                  return false
                }
                return yield* Deferred.succeed(current.value.deferred, response)
              }),
            pending: Ref.get(pending),
            history: Effect.succeed(Prompt.make([])),
            status: Effect.map(Ref.get(running), (active) =>
              active ? "running" as const : "idle" as const
            ),
            events: () => Stream.fromPubSub(events)
          }
        }),
      session: (id) =>
        Effect.fail(
          new AgentClient.AgentSessionNotFoundError({ sessionId: id })
        )
    })
  })
)

const transport = McpServer.layerStdio({
  name: "effect-harness-stdio-conformance",
  version: "1.0.0",
  protocols: [
    McpProtocol.v2025_11_25,
    McpProtocol.v2025_06_18,
    McpProtocol.v2025_03_26,
    McpProtocol.v2024_11_05
  ]
})

const HarnessHost = AgentSessionHost.Tag<string>(
  "test/McpServerConformance/stdio-host"
)
const host = AgentSessionHost.layer(HarnessHost, {
  principal: { resolve: () => Effect.succeed("stdio") },
  authorization: AgentSessionHost.allowAll(),
  maxSessions: 2,
  maxRequestsPerSession: 16
}).pipe(Layer.provide(client))

const frontend = AgentMcp.serverLayer({ host: HarnessHost }).pipe(Layer.provide(host))

const server = frontend.pipe(
  Layer.provide(transport),
  Layer.provide(NodeServices.layer)
)

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => record("server:released"))
    )
    yield* Effect.sync(() => record("server:started"))
    return yield* Layer.launch(server)
  })
)

NodeRuntime.runMain(program, { disableErrorReporting: false })
