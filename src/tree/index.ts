/**
 * A tree of conversations over the ordinary session primitives.
 *
 * A session is one line of talk. A tree is what you get when a line can be
 * gone back to and taken a second way: every turn boundary is a node, any node
 * can be branched from, and branching never disturbs what it branched from.
 *
 * Nothing here is a new kind of session. `branch` and `activate` hand back the
 * same `AgentSession` everything else in this library takes, which is what
 * lets a tree be added to an application without changing how it talks to an
 * agent.
 */
export * as NodeStore from "./NodeStore.js"
export * as SessionTree from "./SessionTree.js"
export * as TreeExport from "./TreeExport.js"
