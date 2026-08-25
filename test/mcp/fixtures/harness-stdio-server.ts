import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Ref, Stream } from "effect"
import { McpProtocol, McpServer, Prompt } from "effect/unstable/ai"
import { AgentClient, AgentProtocol } from "../../../src/client/index.js"
import { AgentMcp } from "../../../src/mcp/index.js"

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
          yield* Effect.sync(() => record(`opened:${id}`))
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => record(`released:${id}`))
          )
          return {
            id,
            prompt: (input) =>
              Effect.gen(function* () {
                const text = typeof input === "string" ? input : "non-text"
                const count = yield* Ref.updateAndGet(
                  promptCount,
                  (current) => current + 1
                )
                yield* Effect.sync(() => record(`call:${id}:${count}:${text}`))
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
                  text: `${id}:${count}:${text}`
                }
              }),
            steer: () => Effect.void,
            followUp: () => Effect.void,
            interrupt: () => Effect.void,
            respond: () => Effect.succeed(false),
            pending: Effect.succeed([]),
            history: Effect.succeed(Prompt.make([])),
            status: Effect.succeed("idle"),
            events: () => Stream.empty
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

const server = AgentMcp.layer.pipe(
  Layer.provide(transport),
  Layer.provide(client),
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
