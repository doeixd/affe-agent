import type { ColorInput } from "@opentui/core"
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
  writeSolidToScrollback
} from "@opentui/solid"
import type { Accessor } from "solid-js"
import { createEffect, createMemo, For, Match, onCleanup, Show, Switch } from "solid-js"
import * as Diff from "./diff.ts"
import { marker, theme } from "./theme.ts"
import { approvalOf, defaultViews, type ToolView } from "./tools.ts"
import type {
  Body,
  BranchItem,
  Command,
  Entry,
  FooterView,
  Handle,
  Rewind,
  Status,
  ToolSnapshot
} from "./view.ts"
import { fit, widthPolicy } from "./width.ts"

/**
 * The renderer.
 *
 * It knows nothing about Effect, sessions or agents -- only entries, a status,
 * and a handle with two methods. That is the seam: everything reactive lives
 * here, everything effectful lives in `harness.ts`.
 *
 * Structure follows opencode's `run` UI (see `vendor/opencode/`), in two parts:
 *
 * - An entry has a *kind*, which decides its marker and colour, and a *body*,
 *   which decides how its content is drawn. One body renderer serves every
 *   kind, so a tool result and an assistant message do not each grow their own.
 * - A finished entry is **committed to the terminal's own scrollback** and
 *   leaves the reactive tree; only unfinished work is re-rendered each frame.
 *   That is their architecture, and it is why their transcript does not slow
 *   down as it grows.
 */

/** How many lines of a body to show before collapsing. */
const BODY_LINES = 12

const clip = (text: string, limit = BODY_LINES): { lines: Array<string>; hidden: number } => {
  const lines = text.replace(/\n+$/, "").split("\n")
  return lines.length <= limit
    ? { lines, hidden: 0 }
    : { lines: lines.slice(0, limit), hidden: lines.length - limit }
}

/**
 * An edit, as an interleaved diff.
 *
 * Previously this printed one side and then the other, which is legible for a
 * one-line change and unreadable for anything else -- a reader has to hold six
 * removed lines in their head to see which three of them came back. Lining
 * them up is what a diff is for.
 *
 * Clipped like any other body: the point is to show *what* changed, not all of
 * it. Clipped after diffing rather than before, so the lines that survive are
 * the ones a reader wants -- clipping each side first would show six removals
 * and no additions.
 */
const DIFF_LINES = 12

interface Clipped {
  readonly lines: ReadonlyArray<Diff.Line>
  readonly hidden: number
  readonly note: string | undefined
}

const diffOf = (
  before: string | undefined,
  after: string | undefined
): Clipped => {
  if (before === undefined && after === undefined) {
    return { lines: [], hidden: 0, note: undefined }
  }
  const diff = Diff.of(before ?? "", after ?? "")
  const hidden = Math.max(0, diff.lines.length - DIFF_LINES)
  const note = diff.summarised
    ? "too large to line up"
    : diff.newlineChange === undefined
    ? undefined
    : `no newline at end of file (${diff.newlineChange})`
  return { lines: diff.lines.slice(0, DIFF_LINES), hidden, note }
}

const diffColour = (kind: Diff.Line["kind"]): ColorInput =>
  kind === "added"
    ? theme.block.diffAdded
    : kind === "removed"
    ? theme.block.diffRemoved
    : theme.block.muted

const diffMarker = (kind: Diff.Line["kind"]): string =>
  kind === "added" ? "+" : kind === "removed" ? "-" : " "

const Lines = (props: { text: string; fg: ColorInput }) => {
  const clipped = () => clip(props.text)
  return (
    <box flexDirection="column">
      <For each={clipped().lines}>
        {(line) => <text fg={props.fg}>{`  ${line}`}</text>}
      </For>
      <Show when={clipped().hidden > 0}>
        <text fg={theme.block.muted}>{`  … ${clipped().hidden} more lines`}</text>
      </Show>
    </box>
  )
}

/**
 * The diff, computed once.
 *
 * A child component with one derived value, because the previous version
 * called `diffOf` three separate times in the same JSX -- for the list, for
 * the `<Show>` condition, and for the hidden-line label. Each of those is an
 * alignment, so a reactive render did the work three times over.
 */
