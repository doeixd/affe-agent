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
import type { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"

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
      "conflicting-capability",
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
  readonly resolve: (
    id: AgentRevisionId
  ) => Effect.Effect<ResolvedAgent, RevisionResolutionError | WorkbenchStorageError, Scope.Scope>
}

export class AgentResolver extends Context.Service<AgentResolver, Service>()("workbench/AgentResolver") {}

/**
 * How a resolved agent becomes a client: the one choice between an agent
 * whose sessions live in this process and one whose sessions survive it.
 * The agent is the same either way; durability is the interpreter's.
 */
export interface ClientFactory {
  readonly make: <Tools extends Record<string, Tool.Any>, E, R, Value, Input>(
    /** Stable per revision: a durable client names its workflow with it. */
    name: string,
    agent: Agent.AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>
  ) => Layer.Layer<AgentClient.AgentClient, never, LanguageModel.LanguageModel | R>
}

export class AgentClientFactory extends Context.Service<AgentClientFactory, ClientFactory>()(
  "workbench/AgentClientFactory"
) {}

/** Sessions in this process, gone with it. */
export const inProcess: Layer.Layer<AgentClientFactory> = Layer.succeed(AgentClientFactory, {
  make: <Tools extends Record<string, Tool.Any>, E, R, Value, Input>(
    _name: string,
    agent: Agent.AgentDefinition<Tools, E, R, LanguageModel.LanguageModel, Value, Input>
  ): Layer.Layer<AgentClient.AgentClient, never, LanguageModel.LanguageModel | R> =>
    AgentClient.layer(agent, { elicitation: Elicitation.memory })
})

/** A name a workflow engine accepts, derived from a revision id. */
export const clientNameOf = (id: AgentRevisionId): string => `workbench-${id.replace(/[^A-Za-z0-9]+/g, "-")}`

/** Every entry of `refs` bound in `table`, or the first that is not. */
const bindAll = <A>(
  table: Readonly<Record<string, A>>,
  refs: ReadonlyArray<{ readonly id: string }>
): Binding<ReadonlyArray<A>> => {
  const bound: Array<A> = []
  for (const ref of refs) {
    const entry = table[ref.id]
    if (entry === undefined) return { _tag: "Missing", ref: ref.id }
    bound.push(entry)
  }
  return { _tag: "Bound", value: bound }
}

type Binding<A> = { readonly _tag: "Bound"; readonly value: A } | { readonly _tag: "Missing"; readonly ref: string }

/**
 * The first tool name two capabilities both bind, if any. Lowering bound
 * tools keys handlers by name, so a second `build` would silently replace
 * the first; a revision that asks for both is refused instead.
 */
const firstConflict = (tools: ReadonlyArray<Agent.BoundTool<Tool.Any>>): Option.Option<string> => {
  const seen = new Set<string>()
  for (const { tool } of tools) {
    if (seen.has(tool.name)) return Option.some(tool.name)
    seen.add(tool.name)
  }
  return Option.none()
}

export const layerWith: Layer.Layer<AgentResolver, never, AgentRegistry | AgentBindings | AgentClientFactory> = Layer.effect(
  AgentResolver,
  Effect.gen(function*() {
    const registry = yield* AgentRegistry
    const bindings = yield* AgentBindings
    const factory = yield* AgentClientFactory

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
      const tools = capabilities.value.flat()
      const conflict = firstConflict(tools)
      if (Option.isSome(conflict)) return yield* refused("conflicting-capability", conflict.value)

      const skills = bindAll(bindings.skills, revision.skills)
      if (skills._tag === "Missing") return yield* refused("unknown-skill", skills.ref)

      const permission = Permission.fromRecorded(revision.permission.recorded)
      if (Option.isNone(permission)) return yield* refused("permission-not-recreatable")

      const agent = Agent.make({
        instructions: revision.instructions,
        tools,
        loop: AgentLoop.bounded(revision.maxTurns),
        permission: permission.value
      })
      const name = clientNameOf(id)
      const client = skills.value.length === 0
        ? factory.make(name, agent)
        : factory.make(name, Skills.install(agent)).pipe(Layer.provide(Skills.layer(skills.value)))
      const built = yield* Layer.build(client.pipe(Layer.provide(model)))
      return { revision, client: Context.get(built, AgentClient.AgentClient) }
    })

    return AgentResolver.of({ resolve })
  })
)

/** The resolver with in-process clients. */
export const layer: Layer.Layer<AgentResolver, never, AgentRegistry | AgentBindings> = layerWith.pipe(
  Layer.provide(inProcess)
)
