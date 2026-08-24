import type { ColorInput } from "@opentui/core"
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
  writeSolidToScrollback
} from "@opentui/solid"
import type { Accessor } from "solid-js"
import { createEffect, For, Match, Show, Switch } from "solid-js"
import { marker, theme } from "./theme.ts"
import { approvalOf, defaultViews, type ToolView } from "./tools.ts"
import type {
  Body,
  Entry,
  FooterView,
  Handle,
  Rewind,
  Status,
  ToolSnapshot
} from "./view.ts"
import { widthPolicy } from "./width.ts"

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
 * One side of an edit, as prefixed lines.
 *
 * Clipped like any other body: an edit can be large, and the point is to show
 * *what* changed rather than all of it. A trailing newline is dropped so a
 * whole-line replacement does not render a blank final row.
 */
const sides = (text: string | undefined, marker: string): ReadonlyArray<string> => {
  if (text === undefined || text === "") return []
  const { hidden, lines } = clip(text.replace(/\n$/, ""), 6)
  const shown = lines.map((line) => `  ${marker} ${line}`)
  return hidden === 0 ? shown : [...shown, `  ${marker} … ${hidden} more lines`]
}

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
          {/* The two sides of the edit. `before` is what was *actually*
              replaced, so when a fuzzy strategy matched, this is where that
              shows. */}
          <For each={sides(snapshot().before, "-")}>
            {(line) => <text fg={theme.block.diffRemoved}>{line}</text>}
          </For>
          <For each={sides(snapshot().after, "+")}>
            {(line) => <text fg={theme.block.diffAdded}>{line}</text>}
          </For>
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
      <text fg={theme.footer.muted}>{"  y allow · n refuse"}</text>
    </box>
  )
}

export const App = (props: {
  entries: ReadonlyArray<Entry>
  status: Status
  handle: Handle
  drainSettled: () => ReadonlyArray<Entry>
  footer: FooterView
  rewind: Rewind
  /** Which model and workspace are behind this. See `Sink.setBackend`. */
  backend: string
  views?: Readonly<Record<string, ToolView>>
}) => {
  const renderer = useRenderer()
  const views = () => props.views ?? defaultViews
  const dimensions = useTerminalDimensions()
  const policy = () => widthPolicy(dimensions().width)

  /** Nowhere to go back to from the first turn. */
  const canRewind = () => props.rewind.depth > 1

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
    if (props.footer.type !== "prompt") return
    if (key.ctrl !== true || String(key.name ?? "").toLowerCase() !== "r") return
    if (!canRewind()) return
    props.handle.rewind()
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
  createEffect(() => {
    props.entries.length
    queueMicrotask(() => {
      for (const entry of props.drainSettled()) {
        writeSolidToScrollback(renderer, () => <EntryView entry={entry} />)
      }
    })
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
        {/* Named before the hints, and kept at the narrowest width the
            footer still draws anything at: which backend is running changes
            what the transcript above *means*, so it is the last thing to go. */}
        <Show when={props.backend !== ""}>
          <text fg={theme.footer.muted}>{`   ${props.backend}`}</text>
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
        <Match when={props.footer.type === "prompt"}>
          <box border borderColor={theme.footer.border} marginTop={1}>
            <input
              focused
              placeholder="message…"
              onSubmit={(value: unknown) => {
                // The element types `onSubmit` as accepting either shape; only
                // the string form carries what was typed.
                if (typeof value !== "string") return
                const text = value.trim()
                if (text.length > 0) props.handle.submit(text)
              }}
            />
          </box>
        </Match>
      </Switch>
    </box>
  )
}
