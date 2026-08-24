# Research: session trees on our primitives

Can Pi's branch-and-rewind session tree be built on top of what this library
already has — without changing the core, keeping types precise, and composing
with the rest?

**Short answer: yes, and a working spike proved it before this was written.**
Two branches diverged from one trunk with zero core changes. The interesting
part is not feasibility; it is the three constraints the spike surfaced, one of
which is a trap that any naive implementation walks straight into.

Sources: [`earendil-works/pi`](https://github.com/earendil-works/pi) at commit
`dcd461925db2edf69a43c8135db1180d418afd54`, read directly; our own
`AgentSession.ts`, `ContextTransform.ts`, `AgentEvent.ts`, `state/`.

## What Pi actually does

Not a tree of *sessions* — a tree of **log entries**.

```ts
interface EntryBase {
  type: string
  id: string
  seq: number            // shared sequence; storage-assigned
  parentId: string | null // storage-assigned: the appending lane's leaf
  timestamp: number
}
```

- Entry types are `message`, `model_change`, `thinking_level_change`,
  `active_tools_change`, `compaction`, and `branch_summary`. The conversation
  is one kind of entry among several; **changing model or tool set is recorded
  in the same log**, so a branch replays the settings it was made under.
- **A branch is a path, not a copy.** `findEntriesOnBranch` walks `parentId`
  from a leaf to the root; the message list handed to the model is that walk.
- **Lanes** are named leaves (`getLanes(): { lane, leafId }[]`), so a session
  has several concurrent heads rather than one cursor.
- `fork(source, options)` where
  `ForkOptions = { scope?: "branch"; entryId?: string; position?: "before" | "at" } | { scope: "tree" }`
  — fork a branch at an entry, or the whole tree.
- **Global facts are deliberately not branch-scoped**: the types say
  *"Global facts. Latest wins; not branch-scoped. 'set', not 'append'"*. Pi
  drew a line between conversation (branched) and facts (shared). That line
  matters for us too, and for the same reason.

## What we already have

Every piece needed is present and public:

| Primitive | What it gives a tree |
| --- | --- |
| `AgentSession.Snapshot` = `{ sessionId, history }`, **Schema-defined** | The node. Serialisable, so it persists and crosses processes like anything else here. |
| `AgentSession.snapshot(session)` | Capture a node. **Idle-only** — fails `AgentBusyError` when a run is in flight. |
| `AgentSession.make(agent, { history, sessionId })` | Start a session mid-conversation. This is the fork. |
| `AgentSession.restore(agent, snapshot)` | Resume — same `sessionId`. Right for resume, **wrong for a branch**, which needs a fresh identity. |
| `AgentEvent.TurnCompleted` | Where a node may safely be taken. |
| `ContextTransform` | Per-turn projection of canonical history; untouched by branching. |

The docstring on `snapshot` already states the invariant a tree depends on:

> A running session's history is mid-flight — a turn may be about to commit an
> assistant message and its tool results as one unit — and a snapshot taken
> between those would record a conversation that never existed.

## The spike

One trunk exchange, snapshot, then two sessions seeded from that snapshot and
prompted differently:

```
node history messages: 3      (system, user, assistant)
left messages:  5             shared prefix + "go left"  + its answer
right messages: 5             shared prefix + "go right" + its answer
trunk messages: 3             untouched by either branch
```

Each branch contained the shared prefix and only its own continuation; neither
leaked into the other or into the trunk. **No core change, no cast.** The whole
fork is:

```ts
const node = yield* AgentSession.snapshot(trunk)
const branch = yield* AgentSession.make(agent, {
  history: node.history,
  sessionId: freshId()
})
```

## Constraint 1 — you cannot cut history wherever you like

The trap. A tool turn's history looks like this (dumped from a real run):

```
0:system[-]  1:user[text]  2:assistant[tool-call]  3:tool[tool-result]  4:assistant[text]
```

Indices 2 and 3 are **one atomic unit**. Slicing between them yields an
assistant message with a tool call and no result — which providers reject
outright. So a tree whose "rewind to message N" is `history.content.slice(0, n)`
is broken for every conversation that used a tool, which is every interesting
one.

Two sound options:

1. **Nodes only at turn boundaries.** Capture on `TurnCompleted` (or on demand
   while idle, which `snapshot` already enforces). Every node is then valid by
   construction, and this is the option to take.
2. Validate and repair an arbitrary slice — drop a trailing partial turn. More
   flexible, more ways to be subtly wrong, and it re-implements a rule the
   engine already knows.

Pi does not have this problem because its unit of storage is the entry and its
message entries are appended already-committed; the equivalent care lives in
its reducer.

## Constraint 2 — branching the conversation does not branch the world

The most important finding, and the one most likely to surprise a user.

A branch forks *history*. It does not fork:

- **The filesystem.** A tool that wrote a file on branch A wrote it for branch B
  too. `Sandbox` is a service, not conversation state.
- **`AgentState`.** By design — the module's own docstring says state "belongs
  in ordinary Effect services, so the harness never becomes a competing
  state-management system". Services are not branch-scoped.
- **Memory**, for the same reason.

This is not a defect to fix; it is the same line **Pi draws explicitly** with
"global facts, latest wins, not branch-scoped". But it must be documented at
the top of any tree API, because "rewind and try again" reads like undo and is
not: the model forgets, the world does not. A tree over a sandbox that supports
snapshotting could offer real undo, which is a much larger and separate idea.

## Constraint 3 — a snapshot is not bound to an agent

`Snapshot` is `{ sessionId, history }`. Nothing ties it to the agent whose
tools produced it, so a snapshot from agent A can be restored into agent B
whose toolkit lacks the tools its history references. Types cannot fix this on
the snapshot itself: it is Schema-defined precisely so it can be serialised, and
a phantom type parameter does not survive a round trip through a database.

The fix is API shape, not type gymnastics: **let the tree own the agent.**

```ts
const tree = yield* SessionTree.make(agent)        // Tools captured once, here
const node = yield* tree.commit(session)           // capture a node
const branch = yield* tree.branch(node)            // => AgentSession<Tools, E>
```

Every session the tree hands back is `AgentSession<Tools, E>` by construction,
inferred from `agent`, with no cast anywhere — and the unsafe operation
(grafting an arbitrary snapshot onto an arbitrary agent) is simply not
exposed. This is the same trick `Agent.toolkit` uses: bind once where the type
is known, hand out precise types thereafter.

## Composability

- **`ContextTransform`** — unaffected. It derives the model prompt from
  canonical history each turn; a branch is just a session with different
  canonical history.
- **Compaction** — already rewrites history, so a compaction is naturally a new
  node. Pi agrees, modelling `compaction` and `branch_summary` as entry types.
  Worth recording *why* a node exists (`prompt` / `compaction` / `fork`), which
  is Pi's `cause` field.
- **Durable** — `Snapshot` is Schema-defined, so a node store is an ordinary
  store; `DurableSessionStore` is the pattern to copy, not to change.
- **Events** — `TurnCompleted` is the auto-capture hook, so a tree can be built
  as an event consumer with no polling.
- **Permission / sandbox** — untouched; see constraint 2 for what that means.

## Sketch

A separate module, no core change:

```ts
NodeId                                  // branded
Node = { id, parent: Option<NodeId>, cause, snapshot: Snapshot, at }
SessionTree.make(agent, store?)         // owns the agent; store defaults in-memory
  .commit(session, cause?)  : Node      // idle-only, inherits snapshot's rule
  .branch(node)             : AgentSession<Tools, E>   // fresh sessionId
  .lane(name)               : Option<Node>             // named leaves, as Pi has
  .path(node)               : ReadonlyArray<Node>      // node to root
  .children(node)           : ReadonlyArray<Node>
```

Invariants worth holding: a node is always at a turn boundary; `branch` never
reuses a `sessionId`; the trunk is unaffected by anything done on a branch
(the spike already tests this); and the tree refuses to capture a busy session
rather than recording a conversation that never happened.

## Recommendation

Feasible, genuinely useful, and cleanly separable — it needs no core change and
no new seam, which puts it in a very different position from the web tools of
M6. The three constraints are all addressable, and two of them (turn-boundary
nodes, tree-owns-agent) are just design choices to make deliberately rather
than problems to solve.

Before building, one thing is worth deciding: whether **lanes** are wanted or
whether parent pointers alone are enough. Lanes are what make Pi's tree usable
interactively (several named heads you switch between); without a TUI the same
value may come from the caller just holding node handles. That is a genuine
open question, not one to settle by copying.

The scope rule applies as it did to M6: this would be a new exported concept,
so it wants either a second consumer or a recorded decision in `PLAN.md` — with
the difference that `PLAN.md` *does* already contemplate this territory
(`Persistence`, `Memory`, `Compaction` are all listed), and a tree is a closer
neighbour to those than a network seam was to anything.
