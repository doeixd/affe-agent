import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Ref } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The input gate's hardest invariant: a follow-up offered while the gate still
 * reads open -- specifically after a submission's first drain and before it
 * closes its input -- must be caught by the *closing* drain and run, never
 * accepted and then discarded.
 *
 * That window is internal, between two lines of `AgentSubmission`, so it is
 * driven deterministically through the `beforeClose` synchronisation seam (an
 * effect run in exactly that window) rather than raced. The seam offers a
 * follow-up there; the assertion is that a second run happens.
 */

const Simple = Agent.make({ loop: AgentLoop.bounded(2) })

describe("closing-drain invariant", () => {
  it.effect("a follow-up offered in the close window is caught by the closing drain and runs", () =>
    Effect.gen(function* () {
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.text("first"),
        TestLanguageModel.text("second")
      ])

      const sessionRef = yield* Deferred.make<AgentSession.AgentSession>()
      const fired = yield* Ref.make(false)
      // Fire once, in the post-first-drain / pre-close window: offer a follow-up
      // that only the closing drain (and its reopen) can still catch.
      const beforeClose = Effect.gen(function* () {
        if (yield* Ref.getAndSet(fired, true)) return
        const session = yield* Deferred.await(sessionRef)
        yield* AgentSession.followUp(session, "late").pipe(Effect.orDie)
      })

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(Simple, { beforeClose })
          yield* Deferred.succeed(sessionRef, session)
          return yield* AgentSession.prompt(session, "go")
        })
      ).pipe(Effect.provide(model))

      // The late follow-up was not dropped: it ran as a second run.
      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.runs, 2)
      assert.strictEqual(result.text, "second")
    })
  )
})
