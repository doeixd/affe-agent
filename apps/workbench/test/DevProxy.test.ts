/**
 * The dev server reaches every route the workbench server serves.
 *
 * `devProxy.ts` (used by `vite.config.ts`) lists the route prefixes to the server; a route whose prefix
 * is missing is one the dev page cannot reach, and nothing else would say so
 * -- sign-in, tasks and the inbox were unreachable under `workbench:dev` for
 * a day that way. Every `WorkbenchApi` path must start with a proxied prefix.
 */
import { assert, describe, it } from "@effect/vitest"
import { WorkbenchApi } from "../src/protocol/WorkbenchApi.js"
import { proxiedPrefixes } from "../devProxy.js"

const pathsOf = (): ReadonlyArray<string> =>
  Object.values(WorkbenchApi.groups).flatMap((group) => Object.values(group.endpoints).map((endpoint) => endpoint.path))

describe("the dev proxy", () => {
  it("covers every product route, and the agent's", () => {
    const paths = pathsOf()
    // The walk sees the routes: a vacuous list would pass anything.
    assert.isAbove(paths.length, 20)
    const unreachable = paths.filter((path) =>
      !proxiedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    )
    assert.deepStrictEqual(unreachable, [])
    // AgentHttp serves everything under /sessions.
    assert.include(proxiedPrefixes, "/sessions")
  })
})
