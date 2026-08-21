import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { z } from "zod/v4"

const lifecycleDirectory = process.argv[2]
if (lifecycleDirectory === undefined) {
  throw new Error("Expected a lifecycle directory argument")
}

const lifecyclePath = join(lifecycleDirectory, `${process.pid}.log`)
const record = (event) => appendFileSync(lifecyclePath, `${event}\n`)
let used = false

record("started")

const makeServer = ({ era }) => {
  record(`era:${era}`)
  const server = new McpServer(
    { name: "v2-stdio-fixture", version: "2.0.0" },
    { capabilities: { tools: {} } }
  )
  server.registerTool(
    "echo",
    {
      description: "Echo a value through a v2 stdio server",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ value: z.string() })
    },
    ({ value }) => {
      used = true
      return Promise.resolve({
        content: [{ type: "text", text: value }],
        structuredContent: { value }
      })
    }
  )
  server.registerTool(
    "refuse",
    { inputSchema: z.object({}) },
    () => {
      used = true
      return Promise.resolve({
        isError: true,
        content: [{ type: "text", text: "v2 stdio refused" }]
      })
    }
  )
  server.registerTool(
    "slow",
    { inputSchema: z.object({}) },
    (_args, context) => new Promise((resolve) => {
      used = true
      record("slow:started")
      const onAbort = () => {
        record("slow:cancelled")
        resolve({
          isError: true,
          content: [{ type: "text", text: "slow stdio call cancelled" }]
        })
      }
      if (context.mcpReq.signal.aborted) onAbort()
      else context.mcpReq.signal.addEventListener("abort", onAbort, { once: true })
    })
  )
  return server
}

const handle = serveStdio(makeServer)

let closing = false
const close = () => {
  if (closing) return
  closing = true
  record("terminating")
  process.exit(0)
}

process.once("SIGTERM", close)
process.once("SIGINT", close)
process.once("exit", () => record(used ? "session:exited" : "exited"))