const ChangeBody = (props: {
  before: string | undefined
  after: string | undefined
}) => {
  const clipped = createMemo(() => diffOf(props.before, props.after))
  return (
    <box flexDirection="column">
      <For each={clipped().lines}>
        {(line) => (
          <text fg={diffColour(line.kind)}>
            {`  ${diffMarker(line.kind)} ${line.text}`}
          </text>
        )}
      </For>
      <Show when={clipped().hidden > 0}>
        <text fg={theme.block.muted}>{`  … ${clipped().hidden} more lines`}</text>
      </Show>
      <Show when={clipped().note !== undefined}>
        <text fg={theme.block.muted}>{`  ${clipped().note}`}</text>
      </Show>
    </box>
  )
}

const Snapshot = (props: { snapshot: ToolSnapshot }) => (
  <Switch>
    <Match when={props.snapshot.kind === "listing" ? props.snapshot : undefined}>
      {(snapshot: Accessor<Extract<ToolSnapshot, { kind: "listing" }>>) => (
        <box flexDirection="column">
          <For each={snapshot().items.slice(0, BODY_LINES)}>
            {(item) => (
              <text fg={item.directory ? theme.block.highlight : theme.block.text}>
                {`  ${item.path}${item.directory ? "/" : ""}`}
              </text>
            )}
          </For>
          <Show when={snapshot().items.length > BODY_LINES}>
            <text fg={theme.block.muted}>
              {`  … ${snapshot().items.length - BODY_LINES} more`}
            </text>
          </Show>
        </box>
      )}
    </Match>

    <Match when={props.snapshot.kind === "matches" ? props.snapshot : undefined}>
      {(snapshot: Accessor<Extract<ToolSnapshot, { kind: "matches" }>>) => (
        <box flexDirection="column">
          <Lines text={snapshot().text} fg={theme.block.text} />
          <Show when={snapshot().truncated}>
            <text fg={theme.block.warning}>{"  (results truncated)"}</text>
          </Show>
        </box>
      )}
    </Match>

    <Match when={props.snapshot.kind === "change" ? props.snapshot : undefined}>
      {(snapshot: Accessor<Extract<ToolSnapshot, { kind: "change" }>>) => (
        <box flexDirection="column">
          {/* One string per line: adjacent text nodes paint over one another
              rather than laying out side by side. The path is not repeated --
              the entry's title already names the file being edited. */}
          <text fg={theme.block.text}>
            {`  +${snapshot().added} -${snapshot().removed}`
              + (snapshot().strategy === undefined ? "" : `  (matched by ${snapshot().strategy})`)}
          </text>
          {/* The two sides, lined up. `before` is what was *actually*
              replaced, so when a fuzzy strategy matched, the difference
              between what was asked for and what was changed shows here. */}
          <ChangeBody before={snapshot().before} after={snapshot().after} />
        </box>
      )}
    </Match>

    <Match when={props.snapshot.kind === "command" ? props.snapshot : undefined}>
      {(snapshot: Accessor<Extract<ToolSnapshot, { kind: "command" }>>) => (
        <box flexDirection="column">
          <Show when={snapshot().stdout !== ""}>
            <Lines text={snapshot().stdout} fg={theme.block.text} />
          </Show>
          <Show when={snapshot().stderr !== ""}>
            <Lines text={snapshot().stderr} fg={theme.block.diffRemoved} />
          </Show>
          <Show when={snapshot().exitCode !== 0}>
            <text fg={theme.block.diffRemoved}>{`  exit ${snapshot().exitCode}`}</text>
          </Show>
        </box>
      )}
    </Match>

    <Match when={props.snapshot.kind === "file" ? props.snapshot : undefined}>
      {(snapshot: Accessor<Extract<ToolSnapshot, { kind: "file" }>>) => (
        <Lines text={snapshot().content} fg={theme.block.text} />
      )}
    </Match>
  </Switch>
)

const BodyView = (props: { body: Body }) => (
  <Switch>
    <Match when={props.body.type === "text" ? props.body : undefined}>
      {(body: Accessor<Extract<Body, { type: "text" }>>) => (
        <Lines text={body().content} fg={theme.block.text} />
      )}
    </Match>
    <Match when={props.body.type === "code" ? props.body : undefined}>
      {(body: Accessor<Extract<Body, { type: "code" }>>) => (
        <Lines text={body().content} fg={theme.block.muted} />
      )}
    </Match>
    <Match when={props.body.type === "markdown" ? props.body : undefined}>
      {(body: Accessor<Extract<Body, { type: "markdown" }>>) => (
        <Lines text={body().content} fg={theme.block.text} />
      )}
    </Match>
    <Match when={props.body.type === "structured" ? props.body : undefined}>
      {(body: Accessor<Extract<Body, { type: "structured" }>>) => (
        <Snapshot snapshot={body().snapshot} />
      )}
    </Match>
  </Switch>
)

