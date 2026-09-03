/**
 * Processes that outlive the tool call that started them: identity, listing,
 * reacquisition, output history, events -- over `Sandbox.execStream`, so
 * every sandbox provider's guarantees carry through and nothing here touches
 * a host. `ProcessTools` is the toolkit that hands them to a model, each tool
 * projected for `Permission` as its own act.
 */
export * as ProcessManager from "./ProcessManager.js"
export * as ProcessTools from "./ProcessTools.js"
