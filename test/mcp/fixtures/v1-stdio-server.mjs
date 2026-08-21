import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js"

const lifecycleDirectory = process.argv[2]
if (lifecycleDirectory === undefined) {
  throw new Error("Expected a lifecycle directory argument")
}

const lifecyclePath = join(lifecycleDirectory, `${process.pid}.log`)
const record = (event) => appendFileSync(lifecyclePath, `${event}\n`)
let used = false

record("started")
record("era:legacy")

const server = new Server(
  { name: "v1-stdio-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "echo",
        description: "Echo a value through a v1 stdio server",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"]
        }
      },
      { name: "refuse", inputSchema: { type: "object" } }
    ]
  })
)

server.setRequestHandler(CallToolRequestSchema, (request) => {
  used = true
  if (request.params.name === "refuse") {
    return Promise.resolve({
      isError: true,
      content: [{ type: "text", text: "v1 stdio refused" }]
    })
  }
  return Promise.resolve({
    content: [{
      type: "text",
      text: String(request.params.arguments?.value)
    }]
  })
})

const transport = new StdioServerTransport()
await server.connect(transport)
record("connected")

let closing = false
const close = () => {
  if (closing) return
  closing = true
  server.close().finally(() => process.exit(0))
}

process.once("SIGTERM", close)
process.once("SIGINT", close)
process.once("exit", () => record(used ? "session:exited" : "exited"))
