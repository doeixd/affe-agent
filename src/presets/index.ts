/**
 * Opinionated assemblies over the primitives: the recipe that stops every
 * target re-deriving the same wiring (`docs/plan-primitives.md` §3B).
 *
 * A preset composes existing layers and adds defaults. It has no
 * execution model of its own, adds no type parameter to `Agent.make`,
 * and hides nothing -- each returns the parts it assembled, so dropping
 * back to the primitives is taking a field rather than starting over.
 */
export * as Presets from "./Presets.js"
