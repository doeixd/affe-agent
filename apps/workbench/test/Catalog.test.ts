/**
 * The catalog over the server: a signed-in browser reads what the deployment
 * binds, and nobody else reads anything.
 */
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Catalog from "../src/runtime/Catalog.js"
import { tokens } from "../src/server/Authentication.js"
import { serve } from "../src/server/app.js"
import * as HttpStores from "../src/store/http.js"

const port = 8785

const read = (token: string) =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(
      HttpStores.catalog({ baseUrl: `http://localhost:${port}`, token }).pipe(Layer.provideMerge(FetchHttpClient.layer))
    )
    return yield* Context.get(context, Catalog.Catalog)
  }))

describe("catalog over the server", () => {
  it.live("names the deployment's bindings for a signed-in browser, and nothing for a stranger", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* Layer.build(serve({ port, database: ":memory:" }).pipe(Layer.provide(tokens({ "ada-token": "ada" }))))
      assert.deepStrictEqual(yield* read("ada-token"), {
        models: ["scripted"],
        capabilities: ["build", "deleteEverything"],
        skills: []
      })
      assert.strictEqual((yield* Effect.flip(read("not-a-token")))._tag, "WorkbenchStorageError")
    })), 30_000)
})
