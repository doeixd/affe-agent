import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as Harness from "../src/index.js"

/**
 * PLAN §4 and §42: the exported vocabulary, and its size.
 */
describe("public API", () => {
  it("exports the core vocabulary and nothing beyond it", () => {
    assert.deepStrictEqual(Object.keys(Harness).sort(), [
      "Agent",
      "AgentBusyError",
      "AgentClosedError",
      "AgentEvent",
      "AgentIdleError",
      // The shape a submission is asked in: the mirror of `AgentOutput`,
      // and a noun for the same reason -- it changes `prompt`'s parameter.
      "AgentInput",
      "AgentLoop",
      // The shape a submission is asked to end in. A first-class noun because
      // it changes an agent's *type* -- `Result.value` is `Option<never>`
      // without one -- which no helper on another module could express.
      "AgentOutput",
      "AgentRun",
      "AgentSession",
      "AgentSubmission",
      // Raised by awaitSubmission for a submission the session does not hold.
      "AgentSubmissionNotFoundError",
      "ContextTransform",
      "Elicitation",
      "InputChannel",
      "Permission",
      // The caller's subject on the fibre that acts: a Context.Reference the
      // host sets per request, None outside any host. Decided in
      // docs/plan-principal-on-tool-fibre.md; deliberately not a kernel noun.
      "Principal",
      // The same prompt codec is used by every JSON and durable boundary. It
      // is public so custom JobStore and transport implementations do not
      // invent a subtly incompatible file-data representation.
      "PromptWire",
      // The vocabulary for a failing store, public because a caller has to be
      // able to catch it and to recognise one that crossed a journal.
      // `detailOf`, which fills in its `detail`, is deliberately internal.
      "StorageError",
      "ToolApprovalRequiredError",
      "ToolExecution",
      "ToolPermissionDeniedError",
      "isStorageError"
    ])
  })

  it("exports the principal reference and nothing beyond it", () => {
    assert.deepStrictEqual(Object.keys(Harness.Principal).sort(), [
      "CurrentPrincipal"
    ])
  })

  it("keeps the convenience surface small and named for its use", () => {
    // Sugar is allowed to exist only where it removes real, repeated friction:
    // `Agent.toolkit` makes a silent footgun unrepresentable, `AgentLoop.bounded`
    // is the loop nearly every agent wants, the system-message transforms are
    // the canonical dynamic-instruction case, and `AgentEvent.match` replaces a
    // hand-written switch that silently stops covering new events. The
    // authoring combinators (issue #11) are pure functions over the one
    // `AgentDefinition` representation: each `withX` replaces, each
    // `updateX` combines, `tool` pairs a tool with its handler, and `run`
    // is the scoped one-shot prompt.
    assert.deepStrictEqual(Object.keys(Harness.Agent).sort(), [
      "make",
      "run",
      "tool",
      "toolkit",
      "updateContextTransform",
      "updateLoop",
      "withContextTransform",
      // Provider fallback. A combinator rather than a `Config` field because it
      // changes the signature -- a planned agent no longer needs a
      // `LanguageModel` from its environment.
      "withExecutionPlan",
      // The typed-input mirror of `output`: the one combinator that replaces
      // the agent's `Input` slot rather than threading it.
      "withInput",
      "withInstructions",
      "withLoop",
      "withPermission",
      "withTool",
      "withToolDenialPolicy",
      "withToolExecution",
      "withToolFailurePolicy",
      "withToolkit",
      "withTools"
    ])
    assert.isTrue(typeof Harness.AgentEvent.match === "function")
    assert.deepStrictEqual(Object.keys(Harness.PromptWire).sort(), [
      "Message",
      "Part",
      "Prompt"
    ])
    // The permission vocabulary (#9): decisions, requests, projections, the
    // policy seam and a few trivial interpreters. No DSL, no UI, no store.
    assert.deepStrictEqual(Object.keys(Harness.Permission).sort(), [
      "ApprovalDetail",
      "ApprovalValue",
      "Decision",
      "ProjectionKey",
      "all",
      "allow",
      "allowAll",
      "annotate",
      "ask",
      "askAll",
      "combine",
      "defaultProjection",
      "deny",
      "denyAll",
      "except",
      "grantKey",
      "make",
      "projectionOf",
      "remembered",
      "rules"
    ])
  })

  it("exposes the operations §42 targets", () => {
    assert.deepStrictEqual(
      Object.keys(Harness.AgentSession).sort(),
      [
        "Id",
        "Snapshot",
        // Join a submitted run, or the most recently settled one; see
        // docs/plan-submit-await.md for what is retained where.
        "awaitSubmission",
        "events",
        "followUp",
        "history",
        "interrupt",
        "make",
        "observe",
        "pending",
        "prompt",
        "respond",
        "restore",
        "snapshot",
        "state",
        "status",
        "steer",
        // Admit without awaiting; the child fiber owns terminal events and
        // release, so a caller that stops observing cannot abandon cleanup.
        "submit",
        "subscribe"
      ]
    )
    // The public/SPI boundary (design-assessment rec 2): what an engine
    // needs -- `makeEngine` with `EngineOptions`, `ToolExecution.execute` --
    // is reachable by module path and absent from the package's namespaces.
    assert.notProperty(Harness.AgentSession, "makeEngine")
    assert.deepStrictEqual(Object.keys(Harness.ToolExecution).sort(), [
      "FailRun",
      "Parallel",
      "ReturnToModel",
      "Sequential",
      "concurrency",
      "decide",
      "intrinsicApproval",
      "perTool"
    ])
    assert.deepStrictEqual(Object.keys(Harness.AgentLoop).sort(), [
      "Continue",
      "Final",
      "Stop",
      "and",
      "bounded",
      "final",
      "limits",
      "make",
      "maxDuration",
      "maxToolCalls",
      "maxTurns",
      "or",
      "stop",
      "untilIdle",
      "withFinalTurn"
    ])
    assert.deepStrictEqual(Object.keys(Harness.ContextTransform).sort(), [
      "appendSystem",
      "cacheBreakpoint",
      "compose",
      "identity",
      "instructions",
      "make",
      "prependSystem"
    ])
  })

  it.effect("namespaced ids are usable as Schemas", () =>
    Effect.gen(function* () {
      // §4: AgentSession.Id, AgentSubmission.Id, AgentRun.Id
      const session = yield* Schema.decodeEffect(Harness.AgentSession.Id)(
        "session-1"
      )
      const submission = yield* Schema.decodeEffect(Harness.AgentSubmission.Id)(
        "submission-1"
      )
      const run = yield* Schema.decodeEffect(Harness.AgentRun.Id)("run-1")
      assert.strictEqual(`${session}/${submission}/${run}`, "session-1/submission-1/run-1")
    })
  )
})

