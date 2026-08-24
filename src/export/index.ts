/**
 * Transcripts that leave the process.
 *
 * `AgentSession.Snapshot` is the restore contract -- the least a process needs
 * to rebuild a session it already has the agent for. An *export* is read
 * somewhere that has none of that context, so it carries a version and its
 * provenance; `Export` is an envelope around a snapshot rather than a
 * replacement for one.
 *
 * `Replay` is why the format earns its keep straight away: an exported
 * transcript is already a `TestLanguageModel` script, so a session that hit a
 * bug becomes a fixture that reproduces it with no provider and no network.
 */
export * as Export from "./Export.js"
export * as Replay from "./Replay.js"
