/**
 * A stored revision -> a running agent (plan-agent-product-control-plane.md §6).
 *
 * Every reference in the revision is bound here, against `AgentBindings`,
 * into an ordinary `AgentDefinition` built with public combinators, and the
 * result is erased exactly once, to the `AgentClient.Service` every consumer
 * already speaks. Nothing downstream holds an `AgentDefinition<any, ...>`.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Scope } from "effect"
import type { LanguageModel, Tool } from "effect/unstable/ai"
import { Agent, AgentLoop, Permission } from "affe-agent"
import { AgentClient } from "affe-agent/client"
import * as Elicitation from "affe-agent/elicitation"
import { Skills } from "affe-agent/skills"
import type { AgentRevision } from "../domain/AgentRevision.js"
import { AgentRevisionId } from "../domain/WorkbenchIds.js"
import { AgentRegistry } from "../store/AgentRegistry.js"

/** What a deployment registers for revisions to name. */
export interface Bindings {
  readonly models: Readonly<Record<string, Layer.Layer<LanguageModel.LanguageModel>>>
  readonly capabilities: Readonly<Record<string, ReadonlyArray<Agent.BoundTool<Tool.Any>>>>
  readonly skills: Readonly<Record<string, Skills.Skill>>
}

export class AgentBindings extends Context.Service<AgentBindings, Bindings>()("workbench/AgentBindings") {}

export class RevisionResolutionError extends Schema.TaggedError<RevisionResolutionError>()(
  "RevisionResolutionError",
  {
    revisionId: AgentRevisionId,
    reason: Schema.Literals([
      "unknown-revision",
      "unknown-model",
      "unknown-capability",
      "unknown-skill",
      "permission-not-recreatable"
    ]),
    /** The reference that did not bind, when one did not. */
    ref: Schema.optional(Schema.String)
  }
) {}

export interface ResolvedAgent {
  readonly revision: AgentRevision
  readonly client: AgentClient.Service
}

export interface Service {
  /** Scoped: the client's sessions and the model wiring live as long as the scope. */
  readonly resolve: (id: AgentRevisionId) => Effect.Effect<ResolvedAgent, RevisionResolutionError, Scope.Scope>
}

export class AgentResolver extends Context.Service<AgentResolver, Service>()("workbench/AgentResolver") {}

/** Every entry of `refs` bound in `table`, or the first that is not. */
const bindAll = <A>(
  table: Readonly<Record<string, A>>,
  refs: ReadonlyArray<{ readonly id: string }>
): Either<ReadonlyArray<A>, string> => {
  const bound: Array<A> = []
  for (const ref of refs) {
    const entry = table[ref.id]
    if (entry === undefined) return { _tag: "Missing", ref: ref.id }
    bound.push(entry)
  }
  return { _tag: "Bound", value: bound }
}

type Either<A, Ref> = { readonly _tag: "Bound"; readonly value: A } | { readonly _tag: "Missing"; readonly ref: Ref }

export const layer: Layer.Layer<AgentResolver, never, AgentRegistry | AgentBindings> = Layer.effect(
  AgentResolver,
  Effect.gen(function*() {
    const registry = yield* AgentRegistry
    const bindings = yield* AgentBindings

    const resolve = Effect.fn("AgentResolver.resolve")(function*(id: AgentRevisionId) {
      const refused = (reason: RevisionResolutionError["reason"], ref?: string) =>
        new RevisionResolutionError({ revisionId: id, reason, ...(ref === undefined ? {} : { ref }) })

      const found = yield* registry.revision(id)
      if (Option.isNone(found)) return yield* refused("unknown-revision")
      const revision = found.value

      const model = bindings.models[revision.modelPolicy.profile]
      if (model === undefined) return yield* refused("unknown-model", revision.modelPolicy.profile)

      const capabilities = bindAll(bindings.capabilities, revision.capabilities)
      if (capabilities._tag === "Missing") return yield* refused("unknown-capability", capabilities.ref)

      const skills = bindAll(bindings.skills, revision.skills)
      if (skills._tag === "Missing") return yield* refused("unknown-skill", skills.ref)

      const permission = Permission.fromRecorded(revision.permission.recorded)
      if (Option.isNone(permission)) return yield* refused("permission-not-recreatable")

      const agent = Agent.make({
        instructions: revision.instructions,
        tools: capabilities.value.flat(),
        loop: AgentLoop.bounded(revision.maxTurns),
        permission: permission.value
      })
      const client = skills.value.length === 0
        ? AgentClient.layer(agent, { elicitation: Elicitation.memory })
        : AgentClient.layer(Skills.install(agent), { elicitation: Elicitation.memory }).pipe(
          Layer.provide(Skills.layer(skills.value))
        )
      const built = yield* Layer.build(client.pipe(Layer.provide(model)))
      return { revision, client: Context.get(built, AgentClient.AgentClient) }
    })

    return AgentResolver.of({ resolve })
  })
)