describe("durable and cluster surfaces", () => {
  it("exports the durable vocabulary and nothing beyond it", async () => {
    const durable = await import("../src/durable/index.js")
    // Guards against a helper leaking out by accident, and against one being
    // dropped: both are breaking for a published package.
    assert.deepStrictEqual(Object.keys(durable).sort(), [
      "DeliveryLog",
      "DurableAgent",
      "DurableAgentClient",
      "DurableChannels",
      "DurableElicitation",
      "DurableModel",
      "DurablePermission",
      "DurablePolling",
      "DurableSessionStore",
      "DurableSubmission",
      "DurableToolkit"
    ])
  })

  it("exports the cluster vocabulary and nothing beyond it", async () => {
    const cluster = await import("../src/cluster/index.js")
    assert.deepStrictEqual(Object.keys(cluster).sort(), [
      "AgentEntity",
      "EntityClient",
      "ScheduledAgent"
    ])
  })

  it("keeps the durable entry points a deployment needs", async () => {
    const { DurableAgent, DurableChannels } = await import(
      "../src/durable/index.js"
    )
    // Named individually because these are what the README documents; a rename
    // is a breaking change and should read as one here.
    for (const name of [
      "workflow",
      "submit",
      "steer",
      "followUp",
      "result",
      "executionIdFor",
      "open",
      "DurableAgentFailure"
    ]) {
      assert.property(DurableAgent, name)
    }
    for (const name of ["memoryStore", "sqlStore", "sqlStoreWithTable"]) {
      assert.property(DurableChannels, name)
    }
  })

  it("exports the testing vocabulary and nothing beyond it", async () => {
    const testing = await import("../src/testing/index.js")
    assert.deepStrictEqual(Object.keys(testing).sort(), [
      "AgentClientConformance",
      "AgentProbe",
      "ChannelConformance",
      "DeliveryLogConformance",
      "DurableSessionStoreConformance",
      "NodeStoreConformance",
      "SandboxConformance",
      "SessionDirectoryConformance",
      "TestLanguageModel",
      "TestWebCapture",
      "TestWebCrawl",
      "TestWebFetch",
      "TestWebSearch"
    ])
  })

  it("exports the compaction vocabulary and nothing beyond it", async () => {
    const compaction = await import("../src/compaction/index.js")
    assert.deepStrictEqual(Object.keys(compaction).sort(), ["Compaction"])
    assert.deepStrictEqual(Object.keys(compaction.Compaction).sort(), [
      "Checkpoint",
      "CompactionCannotHelpError",
      "CompactionCompleted",
      "CompactionEvent",
      "CompactionFailed",
      "CompactionStarted",
      "SummaryResult",
      "Trigger",
      "continuationSummary",
      "controller",
      "estimate",
      "make",
      "model",
      "serialize",
      "tokens",
      "whenLongerThan"
    ])
  })

  it("exports the presets vocabulary and nothing beyond it", async () => {
    const presets = await import("../src/presets/index.js")
    assert.deepStrictEqual(Object.keys(presets).sort(), ["Presets"])
    // Two presets, each with a caller in `examples/`. A chat preset is
    // deliberately absent until one has callers: see the module docs.
    assert.deepStrictEqual(Object.keys(presets.Presets).sort(), [
      "coding",
      "codingPolicy",
      "gateway"
    ])
  })

  it("exports the code vocabulary and nothing beyond it", async () => {
    const code = await import("../src/code/index.js")
    assert.deepStrictEqual(Object.keys(code).sort(), [
      "Catalog",
      "CodeMode",
      "CodeTool"
    ])
    assert.deepStrictEqual(Object.keys(code.CodeTool).sort(), [
      "Result",
      // The search tool and its result schema (executors plan step 2):
      // `Catalog.search` reachable by the model, not only by the host.
      "SearchResult",
      "catalogOf",
      "searchTool",
      "tool"
    ])
    assert.deepStrictEqual(Object.keys(code.CodeMode).sort(), [
      "interpreted",
      "make"
    ])
    assert.deepStrictEqual(Object.keys(code.Catalog).sort(), [
      "catalog",
      "entries",
      "estimateTokens",
      "pathOf",
      "search",
      "signatureOf"
    ])
  })

  it("exports the blob vocabulary and nothing beyond it", async () => {
    const blob = await import("../src/blob/index.js")
    assert.deepStrictEqual(Object.keys(blob).sort(), ["BlobStore", "BlobWire"])

    assert.deepStrictEqual(Object.keys(blob.BlobStore).sort(), [
      "BlobId",
      "BlobMissingError",
      "BlobRef",
      "BlobRejectedError",
      "BlobStore",
      "BlobStoreError",
      "describe",
      "getBytes",
      "layerMemory",
      "memory",
      "putBytes",
      "sha256",
      "withPolicy"
    ])

    assert.deepStrictEqual(Object.keys(blob.BlobWire).sort(), [
      "externalize",
      "references",
      "resolve"
    ])
  })

  it("exports the tree vocabulary and nothing beyond it", async () => {
    const tree = await import("../src/tree/index.js")
    assert.deepStrictEqual(Object.keys(tree).sort(), [
      "BranchSummary",
      "NodeStore",
      "SessionTree",
      "TreeExport"
    ])

    // Branch carryover: one operation and the refusal it can answer with.
    assert.deepStrictEqual(Object.keys(tree.BranchSummary).sort(), [
      "NothingToCarry",
      "branch"
    ])

    // The store is a seam, so what it offers is part of the contract: two
    // implementations and the vocabulary to write a third.
    assert.deepStrictEqual(Object.keys(tree.NodeStore).sort(), [
      "Node",
      "NodeCause",
      "NodeId",
      "StoreError",
      "keyValue",
      "memory"
    ])

    assert.deepStrictEqual(Object.keys(tree.SessionTree).sort(), [
      "Node",
      "NodeCause",
      "NodeId",
      "NodeMissing",
      "SessionBusy",
      "SessionClosed",
      "StoreError",
      // A traversal walks a store the caller may have supplied, so "this is
      // not a tree" is an answer callers have to be able to name.
      "TreeCorrupt",
      "make"
    ])
  })

  it("exports the export vocabulary and nothing beyond it", async () => {
    const exported = await import("../src/export/index.js")
    assert.deepStrictEqual(Object.keys(exported).sort(), ["Export", "Replay"])

    assert.deepStrictEqual(Object.keys(exported.Export).sort(), [
      "Export",
      "ExportError",
      "Header",
      // The floor is public because it is the promise: a reader can ask what
      // this build still opens, not only what it writes.
      "MINIMUM_READABLE_VERSION",
      "Provenance",
      "VERSION",
      "append",
      "decode",
      "encode",
      "encodeJsonl",
      "headerOf",
      "historyOf",
      "missingTools",
      "of",
      "ofSession",
      "parse",
      "parseJsonl",
      // The recovering read is separate from `parseJsonl` so a caller that
      // wants to know a tail was dropped can, without every caller having to.
      "parseJsonlRecovering"
    ])

    assert.deepStrictEqual(Object.keys(exported.Replay).sort(), [
      "promptsOf",
      "seedOf",
      "toolsUsed",
      "turnsOf",
      "unavailable"
    ])
  })

  it("exports the redaction vocabulary and nothing beyond it", async () => {
    const redaction = await import("../src/redaction/index.js")
    assert.deepStrictEqual(Object.keys(redaction).sort(), ["Redaction"])

    // Two matchers, and the surface says so. A longer list here would be the
    // first step towards looking like a secret scanner.
    assert.deepStrictEqual(Object.keys(redaction.Redaction).sort(), [
      "asHook",
      "asSpanHook",
      "bearerTokens",
      "deep",
      "environmentSecrets",
      "literal",
      "make",
      "none",
      "pattern"
    ])
  })

  it("exports the client vocabulary and nothing beyond it", async () => {
    const client = await import("../src/client/index.js")
    assert.deepStrictEqual(Object.keys(client).sort(), [
      "AgentClient",
      "AgentProtocol",
      "AgentSessionHost"
    ])
    assert.deepStrictEqual(Object.keys(client.AgentSessionHost).sort(), [
      "Tag",
      "allowAll",
      "layer"
    ])
  })

  it("exports the mcp vocabulary and nothing beyond it", async () => {
    const mcp = await import("../src/mcp/index.js")
    assert.deepStrictEqual(Object.keys(mcp).sort(), [
      "AgentMcp",
      "McpClient",
      "McpToolkit"
    ])
    assert.deepStrictEqual(Object.keys(mcp.AgentMcp).sort(), [
      "AskAgent",
      "AwaitAgent",
      "CloseAgent",
      "FollowUpAgent",
      "InterruptAgent",
      "RespondAgent",
      "ServerToolkit",
      "StartAgent",
      "StatusAgent",
      "SteerAgent",
      "ToolFailure",
      // The client-backed `layer` / `handlers` path was removed 2026-08-30;
      // the host path is the one way in.
      "serverLayer"
    ])
    assert.deepStrictEqual(Object.keys(mcp.McpClient).sort(), [
      "stdio",
      "streamableHttp"
    ])
  })

  it("isolates the two official MCP SDK generations by package path", async () => {
    const v1 = await import("../src/mcp/v1/index.js")
    const v2 = await import("../src/mcp/v2/index.js")
    assert.deepStrictEqual(Object.keys(v1).sort(), ["McpClientV1"])
    assert.deepStrictEqual(Object.keys(v1.McpClientV1).sort(), [
      "fromSdkClient",
      "stdio",
      "streamableHttp"
    ])
    assert.deepStrictEqual(Object.keys(v2).sort(), ["McpClientV2"])
    assert.deepStrictEqual(Object.keys(v2.McpClientV2).sort(), [
      "fromSdkClient",
      "stdio",
      "streamableHttp"
    ])
  })

  it("exports the rpc vocabulary and nothing beyond it", async () => {
    const rpc = await import("../src/rpc/index.js")
    assert.deepStrictEqual(Object.keys(rpc).sort(), ["AgentRpc"])
    assert.deepStrictEqual(Object.keys(rpc.AgentRpc).sort(), [
      "Client",
      "Protocol",
      "acquireSession",
      "clientLayer",
      "serverLayer"
    ])
  })

  it("exports the pi vocabulary and nothing beyond it", async () => {
    const pi = await import("../src/pi/index.js")
    assert.deepStrictEqual(Object.keys(pi).sort(), ["PiToolkit"])
    assert.deepStrictEqual(Object.keys(pi.PiToolkit).sort(), [
      "EditFile",
      "GREP_MAX_LINE_LENGTH",
      "LS_LIMIT",
      "ListFiles",
      "MAX_BYTES",
      "MAX_BYTES_LABEL",
      "MAX_LINES",
      "ReadFile",
      "Search",
      "Shell",
      "WriteFile",
      "configure",
      "formatSize",
      "handlers",
      "head",
      "headNotice",
      "lockRegistrySize",
      "tailNotice",
      "toolkit",
      "tools"
    ])
  })

  it("exports the shell vocabulary and nothing beyond it", async () => {
    const shell = await import("../src/shell/index.js")
    assert.deepStrictEqual(Object.keys(shell).sort(), ["Shell"])
    assert.deepStrictEqual(Object.keys(shell.Shell).sort(), [
      "Shell",
      "bash",
      "current",
      "fish",
      "fromKind",
      "layer",
      "make",
      "nushell",
      "powershell",
      "pwsh",
      "sh",
      "zsh"
    ])
  })

  it("exports the http vocabulary and nothing beyond it", async () => {
    const http = await import("../src/http/index.js")
    assert.deepStrictEqual(Object.keys(http).sort(), ["AgentHttp", "AgentServer"])
    assert.deepStrictEqual(Object.keys(http.AgentHttp).sort(), [
      "Api",
      "Client",
      // The typed-client seam: a generated HTTP client wrapped as an ordinary
      // `AgentClient`, so a remote agent is indistinguishable from a local one
      // at the host. `fromGenerated` takes a client you already have;
      // `agentClientLayer` dials a base URL; `agentClientFromServer` binds to a
      // server in the same scope, which is what the contract suite uses.
      "agentClientFromServer",
      "agentClientLayer",
      "api",
      "clientLayer",
      "errorStatus",
      "fromGenerated",
      "serverLayer"
    ])
    assert.deepStrictEqual(Object.keys(http.AgentServer).sort(), [
      "DuplicateMountError",
      // Public alongside `DuplicateMountError` because it is the same kind of
      // construction-time refusal: a mount that cannot safely become a route.
      "InvalidMountNameError",
      // The `/inventory` payload, exported because a caller decoding that
      // endpoint needs the same schema the server encodes with.
      "Inventory",
      "MountSnapshot",
      "make",
      "mount",
      "serverLayer"
    ])
  })

  it("exports the AG-UI vocabulary and nothing beyond it", async () => {
    const agUi = await import("../src/ag-ui/index.js")
    assert.deepStrictEqual(Object.keys(agUi).sort(), ["AgentAgUi"])
    assert.deepStrictEqual(Object.keys(agUi.AgentAgUi).sort(), [
      "AgentAgUiInvalidInputError",
      "AgentAgUiUnsupportedError",
      "Error",
      "Event",
      "InputContent",
      "Message",
      "ResumeEntry",
      "RunAgentInput",
      "UserContent",
      "custom",
      "encodePayload",
      "event",
      "events",
      "initialState",
      "makeEventMapper",
      "project",
      "run",
      "serverLayer",
      "step",
      "text",
      "tool",
      "transition"
    ])
  })

  it("exports the Durable Streams backend: the typed protocol wrapper and the delivery log", async () => {
    const streams = await import("../src/durable-streams/index.js")
    assert.deepStrictEqual(Object.keys(streams).sort(), ["DurableStreams", "DurableStreamsDeliveryLog"])
    assert.deepStrictEqual(Object.keys(streams.DurableStreams).sort(), [
      "DurableStreamError",
      "ErrorCode",
      "Offset",
      "fold",
      "last",
      "make",
      "start"
    ])
    assert.deepStrictEqual(Object.keys(streams.DurableStreamsDeliveryLog).sort(), ["make", "streamFor"])
  })

  it("exports the OpenAI-compatible surface: the server, the pure projection, the wire schemas", async () => {
    const openai = await import("../src/openai/index.js")
    assert.deepStrictEqual(Object.keys(openai).sort(), [
      "OpenAiAgent",
      "OpenAiProjection",
      "OpenAiSchema"
    ])
    assert.deepStrictEqual(Object.keys(openai.OpenAiAgent).sort(), [
      "OpenAiError",
      "fromRemoteError",
      "lastAssistantText",
      "memoryIdempotency",
      "serverLayer",
      "statefulDelta",
      "strictPrompt"
    ])
    assert.deepStrictEqual(Object.keys(openai.OpenAiProjection).sort(), [
      "MESSAGE_SEPARATOR",
      "chunk",
      "error",
      "initialState",
      "project",
      "response",
      "transition"
    ])
  })

  it("exports the A2A v1 server and client vocabulary and nothing beyond it", async () => {
    const a2a = await import("../src/a2a/index.js")
    assert.deepStrictEqual(Object.keys(a2a).sort(), [
      "AgentA2A",
      "ClaudeCodeA2A",
      "ClaudeCodePermissions",
      "OpenCodeA2A"
    ])
    // Both bridges expose the same three things: a constructor, the projection
    // that puts the runtime's tools in this application's vocabulary, and the
    // parser where somebody else's evolving format would break first.
    assert.deepStrictEqual(Object.keys(a2a.OpenCodeA2A).sort(), [
      "PermissionAsked",
      "defaultProjection",
      // One reader per protocol, both exported: they are where somebody else's
      // evolving event vocabulary would break first.
      "readEvent",
      "readEventV2",
      "remote"
    ])
    assert.deepStrictEqual(Object.keys(a2a.ClaudeCodePermissions).sort(), [
      // The CLI flags that point a run at the decision endpoint.
      "args",
      // The decision itself, exported because it is the whole behaviour and
      // needs no server to test.
      "decide",
      "defaultProjection",
      "layer",
      // The published tool, so a caller can serve it on their own server.
      "tool",
      "toolReference"
    ])
    // The bridge's surface is two values: a constructor, and the line parser
    // it is built on -- exported because a caller reading `stream-json` from
    // somewhere else (a log, a recorded run) should not re-derive it.
    assert.deepStrictEqual(Object.keys(a2a.ClaudeCodeA2A).sort(), ["parseLine", "remote"])
    assert.deepStrictEqual(Object.keys(a2a.AgentA2A).sort(), [
      "AgentA2AInvalidInputError",
      "AgentA2ARemoteError",
      "AgentA2ATransportError",
      "AgentA2AUnsupportedContentError",
      "client",
      // Public because the policy it enforces is a deployment decision: an
      // operator has to be able to ask what this server will refuse to call,
      // and to test their `allowHosts` without standing a server up.
      "rejectPushUrl",
      "serverLayer",
      // A remote A2A peer as a BoundTool for Agent.make({ tools }).
      "tool",
      "typed"
    ])
  })

  it("exports the elicitation vocabulary and nothing beyond it", async () => {
    const elicitation = await import("../src/Elicitation.js")
    assert.deepStrictEqual(Object.keys(elicitation).sort(), [
      "Request",
      "Response",
      "denied",
      "elicitValue",
      "memory"
    ])
  })

  it("exports the tool-source vocabulary and nothing beyond it", async () => {
    const toolSource = await import("../src/toolSource/index.js")
    assert.deepStrictEqual(Object.keys(toolSource).sort(), ["Credentials", "GraphQL", "OpenApi", "ToolSource"])
    assert.deepStrictEqual(Object.keys(toolSource.ToolSource).sort(), [
      "ExtractionError",
      "InvocationError",
      "ToolError",
      "ToolSourceMissingError",
      "bind",
      "bindDiscovered",
      "fromMcpConnection"
    ])
    assert.deepStrictEqual(Object.keys(toolSource.OpenApi).sort(), ["extractOpenApi", "makeOpenApiSource"])
    assert.deepStrictEqual(Object.keys(toolSource.GraphQL).sort(), ["extractGraphQL", "makeGraphQLSource"])

    // Credentials: the three layers, the per-principal store, and the
    // stateful-token escape hatch with the question it can raise.
    // `Binding` is type-only, so it is deliberately absent here: the
    // runtime vocabulary is the constructors and the services.
    assert.deepStrictEqual(Object.keys(toolSource.Credentials).sort(), [
      "Bindings",
      "CredentialError",
      "Method",
      "Placement",
      "Provider",
      "ReauthDetail",
      "bearer",
      "binding",
      "bindings",
      "fromConfig",
      "fromRefreshing",
      "fromValues",
      "header",
      "headers",
      "headersFor",
      "methodFromOpenApi",
      "none",
      "query",
      "readOnly",
      "render",
      "requiredVariables",
      "resolve",
      "resolveFor",
      "withReauth"
    ])
  })
})
