import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { makeStore } from "./store.ts"
import type { Entry, Handle } from "./view.ts"

/**
 * Does a long transcript slow the UI down?
 *
 * That question is the entire justification for V2. Before it, every entry
 * lived in the reactive tree forever and each frame re-rendered all of them;
 * after it, a finished entry is committed to the terminal's own scrollback and
 * leaves. So the live tree should stay flat no matter how long the session runs
 * -- and "should" is what this measures.
 */

const { backend, commitSettled, drainSettled, entries, footer, rewind, sink, status } = makeStore()

const handle: Handle = {
  submit: () => {},
  interrupt: () => {},
  respond: () => {},
  rewind: () => {},
  command: () => {},
  switchTo: () => {},
  commands: [],
  stop: () => {}
}

const { flush } = await testRender(
  () => (
    <App entries={entries} status={status()} handle={handle} commitSettled={commitSettled} footer={footer()} rewind={rewind()} backend={backend()} dismiss={() => sink.setPalette(undefined)}
      openPalette={() => sink.setPalette(handle.commands)}
      quit={() => {}} />
  ),
  {
    width: 80,
    height: 24,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout"
  }
)

const entryAt = (index: number): Entry => ({
  id: `e-${index}`,
  kind: index % 2 === 0 ? "user" : "assistant",
  title: `entry ${index} -- some text of a realistic length for a transcript line`,
  body: index % 3 === 0
    ? { type: "text", content: "a body line\nand another\nand a third" }
    : { type: "none" }
})

const TOTAL = 500
const SAMPLE = 50

const samples: Array<{ at: number; ms: number; live: number }> = []

for (let index = 0; index < TOTAL; index++) {
  sink.append(entryAt(index))
  const started = performance.now()
  await flush()
  const elapsed = performance.now() - started
  if ((index + 1) % SAMPLE === 0) {
    samples.push({ at: index + 1, ms: elapsed, live: entries.length })
  }
}

console.log("entries   flush(ms)   live tree")
for (const sample of samples) {
  console.log(
    `${String(sample.at).padStart(7)}   ${sample.ms.toFixed(2).padStart(9)}   ${
      String(sample.live).padStart(9)
    }`
  )
}

const first = samples[0]
const last = samples[samples.length - 1]
if (first === undefined || last === undefined) {
  console.log("no samples")
  process.exit(1)
}

// The live tree must not grow with the transcript. That is the property; the
// timing is a consequence of it, and is noisy enough not to assert on directly.
const flat = last.live <= first.live + 1
console.log(`\nlive tree at ${first.at}: ${first.live}   at ${last.at}: ${last.live}`)
console.log(flat ? "bench: OK -- live tree stayed flat" : "bench: FAILED -- live tree grew")
process.exit(flat ? 0 : 1)
