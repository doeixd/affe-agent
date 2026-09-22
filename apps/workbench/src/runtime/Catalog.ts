/**
 * What this deployment offers a revision to name (plan-workbench.md W1,
 * "model configuration"): the model profiles, capabilities and skills
 * bound in `AgentBindings`, as names. A settings page builds its choices
 * from this, so an agent can only be configured with what the resolver
 * will accept -- the same names `RevisionResolutionError` refuses by.
 *
 * Read-only and deployment-wide: it is the server's configuration, not a
 * record anyone owns.
 */
import { Context, Effect, Layer, Schema } from "effect"
import type { WorkbenchStorageError } from "../store/WorkbenchStorageError.js"
import { AgentBindings } from "./AgentResolver.js"

export const View = Schema.Struct({
  models: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String)
})
export type View = typeof View.Type

/** In a browser, the read is over the network (`HttpStores.catalog`); the error is the same the stores name. */
export class Catalog extends Context.Service<Catalog, Effect.Effect<View, WorkbenchStorageError>>()("workbench/Catalog") {}

const sorted = (names: Iterable<string>): ReadonlyArray<string> => [...names].sort()

/** From the bindings this process resolves against. */
export const layer: Layer.Layer<Catalog, never, AgentBindings> = Layer.effect(
  Catalog,
  Effect.map(AgentBindings, (bindings) =>
    Effect.succeed<View>({
      models: sorted(Object.keys(bindings.models)),
      capabilities: sorted(Object.keys(bindings.capabilities)),
      skills: sorted(Object.keys(bindings.skills))
    }))
)
