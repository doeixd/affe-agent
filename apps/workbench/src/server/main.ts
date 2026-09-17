/**
 * `npm run workbench:server`: the agent and the product database the page
 * talks to, on :8787 (`WORKBENCH_PORT`), with conversations kept in
 * `.workbench/workbench.db` (`WORKBENCH_DB`). People are bearer tokens,
 * `WORKBENCH_TOKENS=token=user,...`, defaulting to the single local person
 * `local=local`. Run `npm run workbench:dev` beside it.
 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { serve } from "./app.js"
import { tokensFromConfig } from "./Authentication.js"

NodeRuntime.runMain(
  Effect.gen(function*() {
    const port = yield* Config.Int("WORKBENCH_PORT").pipe(Config.withDefault(8787))
    const database = yield* Config.String("WORKBENCH_DB").pipe(Config.withDefault(".workbench/workbench.db"))
    yield* Effect.sync(() => mkdirSync(dirname(database), { recursive: true }))
    return yield* Layer.launch(serve({ port, database }).pipe(Layer.provide(tokensFromConfig)))
  })
)
