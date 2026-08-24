import { createSignal } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type {
  Approval,
  BranchItem,
  Command,
  Entry,
  FooterView,
  Rewind,
  Sink,
  Status
} from "./view.ts"

/**
 * The reactive state, and the `Sink` the harness writes into.
 *
 * This is the join between the two halves: the harness pushes from an Effect
 * fibre, Solid reads in JSX, and nothing else crosses. Both the app and the
 * smoke test build one of these, which is the point -- the test drives the
 * same state the real UI does.
 *
 * Writes are targeted (`setEntries(index, produce(...))`) rather than replacing
 * the array, so only the entry that changed re-renders. That matters when
 * tokens arrive dozens per second.
 */

/**
 * Whether an entry will never change again.
 *
 * Only a settled entry may be handed to the terminal's scrollback, because
 * scrollback is write-once: a line committed there cannot be repainted.
 */
export const settled = (entry: Entry): boolean =>
  entry.streaming !== true && entry.status !== "running"

export const makeStore = () => {
  const [entries, setEntries] = createStore<Array<Entry>>([])
  const [status, setStatus] = createSignal<Status>("idle")
  // The footer is a state machine with one active surface. A signal holding
  // the union, not a pair of booleans: "asking while also prompting" should be
  // unrepresentable rather than merely avoided.
  const [footer, setFooter] = createSignal<FooterView>({ type: "prompt" })
  const [rewind, setRewind] = createSignal<Rewind>({ depth: 0, taken: 0 })
  const [backend, setBackend] = createSignal<string>("")

  const indexOf = (id: string): number => entries.findIndex((entry) => entry.id === id)

  const sink: Sink = {
    append: (entry) => setEntries(entries.length, entry),

    patch: (id, change) => {
      const index = indexOf(id)
      if (index === -1) return
      setEntries(index, produce((entry) => Object.assign(entry, change)))
    },

    appendTitle: (id, delta) => {
      const index = indexOf(id)
      if (index === -1) return
      setEntries(index, produce((entry) => {
        entry.title += delta
      }))
    },

    setStatus,

    setApproval: (request: Approval | undefined) =>
      setFooter(request === undefined ? { type: "prompt" } : { type: "approval", request }),

    setRewind,

    setBackend,

    // Each of these *replaces* the footer's surface rather than layering on
    // it, which is what keeps "asking for approval while also choosing a
    // branch" unrepresentable instead of merely avoided.
    setPalette: (commands: ReadonlyArray<Command> | undefined) =>
      setFooter(commands === undefined ? { type: "prompt" } : { type: "palette", commands }),

    setBranches: (items: ReadonlyArray<BranchItem> | undefined) =>
      setFooter(items === undefined ? { type: "prompt" } : { type: "branches", items })
  }

  /**
   * Remove and return the leading run of settled entries.
   *
   * A *prefix*, not every settled entry: the transcript is ordered, and
   * scrollback is append-only, so committing a later entry while an earlier one
   * is still streaming would print them out of order. A running tool therefore
   * holds back everything after it, which is also what a reader expects.
   *
   * Entries are unwrapped on the way out. What is returned has left the store,
   * and reading a removed proxy afterwards is a bug waiting to happen.
   */
  const drainSettled = (): ReadonlyArray<Entry> => {
    let count = 0
    while (count < entries.length && settled(entries[count]!)) count++
    if (count === 0) return []
    const taken = entries.slice(0, count).map((entry) => ({ ...unwrap(entry) }))
    setEntries(produce((list) => {
      list.splice(0, count)
    }))
    return taken
  }

  return { entries, status, footer, rewind, backend, sink, drainSettled }
}