/** A tool's status replaces its marker, so state reads at a glance. */
const markerOf = (entry: Entry): string =>
  entry.status === undefined
    ? marker[entry.kind]
    : entry.status === "running"
    ? "◐"
    : entry.status === "ok"
    ? "✓"
    : "✗"

const markerColour = (entry: Entry): ColorInput => {
  if (entry.status === "ok") return theme.footer.success
  if (entry.status === "failed") return theme.footer.error
  const tone = theme.entry[entry.kind]
  return tone.start ?? tone.body
}

export const EntryView = (props: { entry: Entry }) => (
  <box flexDirection="column" marginBottom={1}>
    <box flexDirection="row">
      <text fg={markerColour(props.entry)}>{`${markerOf(props.entry)} `}</text>
      <text fg={theme.entry[props.entry.kind].body}>
        {/* The cursor is part of the text, so a streaming line reflows as one
            unit rather than as two adjacent renderables. */}
        {props.entry.streaming === true ? `${props.entry.title}▌` : props.entry.title}
      </text>
    </box>
    <Show when={props.entry.body.type !== "none"}>
      <BodyView body={props.entry.body} />
    </Show>
  </box>
)

/**
 * The footer when a run is paused on a decision.
 *
 * Ported in spirit from opencode's permission footer: the prompt is *replaced*
 * rather than decorated, so there is no way to type a message at a moment when
 * the only meaningful input is yes or no.
 */
const ApprovalView = (props: {
  request: Extract<FooterView, { type: "approval" }>["request"]
  handle: Handle
  views: Readonly<Record<string, ToolView>>
}) => {
  useKeyboard((key) => {
    const name = String(key.name ?? "").toLowerCase()
    if (name === "y") props.handle.respond(props.request.id, true)
    // `a` allows and asks the policy to keep the grant. Separate from `y`
    // rather than a modifier on it, because "just this once" is the answer a
    // user should be able to give without thinking about policy at all.
    if (name === "a") props.handle.respond(props.request.id, true, { remember: true })
    if (name === "n" || name === "escape") props.handle.respond(props.request.id, false)
  })

  return (
    <box
      border
      borderColor={theme.footer.warning}
      flexDirection="column"
      padding={1}
      marginTop={1}
    >
      {/* One <text> per line, and each line one whole string. Adjacent text
          nodes do not lay themselves out as separate rows here -- they paint
          over one another -- so anything that must be its own line has to be
          its own string, and anything on one line has to be one string. */}
      <text fg={theme.footer.text}>
        {`? ${approvalOf(props.views, props.request)}`
          + (props.request.reason === undefined ? "" : `  (${props.request.reason})`)}
      </text>
      <text fg={theme.footer.muted}>{"  y allow · a always · n refuse"}</text>
    </box>
  )
}

/**
 * The `/` palette.
 *
 * A `<select>` rather than a list plus key handling, because a list that does
 * not move under the arrow keys is a picture of a menu. Escape returns to the
 * prompt, which is the only other thing that can be meant here.
 */
const PaletteView = (props: {
  commands: ReadonlyArray<Command>
  handle: Handle
  dismiss: () => void
}) => {
  useKeyboard((key) => {
    if (String(key.name ?? "").toLowerCase() === "escape") props.dismiss()
  })

  return (
    <box border borderColor={theme.footer.border} flexDirection="column" marginTop={1}>
      <text fg={theme.footer.muted}>{"  ↑↓ choose · enter run · esc cancel"}</text>
      <select
        focused
        options={props.commands.map((command) => ({
          name: `/${command.name}`,
          description: command.description,
          value: command.name
        }))}
        showDescription
        onSelect={(_index: number, option: { value?: unknown } | null) => {
          const name = option?.value
          if (typeof name === "string") props.handle.command(name)
        }}
      />
    </box>
  )
}

/**
 * Somewhere else to be.
 *
 * The active branch is marked rather than hidden: a selector that omits where
 * you are makes "switch" read as "leave", and the whole point of a tree is
 * that the line you are on is one of several equals.
 */
