/**
 * Stored agent configuration (plan-workbench.md §3).
 */
import { Context, Effect, Layer, Option, Ref } from "effect"
import type * as Conversation from "../domain/Conversation.js"
import type { AgentProfileId, UserId } from "../domain/WorkbenchIds.js"

export interface Service {
  readonly get: (id: AgentProfileId) => Effect.Effect<Option.Option<Conversation.AgentProfile>>
  readonly list: (owner: UserId) => Effect.Effect<ReadonlyArray<Conversation.AgentProfile>>
  readonly put: (profile: Conversation.AgentProfile) => Effect.Effect<void>
  readonly remove: (id: AgentProfileId) => Effect.Effect<void>
}

export class AgentCatalog extends Context.Service<AgentCatalog, Service>()("workbench/AgentCatalog") {}

export const memory = (
  initial: Iterable<Conversation.AgentProfile> = []
): Layer.Layer<AgentCatalog> =>
  Layer.effect(
    AgentCatalog,
    Effect.gen(function*() {
      const profiles = yield* Ref.make(
        new Map<AgentProfileId, Conversation.AgentProfile>([...initial].map((profile) => [profile.id, profile]))
      )
      return AgentCatalog.of({
        get: (id) => Effect.map(Ref.get(profiles), (map) => Option.fromNullishOr(map.get(id))),
        list: (owner) =>
          Effect.map(Ref.get(profiles), (map) => [...map.values()].filter((profile) => profile.ownerId === owner)),
        put: (profile) => Ref.update(profiles, (map) => new Map(map).set(profile.id, profile)),
        remove: (id) =>
          Ref.update(profiles, (map) => {
            const next = new Map(map)
            next.delete(id)
            return next
          })
      })
    })
  )
