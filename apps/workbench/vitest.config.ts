import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * `affe-agent` resolves to `dist` through `package.json#exports`, which is
 * whatever was last built. The workbench is tested against source instead,
 * through the same subpath map the root tsconfig gives the typechecker -- so
 * a path the package does not publish fails here as it would for a user.
 */
const root = fileURLToPath(new URL("../../", import.meta.url))
const tsconfig = readFileSync(`${root}tsconfig.json`, "utf8")
const paths = /"paths":\s*(\{[^}]*\})/.exec(tsconfig)?.[1]
if (paths === undefined) throw new Error("tsconfig.json has no paths map")
const mapped: Record<string, ReadonlyArray<string>> = JSON.parse(paths.replace(/\/\/.*$/gm, ""))

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    maxWorkers: 4,
    alias: Object.entries(mapped).map(([name, [target]]) => ({
      find: new RegExp(`^${name.replace(/[/-]/g, "\\$&")}$`),
      replacement: `${root}${target}`
    }))
  }
})
