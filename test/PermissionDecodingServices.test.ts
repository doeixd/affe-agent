import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Ref, Schema, SchemaGetter } from "effect"
import { LanguageModel, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * R144 -- a parameter codec that needs a service, proven at the public
 * boundary.
 *
 * `decide` spells its requirement as
 * `Tool.ParametersSchema<T>["DecodingServices"]`, and `executeOne` then
 * widens that to the handler-services union because TypeScript cannot reduce
 * the conditional type after an indexed lookup. Internal assertions are the
 * kind of thing that quietly stops being true, so what matters is whether the
 * requirement is visible where an application meets it: does
 * `AgentSession.make` refuse to run without the Layer, and does permission
 * evaluation see the *decoded* value?
 *
 * Everything here is written without a cast, deliberately. `any` compiles.
 */

/** The service the codec needs, and which nothing else in the agent provides. */
class Canonicalizer extends Context.Service<Canonicalizer, {
  readonly canonical: (raw: string) => Effect.Effect<string>
  /** How many times a value has been decoded, so R2 is measured rather than assumed. */
  readonly decodes: Ref.Ref<number>
}>()("test/PermissionDecodingServices/Canonicalizer") {}

/**
 * A schema whose decode calls a service.
 *
 * `DecodingServices` is `Canonicalizer` from here on, and every type that
 * carries this tool inherits it.
 */
const CanonicalPath = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    {
      decode: SchemaGetter.transformOrFail((raw: string) =>
        Canonicalizer.use((service) =>
          Effect.flatMap(
            Ref.update(service.decodes, (n) => n + 1),
            () => service.canonical(raw)
          ))),
      encode: SchemaGetter.passthrough()
    }
  )
)

const Read = Permission.annotate(
  Tool.make("read_path", {
    parameters: Schema.Struct({ path: CanonicalPath }),
    success: Schema.String
  }),
  { action: "fs.read", resource: ({ path }) => path }
)

describe("permission decoding services", () => {
  it.effect("the codec's service is required by the session and used by the policy", () =>
    Effect.gen(function*() {
      const decodes = yield* Ref.make(0)
      const seen = yield* Ref.make<Array<string>>([])
      const ran = yield* Ref.make<Array<string>>([])
      const { layer: model } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "c1", name: "read_path", params: { path: "/tmp/x/../y" } }] },
        TestLanguageModel.text("done")
      ])

      /**
       * The proof, and it is a type-level one.
       *
       * Building the toolkit, the agent and the session all carry
       * `Canonicalizer`, because the tool's parameter codec put it there.
       * Spelling the requirement out is what makes that visible: if it ever
       * stops surfacing, this annotation stops compiling rather than
       * silently accepting a session that cannot decode its own parameters.
       */
      const program: Effect.Effect<
        ReadonlyArray<string>,
        never,
        Canonicalizer | LanguageModel.LanguageModel
      > = Effect.scoped(
        Effect.gen(function*() {
          const toolkit = yield* Agent.toolkit([Read], {
            read_path: ({ path }) =>
              Ref.update(ran, (all) => [...all, path]).pipe(Effect.as("ok"))
          })
          const agent = Agent.make({
            toolkit,
            loop: AgentLoop.bounded(4),
            permission: Permission.make((request) =>
              Ref.update(seen, (all) => [...all, request.resource]).pipe(
                Effect.as(Permission.allow)
              ))
          })
          const session = yield* AgentSession.make(agent, {
            elicitation: Elicitation.memory
          })
          const running = yield* Effect.forkChild(Effect.exit(session.prompt("go")))
          yield* Fiber.join(running)
          return yield* Ref.get(seen)
        })
      )

      const resources = yield* program.pipe(
        // One provide, not two chained: separate calls give the layers
        // separate lifetimes.
        Effect.provide(Layer.mergeAll(
          model,
          Layer.succeed(Canonicalizer)(
            Canonicalizer.of({
              // "/a/../b" becomes "/b": a real transformation, so a policy
              // reading the encoded string and one reading the decoded value
              // cannot agree by accident.
              canonical: (raw) => Effect.succeed(raw.replace(/\/[^/]+\/\.\./g, "")),
              decodes
            })
          )
        ))
      )

      // The policy saw the *decoded* path, not the raw one: the service ran
      // before the decision was made.
      assert.deepStrictEqual(resources, ["/tmp/y"])
      // And the handler ran on the same decoded value.
      assert.deepStrictEqual(yield* Ref.get(ran), ["/tmp/y"])

      /**
       * R2, measured rather than assumed.
       *
       * The decision and the handler each decode: `decide` decodes in order
       * to authorize, and `Toolkit.handle` decodes again because Effect AI
       * has no entry point that takes an already-decoded value. Two decodes
       * per call is the current contract, and it is why a parameter codec
       * used with permission must be a deterministic, side-effect-free
       * function of its input -- one that answers differently the second time
       * authorizes one value and executes another.
       *
       * Pinned so the number cannot change without someone choosing to
       * change it.
       */
      assert.strictEqual(yield* Ref.get(decodes), 2)
    }))
})
