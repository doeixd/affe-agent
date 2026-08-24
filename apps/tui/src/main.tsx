import { render } from "@opentui/solid"
import { App } from "./App.tsx"
import { fromArgv } from "./backend.ts"
import { start, stop } from "./harness.ts"
import { makeStore } from "./store.ts"

/** Entry point: build the state, hand its sink to the harness, render. */

const { backend, drainSettled, entries, footer, rewind, sink, status } = makeStore()

/**
 * Scripted unless `--live --workspace <dir>` says otherwise.
 *
 * Parsed before the renderer starts, so a missing `--workspace` is a plain
 * message on a normal terminal rather than an exception inside a full-screen
 * UI that has already taken over the display.
 */
const handle = await start(sink, { backend: fromArgv(process.argv.slice(2)) })

process.on("SIGINT", () => handle.interrupt())

await render(
  () => <App entries={entries} status={status()} handle={handle} drainSettled={drainSettled} footer={footer()} rewind={rewind()} backend={backend()} />,
  // Finished entries are committed to the terminal's own scrollback, which
  // needs the live UI pinned to a footer region below it.
  { screenMode: "split-footer" }
)

stop()
