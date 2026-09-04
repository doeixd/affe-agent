/**
 * Content-addressed storage for large binary content, and the wire helpers
 * that let an encoded prompt carry references instead of megabytes.
 *
 * The Node filesystem backing lives at `affe-agent/blob/fs`, so
 * importing this entry never pulls in `node:*`.
 */
export * as BlobStore from "./BlobStore.js"
export * as BlobWire from "./BlobWire.js"
