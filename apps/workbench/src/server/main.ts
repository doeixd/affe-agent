/**
 * `npm run workbench:server`: the agent the W0 page talks to, on :8787
 * (`WORKBENCH_PORT` to change it). Run `npm run workbench:dev` beside it.
 */
import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { serve } from "./app.js"

NodeRuntime.runMain(
  Effect.gen(function*() {
    const port = yield* Config.int("WORKBENCH_PORT").pipe(Config.withDefault(8787))
    return yield* Layer.launch(serve(port))
  })
)