const BranchesView = (props: {
  items: ReadonlyArray<BranchItem>
  handle: Handle
  dismiss: () => void
}) => {
  useKeyboard((key) => {
    if (String(key.name ?? "").toLowerCase() === "escape") props.dismiss()
  })

  return (
    <box border borderColor={theme.footer.border} flexDirection="column" marginTop={1}>
      <Show
        when={props.items.length > 0}
        fallback={<text fg={theme.footer.muted}>{"  no other line of work yet"}</text>}
      >
        <text fg={theme.footer.muted}>{"  ↑↓ choose · enter switch · esc cancel"}</text>
        <select
          focused
          options={props.items.map((item) => ({
            name: `${item.active ? "● " : "  "}${item.label}`,
            description: item.detail,
            value: item.id
          }))}
          showDescription
          /**
           * Selected by position, not by the option's `value`.
           *
           * OpenTUI hands `value` back as `unknown`, so reading the id out of
           * it meant narrowing to `string` and then converting to a `NodeId`
           * with a cast -- in application code, which this repository forbids.
           * The index addresses the very list that was just rendered, so the
           * item it finds is the item that was drawn, brand and all.
           */
          onSelect={(index: number) => {
            const item = props.items[index]
            if (item !== undefined) props.handle.switchTo(item.id)
          }}
        />
      </Show>
    </box>
  )
}

