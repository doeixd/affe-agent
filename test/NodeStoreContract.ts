import { describe, it } from "@effect/vitest"
import type { Effect } from "effect"
import type * as NodeStore from "../src/tree/NodeStore.js"
import { NodeStoreConformance } from "../src/testing/index.js"

/**
 * The node store contract, as vitest wiring over the shipped suite.
 *
 * The cases live in `NodeStoreConformance` (`/testing`) so a store over a
 * backing this repository does not have is held to the same rows; what
 * remains here is one `it.effect` per case.
 */
export const contract = <E>(
  name: string,
  makeStore: Effect.Effect<NodeStore.NodeStore<E>>
) =>
  describe(`NodeStore (${name})`, () => {
    for (const entry of NodeStoreConformance.cases(makeStore)) {
      it.effect(entry.name, () => entry.run)
    }
  })
