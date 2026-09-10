import { Config, Effect, Layer, Option } from "effect"
import { WorkerConfig } from "effect-cf"
import { Agent, AgentLoop } from "affe-agent"
import { AgentSessionHost } from "affe-agent/client"
import * as CloudflareHost from "affe-agent/cloudflare"
import { TestLanguageModel } from "affe-agent/testing"
import * as Failpoint from "../../src/internal/failpoint.js"

/**
 * The Worker entry `test/WorkerDispatchIntents.test.ts` bundles: the host as
 * shipped, a scripted model that answers every prompt in one turn, and a
 * failpoint armed from a binding. `AFFE_FAILPOINT=<qualified location>`
 * makes that boundary die the first time it is reached in this runtime,
 * which is how the test kills a pass at a chosen point on real workerd. The
 * binding is this entry's, not the host's: nothing in `src/cloudflare` reads
 * it, and a deployment has no such switch.
 */

const agent = Agent.make({
  instructions: "You are a scheduled job runner.",
  loop: AgentLoop.bounded(1)
})

const model = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script(Array.from({ length: 20 }, (_, index) => TestLanguageModel.text(`ran-${index + 1}`))),
    ({ layer }) => layer
  )
)

const failpoint = Layer.unwrap(
  Effect.gen(function* () {
    const provider = yield* WorkerConfig.provider
    const armed = yield* Config.option(Config.string("AFFE_FAILPOINT")).parse(provider)
    let fired = false
    return Layer.succeed(Failpoint.Failpoint, {
      hit: (location) =>
        Option.isSome(armed) && armed.value === location && !fired
          ? Effect.sync(() => {
            fired = true
          }).pipe(Effect.andThen(Effect.die(new Error(`failpoint ${location}`))))
          : Effect.void
    })
  })
)

const host = CloudflareHost.make({
  agent,
  layer: Layer.merge(model, failpoint),
  // Fast enough for a test to see a re-fire; a deployment keeps the default.
  retryFailedAfter: "200 millis",
  // A demo: every caller is one principal, allowed everything. A deployment
  // resolves the principal from its own authentication and narrows this --
  // both are required, so neither is forgotten.
  principal: { resolve: () => Effect.succeed("demo") },
  authorization: AgentSessionHost.allowAll()
})

export const AgentSessionObject = host.SessionObject
export default host.Worker