export const App = (props: {
  entries: ReadonlyArray<Entry>
  status: Status
  handle: Handle
  /** Hand settled entries to the terminal, one at a time. See the store. */
  commitSettled: (write: (entry: Entry) => void) => void
  /**
   * How many leading entries have finished, as a reactive read.
   *
   * A function rather than a value, because the drain has to *track* it: the
   * whole point is to run when a row settles, which changes no length.
   */
  settledCount: () => number
  /** Test seam: counts how often the drain effect is woken. */
  onDrainScheduled?: () => void
  footer: FooterView
  rewind: Rewind
  /** Which model and workspace are behind this. See `Sink.setBackend`. */
  backend: string
  /** Return the footer to the prompt. Escape, from anywhere. */
  dismiss: () => void
  /** Open the `/` palette. */
  openPalette: () => void
  /** Leave. The footer advertises ctrl+d, so something has to answer it. */
  quit: () => void
  views?: Readonly<Record<string, ToolView>>
}) => {
  const renderer = useRenderer()
  const views = () => props.views ?? defaultViews
  const dimensions = useTerminalDimensions()
  const policy = () => widthPolicy(dimensions().width)

  /**
   * Nowhere to go back to from the first turn -- and nowhere to go *from*
   * while a turn is running.
   *
   * R15: the footer only ever advertised rewind while idle, but the key was
   * live regardless. During a submission `tree.active` still points at the
   * last completed boundary, so ctrl+r abandoned the in-flight branch *and*
   * stepped back from an older point than the user was looking at -- leaving
   * the abandoned branch's entries streaming, which blocks scrollback for
   * good.
   *
   * Gated rather than made into an interrupt-and-rewind transaction: the
   * affordance already said idle-only, so the honest fix is to mean it.
   */
  const canRewind = () => props.rewind.depth > 1 && props.status === "idle"

  /**
   * What has been typed, newest last, and where in it the user is.
   *
   * Kept here rather than in the store because it is not transcript: a prompt
   * the kernel refused is still something the user typed and should still be
   * recallable, so this deliberately does *not* share the store's rule that a
   * line is only drawn once the agent accepted it.
   */
  let input: { value: string } | undefined
  const typed: Array<string> = []
  let cursor = -1

  const recall = (delta: number) => {
    if (input === undefined || typed.length === 0) return
    // -1 means "at the empty prompt", which is where down-arrow returns to.
    const next = cursor === -1
      ? (delta < 0 ? typed.length - 1 : -1)
      : Math.min(typed.length - 1, Math.max(-1, cursor + (delta < 0 ? -1 : 1)))
    cursor = next
    input.value = next === -1 ? "" : typed[next]!
  }

  /**
   * Ctrl+R rewinds a turn.
   *
   * Bound here rather than in the footer because it is not a footer concern:
   * the prompt keeps the focus, and rewinding does not change what the user is
   * typing. Ignored while an approval is up -- the only meaningful answer then
   * is yes or no, and quietly rewinding out from under a pending question
   * would leave a run waiting on an answer nobody can give.
   */
  useKeyboard((key) => {
    const name = String(key.name ?? "").toLowerCase()

    /**
     * Leaving and interrupting are bound before the footer check, because they
     * have to work from every surface.
     *
     * The footer advertised `ctrl+d quit` and nothing answered it -- an
     * affordance that does nothing teaches the user the app is broken. And
     * `ctrl+c` reached the app only through `process.on("SIGINT")`, which a
     * terminal in raw mode need not deliver: the renderer owns the keyboard,
     * so the key has to be handled where the keys are.
     */
    if (key.ctrl === true && name === "d") return props.quit()
    if (key.ctrl === true && name === "c") return props.handle.interrupt()

    if (props.footer.type !== "prompt") return

    // History, the way every shell does it.
    if (name === "up") return recall(-1)
    if (name === "down") return recall(1)

    if (key.ctrl === true && name === "r" && canRewind()) props.handle.rewind()
  })

  /**
   * Ctrl+R rewinds a turn.
   *
   * Bound here rather than in the footer because it is not a footer concern:
   * the prompt keeps the focus, and rewinding does not change what the user is
   * typing. Ignored while an approval is up -- the only meaningful answer then
   * is yes or no, and quietly rewinding out from under a pending question
   * would leave a run waiting on an answer nobody can give.
   */


  // Finished entries are handed to the terminal and leave the reactive tree.
  // The effect tracks `entries` because that is what changes; the drain itself
  // decides how much has settled.
  //
  // Deferred to a microtask, and that is load-bearing: `drainSettled` splices
  // the very array `<For>` below is rendering, and doing that *inside* the
  // effect that renders it tears the list out from under the row callbacks --
  // `undefined is not an object` from a row reading an index that no longer
  // exists. Only visible once an entry lingers in the live tree, which is to
  // say once a message streams.
  /**
   * How many times a failed write is retried before the entries are left.
   *
   * A failure changes no reactive value and schedules nothing, so without this
   * a single transient throw pinned the prefix -- and with it every later
   * entry -- for the rest of the session. Bounded rather than a retry loop:
   * the usual cause is a disposed renderer, and a loop against one spins
   * forever.
   */
  const WRITE_ATTEMPTS = 3
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const drain = (attempt: number): void => {
    if (disposed) return
    /**
     * One entry at a time, and each stays in the store until it is written.
     *
     * The batch version removed the whole settled prefix first, so a throw
     * partway -- a disposed renderer, a bad extension view -- lost every
     * entry after it, and retrying was unsafe because the earlier ones had
     * already reached the terminal irreversibly.
     *
     * The catch is not swallowing the failure so much as bounding it: this
     * runs in an unowned microtask, so an escaping exception bypasses the
     * harness's error handling entirely and becomes an unhandled rejection.
     */
    try {
      props.commitSettled((entry) => {
        writeSolidToScrollback(renderer, () => <EntryView entry={entry} />)
      })
    } catch (cause) {
      if (attempt < WRITE_ATTEMPTS) {
        queueMicrotask(() => drain(attempt + 1))
        return
      }
      console.error(
        `could not write to scrollback after ${WRITE_ATTEMPTS} attempts;` +
          ` ${props.entries.length} entries are held back:`,
        cause
      )
    }
  }

  /**
   * Driven by the *settled prefix*, not by the number of entries.
   *
   * A length dependency misses the only thing that makes an entry drainable. A
   * streamed message or a running tool is appended while unsettled, so the
   * append fires one attempt that correctly stops at that row -- and its later
   * `streaming = false` or `status = "ok"` is a nested store write that
   * changes no length, so nothing ran again. The settled row and everything
   * behind it stayed in the live tree until some future append moved the
   * length; the last submission of a session could sit there indefinitely.
   *
   * The memo in the store notifies only when the *count* changes, so tokens
   * mid-stream wake nobody and the moment a row settles wakes this once.
   *
   * Still deferred to a microtask, and that is load-bearing: the drain splices
   * the very array `<For>` below is rendering, and doing that inside the
   * effect that renders it tears the list out from under the row callbacks.
   */
  createEffect(() => {
    props.settledCount()
    props.onDrainScheduled?.()
    queueMicrotask(() => drain(1))
  })

  return (
    <box flexDirection="column" padding={1}>
      <Show when={props.entries.length > 0}>
        <box flexDirection="column">
          <For each={props.entries}>{(entry) => <EntryView entry={entry} />}</For>
        </box>
      </Show>

      <box flexDirection="row">
        <text fg={props.status === "working" ? theme.footer.warning : theme.footer.muted}>
          {props.status === "working" ? "◐ working" : "○ idle"}
        </text>
        {/* One policy decides what a width affords, so parts of the footer
            disappear in a considered order instead of overflowing. */}
        <Show when={policy().hints}>
          <text fg={theme.footer.muted}>
            {props.status === "working"
              ? "   ctrl+c interrupt"
              : "   enter send · ctrl+d quit"}
          </text>
        </Show>
        <Show when={policy().spacious && props.entries.length > 0}>
          <text fg={theme.footer.muted}>{`   ${props.entries.length} in flight`}</text>
        </Show>
        {/* Only offered when it would do something. An affordance shown while
            inert teaches the user it does not work. */}
{/* Which backend is running changes what the transcript above *means*,
            so it survives narrowing longer than the hints do -- but it obeys
            the same policy rather than ignoring it. A live label carries a
            model name and a workspace path and can be wider than the terminal
            on its own, which is how a footer that only ever drew a
            ten-character `scripted` came to overflow. */}
        <Show when={props.backend !== ""}>
          <text fg={theme.footer.muted}>
            {`   ${fit(props.backend, policy().backendWidth)}`}
          </text>
        </Show>
        <Show when={policy().hints && props.status === "idle" && canRewind()}>
          <text fg={theme.footer.muted}>
            {`   ctrl+r rewind${props.rewind.taken === 0 ? "" : ` (${props.rewind.taken}×)`}`}
          </text>
        </Show>
      </box>

      <Switch>
        <Match when={props.footer.type === "approval" ? props.footer : undefined}>
          {(footer: Accessor<Extract<FooterView, { type: "approval" }>>) => (
            <ApprovalView request={footer().request} handle={props.handle} views={views()} />
          )}
        </Match>
        <Match when={props.footer.type === "palette" ? props.footer : undefined}>
          {(footer: Accessor<Extract<FooterView, { type: "palette" }>>) => (
            <PaletteView
              commands={footer().commands}
              handle={props.handle}
              dismiss={props.dismiss}
            />
          )}
        </Match>
        <Match when={props.footer.type === "branches" ? props.footer : undefined}>
          {(footer: Accessor<Extract<FooterView, { type: "branches" }>>) => (
            <BranchesView
              items={footer().items}
              handle={props.handle}
              dismiss={props.dismiss}
            />
          )}
        </Match>
        <Match when={props.footer.type === "prompt"}>
          <box border borderColor={theme.footer.border} marginTop={1}>
            <input
              ref={(element: { value: string }) => {
                input = element
              }}
              focused
              placeholder="message…  (/ for commands, ↑ for history)"
              onInput={(value: unknown) => {
                /**
                 * `/` on an empty prompt opens the palette.
                 *
                 * Read from the input rather than from a key handler, because
                 * a focused input *consumes* printable keys -- control keys
                 * are broadcast to the global handler and characters are not.
                 * A `useKeyboard` binding for `/` therefore never fired, which
                 * is the sort of thing that looks like a state bug for an hour.
                 *
                 * Cleared as it opens, so dismissing the palette does not
                 * leave a stray slash in the prompt. Typed mid-line it stays a
                 * character: paths and regexes contain slashes.
                 */
                if (value !== "/") return
                // Clearing needs the ref; opening does not, and making the
                // one depend on the other would mean a palette that silently
                // stops opening if the ref is ever not set.
                if (input !== undefined) input.value = ""
                props.openPalette()
              }}
              onSubmit={(value: unknown) => {
                // The element types `onSubmit` as accepting either shape; only
                // the string form carries what was typed.
                if (typeof value !== "string") return
                const text = value.trim()
                if (text.length === 0) return
                // Recorded before submission, and regardless of what the
                // kernel does with it: a refused prompt is still something the
                // user typed and will want back.
                typed.push(text)
                cursor = -1
                /**
                 * R106 -- clear it.
                 *
                 * `InputRenderable.submit()` emits the value and leaves it in
                 * the box; the Solid adapter only forwards the event. So the
                 * sent prompt stayed on screen, the next thing typed appended
                 * to it, `/` was never at an empty prompt again, and history
                 * navigation started from stale visible text.
                 *
                 * Cleared even if the kernel refuses the prompt. The draft is
                 * not lost -- it is the newest entry in the history above, one
                 * press of Up away -- and leaving it would mean the box
                 * disagreeing with the transcript about what was sent.
                 */
                if (input !== undefined) input.value = ""
                props.handle.submit(text)
              }}
            />
          </box>
        </Match>
      </Switch>
    </box>
  )
}
