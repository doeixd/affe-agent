import { defineConfig } from "vitest/config"
import { affeAgentAliases } from "./aliases.ts"

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    maxWorkers: 4,
    alias: affeAgentAliases
  }
})
