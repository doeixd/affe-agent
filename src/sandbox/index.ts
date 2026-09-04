/**
 * The portable sandbox surface: the capability, its errors and the in-memory
 * provider. The Node-backed provider is a host implementation and lives at
 * `affe-agent/sandbox/local`, so importing this entry never pulls
 * in `node:*`.
 */
export * as Sandbox from "./Sandbox.js"
export * as WorkspaceManager from "./WorkspaceManager.js"
export * as MemorySandbox from "./memory.js"
