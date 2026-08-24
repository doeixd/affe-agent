import { render } from "@opentui/solid"
import { App } from "./App.tsx"
import { start, stop } from "./harness.ts"
import { makeStore } from "./store.ts"

/** Entry point: build the state, hand its sink to the harness, render. */

const { drainSettled, entries, footer, sink, status } = makeStore()
const handle = await start(sink)

process.on("SIGINT", () => handle.interrupt())

await render(
  () => <App entries={entries} status={status()} handle={handle} drainSettled={drainSettled} footer={footer()} />,
  // Finished entries are committed to the terminal's own scrollback, which
  // needs the live UI pinned to a footer region below it.
  { screenMode: "split-footer" }
)

stop()
