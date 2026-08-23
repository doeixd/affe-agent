/**
 * Scheduling and self-dispatch: an AgentDispatcher seam for enqueuing future
 * work, and a resilient `recurring` over Effect's Schedule. Adapters over
 * Effect's own scheduling primitives, not a scheduler runtime. See `Scheduling`.
 */
export * as Scheduling from "./Scheduling.js"
