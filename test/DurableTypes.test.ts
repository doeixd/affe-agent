import { assert, describe, it } from "@effect/vitest"
import type { Layer } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import type { WorkflowEngine } from "effect/unstable/workflow"
import type { AgentClient } from "../src/client/AgentClient.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"

/**
 * The durable layers promise, in their types, what they need at runtime.
 *
 * `DurableAgent.workflow(...).layer` resolves `LanguageModel` inside the
 * workflow body (`DurableModel.wrap`) and runs under the engine, so its
 * requirement must name both. Inference had erased it to `never` -- the
 * agent's `any`-typed slots reached `toLayer` -- and `STATUS.md` carried the
 * lie for a week as "known, deliberately left". Held here by assignability,
 * since a layer's requirement slot is covariant: a layer is assignable to one
 * that requires a superset, and not to one that requires less. Break by
 * removing the annotation on `layer` in `DurableAgent.ts`: the first
 * assertion flips, because a layer requiring nothing is assignable to
 * anything.
 */
type Assert<T extends true> = T
type Not<T extends boolean> = T extends true ? false : true

type WorkflowLayer = ReturnType<typeof DurableAgent.workflow>["layer"]
// Requires something: not assignable to a layer that requires nothing.
type _WorkflowRequires = Assert<Not<WorkflowLayer extends Layer.Layer<never, never, never> ? true : false>>
// Requires the model: not satisfied by the engine alone.
type _WorkflowNeedsModel = Assert<Not<WorkflowLayer extends Layer.Layer<never, never, WorkflowEngine.WorkflowEngine> ? true : false>>
// And nothing beyond the two.
type _WorkflowExactly = Assert<
  WorkflowLayer extends Layer.Layer<never, never, WorkflowEngine.WorkflowEngine | LanguageModel.LanguageModel> ? true : false
>

type ClientLayer = ReturnType<typeof DurableAgentClient.layer>
type _ClientNeedsModel = Assert<Not<ClientLayer extends Layer.Layer<AgentClient, never, WorkflowEngine.WorkflowEngine> ? true : false>>
type _ClientExactly = Assert<
  ClientLayer extends Layer.Layer<AgentClient, never, WorkflowEngine.WorkflowEngine | LanguageModel.LanguageModel> ? true : false
>

describe("durable layers say what they need", () => {
  it("is a type-level test; the assertions above are what it holds", () => {
    assert.isTrue(true)
  })
})
