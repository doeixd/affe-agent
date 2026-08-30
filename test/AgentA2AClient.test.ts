import {
  AgentCard as AgentCardCodec,
  formatSSEEvent,
  Role,
  TaskState,
  AGENT_CARD_PATH,
  type AgentCard,
  type Message
} from "@a2a-js/sdk"
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema, Stream } from "effect"
import { createServer, type Server } from "node:http"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentA2A } from "../src/a2a/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

const textPart = (text: string): Message["parts"][number] => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain"
})

const userMessage = (text: string): Message => ({
  messageId: `client-${Math.random().toString(36).slice(2)}`,
  contextId: "",
  taskId: "",
  role: Role.ROLE_USER,
  parts: [textPart(text)],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: []
})

const peerCard = (url: string): AgentCard => ({
  name: "Official SDK echo peer",
  description: "An official-SDK executor served for reverse conformance",
  supportedInterfaces: [{
    url,
    protocolBinding: "JSONRPC",
    tenant: "",
    protocolVersion: "1.0"
  }],
  provider: undefined,
  version: "1.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{
    id: "echo",
    name: "Echo",
    description: "Echoes a typed request",
    tags: ["echo"],
    examples: [],
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    securityRequirements: []
  }],
  signatures: []
})

interface PeerOptions {
  /** When set, execute blocks forever, so only cancelTask can finish it. */
  readonly hangUntilCanceled?: boolean
}

type Publish = (event: unknown) => void

/**
 * An executor implemented entirely with official SDK types — the reverse of
 * the adapter under test, which is what reverse conformance needs.
 */
const plainExecutor = (options: PeerOptions): {
  readonly executor: AgentExecutor
  readonly started: Promise<void>
} => {
  let signalStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const publishStatus = (
    publish: Publish,
    requestContext: RequestContext,
    state: TaskState
  ) =>
    publish({
      kind: "statusUpdate",
      data: {
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        status: {
          state,
          message: undefined,
          timestamp: new Date().toISOString()
        },
        metadata: undefined
      }
    })

  return {
    started,
    executor: {
      execute: async (
        requestContext: RequestContext,
        eventBus: ExecutionEventBus
      ) => {
        const publish = (event: unknown) =>
          eventBus.publish(event as never)
        publish({
          kind: "task",
          data: {
            id: requestContext.taskId,
            contextId: requestContext.contextId,
            status: {
              state: TaskState.TASK_STATE_SUBMITTED,
              message: undefined,
              timestamp: new Date().toISOString()
            },
            artifacts: [],
            history: [requestContext.userMessage],
            metadata: undefined
          }
        })
        publishStatus(publish, requestContext, TaskState.TASK_STATE_WORKING)
        signalStarted?.()

        if (options.hangUntilCanceled === true) {
          await new Promise<void>(() => {
            // Only cancelTask ends this.
          })
          return
        }

        const part = requestContext.userMessage.parts[0]?.content
        const text = part?.$case === "text" ? part.value : ""
        let prompt = ""
        try {
          const parsed = JSON.parse(text) as { prompt?: unknown }
          prompt = String(parsed.prompt ?? "")
        } catch {
          prompt = text
        }
        publish({
          kind: "artifactUpdate",
          data: {
            taskId: requestContext.taskId,
            contextId: requestContext.contextId,
            artifact: {
              artifactId: `${requestContext.taskId}:result`,
              name: "Reply",
              description: undefined,
              parts: [textPart(JSON.stringify({ reply: `echo:${prompt}` }))],
              metadata: undefined,
              extensions: []
            },
            append: false,
            lastChunk: true,
            metadata: undefined
          }
        })
        publishStatus(publish, requestContext, TaskState.TASK_STATE_COMPLETED)
      },
      cancelTask: async (
        taskId: string,
        eventBus: ExecutionEventBus
      ) => {
        eventBus.publish({
          kind: "statusUpdate",
          data: {
            taskId,
            contextId: "",
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              message: undefined,
              timestamp: new Date().toISOString()
            },
            metadata: undefined
          }
        } as never)
      }
    } satisfies AgentExecutor
  }
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value

const servePeer = Effect.fn("AgentA2AClient.test.servePeer")(function* (
  options: PeerOptions
) {
  const { executor } = plainExecutor(options)
  // The card is built after binding: the official client routes every
  // subsequent call to the interface URL advertised by the card.
  let handle: ((body: Record<string, unknown>) => Promise<unknown>) | undefined

  const nodeServer: Server = createServer((request, response) => {
    void (async () => {
      if (
        request.method === "GET" &&
        (request.url ?? "").includes(AGENT_CARD_PATH)
      ) {
        const address = nodeServer.address()
        const port = address !== null && typeof address !== "string"
          ? address.port
          : 0
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(AgentCardCodec.toJSON(
          peerCard(`http://127.0.0.1:${port}`)
        )))
        return
      }
      const chunks: Array<Buffer> = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = JSON.parse(
        Buffer.concat(chunks).toString("utf8")
      ) as Record<string, unknown>
      if (handle === undefined) {
        response.writeHead(503, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "peer not ready" }))
        return
      }
      const result = await handle(body)
      if (isAsyncIterable(result)) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache"
        })
        for await (const event of result) {
          response.write(formatSSEEvent(event))
        }
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(result))
    })().catch((cause) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" })
      }
      response.end(JSON.stringify({ error: String(cause) }))
    })
  })

  yield* Effect.callback((resume) => {
    nodeServer.once("listening", () => resume(Effect.succeed(nodeServer)))
    nodeServer.listen(0)
  })

  yield* Effect.addFinalizer(() =>
    Effect.promise(() =>
      new Promise<void>((resolve, reject) =>
        nodeServer.close((cause) =>
          cause === undefined ? resolve() : reject(cause)
        )
      )
    )
  )

  const address = nodeServer.address()
  if (address === null || typeof address === "string") {
    return yield* Effect.die(new Error("peer server has no port"))
  }
  const url = `http://127.0.0.1:${address.port}`
  const handler = new JsonRpcTransportHandler(
    new DefaultRequestHandler(
      peerCard(url),
      new InMemoryTaskStore(),
      executor,
      new DefaultExecutionEventBusManager()
    )
  )
  handle = (body) => handler.handle(body, new ServerCallContext())
  return { url }
})

