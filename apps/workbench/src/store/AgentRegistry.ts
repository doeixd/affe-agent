/**
 * Named agents and their revisions (plan-agent-product-control-plane.md §6).
 */
import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import type { AgentRevision, AgentSpec, RevisionInput } from "../domain/AgentRevision.js"
import { AgentId, AgentRevisionId } from "../domain/WorkbenchIds.js"
import type { UserId } from "../domain/WorkbenchIds.js"

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()("AgentNotFoundError", {
  agentId: AgentId
}) {}

export interface NewAgent {
  readonly ownerId: UserId
  readonly name: string
  readonly description?: string | undefined
  readonly revision: RevisionInput
}

export interface Created {
  readonly spec: AgentSpec
  readonly revision: AgentRevision
}

export interface Service {
  readonly get: (id: AgentId) => Effect.Effect<Option.Option<AgentSpec>>
  readonly revision: (id: AgentRevisionId) => Effect.Effect<Option.Option<AgentRevision>>
  /** Oldest first. */
  readonly revisions: (id: AgentId) => Effect.Effect<ReadonlyArray<AgentRevision>>
  readonly list: (owner: UserId) => Effect.Effect<ReadonlyArray<AgentSpec>>
  readonly create: (input: NewAgent) => Effect.Effect<Created>
  /** Write the next revision and make it the active one. Earlier revisions are untouched. */
  readonly revise: (
    id: AgentId,
    input: RevisionInput,
    by: UserId
  ) => Effect.Effect<AgentRevision, AgentNotFoundError>
  readonly archive: (id: AgentId) => Effect.Effect<void, AgentNotFoundError>
}

export class AgentRegistry extends Context.Service<AgentRegistry, Service>()("workbench/AgentRegistry") {}

/** Readable and ordered: an agent's third revision is `<agent>@3`. */
const revisionIdOf = (agentId: AgentId, revision: number) => AgentRevisionId.make(`${agentId}@${revision}`)

interface State {
  readonly specs: ReadonlyMap<AgentId, AgentSpec>
  readonly revisions: ReadonlyMap<AgentRevisionId, AgentRevision>
}

export const memory: Layer.Layer<AgentRegistry> = Layer.effect(
  AgentRegistry,
  Effect.gen(function*() {
    const state = yield* Ref.make<State>({ specs: new Map(), revisions: new Map() })

    const create = Effect.fn("AgentRegistry.create")(function*(input: NewAgent) {
      const now = yield* DateTime.now
      const agentId = AgentId.make(globalThis.crypto.randomUUID())
      const revision: AgentRevision = {
        id: revisionIdOf(agentId, 1),
        agentId,
        revision: 1,
        ...input.revision,
        createdBy: input.ownerId,
        createdAt: now
      }
      const spec: AgentSpec = {
        id: agentId,
        ownerId: input.ownerId,
        name: input.name,
        description: Option.fromNullishOr(input.description),
        activeRevisionId: revision.id,
        createdAt: now,
        archivedAt: Option.none()
      }
      yield* Ref.update(state, (current) => ({
        specs: new Map(current.specs).set(agentId, spec),
        revisions: new Map(current.revisions).set(revision.id, revision)
      }))
      return { spec, revision }
    })

    const revise = Effect.fn("AgentRegistry.revise")(function*(id: AgentId, input: RevisionInput, by: UserId) {
      const now = yield* DateTime.now
      // One modify: the number is read and the revision written together, so
      // two concurrent edits cannot both become revision N+1.
      const written = yield* Ref.modify(state, (current): [Option.Option<AgentRevision>, State] => {
        const spec = current.specs.get(id)
        if (spec === undefined) return [Option.none(), current]
        const latest = [...current.revisions.values()].filter((entry) => entry.agentId === id).length
        const revision: AgentRevision = {
          id: revisionIdOf(id, latest + 1),
          agentId: id,
          revision: latest + 1,
          ...input,
          createdBy: by,
          createdAt: now
        }
        return [Option.some(revision), {
          specs: new Map(current.specs).set(id, { ...spec, activeRevisionId: revision.id }),
          revisions: new Map(current.revisions).set(revision.id, revision)
        }]
      })
      return yield* Option.match(written, {
        onNone: () => Effect.fail(new AgentNotFoundError({ agentId: id })),
        onSome: Effect.succeed
      })
    })

    const archive = Effect.fn("AgentRegistry.archive")(function*(id: AgentId) {
      const now = yield* DateTime.now
      const found = yield* Ref.modify(state, (current): [boolean, State] => {
        const spec = current.specs.get(id)
        if (spec === undefined) return [false, current]
        if (Option.isSome(spec.archivedAt)) return [true, current]
        return [true, { ...current, specs: new Map(current.specs).set(id, { ...spec, archivedAt: Option.some(now) }) }]
      })
      if (!found) {
        return yield* new AgentNotFoundError({ agentId: id })
      }
    })

    return AgentRegistry.of({
      get: (id) => Effect.map(Ref.get(state), (current) => Option.fromNullishOr(current.specs.get(id))),
      revision: (id) => Effect.map(Ref.get(state), (current) => Option.fromNullishOr(current.revisions.get(id))),
      revisions: (id) =>
        Effect.map(Ref.get(state), (current) =>
          [...current.revisions.values()]
            .filter((entry) => entry.agentId === id)
            .sort((a, b) => a.revision - b.revision)),
      list: (owner) =>
        Effect.map(Ref.get(state), (current) => [...current.specs.values()].filter((spec) => spec.ownerId === owner)),
      create,
      revise,
      archive
    })
  })
)
