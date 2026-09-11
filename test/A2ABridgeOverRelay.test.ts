import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"
import { Agent, AgentLoop } from "../src/index.js"
import { AgentA2A, ClaudeCodeA2A } from "../src/a2a/index.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import { Relay, RelayClient, RelayProtocol, RelayRpc, RelayServer } from "../src/relay/index.js"
import { AgentRpc } from "../src/rpc/index.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Item 114 (`plan-a2a-layers-bridges.txt` step 5): a coding CLI on a machine
 * behind NAT, driven from somewhere else, through the relay.
 *
 * Nothing new was needed, which is the finding. The desktop runs an agent
 * whose tool is the Claude Code bridge (`AgentA2A.tool` over
 * `ClaudeCodeA2A.remote`) and serves it over the relay with `AgentRpc`; the
 * VPS prompts it through `RelayRpc.clientProtocol`. Local or remote is the
 * transport the caller picks. The CLI is scripted, as in
 * `ClaudeCodeA2A.test.ts`: the bridge reaches it through
 * `Sandbox.execStream`, so a scripted provider is the CLI as far as the
 * bridge can tell.
 *
 * What it does not add: the bridge's own `RemoteAgent` surface -- tasks,
 * cancel -- is not carried across the relay directly; the caller delegates
 * to an agent that holds the bridge. Reopens if a caller needs that surface.
 */

const peer = (id: string) => Relay.PeerId.make(id)
const DESKTOP = peer("desktop")
const VPS = peer("vps")
const tokens = { "desktop-secret": DESKTOP, "vps-secret": VPS }
const AgentEndpoint = RelayRpc.endpoint("affe-agent/agent", AgentRpc.Protocol)

const relay = Effect.gen(function* () {
  const routes = RpcServer.layerHttp({ group: RelayProtocol.Protocol, path: "/relay", protocol: "websocket" }).pipe(
    Layer.provide(RelayServer.layer({ authorization: RelayServer.allowAll })),
    Layer.provide(RelayServer.bearerTokens(tokens)),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 }))
    )
  )
  const { address } = Context.get(services, HttpServer.HttpServer)
  return `${HttpServer.formatAddress(address).replace(/^http/, "ws")}/relay`
})

const node = (url: string, id: Relay.PeerId, token: string) =>
  RelayClient.layer({ peer: id, headers: { authorization: `Bearer ${token}` } }).pipe(
    Layer.provide(Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket().pipe(
        Effect.provide(RpcSerialization.layerNdjson),
        Effect.provideServiceEffect(Socket.Socket, Socket.makeWebSocket(url)),
        Effect.provide(Socket.layerWebSocketConstructorGlobal)
      )
    ))
  )

const encoder = new TextEncoder()
const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" })
const RESULT = (text: string) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: "sess-1" })

describe("an A2A bridge over the relay (item 114)", () => {
  it.live("a caller elsewhere delegates to the CLI behind the desktop's relay connection", () =>
    Effect.gen(function* () {
      const url = yield* relay

      // ---- The desktop: the CLI, the bridge, an agent that uses it --------
      const commands: Array<Sandbox.Command> = []
      const cli: Sandbox.Sandbox["execStream"] = (command) => {
        commands.push(command)
        return Stream.fromArray([
          ...[INIT, RESULT("Fixed the off-by-one in parse().")].map((line) =>
            Sandbox.outputEvent("stdout", encoder.encode(`${line}\n`))),
          Sandbox.exitEvent(0)
        ])
      }
      const sandbox = yield* Effect.provide(Sandbox.acquire(Sandbox.workspace("claude")), MemorySandbox.layer({ execStream: cli }))
      const claude = yield* ClaudeCodeA2A.remote(sandbox)
      const coder = Agent.make({
        tools: [
          AgentA2A.tool("claude_coder", {
            description: "Delegate a coding task to Claude Code on this machine.",
            request: Schema.String,
            result: Schema.String,
            agent: claude,
            contextId: "coding"
          })
        ],
        loop: AgentLoop.bounded(3)
      })
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "c1", name: "claude_coder", params: "Fix the parser" }] },
        TestLanguageModel.text("Claude Code fixed it.")
      ])
      const Host = AgentSessionHost.Tag<string>(`test/A2ABridgeOverRelay/${globalThis.crypto.randomUUID()}`)
      const host = AgentSessionHost.layer(Host, {
        authorization: { authorize: () => Effect.void },
        principal: { resolve: ({ headers }) => Effect.succeed(headers[Relay.PEER_HEADER] ?? "unknown") },
        maxSessions: 4,
        maxRequestsPerSession: 16
      }).pipe(Layer.provide(AgentClient.layer(coder).pipe(Layer.provide(model))))
      yield* Layer.build(
        RelayRpc.serve(AgentEndpoint).pipe(
          Layer.provide(AgentRpc.serverLayer({ host: Host }).pipe(Layer.provide(host))),
          Layer.provideMerge(node(url, DESKTOP, "desktop-secret"))
        )
      )

      // ---- The VPS: a caller that knows only the desktop's peer id --------
      const caller = yield* Layer.build(
        AgentRpc.clientLayer.pipe(
          Layer.provide(RelayRpc.clientProtocol({ peer: DESKTOP, endpoint: AgentEndpoint })),
          Layer.provideMerge(node(url, VPS, "vps-secret"))
        )
      )
      const client = yield* Effect.provide(AgentRpc.Client, caller)
      const sessionId = AgentProtocol.SessionId.make("remote-coding")
      const none = { headers: {} }
      yield* client.createSession({ requestId: AgentProtocol.RequestId.make("create"), sessionId }, none)
      const answer = yield* client.prompt(
        { requestId: AgentProtocol.RequestId.make("fix"), sessionId, input: Prompt.make("fix the parser") },
        none
      )

      assert.strictEqual(answer.result.status, "completed")
      assert.strictEqual(answer.result.text, "Claude Code fixed it.")
      // The CLI ran on the desktop, with the task the model delegated -- as
      // `AgentA2A.typed` sends a request: JSON, so a string arrives quoted.
      assert.strictEqual(commands.length, 1)
      assert.include(commands[0]?.args ?? [], JSON.stringify("Fix the parser"))
    }).pipe(Effect.scoped),
    30_000
  )
})
