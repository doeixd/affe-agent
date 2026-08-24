# Plan: session tree, with a TUI as the driving use case

Third in the series, after [plan-opencode-tools-port.md](./plan-opencode-tools-port.md)
and [plan-pi-toolkit.md](./plan-pi-toolkit.md). Feasibility, constraints and a
working spike are in [research-session-tree.md](./research-session-tree.md);
this is the build.

Sources read directly: [`earendil-works/pi`](https://github.com/earendil-works/pi)
at commit `dcd461925db2edf69a43c8135db1180d418afd54`.

## Goal

Branch and rewind a conversation, and give a terminal UI everything it needs to
show and drive that — **without building a TUI**. The deliverable is the
substrate: a tree over sessions, and the observation surfaces a renderer needs.
Which framework paints it is the application's business, exactly as the model
provider is.

## What the research already settled

- **It works on today's primitives with no core change.** The spike branched
  two sessions from one snapshot; both diverged, the trunk was untouched.
- **Nodes must sit at turn boundaries.** `assistant[tool-call]` and
  `tool[tool-result]` are one atomic unit; slicing between them yields a
  conversation providers reject. `snapshot` already refuses a busy session,
  which is the enforcement.
- **Branching forks the conversation, not the world.** Files, `AgentState` and
  memory are services and are shared. Pi draws the same line deliberately.
- **The tree owns the agent**, so every session it returns is
  `AgentSession<Tools, E>` by construction and no cast is needed anywhere.

## What the TUI requirement changes

Two things the research left open are now decided.

**Lanes are wanted.** The research asked whether named heads earn their keep
without a UI. With a TUI they plainly do: a lane is what a branch selector
lists and what "switch back to what I was doing" means.

**One active branch at a time is the default.** Pi's runtime does not run
branches concurrently — it tears the current session down and starts a new one
(`teardownCurrent("fork", ...)`, then a start event carrying
`reason: "startup" | "reload" | "new" | "resume" | "fork"`). That is the right
default here too: sessions hold a scope, a fibre and an event bus, and keeping
five branches live to look at one is a cost with no return. Concurrent branches
stay *possible* — our sessions are independent — but they are opt-in, not the
model.

## Ideas worth building (and one worth refusing)

The substance of this plan. Each is here because a TUI needs it, not because
Pi has it.

**1. Auto-capture on `TurnCompleted`.** You cannot rewind to a point nobody
recorded. A tree that only captures on explicit `commit` gives a user "rewind"
that quietly cannot reach most of the conversation. Subscribing to the session
event stream and capturing at every turn boundary makes rewind mean what a user
thinks it means — and turn boundaries are exactly the safe points.

**2. An active-branch event stream that survives a switch.** The single
biggest TUI ergonomic. A renderer wants *one* stream for the lifetime of the
app, not a resubscribe dance every time the user switches branch. The tree
exposes `tree.events` which follows the active branch — a switch ends the inner
subscription and begins the next, and the renderer never notices. Without this,
every TUI author writes the same fiddly swap by hand and gets the interleaving
subtly wrong.

**3. Replay, then live.** On switching to a branch the renderer must draw what
is already there before new events arrive. `tree.activate(node)` should hand
back both the history to paint and the stream to follow, in that order, rather
than leaving the caller to stitch a snapshot onto a live stream and hope
nothing arrived in between. Note it hands back a *materialised* history rather
than exposing storage — see T1 on why `Node` carries no history field.

**4. Node metadata a selector can render.** A tree view needs more than
parentage: a `cause` (`prompt` / `compaction` / `fork` / `manual`) to pick a
glyph, a timestamp, a turn count, an optional user label, and a short auto
preview (first user message of the node's last turn, truncated) so an unlabelled
node is still recognisable. Cheap to derive, and the difference between a usable
selector and a list of ids.

**5. Divergence and common ancestor.** Parent pointers make
`commonAncestor(a, b)` and "what differs between these branches" trivial to
compute, and they are what lets a TUI draw the tree properly — and lets a user
answer "what did I actually change by going this way?".

**6. Lifetime ownership, stated — and `RcMap` states it.** Sessions are scoped.
If the tree hands out sessions it must say who closes them: the tree owns a
scope per activated branch and closes it on switch (the Pi model), while an
explicitly *concurrent* branch is the caller's to hold. Getting this wrong leaks
fibres, which in a long-lived TUI is the failure that shows up an hour in.

Note the two halves of that sentence are one primitive. A branch is a keyed,
scoped resource with a varying number of holders — the active one, plus any
concurrent branch the caller kept — and it should be released when the last
holder goes, not when the tree guesses. **`RcMap` is that**
([audit-effect-ecosystem.md](./audit-effect-ecosystem.md) E4), and using it
means IT4 stops being a discipline the tree enforces by hand and becomes a
property of the structure holding the branches. It also makes "activate A, B, A"
cheap: re-activating a branch somebody still holds finds it live rather than
rebuilding it.

**7. Busy is a first-class state.** `snapshot` refuses a running session, so
"branch from here" must be disabled — not attempted and failed — while a turn
is in flight. `AgentSession.state(session)` already streams status; the tree
should surface it so a renderer can grey the affordance rather than surprise
the user with an `AgentBusyError`.

**8. Persistence for free.** `Snapshot` is Schema-defined, so a node store is
an ordinary store and a TUI that survives restart needs no new machinery —
follow `DurableSessionStore`, don't change it.

**9. Branch summarisation on abandon (optional, later).** Pi summarises a
branch it leaves (`branch-summarization.ts`) so the trunk can carry what was
learned. We already have `/compaction`; this is a composition of existing
parts, and it is the kind of thing to add once the tree is real rather than to
design speculatively.

**10. Protocol projection (optional, later).** `/ag-ui` already converts an
event stream into a UI protocol and `/data` forwards typed output. If a tree
is worth showing in a terminal it is worth showing in a browser, and the tree's
own changes (node added, branch switched) are events like any other. Worth
keeping the tree's event shape compatible with that from the start, and
worth *not* building until someone asks.

**One to refuse: a TUI framework.** Pi ships one, and its `tui-plan.md` is a
serious piece of work about component trees, layout trees and hit testing.
That is a rendering library, and this library has no business growing one. We
provide state, history, streams and a tree; painting is the application's.

Two corollaries, from [audit-effect-ecosystem.md](./audit-effect-ecosystem.md)
E6. **`effect/unstable/reactivity` does not belong in `apps/tui`** — OpenTUI and
Solid bring their own reactive system, and running two is worse than running
either; the tree's `events` stream is the seam between them. And the *other*
consumer of this tree is a **CLI** on `effect/unstable/cli` and `Terminal`,
which ROADMAP names as the top remaining ecosystem gap. A CLI needs everything
T1-T5 build and none of the painting, which makes it the cheaper proof that the
tree API is right — worth keeping in view while designing T3's activation, so
the API does not accidentally assume a long-lived renderer.

## Invariants

**IT1 — Every node is at a turn boundary.** A node is only ever captured from
an idle session, so no node records a conversation that never existed.

**IT2 — A branch never reuses a session id.** `restore` keeps identity because
resuming is the same session continuing; branching is a different session and
must be traceable as one.

**IT3 — The trunk is immutable to its branches.** Anything done on a branch
leaves ancestors byte-identical. (Already tested in the spike.)

**IT4 — Switching branches leaks nothing.** Activating a branch releases the
previously activated one's scope; after N switches, one session is live.

**IT5 — The tree hands out precisely typed sessions.** Everything returned is
`AgentSession<Tools, E>` inferred from the agent the tree was built with, with
no cast in the library or the caller.

**IT6 — The world is not branched, and the API says so.** Documented at the top
of the module, because "rewind" reads like undo and is not.

## Milestones

### T1 — The tree, in memory

`NodeId`, `SessionTree.make(agent)` owning the agent; `commit`, `branch`,
`path`, `children`, `root`. Fresh session id per branch. Tests for IT1, IT2,
IT3, IT5.

**The shape of `Node` is the one decision here that is expensive to change**,
because it decides whether T5 can adopt delta storage without breaking every
caller:

```ts
interface Node {
  readonly id: NodeId
  readonly parent: Option<NodeId>
  readonly cause: NodeCause
  readonly at: number
  readonly label: Option<string>
  // deliberately no history, and no snapshot
}

tree.historyOf(node): Effect<Prompt.Prompt, NodeMissing>
```

The rule: **bounded metadata lives on the value; unbounded content lives behind
an operation.** A `snapshot` field would freeze the representation into the
type — every node would have to hold a fully materialised history for ever, and
the delta storage T5 wants would be a breaking change. An `Effect` can read
from memory, walk deltas to the root, or hit a database; it can be async; and
it can *fail* when a node is missing, which a field cannot express at all.

The reinforcing detail is that `branch(node)` never exposes history: it
materialises internally and calls `AgentSession.make`. So `historyOf` exists
only for rendering, and the common path is independent of how nodes are stored.

`AgentSession.Snapshot` remains exactly right as the *transport* for one node's
history — it is Schema-defined and crosses processes — but it is what
`historyOf` produces, not what a `Node` is.

**T1: landed (2026-08-24).** `src/tree/SessionTree.ts` and
`test/SessionTree.test.ts` (6 tests). No core change, as the spike predicted.

`Node` carries id, parent, cause, timestamp and label -- **no history and no
snapshot field**, with a compile-time assertion saying so, because that is the
decision T5 cannot afford to have made wrongly. `historyOf` is an `Effect`, so
a later store can hold whole snapshots, walk deltas, or read a database without
any caller noticing.

**Deliberately not exported.** `src/tree/` is absent from `src/index.ts` and
from `package.json`. The scope rule that held M6 applies here too -- a new
exported concept wants a second consumer or a recorded decision in `PLAN.md` --
so the module is built and tested while the *export* stays an open decision.
Nothing is blocked by that: the TUI imports source directly.

**The tests found two real bugs**, both of which would have been invisible
until someone used the feature:

- **IT2 was violated by the default naming.** Branch sessions were named
  `${node.id}-branch`, so branching *twice from one node* produced two sessions
  with the same id -- which also conflated them in the tree's own bookkeeping,
  since that map is keyed by session id. Branches are now numbered
  independently of nodes.
- **A node from another tree was not refused.** Every tree started its counter
  at one, so two trees both minted `node-1`, and `historyOf` answered for the
  wrong tree's node -- returning a different conversation rather than failing.
  Node ids now carry a per-tree prefix. Ids are unique per process, which is
  all an in-memory tree needs; a persisted tree (T5) needs ids that survive
  one, and that is now a documented requirement rather than a latent bug.

The second is the more interesting failure: it is exactly the class of error a
`history` *field* would have hidden, because the wrong history would simply
have been there to read. Making materialisation an operation is what gave it
somewhere to fail.

### T2 — Auto-capture and lanes

Capture on `TurnCompleted` from the session's event stream; named lanes over
leaves (`lane(name)`, `lanes()`, `switchLane`). This is what makes the tree
fill itself and what a selector lists.

**T2: landed (2026-08-24).** `track`, `lanes`, `lane`, and a `lane` option on
`branch`. 9 tree tests pass.

**One constraint the plan did not anticipate: `commit` is idle-only, but
`TurnCompleted` fires mid-submission.** A submission with three turns is
working throughout, so auto-capture cannot go through `AgentSession.snapshot` --
it would be refused every time. The idle guard is a *coarse proxy* for the
invariant that actually matters, which is "at a turn boundary"; `TurnCompleted`
is that boundary exactly, since the turn's assistant message and tool results
have been committed as a unit by the time it is published. So capture reads
`session.history` directly at that point, and the two paths -- `commit`
reaching a boundary by waiting for idle, `track` being told about one -- share
a single recorder.

**Dedup, and the design question it raised.** Recording a node when nothing has
changed leaves two nodes holding the same conversation, which a manual commit
next to an automatic one produces immediately. History is append-only, so an
unchanged `content.length` is a sound proxy for "this turn added nothing".

That broke an existing test, and the break was worth having: a
`commit({ label })` on unchanged history returned the existing *unlabelled*
node, silently discarding the caller's intent to mark that point. Neither
"always dedup" nor "always create" is right -- so a label or an explicit cause
now lands on the node already there. Marking a point adds no node, and asking
to mark one is never ignored.

**Lanes** are a name over a leaf, and they follow their session: a lane starts
at the node it branched from, so it points somewhere real before its first turn
finishes, and advances as that session records. Two lanes over one branch point
are what a selector lists.

`switchLane` from the plan's sketch is **not** here. Switching lanes means
activating a different branch -- releasing one session's scope and starting
another's -- which is T3's subject, not a naming concern.

### T3 — Activation: scopes, replay, and one stream

`tree.activate(node)` returning the history to paint plus the live stream;
tree-owned scope per active branch, released on switch (IT4); `tree.events`
following the active branch across switches; status surfaced for the busy
affordance.

**T3: landed (2026-08-24).** `activate`, `active`, `events`, `status`. 13 tree
tests pass.

**`RcMap` was the right call, and it made IT4 structural.** A branch has a
varying number of holders, and the tree should not be the one guessing when the
last of them is gone. Activation takes a reference into a scope the tree owns
and closes the previous one *after* the new one is in place -- closing first
would leave a window with nothing active, which a renderer reads as a flicker.
The test asserts release by identity rather than by inspecting a count: a
released branch is rebuilt on the way back and gets a new session id, a
retained one does not. That needs no API existing only for tests, and it fails
when the release is removed.

**The plan's `switchMap` sketch loses events, and a test proved it.** `Stream`
subscribes when it is *run*, so with `switchMap` the inner subscription is
established whenever the consumer gets around to it -- and everything the
branch emits before then is gone. The window is precisely "a first prompt right
after a switch", so the symptom is a whole turn that never appears. Measured,
the first branch's events were lost entirely while the second's arrived.

The fix is to subscribe *eagerly*, in the activation's scope, and pump into one
tree-owned `PubSub`. `tree.events` is then a plain stream over that, with no
switching in it at all. This required a new `AgentSession.subscribe` -- a
scoped subscription established at acquisition -- which is the seam `EventBus`
already anticipated in prose ("the race every `Stream` subscriber carries")
but had only offered at session construction via `sink`. It is useful well
beyond the tree: any recorder attaching to a session already in flight has the
same problem.

**`activate` returns history and session together** for the same reason:
fetching a snapshot and then subscribing misses the gap between them, and
subscribing first paints an empty transcript.

**T3, second pass: wired into the TUI (2026-08-24).** Ctrl+R rewinds a turn.
45 smoke assertions, 14 tree tests.

Giving the tree a second consumer was the point, and it found three things no
amount of re-reading the tree in isolation would have.

**`tree.active` answered the wrong question.** It returned the node that was
activated -- where the branch *started* -- and never advanced as turns were
recorded. Rewind counts back from "where the user is now", so with a stale
answer it walked to the branch point's parent every time and refused outright
from the second turn on. The fix routes `active` through the same `at` map that
`record` advances. Broken once to confirm the test bites.

**The tree dropped the caller's session configuration.** `AgentSession.make`
takes `elicitation`, and the tree passed none -- so every branch it built
*refused* any run needing approval rather than asking. Nothing in the types
said so, and the failure surfaces as a permission denial with no question. The
tree now takes a `session` option and forwards it, minus `sessionId` and
`history`, which are its own to decide.

**`Node.parent` is an id, so walking upwards needed `node(id)`.** That is not a
TUI quirk: an id rather than a reference is what keeps a node serialisable, and
anything walking the tree has the same need.

**Rewind does not erase the transcript, and should not.** Scrollback is
write-once -- a committed line cannot be repainted -- so a UI built on it can
either abandon scrollback or be honest that what was shown was shown. A rewind
is *marked*, and what follows continues from the earlier point. The log then
records that a rewind happened, which is both true and what a reader wants.
Repainting only matters when switching to a branch whose history was never on
screen, which is a session switcher rather than a rewind.

**One thing tried and reverted.** The transcript's drain effect depends on
`entries.length`, which misses a `patch` that settles the last entry. Replacing
that with a write counter fixed the narrow case and stalled the renderer, and
reading each entry's fields instead makes the effect retrigger itself through
its own drain. The defect is real but masked -- a turn summary always follows
the last tool result -- so it stays noted rather than half-fixed.

### T4 — Metadata and shape queries

`cause`, timestamps, turn counts, labels, auto preview; `commonAncestor`,
divergence between two nodes. The renderer-facing half.

**Check `Graph` before hand-rolling the walks** ([audit-effect-ecosystem.md](./audit-effect-ecosystem.md)
E5). This milestone is, read plainly, a list of graph algorithms over a
structure T1 stores as parent pointers, and `effect/Graph` has never been
imported in this repository. The question to settle in writing is whether it
carries the shape we need — nodes appended one at a time, every ancestor
immutable (IT3), and a store behind it (T5) — or whether it assumes a graph
built and then queried.

If it fits, T4 is traversals we do not write and do not test. If it does not,
keep the parent-pointer map and **record why here**: audit A3 counts an
unanswered evaluation as worse than an unasked one, because it reads as decided.
Either way this is a T4 question, not a T1 one — T1's discipline of keeping
history out of `Node` is what leaves the choice open this late.

**T4: the `effect/Graph` evaluation, settled (2026-08-24).** Not used. Parent
pointers stay. The plan asked for this to be recorded either way, so here is
the reasoning rather than the verdict alone.

**`Graph` copies on every append, and we append once per turn.** Mutation goes
through `beginMutation` / `endMutation`, and `beginMutation` calls
`internal.clone`, which rebuilds `nodes`, `edges`, and *both* adjacency maps:

```ts
graph.nodes = new Map(source.nodes)
graph.edges = new Map(source.edges)
graph.adjacency = cloneAdjacency(source.adjacency)
graph.reverseAdjacency = cloneAdjacency(source.reverseAdjacency)
```

Our access pattern is one node appended per turn boundary, forever. That is
O(n) per turn and O(n²) over a session, to maintain two adjacency structures
for a graph whose out-degree we never query by edge. This is not a criticism of
`Graph` -- it is built to be constructed and then queried, which the module's
own shape says plainly -- it is a statement that our pattern is the other one.

**The queries T4 actually needs are not in `Graph`.** Its surface is a weighted
general-graph toolkit: `dijkstra`, `bellmanFord`, `astar`, `floydWarshall`,
`topo`, strongly-connected components, minimum spanning forest. What T4 wants
is a lowest common ancestor and the two divergent runs below it. Neither is
there, so they would be hand-rolled *anyway* -- on top of an index indirection
we do not currently have, since `Graph` identifies nodes by `NodeIndex`
(a `number` it assigns) while ours are strings that must survive serialisation.
Adopting `Graph` would mean maintaining a `NodeId <-> NodeIndex` map for the
privilege of writing the same walks.

**With parent pointers those walks are the trivial ones.** A rooted tree where
every node knows its parent answers all of T4 in O(depth) with no adjacency
structure at all: `path` is a `while` loop, `commonAncestor` is two paths and a
set, and divergence is the two suffixes after the fork.

**What would change the answer.** If the tree ever grows queries that are
genuinely graph-shaped -- shortest path under weights, cycles, topological
order over a DAG of merges -- reopen this. A merge in particular would make
`parent` a list rather than an `Option` and the structure would stop being a
tree, which is the point at which a graph library earns its indirection.

**T4: landed (2026-08-24).** `summary`, `commonAncestor`, `divergence`. 18 tree
tests. Every new invariant broken once to confirm its test bites.

**`Summary` exists so a selector need not materialise conversations.** Drawing
a list of twenty branch points wants a label, a size, and enough text to
recognise -- and reaching for `historyOf` to get that means holding twenty
whole conversations to draw one list. Counting and excerpting happen inside the
tree; only the summary escapes.

`messages` and `added` are kept apart deliberately. Conflating them makes every
node look identical once the transcript is long, because the interesting number
is what *this* turn contributed.

**The preview takes the user's words, not the model's.** A branch is remembered
by what was asked of it. Whitespace collapses because the destination is one
row in a list: a pasted stack trace has to occupy a row, not thirty.

**`commonAncestor` and `divergence` are one walk, not two.** Both paths to the
root, compared as prefixes -- the last shared element is the deepest common
ancestor and the two suffixes are what a diff view draws side by side.
Implementing `divergence` in terms of `commonAncestor` would walk twice for
answers that fall out of the same comparison.

Sharing no ancestor is an answer (`None`), not a failure. One tree can hold two
unrelated roots, because a tree records whatever sessions it is given.

### T5 — Persistence

A node store behind an interface, in-memory by default, with a Schema-backed
implementation following `DurableSessionStore`. A tree survives a restart.

This is where T1's discipline pays: the store decides the representation, and
the tree API does not change.

```ts
interface NodeStore {
  readonly put: (node: Node, history: Prompt.Prompt) => Effect<void, StoreError>
  readonly historyOf: (id: NodeId) => Effect<Prompt.Prompt, NodeMissing | StoreError>
  readonly children: (id: NodeId) => Effect<ReadonlyArray<Node>, StoreError>
}
```

Note this store is the same append-only commit log that
[plan-snapshot-export.md](./plan-snapshot-export.md) wants as its export
format -- one mechanism, seen from two directions. Build it once.

- **In memory:** keep the `Prompt` as given. Message objects are already shared
  between nodes, so this is close to free.
- **Delta:** keep only what a node appended to its parent, and materialise by
  walking to the root. O(depth) per read, cacheable, and it removes the
  quadratic write amplification.

"Cacheable" should mean `Cache`, not a `Map` we maintain
([audit-effect-ecosystem.md](./audit-effect-ecosystem.md) E12). Materialised
history is the textbook case for it: keyed by `NodeId`, expensive to compute,
immutable once computed (IT3 guarantees an ancestor never changes, so an entry
can never go stale), and needed repeatedly as a TUI user walks around the tree.

A conformance suite written once against the interface and run against both is
how they stay honest -- `test/DeliveryLogContract.ts` and
`test/AgentClientContract.ts` are the existing pattern for exactly this.

`NodeStore` is also the third hand-rolled `interface Store` in this repository,
after `state/AgentState.ts` and `durable/DurableChannels.ts` (audit E3). If the
`effect/unstable/persistence` evaluation in
[plan-durability-hardening.md](./plan-durability-hardening.md) H4b lands before
T5, take its answer rather than re-deriving one — the conformance suite above is
worth writing once, not three times.

## Success conditions

- **ST1:** The spike's divergence test passes through the public tree API
  rather than by hand.
- **ST2:** After activating branches A, B, A again, exactly one session is
  live and no fibre leaks — asserted, not assumed.
- **ST3:** A renderer written against `tree.events` observes an unbroken stream
  across a branch switch, with the branch's existing history delivered before
  any live event.
- **ST4:** Rewinding to any auto-captured node produces a history a provider
  accepts — specifically, no assistant tool-call without its result.
- **ST5:** Every invariant IT1–IT6 has a test that fails when it is broken.
- **ST6:** An example (`examples/session-tree.ts`) branches, switches and
  renders to plain stdout, typechecked in CI, showing the substrate is enough
  to build a UI on without being one.

## Risks and open questions

- **Auto-capture costs memory — but far less than it appears, and the
  difference decides where to spend effort.** Measured rather than assumed:
  `History.commit` appends with `Prompt.concat`, which builds a new array while
  keeping the **same message objects**. Two snapshots of one session hold
  different arrays whose every element is shared by reference. So in memory a
  tree of N nodes costs O(N²) *pointers*, not bytes — roughly 80 KB at 100
  turns, 8 MB at 1000 — while message text and tool output are stored exactly
  once however many nodes point at them. That is not a problem worth solving.

  **Serialisation is where it is a problem.** Encoding a `Snapshot` writes the
  whole transcript, so persisting 100 nodes writes the transcript 100 times:
  genuinely O(N²) bytes, and quadratic in the length of the session. The fix is
  delta storage (a node records the messages appended since its parent, and a
  read walks to the root) — Pi's model, and the reason their unit of storage is
  the entry rather than the conversation. It belongs to T5, not T1.
- **`AgentBusyError` versus a UI's expectations.** A user hitting "branch"
  mid-turn wants *something* to happen. Interrupt-then-branch is a plausible
  affordance, but it is a policy decision, and belongs to the application
  rather than the tree.
- **Open: does activation close the old session or detach it?** Closing is
  simple and matches Pi. Detaching allows returning to a warm branch instantly.
  Decide with a real TUI in front of us, not before.
- **Open: is `PLAN.md` the right home for the decision?** This is a new
  exported concept, so the scope rule applies as it did to M6 — with the
  difference that `PLAN.md` already contemplates `Persistence`, `Memory` and
  `Compaction`, and a session tree is a near neighbour of all three rather than
  a new kind of thing.

## Non-goals

A TUI framework, a renderer, keybindings, or a component model. Branching the
filesystem or agent state. Changing `Sandbox`, `Permission`, or the agent core.
Pi's entry-log storage format — we branch snapshots, and if structural sharing
is needed later it is an implementation change behind T1's API, not a format we
adopt wholesale.
