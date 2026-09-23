import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import { affeAgentAliases } from "./aliases.ts"
import { proxiedPrefixes } from "./devProxy.ts"

/**
 * The plain page, and the assistant-ui one beside it (`assistant-ui.html`),
 * with every server route prefix proxied (`devProxy.ts`).
 */

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: affeAgentAliases },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        "assistant-ui": fileURLToPath(new URL("assistant-ui.html", import.meta.url))
      }
    }
  },
  server: {
    proxy: Object.fromEntries(
      proxiedPrefixes.map((path) => [path, "http://localhost:8787"])
    )
  }
})
