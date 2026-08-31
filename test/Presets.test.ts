import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Permission from "../src/Permission.js"
import { AgentSessionHost } from "../src/client/index.js"
import { Presets } from "../src/presets/index.js"
import { MemorySandbox, Sandbox } from "../src/sandbox/index.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Presets (`plan-primitives.md` §3B, §7 step 4).
 *
 * Two things are worth testing about a preset, and neither is "does it
 * run": that its **defaults are the safe ones**, since the failure a
 * recipe prevents is the quiet one nobody notices; and that it **erases
 * no inference**, since a preset that hands back an `any`-shaped agent
 * has taken away more than it gave.
 */

const Read = Permission.annotate(
  Tool.make("read_thing", {
    parameters: Schema.Struct({ path: Schema.String }),
    success: Schema.String
  }),
  { action: "read", resource: (params) => params.path }
)

const Write = Permission.annotate(
  Tool.make("write_thing", {
    parameters: Schema.Struct({ path: Schema.String, body: Schema.String }),
    success: Schema.String
  }),
  { action: "write", resource: (params) => params.path }
)

const toolkit = Agent.toolkit([Read, Write], {
  read_thing: ({ path }) => Effect.succeed(`contents of ${path}`),
  write_thing: ({ path }) => Effect.succeed(`wrote ${path}`)
})

// ---------------------------------------------------------------------------
// Inference. `any` compiles, so the claim has to be asserted -- and these
// were broken from the library side to confirm they are not vacuous.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

/**
 * The assertions are taken from *real calls*, not from type arguments
 * spelled by hand: what a user writes is what has to keep its types, and
 * a `typeof` over an actual call cannot drift when the signature's
 * parameter order changes.
 */
const sampleCoder = Presets.coding({
  toolkit,
  sandbox: MemorySandbox.layer({ seed: {} })
})

const sampleGateway = Presets.gateway({
  toolkit,
  principal: { resolve: () => Effect.succeed("caller") },
  subject: (who: string) => who,
  authorization: AgentSessionHost.allowAll<string>()
})

/** The preset hands back a real agent definition, not `any`. */
export type _AgentIsNotAny = Assert<
  IsAny<typeof sampleCoder["agent"]> extends true ? false : true
>

/**
 * The toolkit's literal tool names survive the preset.
 *
 * This is the assertion that matters: the first implementation spread a
 * generic config into `Agent.make`, which widened it and erased the tool
 * names -- a preset that takes away more than it gives. This caught it.
 */
type CoderTools = typeof sampleCoder["agent"] extends
  Agent.AgentDefinition<infer Tools, any, any> ? Tools
  : never
export type _ToolNamesSurvive = Assert<"read_thing" extends keyof CoderTools ? true : false>
export type _ToolsAreNotAny = Assert<IsAny<CoderTools> extends true ? false : true>

/** The same for the gateway. */
type GatewayTools = typeof sampleGateway["agent"] extends
  Agent.AgentDefinition<infer Tools, any, any> ? Tools
  : never
export type _GatewayToolNamesSurvive = Assert<
  "write_thing" extends keyof GatewayTools ? true : false
>

/** And the workspace is an ordinary layer, reachable and typed. */
export type _WorkspaceIsALayer = Assert<
  typeof sampleCoder["workspace"] extends Layer.Layer<Sandbox.Current, any, any> ? true : false
>

describe("Presets.coding", () => {
  it.effect("defaults to asking before it changes anything, without being told to", () =>
    Effect.gen(function*() {
      // The point of the recipe: a caller who says nothing about
      // permission gets the safe policy, not an open one.
      const coder = Presets.coding({
        toolkit: yield* toolkit,
        sandbox: MemorySandbox.layer({ seed: {} })
      })

      const asked: Array<string> = []
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "w1", name: "write_thing", params: { path: "a.ts", body: "x" } }] },
        { text: "asked first" }
      ])

      yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(coder.agent, {
          elicitation: {
            make: () =>
              Effect.succeed({
                elicit: (request, announce) =>
                  Effect.as(
                    Effect.andThen(announce, Effect.sync(() => void asked.push(request.kind))),
                    // Granted, so the run completes: the claim under
                    // test is that it *asked*, not what an answer does.
                    { id: request.id, granted: true }
                  ),
                respond: () => Effect.succeed(false),
                pending: Effect.succeed([])
              })
          }
        })
        yield* session.prompt("write a.ts")
      }).pipe(Effect.provide(Layer.mergeAll(model, coder.workspace)), Effect.scoped)

      // A write asked, because nobody said it should not.
      assert.deepStrictEqual(asked, ["tool-approval"])
    })
  )

  it.effect("a caller's own config wins over every default", () =>
    Effect.gen(function*() {
      const coder = Presets.coding({
        toolkit: yield* toolkit,
        sandbox: MemorySandbox.layer({ seed: {} }),
        instructions: "mine",
        permission: Permission.allowAll
      })
      assert.deepStrictEqual(coder.agent.instructions, Option.some("mine"))
    })
  )
})

describe("Presets.gateway", () => {
  it.effect("a refusal is returned to the model, so the gateway keeps serving", () =>
    Effect.gen(function*() {
      const Host = AgentSessionHost.Tag<string>("test/presets/host")
      const gw = Presets.gateway({
        toolkit: yield* toolkit,
        // Denies writes; the default `toolDenialPolicy` is what decides
        // whether that ends the run or is told to the model.
        permission: Permission.make((request) =>
          Effect.succeed(
            request.action === "write" ? Permission.deny("read-only") : Permission.allow
          )),
        principal: { resolve: () => Effect.succeed("caller") },
        subject: (who) => who,
        authorization: AgentSessionHost.allowAll()
      })

      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "w1", name: "write_thing", params: { path: "a.ts", body: "x" } }] },
        { text: "I could not write that." }
      ])

      const result = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(gw.agent)
        return yield* session.prompt("write a.ts")
      }).pipe(Effect.provide(model), Effect.scoped)

      // The run survived its own refusal and answered.
      assert.strictEqual(result.text, "I could not write that.")
      void Host
    })
  )

  it("requires the subject projection: a gateway cannot forget who is calling", () => {
    // A compile-time claim, so it is stated as one. Removing `subject`
    // from the call below must not compile -- that omission is the bug
    // this preset exists to make unrepresentable, because a gateway
    // without it silently gives every caller the org's credential.
    type Options = Parameters<typeof Presets.gateway<string>>[0]
    type HasSubject = "subject" extends keyof Options ? true : false
    type RequiredSubject = Options extends { subject: (principal: string) => string } ? true
      : false
    const held: [HasSubject, RequiredSubject] = [true, true]
    assert.deepStrictEqual(held, [true, true])
  })
})
