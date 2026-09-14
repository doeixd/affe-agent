import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import { affeAgentAliases } from "./aliases.ts"

/**
 * The plain W0 page. `npm run workbench:server` serves the agent over
 * `AgentHttp` on :8787; this dev server proxies its `/sessions` routes so the
 * page and the API share an origin and need no CORS.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: affeAgentAliases },
  server: { proxy: { "/sessions": "http://localhost:8787" } }
})
