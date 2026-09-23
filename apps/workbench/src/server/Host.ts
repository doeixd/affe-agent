/**
 * The server's session host tag, in one place: `app.ts` builds it,
 * `AgentHttp` serves it, and the server's own callers -- the followers and
 * the task runner's attempts -- go through it, never around it, so every
 * session the server runs emits host events.
 */
import { AgentSessionHost } from "affe-agent/client"
import type { UserId } from "../domain/WorkbenchIds.js"

export const Host = AgentSessionHost.Tag<UserId>("workbench/server")
