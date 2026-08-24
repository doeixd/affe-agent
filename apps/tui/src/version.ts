/**
 * The library version this TUI was built against.
 *
 * A constant rather than a read of `package.json`: the TUI is bundled by Bun
 * from source, so there is no reliable manifest beside the running code, and
 * an exporter that guessed would write a field whose only purpose is to be
 * trusted. Kept beside the version it names -- if the two drift, an export
 * says so wrongly, which is worse than saying nothing.
 */
export const VERSION = "0.0.1"
