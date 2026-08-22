import { DurableStreamTestServer } from "@durable-streams/server"
import { assert, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { DurableStreams } from "../src/durable-streams/index.js"
/**
 * A reader slower than the network loses nothing: the wrapper's queue is
 * unbounded, and a bounded one would silently drop past its capacity.
 */
it.live("a slow reader receives every record of a large burst", () => Effect.gen(function* () {
  const instance = new DurableStreamTestServer({ port: 0 })
  const url = yield* Effect.promise(() => instance.start())
  const stream = DurableStreams.make({ url: `${url}/streams/bp`, schema: Schema.Struct({ n: Schema.Number }) })
  yield* stream.ensure
  for (let n = 1; n <= 200; n++) yield* stream.append({ n })
  const slow = yield* Stream.runCollect(stream.read({ live: false }).pipe(Stream.mapEffect((r) => Effect.delay(Effect.succeed(r.value.n), "2 millis"))))
  assert.strictEqual(slow.length, 200)
  yield* Effect.promise(() => instance.stop())
}), 30_000)
