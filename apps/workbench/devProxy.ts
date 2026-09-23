/**
 * The plain page, and the assistant-ui one beside it (`assistant-ui.html`).
 * `npm run workbench:server` serves the agent over `AgentHttp` and the
 * product API over `WorkbenchApi` on :8787; this dev server proxies every
 * route prefix either serves, so the pages and the API share an origin and
 * need no CORS. A prefix missing here is a route the dev page cannot reach
 * -- which is how sign-in, tasks and the inbox were unreachable under
 * `workbench:dev` until 2026-09-23.
 */
export const proxiedPrefixes = [
  "/sessions",
  "/conversations",
  "/agents",
  "/revisions",
  "/me",
  "/login",
  "/logout",
  "/users",
  "/organizations",
  "/catalog",
  "/inbox",
  "/tasks"
] as const
