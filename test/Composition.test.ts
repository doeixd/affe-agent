import { assert, describe, it } from "@effect/vitest"
import { Context } from "effect"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"

/**
 * Composition of heterogeneous policies, pinned rather than assumed.
 *
 * `compose` and `and` were declared over a single `E` and `R`, which reads
 * naturally and does not work: TypeScript infers them from the first argument
 * and rejects every argument that differs. Two transforms failing in different
 * ways — the case composition exists for — did not compile at all.
 *
 * These are compile-time assertions. The bodies below never run; type-checking
 * this file *is* the test, and every line in `checks` fails the build if either
 * half of a union is dropped.
 */
class AError extends Error {
  readonly _tag = "AError"
}
class BError extends Error {
  readonly _tag = "BError"
}
class AService extends Context.Service<AService, { readonly a: number }>()(
  "test/AService"
) {}
class BService extends Context.Service<BService, { readonly b: number }>()(
  "test/BService"
) {}

declare const transformA: ContextTransform.ContextTransform<AError, AService>
declare const transformB: ContextTransform.ContextTransform<BError, BService>
declare const loopA: AgentLoop.AgentLoop<AError, AService>
declare const loopB: AgentLoop.AgentLoop<BError, BService>

/** Never called. Declared so its body is type-checked, not executed. */
const checks = () => {
  const composed = ContextTransform.compose(transformA, transformB)
  // Both directions, so neither a dropped member nor a widening to `unknown`
  // slips through.
  const composedErrors: AError | BError = null as unknown as typeof composed extends
    ContextTransform.ContextTransform<infer E, infer _R>
    ? E
    : never
  const composedServices: AService | BService =
    null as unknown as typeof composed extends ContextTransform.ContextTransform<
      infer _E,
      infer R
    >
      ? R
      : never
  const composedAccepts: ContextTransform.ContextTransform<
    AError | BError,
    AService | BService
  > = composed

  const conjunction = AgentLoop.and(loopA, loopB)
  const conjunctionAccepts: AgentLoop.AgentLoop<
    AError | BError,
    AService | BService
  > = conjunction

  const disjunction = AgentLoop.or(loopA, loopB)
  const disjunctionAccepts: AgentLoop.AgentLoop<
    AError | BError,
    AService | BService
  > = disjunction

  return [
    composedErrors,
    composedServices,
    composedAccepts,
    conjunctionAccepts,
    disjunctionAccepts
  ]
}

describe("heterogeneous composition", () => {
  it("is checked at compile time", () => {
    // The assertions live in `checks`, which is deliberately never invoked:
    // `transformA` and friends are `declare const` and have no runtime value.
    // Calling it would test nothing and crash; type-checking it tests
    // everything.
    assert.isFunction(checks)
  })
})
