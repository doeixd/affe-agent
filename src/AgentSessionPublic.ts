/**
 * The public `AgentSession` namespace.
 *
 * `AgentSession.ts` also exports `makeEngine` and `EngineOptions`, which a
 * durable interpreter and this repository's tests need and an application
 * does not. Listing the public surface here, rather than `export *`, is what
 * keeps them off `@doeixd/effect-agent` (design-assessment rec 2) while the
 * implementation stays in one file. `test/PublicApi.test.ts` pins the list.
 */
export {
  Id,
  Snapshot,
  awaitSubmission,
  events,
  followUp,
  history,
  interrupt,
  make,
  observe,
  pending,
  prompt,
  respond,
  restore,
  snapshot,
  state,
  status,
  steer,
  submit,
  subscribe
} from "./AgentSession.js"
export type {
  AgentSession,
  MakeOptions,
  PromptError,
  PromptOptions,
  Result,
  StateView,
  SubmissionReceipt,
  SubmitError
} from "./AgentSession.js"