describe("AgentA2A client against an official SDK server", () => {
  it.effect("discovers the card and completes a typed exchange", () =>
    Effect.gen(function* () {
      const peer = yield* servePeer({})
      const agent = yield* AgentA2A.client({ url: peer.url })

      const card = yield* agent.card
      assert.strictEqual(card.name, "Official SDK echo peer")

      const exchange = AgentA2A.typed({
        request: Schema.Struct({ prompt: Schema.String }),
        result: Schema.Struct({ reply: Schema.String })
      })
      const result = yield* exchange.exchange(agent, {
        contextId: "",
        request: { prompt: "hello" }
      })
      assert.strictEqual(result.reply, "echo:hello")
    })
  )

  it.effect("a remote agent is a tool: the exchange with a name, schemas, and a declared failure", () =>
    Effect.gen(function* () {
      const peer = yield* servePeer({})
      const ask = AgentA2A.tool("ask_peer", {
        description: "Ask the echo peer",
        request: Schema.Struct({ prompt: Schema.String }),
        result: Schema.Struct({ reply: Schema.String }),
        agent: { url: peer.url }
      })
      assert.strictEqual(ask.tool.name, "ask_peer")

      // Straight through the handler, as the loop would call it.
      const answered = yield* ask.handler({ prompt: "hello" }, { preliminary: () => Effect.void })
      assert.deepStrictEqual(answered, { reply: "echo:hello" })

      // And through a real run: the model calls the tool, the peer answers.
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("ask_peer", { prompt: "via the loop" }, { id: "call-1" }),
        TestLanguageModel.text("relayed")
      ])
      const result = yield* Agent.run(
        Agent.make({ tools: [ask], loop: AgentLoop.bounded(2) }),
        "ask the peer"
      ).pipe(Effect.provide(layer))
      assert.strictEqual(result.text, "relayed")

      // A peer that is not there is the tool's declared failure, not a defect.
      const missing = AgentA2A.tool("ask_nobody", {
        request: Schema.Struct({ prompt: Schema.String }),
        result: Schema.Struct({ reply: Schema.String }),
        agent: { url: "http://127.0.0.1:1" }
      })
      const failure = yield* Effect.flip(missing.handler({ prompt: "anyone?" }, { preliminary: () => Effect.void }))
      assert.strictEqual(failure._tag, "AgentA2ATransportError")

      // A peer answering off-contract is the peer's fault, named as such:
      // the tool's declared failure, never a bare SchemaError.
      const strict = AgentA2A.tool("ask_strictly", {
        request: Schema.Struct({ prompt: Schema.String }),
        result: Schema.Struct({ answer: Schema.Number }),
        agent: { url: peer.url }
      })
      const offContract = yield* Effect.flip(strict.handler({ prompt: "numbers?" }, { preliminary: () => Effect.void }))
      assert.strictEqual(offContract._tag, "AgentA2ARemoteError")
      if (offContract._tag === "AgentA2ARemoteError") assert.strictEqual(offContract.code, "BAD_RESULT")
    })
  )

  it.effect("streams the official task lifecycle", () =>
    Effect.gen(function* () {
      const peer = yield* servePeer({})
      const agent = yield* AgentA2A.client({ url: peer.url })

      const events = yield* Effect.map(
        Stream.runCollect(agent.stream(userMessage("plain"))),
        (chunk) => Array.from(chunk)
      )
      assert.deepStrictEqual(
        events.map((event) => event.payload?.$case),
        ["task", "statusUpdate", "artifactUpdate", "statusUpdate"]
      )
      const completed = events[3]?.payload
      if (completed?.$case !== "statusUpdate") {
        assert.fail("expected a completed status")
      }
      assert.strictEqual(
        completed.value.status?.state,
        TaskState.TASK_STATE_COMPLETED
      )
    })
  )

  it.effect("maps remote refusals to typed remote errors", () =>
    Effect.gen(function* () {
      const peer = yield* servePeer({})
      const agent = yield* AgentA2A.client({ url: peer.url })

      const missing = yield* Effect.exit(agent.task("no-such-task"))
      if (!Exit.isFailure(missing)) {
        assert.fail("expected task lookup to fail")
      }
      const error = Cause.findErrorOption(missing.cause)
      if (
        error._tag !== "Some" ||
        !(error.value instanceof AgentA2A.AgentA2ARemoteError)
      ) {
        assert.fail("expected a typed remote error")
      }
      assert.include(error.value.detail.toLowerCase(), "not found")
    })
  )
})
