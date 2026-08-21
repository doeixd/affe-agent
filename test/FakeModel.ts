/**
 * The scripted model now ships as `@doeixd/effect-agent/testing`.
 *
 * Kept as a re-export so the suite exercises the *published* utilities rather
 * than a private copy: if the public testing API regresses, these tests are
 * what notice.
 */
export * from "../src/testing/TestLanguageModel.js"
export { script as layer } from "../src/testing/TestLanguageModel.js"
