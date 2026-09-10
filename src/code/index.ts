/**
 * Code mode's interpreter-free half: JSDoc-annotated TypeScript signatures
 * generated from toolkits, the token-budgeted round-robin catalog, and
 * deterministic search.
 *
 * Useful on its own -- it is the fix for prompt bloat whether or not a
 * program ever runs. The engine (the owned interpreter, `execute`, the
 * data boundary) lives behind this same entry, with its own dependency cost.
 */
export * as Catalog from "./Catalog.js"
export * as CodeMode from "./CodeMode.js"
export * as CodeTool from "./CodeTool.js"
