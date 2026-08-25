import { render } from "@opentui/solid"
import { App } from "./App.tsx"
import { fromArgv } from "./backend.ts"
import { start, stop } from "./harness.ts"
import { makeStore } from "./store.ts"

/** Entry point: build the state, hand its sink to the harness, render. */

const { backend, commitSettled, drainSettled, entries, footer, rewind, settledCount, sink, status } =
  makeStore()

/**
 * Scripted unless `--live --workspace <dir>` says otherwise.
 *
 * Parsed before the renderer starts, so a missing `--workspace` is a plain
 * message on a normal terminal rather than an exception inside a full-screen
 * UI that has already taken over the display.
 */
const backendChoice = fromArgv(process.argv.slice(2))

const handle = await start(sink, {
  backend: backendChoice,
  // The *acquisition*, not the store: the harness opens it in its own scope so
  // it lives exactly as long as the session that reads it.
  ...(backendChoice.store === undefined ? {} : { store: backendChoice.store })
})

/**
 * A fallback, not the binding.
 *
 * The renderer owns the keyboard in raw mode, so `ctrl+c` is handled there;
 * this catches a signal sent from outside the terminal -- a `kill`, a parent
 * process shutting the tree down.
 */
process.on("SIGINT", () => handle.interrupt())

await render(
  () => <App entries={entries} status={status()} handle={handle} commitSettled={commitSettled} settledCount={settledCount} footer={footer()} rewind={rewind()} backend={backend()} dismiss={() => sink.setPalette(undefined)}
      openPalette={() => sink.setPalette(handle.commands)}
      quit={() => {
        // Awaited, not fired and forgotten: exiting here used to end the
        // runtime before the session tree and the persistent store had
        // closed, so a graceful-looking Ctrl+D skipped cleanup by
        // construction.
        void stop().then(() => {
          process.exit(0)
        })
      }} />,
  // Finished entries are committed to the terminal's own scrollback, which
  // needs the live UI pinned to a footer region below it.
  { screenMode: "split-footer" }
)

stop()
