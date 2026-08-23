/**
 * Connectors: put an agent in front of an external platform (Slack, a webhook)
 * over the shared AgentSessionHost seam. A thin adapter -- verify, map
 * conversation to session, prompt, reply -- not a second Agent API. See
 * `Connectors`.
 */
export * as Connectors from "./Connectors.js"
