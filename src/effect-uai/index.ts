/**
 * `effect-uai` behind Effect AI's `LanguageModel`, so an Affe agent can run on
 * that ecosystem's providers without the kernel learning about a second AI
 * vocabulary.
 *
 * `@effect-uai/core` is an optional peer dependency: importing this subpath is
 * the only thing that pulls it in, and the default package graph does not.
 *
 * See `docs/plan-effect-uai-compatibility-contract.md` for what crosses the
 * boundary exactly, what crosses with a declared loss, and what is refused.
 */
export * as Compatibility from "./Compatibility.js"
export * as EffectUaiModel from "./EffectUaiModel.js"
