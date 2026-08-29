import {
  Clock,
  Effect,
  Equal,
  Exit,
  Option,
  RcMap,
  PubSub,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import type { LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import type { AgentDefinition } from "../Agent.js"
import type { AgentEventEnvelope } from "../AgentEvent.js"
import * as AgentSession from "../AgentSession.js"
import * as NodeStore from "./NodeStore.js"

/**
 * Branch and rewind a conversation.
 *
 * A tree of *nodes*, where a node is a point a session can be resumed from and
 * a branch is a session seeded with that node's history. Built entirely on the
 * existing primitives -- `AgentSession.snapshot` captures a node,
 * `AgentSession.make({ history })` starts one from it -- so nothing in the core
 * changes to support this. See `docs/research-session-tree.md` for the spike
 * that established that, and `docs/plan-session-tree.md` for the design.
 *
 * **Branching forks the conversation, not the world.** Files a tool wrote,
 * `AgentState` and memory are services: they are shared by every branch and
 * are not rewound. "Rewind and try again" therefore reads like undo and is
 * not -- the model forgets, the world does not. Anything that must be undone
 * with a branch needs its own mechanism.
 *
 * The tree owns the agent, which is what makes it type-safe: every session it
 * hands back is `AgentSession<Tools, E>` inferred from that agent, and the
 * unsafe operation -- grafting an arbitrary snapshot onto an arbitrary agent --
 * is simply not exposed. A `Snapshot` is Schema-defined so it can be
 * serialised, and no phantom type survives that, so the binding is made once
 * here instead.
 */

/**
 * Re-exported from `NodeStore`, which is where they are now declared.
 *
 * A node has to be *persisted*, and the schema that writes it belongs beside
 * the thing doing the writing -- otherwise the two definitions drift and a
 * store round-trips a node into something subtly different. They are still
 * named here because this is the module a caller reaches for.
 */
export { Node, NodeCause, NodeId, StoreError } from "./NodeStore.js"
export type { Held, NodeStore } from "./NodeStore.js"

type Node = NodeStore.Node
type NodeId = NodeStore.NodeId
type NodeCause = NodeStore.NodeCause

// The brand exists to stop a bare string being passed where a node id belongs;
// minting one is this module's own business, so the assertion is absorbed here
// exactly as `internal/ids.ts` does for session and run ids.
const nodeId = (value: string): NodeId => value as NodeId

/**
 * Distinguishes one tree's nodes from another's.
 *
 * Without it every tree starts counting at one, so two trees mint the same
 * ids and `historyOf` happily answers for a node belonging to a different
 * tree -- returning the wrong conversation rather than refusing.
 *
 * Random rather than a process counter, which is what this was. A counter
 * resets when the process does, so reopening a persistent store and
 * committing produced `t1-node-1` again: the same id as an existing ancestor,
 * whose history it would then overwrite while the indexes went on describing
 * the old one. "Unique per process" is exactly the wrong scope for a store
 * that outlives the process, and a test that rebuilds a tree in *one* process
 * cannot show it, because the counter has moved on by then.
 *
 * Sixteen hex digits from the platform's CSPRNG: a tree is created at most a
 * few times per process, so the collision probability is not a number worth
 * writing down, and the value stays short enough to read in a log.
 */
const treePrefix = (): string => {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The stored tree is not a tree.
 *
 * Distinct from `NodeMissing`, which is an ordinary answer about an id that
 * is not here. This says the structure itself is wrong -- a node reachable
 * from its own ancestry -- which no sequence of legal operations can produce
 * and which a walk cannot recover from by continuing.
 */
export class TreeCorrupt extends Schema.TaggedError<TreeCorrupt>()(
  "@doeixd/effect-agent/tree/TreeCorrupt",
  { id: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `Session tree is corrupt at node ${this.id}: ${this.detail}`
  }
}

/** The node is not in this tree. */
export class NodeMissing extends Schema.TaggedError<NodeMissing>()(
  "@doeixd/effect-agent/tree/NodeMissing",
  { id: Schema.String }
) {
  override get message() {
    return `No such node in this tree: ${this.id}`
  }
}

/**
 * A session that is not idle cannot be captured.
 *
 * Inherited from `AgentSession.snapshot`, and the reason is the invariant the
 * whole tree rests on: a turn commits an assistant message and its tool
 * results as one unit, so a node taken mid-turn would record a conversation
 * that never existed -- and every branch from it would start from one.
 */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()(
  "@doeixd/effect-agent/tree/SessionBusy",
  { sessionId: Schema.String }
) {
  override get message() {
    return `Cannot capture a node from a running session: ${this.sessionId}`
  }
}

/**
 * The session cannot be captured because it is finished.
 *
 * Distinct from `SessionBusy`, and the distinction is the whole point: busy
 * means "try again in a moment", closed means "never". Collapsing them into
 * one error tells a caller to retry forever against a session that will not
 * come back.
 */
export class SessionClosed extends Schema.TaggedError<SessionClosed>()(
  "@doeixd/effect-agent/tree/SessionClosed",
  { sessionId: Schema.String }
) {
  override get message() {
    return `Cannot capture a node from a closed session: ${this.sessionId}`
  }
}

export interface CommitOptions {
  readonly cause?: NodeCause | undefined
  readonly label?: string | undefined
}

/**
 * A named leaf.
 *
 * What a branch selector lists, and what "go back to what I was doing" means.
 * A lane follows its session: as that session commits, the lane advances to
 * the newest node, so the name always points at the tip of that line of work
 * rather than at where it started.
 */
export interface Lane {
  readonly name: string
  readonly leaf: Node
}

/**
 * The branch that is currently in front of the user.
 *
 * `history` is what to draw *before* following `events`, and handing both back
 * together is the point: a caller that fetched a snapshot and then subscribed
 * would miss anything that arrived in between, and one that subscribed first
 * would draw an empty transcript.
 *
 * It is the *session's* conversation as of activation, not the node's. Those
 * differ exactly when the branch is already live -- re-activating the node in
 * front of the user -- and the node's copy would then be short by every turn
 * taken since. Use `historyOf` for what the node itself holds.
 */
export interface Activation<Tools extends Record<string, Tool.Any>, E> {
  readonly node: Node
  readonly session: AgentSession.AgentSession<Tools, E>
  readonly history: Prompt.Prompt
}

/**
 * What a node holds, without handing over the conversation.
 *
 * A selector draws a list of branch points: each needs a label, a size, and
 * enough of the text to be recognised. Reaching for `historyOf` to get that
 * would mean holding every branch's full conversation in memory to draw one
 * list -- so the counting and the excerpting happen here, and only the summary
 * escapes.
 */
export interface Summary {
  readonly node: Node
  /** Messages in this node's conversation. */
  readonly messages: number
  /**
   * Messages this node's turn added.
   *
   * Zero at a root, and never negative: history is append-only, so a node
   * always holds at least what its parent held.
   */
  readonly added: number
  /** How many turn boundaries lie between the root and here, inclusive. */
  readonly depth: number
  /**
   * The newest user message, as one line.
   *
   * The user's words rather than the model's: a branch is remembered by what
   * was asked of it. `None` when the turn added no user message, which is what
   * a tool-only continuation looks like.
   */
  readonly preview: Option.Option<string>
}

/**
 * Where two lines of work parted, and what each did afterwards.
 *
 * The shape a diff view wants: one shared prefix, then two runs to show side
 * by side. `at` is the last node they share -- `None` only when they come from
 * different roots, which one tree can hold if it was given two unrelated
 * sessions.
 */
export interface Divergence {
  readonly at: Option.Option<Node>
  /** Nodes below the fork on the first branch, root-first. Empty if it *is* the fork. */
  readonly left: ReadonlyArray<Node>
  readonly right: ReadonlyArray<Node>
}

export interface BranchOptions {
  /** Name this line of work, so it can be found again. */
  readonly lane?: string | undefined
}

export interface SessionTree<Tools extends Record<string, Tool.Any>, E, SE = never> {
  /**
   * Capture the session's current conversation as a node.
   *
   * Idle only. The node's parent is whatever this session was last known at --
   * the node it branched from, or its own previous commit -- so committing
   * repeatedly from one session builds a chain rather than a fan.
   */
  readonly commit: (
    session: AgentSession.AgentSession<Tools, E>,
    options?: CommitOptions
  ) => Effect.Effect<Node, SessionBusy | SessionClosed | SE>

  /**
   * Start a session from a node.
   *
   * A *new* session with a fresh id: resuming is the same conversation
   * continuing, branching is a different one, and the two should not be
   * confused in a log. History is materialised internally, so a caller never
   * has to know how nodes are stored.
   */
  /**
   * Capture a node at every turn boundary, for as long as the scope lives.
   *
   * Rewind is only as good as what was recorded: a tree that captures on
   * explicit commits alone offers a rewind that cannot reach most of the
   * conversation. `TurnCompleted` is the safe point -- the turn's assistant
   * message and tool results have been committed as a unit by then -- which is
   * why this does not need the session to be idle.
   */
  readonly track: (
    session: AgentSession.AgentSession<Tools, E>,
    options?: BranchOptions
  ) => Effect.Effect<void, never, Scope.Scope>

  /**
   * What a node holds, without the conversation itself.
   *
   * See `Summary`: this exists so a selector can list twenty branch points
   * without materialising twenty conversations.
   */
  readonly summary: (node: Node) => Effect.Effect<Summary, NodeMissing | TreeCorrupt | SE>

  /**
   * The deepest node both descend from.
   *
   * `None` when they share no ancestor at all. That is not an error -- one
   * tree can hold two unrelated roots, since a tree records whatever sessions
   * it is given.
   */
  readonly commonAncestor: (
    a: Node,
    b: Node
  ) => Effect.Effect<Option.Option<Node>, NodeMissing | TreeCorrupt | SE>

  /**
   * Where two branches parted, and what each did after.
   *
   * Built from one pair of walks rather than by calling `commonAncestor` and
   * then walking again: the fork and the two suffixes all fall out of the same
   * two paths.
   */
  readonly divergence: (a: Node, b: Node) => Effect.Effect<Divergence, NodeMissing | TreeCorrupt | SE>

  /** Every named leaf, in the order the lanes were first named. */
  readonly lanes: Effect.Effect<ReadonlyArray<Lane>, SE>

  /** One named leaf. */
  readonly lane: (name: string) => Effect.Effect<Option.Option<Node>, SE>

  /**
   * Put a branch in front of the user, releasing the one that was.
   *
   * Branches are reference counted, so switching away releases a branch only
   * when nobody else holds it -- and switching *back* to one somebody still
   * holds finds it live rather than rebuilding it. A branch taken with
   * `branch` is the caller's to hold and is unaffected by activation.
   */
  readonly activate: (
    node: Node,
    options?: BranchOptions
  ) => Effect.Effect<Activation<Tools, E>, NodeMissing | SE>

  /**
   * Where the active branch is *now*, if any.
   *
   * Not the node that was activated. That node is where the branch started;
   * every turn since has recorded another, and a caller asking "what is in
   * front of the user" means the latest -- it is what "go back one turn"
   * counts back from, and answering with the branch point would make rewind
   * refuse from the second turn onwards.
   */
  readonly active: Effect.Effect<Option.Option<Node>, SE>

  /**
   * The node with this id, if the tree still holds it.
   *
   * `Node.parent` is an id rather than a node -- a node holding its parent
   * would make the tree a graph of objects that cannot be serialised or
   * shared -- so anything walking upwards needs this. Rewind is the obvious
   * case: "the turn before this one" is a parent id and nothing else.
   */
  readonly node: (id: NodeId) => Effect.Effect<Option.Option<Node>, SE>

  /**
   * Every event from whichever branch is active, as one stream.
   *
   * A renderer subscribes once for the life of the application: a switch ends
   * the inner subscription and begins the next, and nothing downstream
   * notices. Without this every caller writes the same swap by hand and gets
   * the interleaving subtly wrong.
   */
  readonly events: Stream.Stream<AgentEventEnvelope>

  /**
   * The active branch's status.
   *
   * A node can only be captured from an idle session, so a UI needs this to
   * disable "branch from here" while a turn is in flight rather than offering
   * it and failing.
   */
  readonly status: Stream.Stream<AgentSession.State>

  readonly branch: (
    node: Node,
    options?: BranchOptions
  ) => Effect.Effect<
    AgentSession.AgentSession<Tools, E>,
    NodeMissing | SE,
    Scope.Scope | LanguageModel.LanguageModel
  >

  /** A node's conversation. For rendering; `branch` does not need it. */
  readonly historyOf: (node: Node) => Effect.Effect<Prompt.Prompt, NodeMissing | SE>

  /**
   * From the root down to this node.
   *
   * `TreeCorrupt` because this follows parent pointers through a store the
   * caller may have supplied: a node that is its own ancestor is refused
   * rather than walked forever.
   */
  readonly path: (node: Node) => Effect.Effect<ReadonlyArray<Node>, NodeMissing | TreeCorrupt | SE>

  readonly children: (node: Node) => Effect.Effect<ReadonlyArray<Node>, SE>

  readonly root: Effect.Effect<Option.Option<Node>, SE>

  /** Every node, oldest first. */
  readonly nodes: Effect.Effect<ReadonlyArray<Node>, SE>
}


/**
 * Build a tree over one agent.
 *
 * `R` is absorbed here: the agent's own requirements are satisfied when a
 * branch is created, which is why `branch` asks only for a scope and a model.
 */
export const make = <Tools extends Record<string, Tool.Any>, E, R, SE = never>(
  agent: AgentDefinition<Tools, E, R>,
  options?: {
    /**
     * Where nodes live. In memory by default.
     *
     * `SE` is the store's failure and defaults to `never`, so a tree that
     * never persists carries no error it cannot raise: today's signatures are
     * unchanged for today's callers, and a persistent store makes its failure
     * visible in exactly the operations that touch storage.
     */
    readonly store?: NodeStore.NodeStore<SE> | undefined
    /**
     * How branch session ids are named.
     *
     * The node *and* the branch's ordinal, because the node alone cannot
     * make a unique name: branching twice from one node calls this twice with
     * the same argument, so the obvious deterministic implementation returns
     * one id for two live sessions. The tree keys a session's cursor and lane
     * by that id, so the two would overwrite each other's position and later
     * commits would parent onto the wrong branch.
     *
     * The ordinal is per tree and monotonic, so `(node, n) => ...${n}` is
     * unique by construction.
     */
    readonly sessionIds?: ((node: Node, ordinal: number) => string) | undefined
    /**
     * How the tree builds the sessions it hands back.
     *
     * Without this the tree silently drops the configuration a caller would
     * have passed to `AgentSession.make` -- and the omission is not
     * cosmetic. A tree built for an interactive application configures
     * `elicitation`, and a branch built without it *refuses* a run needing
     * approval instead of asking. The user sees a permission denial with no
     * question, and nothing in the types said this would happen.
     *
     * `sessionId` and `history` are absent because they are the tree's to
     * decide: the first is what keeps branches distinct, and the second is
     * the node being branched from.
     */
    readonly session?: Omit<AgentSession.MakeOptions, "sessionId" | "history"> | undefined
  }
): Effect.Effect<
  SessionTree<Tools, E, SE>,
  never,
  R | Scope.Scope | LanguageModel.LanguageModel
> =>
  Effect.gen(function*() {
    const environment = yield* Effect.context<R>()
    const prefix = `t${treePrefix()}`
    const store: NodeStore.NodeStore<SE> = options?.store ??
      ((yield* NodeStore.memory) as NodeStore.NodeStore<SE>)
    // Where each live session sits in the tree: its branch point, then its own
    // latest commit. Keyed by session id, which is why a branch must not reuse
    // one.
    const at = yield* Ref.make(new Map<string, NodeId>())
    const counter = yield* Ref.make(0)
    // Branch sessions are numbered independently of nodes: two branches from
    // one node are two different conversations and must not share an id.
    const branchCounter = yield* Ref.make(0)
    // A lane is a name over a leaf; `laneOf` remembers which session is working
    // on which lane, so a commit can advance the right one.
    const lanes = yield* Ref.make(new Map<string, NodeId>())
    const laneOf = yield* Ref.make(new Map<string, string>())

    /**
     * Live branches, reference counted by node.
     *
     * Lifetime is the half of this design easiest to get wrong. A branch is a
     * keyed, scoped resource with a varying number of holders -- the active
     * one, plus any the caller kept -- and it should be released when the last
     * of them goes rather than when the tree guesses. `RcMap` is exactly that,
     * so "switching leaks nothing" becomes a property of the structure instead
     * of a discipline enforced by hand.
     */
    const branches = yield* RcMap.make({
      lookup: (id: NodeId) =>
        Effect.gen(function*() {
          const found = yield* find(id)
          const n = yield* Ref.updateAndGet(branchCounter, (value) => value + 1)
          // `sessionIds` names *every* session the store will see, not just
          // the ones `branch` hands out. A caller who supplied it to control
          // those ids -- a durable store keyed by them, say -- would otherwise
          // find the tree's own activations arriving under a scheme they never
          // chose, and exactly for the sessions the tree drives itself.
          //
          // The ordinal comes from the same counter as `branch`'s, so the two
          // never collide even though both call the caller's function with the
          // same node.
          const sessionId = options?.sessionIds?.(found.node, n) ?? `${id}-active-${n}`
          const session = yield* AgentSession.make(agent, {
            ...options?.session,
            history: found.history,
            sessionId
          }).pipe(Effect.provide(environment))
          yield* Ref.update(at, (all) => new Map(all).set(sessionId, id))
          return session
        })
    })

    /**
     * One channel for the whole tree, fed by whichever branch is active.
     *
     * The obvious implementation -- `switchMap` over the active branch -- has
     * a race that costs real events: the inner subscription is established
     * when the *consumer* gets around to it, so anything the branch emits
     * between `activate` returning and that moment is lost. A first prompt
     * right after a switch is exactly that window, and losing it means a turn
     * that never appears.
     *
     * So activation subscribes eagerly, into a scope the tree owns, and pumps
     * into this. By the time `activate` returns, the branch's events are
     * already being captured.
     */
    const feed = yield* PubSub.unbounded<AgentEventEnvelope>()

    // What is in front of the user, and the scope holding it. Closing that
    // scope is what releases the reference taken from `branches`.
    const current = yield* SubscriptionRef.make(
      Option.none<Activation<Tools, E>>()
    )
    const currentScope = yield* Ref.make(Option.none<Scope.Closeable>())

    /**
     * The tree owns whatever it left running.
     *
     * An activation's scope comes from `Scope.make`, which is deliberately
     * caller-managed and *not* a child of the ambient scope. Failed candidates
     * and superseded activations are closed as they are replaced, but the last
     * successful one had nothing linking it to the scope that built the tree.
     * Closing the tree therefore need not release its `RcMap` reference, its
     * event subscription, its observer registration or its pump fibre -- and
     * the aggregate feed was never shut down either, so a `tree.events`
     * consumer in another scope had no terminal signal after the tree was
     * gone and simply waited.
     */
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        const last = yield* Ref.get(currentScope)
        if (Option.isSome(last)) yield* Scope.close(last.value, Exit.void)
        yield* Ref.set(currentScope, Option.none())
        yield* PubSub.shutdown(feed)
      })
    )
    /**
     * One activation at a time.
     *
     * Switching is read-then-write over `currentScope`, which two concurrent
     * callers interleave badly: both read the same predecessor, both install
     * their own, both close that one predecessor -- and the loser's scope
     * stays alive, still forwarding its branch into the feed. The symptom is
     * not a missing branch but *two* of them, interleaved on one stream, which
     * reads as an agent talking over itself.
     *
     * A UI produces exactly this: a held Ctrl+R fires rewinds faster than any
     * of them completes, and each is its own detached fibre.
     */
    const activating = yield* Semaphore.make(1)

    const nextId = Effect.map(
      Ref.updateAndGet(counter, (n) => n + 1),
      (n) => nodeId(`${prefix}-node-${n}`)
    )

    const find = (id: NodeId): Effect.Effect<NodeStore.Held, NodeMissing | SE> =>
      Effect.flatMap(store.get(id), (found) =>
        Option.isNone(found) ? Effect.fail(new NodeMissing({ id })) : Effect.succeed(found.value))

    /**
     * Whether two conversations are the same conversation.
     *
     * **Structurally, not by reference**, and the difference is not academic.
     * A reference comparison was tried and is wrong for every persistent
     * store: history there is JSON on the way in and out, so each read
     * produces fresh message objects and no message is ever pointer-equal to
     * the one it round-tripped from. Dedup then never fires, and *every*
     * commit records a duplicate node. The in-memory store keeps identity, so
     * a suite built on it sees none of that -- which is exactly how the
     * mistake survived until it was checked against `keyValue`.
     *
     * The length check is a short-circuit rather than the comparison. It is
     * the common case at a turn boundary, where a turn has added messages, so
     * the structural walk runs only when the two are the same size -- which is
     * the case R34 is about and the one worth paying for.
     */
    const sameMessages = (left: Prompt.Prompt, right: Prompt.Prompt): boolean =>
      left.content.length === right.content.length && Equal.equals(left, right)

    /**
     * Record a node from a conversation already known to be at a boundary.
     *
     * Shared by `commit`, which reaches a boundary by waiting for idle, and by
     * `track`, which is told about one by `TurnCompleted`.
     *
     * A conversation that is already the session's current node records
     * nothing, which keeps a manual commit next to an automatic one from
     * leaving two nodes holding the same thing. `sameMessages` decides that.
     */
    const record = (
      sessionId: string,
      history: Prompt.Prompt,
      commitOptions?: CommitOptions
    ): Effect.Effect<Option.Option<Node>, SE> =>
      Effect.gen(function*() {
        const parentId = (yield* Ref.get(at)).get(sessionId)
        const parent = Option.fromNullishOr(parentId)
        if (parentId !== undefined) {
          const existing = yield* store.get(parentId)
          /**
           * Unchanged means *the same conversation*, not the same length.
           *
           * Comparing lengths was cheap and wrong. A session id is chosen by
           * the caller -- `AgentSession.make` takes one, and `restore`
           * deliberately reuses it -- so two distinct sessions can share a
           * cursor, and a *different* conversation of the same length was
           * treated as unchanged and handed back the other one's node. A
           * shorter or divergent history could be parented onto the wrong
           * lineage the same way.
           *
           * A rebuilt-but-equal history is therefore *not* a change: it is the
           * same conversation and must map to the same node, because a
           * persistent store hands one back on every read (see
           * `sameMessages`, which is where the comparison lives).
           */
          if (Option.isSome(existing) && sameMessages(existing.value.history, history)) {
            return Option.none()
          }
        }

        const id = yield* nextId
        const node: Node = {
          id,
          parent,
          cause: commitOptions?.cause ?? (Option.isNone(parent) ? "root" : "prompt"),
          at: yield* Clock.currentTimeMillis,
          label: Option.fromNullishOr(commitOptions?.label)
        }
        yield* store.put(node, history)
        // The session now sits at its new node, so a later commit chains from
        // here rather than re-parenting to where it started.
        yield* Ref.update(at, (all) => new Map(all).set(sessionId, id))

        // Advance this session's lane, if it is working on one.
        const name = (yield* Ref.get(laneOf)).get(sessionId)
        if (name !== undefined) {
          yield* Ref.update(lanes, (all) => new Map(all).set(name, id))
        }
        return Option.some(node)
      })

    /**
     * One commit at a time.
     *
     * Recording a node reads where the session sits, decides whether the
     * conversation actually moved, allocates an id, writes the node, and then
     * updates `at` and possibly `lanes` -- five steps over three pieces of
     * state. Two commits for one idle session could both pass the
     * "has anything changed" check, create sibling nodes holding the same
     * conversation, and race over which became the tip; the loser stayed in
     * the store, reachable only as an orphan.
     *
     * A permit rather than one transactional state value, because the state
     * being coordinated includes the *store*, which is an interface with no
     * transaction to offer. Held across the whole decision, so the check and
     * the write cannot be separated.
     *
     * Uncontended in the ordinary case: commits happen at turn boundaries.
     */
    const committing = yield* Semaphore.make(1)

    const commit: SessionTree<Tools, E, SE>["commit"] = (session, commitOptions) =>
      Effect.gen(function*() {
        const captured = yield* AgentSession.snapshot(session).pipe(
          // Preserved rather than flattened: `snapshot` already knows which of
          // the two it is, and throwing that away leaves a caller retrying a
          // session that is gone.
          Effect.mapError((error) =>
            error._tag === "AgentClosedError"
              ? new SessionClosed({ sessionId: session.id })
              : new SessionBusy({ sessionId: session.id })
          )
        )
        const recorded = yield* record(captured.sessionId, captured.history, commitOptions)
        if (Option.isSome(recorded)) return recorded.value

        // Nothing changed, so the session is still at the node it was already
        // at, and a second node holding the same conversation would be noise.
        //
        // But a label or an explicit cause is the caller *marking* this point,
        // and dedup must not silently discard that -- returning an unlabelled
        // node would answer a different question than the one asked. The mark
        // lands on the node that is already there.
        const current = (yield* Ref.get(at)).get(captured.sessionId)
        const existing = current === undefined
          ? Option.none<NodeStore.Held>()
          : yield* store.get(current)
        if (Option.isSome(existing)) {
          if (commitOptions?.label === undefined && commitOptions?.cause === undefined) {
            return existing.value.node
          }
          const marked: Node = {
            ...existing.value.node,
            ...(commitOptions.cause === undefined ? {} : { cause: commitOptions.cause }),
            ...(commitOptions.label === undefined
              ? {}
              : { label: Option.some(commitOptions.label) })
          }
          // Re-stored under its own id, which every store treats as replacing
          // the node rather than adding one -- see the contract.
          yield* store.put(marked, existing.value.history)
          return marked
        }
        // Only reachable for an empty conversation with no prior node.
        return yield* Effect.map(
          record(captured.sessionId, captured.history, { ...commitOptions, cause: "root" }),
          Option.getOrThrow
        )
      }).pipe(Semaphore.withPermit(committing))

    const branch: SessionTree<Tools, E, SE>["branch"] = (node, branchOptions) =>
      Effect.gen(function*() {
        const { history } = yield* find(node.id)
        const n = yield* Ref.updateAndGet(branchCounter, (value) => value + 1)
        const sessionId = options?.sessionIds?.(node, n) ?? `${node.id}-branch-${n}`
        const session = yield* AgentSession.make(agent, {
          ...options?.session,
          history,
          sessionId
        }).pipe(Effect.provide(environment))
        /**
         * Bookkeeping and hand-over, as one uninterruptible step.
         *
         * The session is acquired in the *caller's* scope, which is what makes
         * an interruption here expensive: the caller never receives the
         * branch, but its finalizer is already registered in a scope that may
         * live as long as the application -- so the session keeps its
         * subscriptions, its elicitation state and its captured environment
         * until the whole tree shuts down. The cursor and lane maps were left
         * half-written beside it.
         *
         * The acquisition itself cannot be moved: `branch` hands the session
         * to the caller, so the caller's scope is where it belongs. What can
         * be made atomic is everything after it, so an interruption either
         * leaves nothing recorded or leaves a branch the caller has.
         */
        return yield* Effect.uninterruptible(
          Effect.gen(function*() {
            yield* Ref.update(at, (all) => new Map(all).set(sessionId, node.id))
            if (branchOptions?.lane !== undefined) {
              yield* Ref.update(laneOf, (all) => new Map(all).set(sessionId, branchOptions.lane!))
              // A new lane starts at the node it branched from, so it points
              // somewhere real before its first turn completes.
              yield* Ref.update(lanes, (all) => new Map(all).set(branchOptions.lane!, node.id))
            }
            return session
          })
        )
      })

    const path: SessionTree<Tools, E, SE>["path"] = (node) =>
      Effect.gen(function*() {
        const walked: Array<Node> = []
        /**
         * Where we have already been.
         *
         * A tree cannot contain a cycle -- a node's parent is fixed when it is
         * inserted and every node is inserted below an existing one -- but
         * `NodeStore` is a public seam, and a custom or damaged store can
         * hand back a node that is its own ancestor. Without this the walk
         * never ends: not an error, not a wrong answer, a hang, with every
         * caller of `summary`, `commonAncestor` and `divergence` behind it.
         *
         * Reported as corruption rather than by stopping quietly, because a
         * truncated path is a wrong answer that looks like a right one.
         */
        const seen = new Set<string>()
        let current: Option.Option<NodeId> = Option.some(node.id)
        while (Option.isSome(current)) {
          if (seen.has(current.value)) {
            return yield* new TreeCorrupt({
              id: current.value,
              detail: "a node is its own ancestor"
            })
          }
          seen.add(current.value)
          const found = yield* store.get(current.value)
          if (Option.isNone(found)) return yield* new NodeMissing({ id: current.value })
          walked.push(found.value.node)
          current = found.value.node.parent
        }
        // Walked leaf-to-root; a path reads root-first.
        return walked.reverse()
      })

    /**
     * The newest user message, flattened to one line.
     *
     * Only `text` parts: a file part has no words to show, and a message that
     * is only a file should read as having no preview rather than as having an
     * empty one. Whitespace is collapsed because this goes in a list -- a
     * pasted stack trace must occupy one row, not thirty.
     */
    const previewOf = (history: Prompt.Prompt): Option.Option<string> => {
      for (let i = history.content.length - 1; i >= 0; i--) {
        const message = history.content[i]
        if (message === undefined || message.role !== "user") continue
        const text = message.content
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
        return text === "" ? Option.none() : Option.some(text)
      }
      return Option.none()
    }

    const summary: SessionTree<Tools, E, SE>["summary"] = (node) =>
      Effect.gen(function*() {
        const found = yield* find(node.id)
        // The parent's size, so `added` is this turn's contribution rather
        // than the whole conversation.
        const parent = Option.isNone(node.parent)
          ? Option.none<NodeStore.Held>()
          : yield* store.get(node.parent.value)
        const before = Option.isNone(parent) ? 0 : parent.value.history.content.length
        const walked = yield* path(node)
        return {
          node: found.node,
          messages: found.history.content.length,
          added: Math.max(0, found.history.content.length - before),
          depth: walked.length,
          preview: previewOf(found.history)
        }
      })

    /**
     * Both paths to the root, and the last node they share.
     *
     * One walk answers all three of `commonAncestor`, `divergence`, and the
     * suffixes -- which is why they are not built on top of each other.
     */
    const fork = (
      a: Node,
      b: Node
    ): Effect.Effect<
      { at: Option.Option<Node>; left: ReadonlyArray<Node>; right: ReadonlyArray<Node> },
      NodeMissing | TreeCorrupt | SE
    > =>
      Effect.gen(function*() {
        const left = yield* path(a)
        const right = yield* path(b)
        // Both are root-first, so the shared prefix is a straight comparison
        // and its last element is the deepest common ancestor.
        let shared = 0
        while (
          shared < left.length &&
          shared < right.length &&
          left[shared]!.id === right[shared]!.id
        ) shared++
        return {
          at: shared === 0 ? Option.none<Node>() : Option.some(left[shared - 1]!),
          left: left.slice(shared),
          right: right.slice(shared)
        }
      })

    /**
     * Watch a session's events from a fibre owned by `scope`.
     *
     * Subscribing is separated from consuming on purpose. `Stream.runForEach`
     * in a forked fibre subscribes whenever that fibre first runs, so anything
     * emitted before then is lost -- and the caller has no moment it can point
     * to and say "I am attached now". Acquiring the subscription here, before
     * returning, means everything from this point on is queued whether or not
     * the consumer has started.
     */
    const consume = (
      session: AgentSession.AgentSession<Tools, E>,
      scope: Scope.Scope,
      onEvent: (envelope: AgentEventEnvelope) => Effect.Effect<void>
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const subscription = yield* AgentSession.subscribe(session).pipe(
          Effect.provideService(Scope.Scope, scope)
        )
        yield* Effect.forkIn(
          Effect.forever(Effect.flatMap(PubSub.take(subscription), onEvent)),
          scope
        )
      })

    /**
     * Record a node at every turn boundary.
     *
     * Attached as an *observer* rather than consumed from a subscription, and
     * that is the whole correctness argument: `TurnCompleted` carries no
     * payload, so this has to read `session.history` -- and a subscriber that
     * lagged would read the history as of whenever it got around to it. Three
     * turns would then record one node holding the final conversation, with
     * dedup quietly hiding the other two.
     */
    const capture = (session: AgentSession.AgentSession<Tools, E>) =>
    (envelope: AgentEventEnvelope): Effect.Effect<void> =>
      envelope.event._tag === "TurnCompleted"
        ? Effect.flatMap(session.history, (history) =>
          Effect.asVoid(record(session.id, history))).pipe(
            /**
             * A store that fails here must not take the agent down with it.
             *
             * This runs under the event bus's publish permit, so raising would
             * fail the *emit* -- an unwritable disk would stop the agent
             * mid-turn, and a UI would see the run die for a reason that has
             * nothing to do with the conversation. The turn goes uncaptured
             * instead: rewind cannot reach it, which is a real loss and the
             * lesser one.
             *
             * `commit` is the path that reports storage failure to a caller,
             * because there a caller asked and is waiting for an answer.
             *
             * `catch`, not `catchCause`. The wider form also swallowed
             * *interruption* -- so closing a tracking scope while a write was
             * in flight turned a cancellation into a successful log line and
             * the observer carried on -- and every defect from the tree, a
             * codec or the store, which then read as an ordinary missed
             * snapshot rather than as the programming error it is. Only the
             * store's declared failure is a condition this is entitled to
             * absorb.
             */
            Effect.catch((error: SE) =>
              Effect.logError("Failed to capture a node at a turn boundary", error).pipe(
                Effect.annotateLogs({ sessionId: session.id })
              ))
          )
        : Effect.void

    const activate: SessionTree<Tools, E, SE>["activate"] = (node, activateOptions) =>
      Effect.gen(function*() {
        // A scope of the tree's own, so the reference is dropped on the next
        // switch rather than when some caller's scope happens to end.
        //
        // No `find` here any more. It used to read the node's history to hand
        // to `install`, and that read is what made `Activation.history` stale:
        // the node records where a branch *started*, and the branch may have
        // run turns since. `install` reads the live session instead, and the
        // `NodeMissing` this used to raise still comes from the `RcMap`
        // lookup, which finds the node to seed a branch from.
        const scope = yield* Scope.make()
        return yield* Effect.onExit(
          install(node, scope, activateOptions?.lane),
          // Anything that is not a completed install leaves this scope
          // holding a branch reference and two consumers that nobody will
          // ever close, because nobody else has a handle on it. Interruption
          // is the realistic case: a UI that switches away mid-switch.
          (exit) => Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void)
        )
      }).pipe(Semaphore.withPermit(activating))

    /** The second half of `activate`, once its scope exists. */
    const install = (
      node: Node,
      scope: Scope.Closeable,
      /**
       * Name this line of work.
       *
       * On `activate` rather than only on `branch` because a lane is a name
       * for the line the user is on, and activation is how that line is
       * chosen. Requiring `branch` to name one meant building a session purely
       * to register a name and then discarding it, since activation makes its
       * own.
       */
      lane?: string | undefined
    ): Effect.Effect<Activation<Tools, E>, NodeMissing | SE> =>
      Effect.gen(function*() {
        const session = yield* RcMap.get(branches, node.id).pipe(
          Effect.provideService(Scope.Scope, scope)
        )
        // Activation is also tracking: the branch in front of the user is
        // exactly the one whose turns must stay reachable, and a rewind that
        // could not reach the turn just taken would be useless.
        //
        // Two mechanisms because they want different things. Forwarding to the
        // feed is for a renderer, which may lag without harm. Capturing must
        // not lag, because it reads history to interpret an event. Both end
        // with the activation's scope.
        yield* AgentSession.observe(session, capture(session)).pipe(
          Effect.provideService(Scope.Scope, scope)
        )
        yield* consume(session, scope, (envelope) => PubSub.publish(feed, envelope))

        /**
         * The history to paint, read *after* the subscription exists.
         *
         * The node's own history is the wrong answer whenever the branch is
         * already live: `RcMap` hands back the session a previous activation
         * left running, and re-activating the node in front of the user then
         * painted a transcript missing every turn taken since.
         *
         * The ordering is the invariant `Activation` states, and it is the
         * reason this read is here rather than three lines up. `consume`
         * subscribes before returning -- that is what its docstring is for --
         * so from this point everything the branch emits is queued. Reading
         * the history *after* that means the snapshot can only be older than
         * the queue, never newer: a renderer that paints it and then follows
         * the events misses nothing. It cannot double-render either, because
         * a turn already in this snapshot published its events before the
         * subscription existed and so is not in the queue.
         */
        const history = yield* session.history

        const activation: Activation<Tools, E> = { node, session, history }

        /**
         * The commit: everything that makes this activation the current one,
         * as one uninterruptible step.
         *
         * The pieces used to be spread either side of the acquisition. The
         * lane names were written *first*, so an interruption before the
         * activation published left a name pointing at a branch that never
         * became active -- and if the name already existed, its previous
         * target had by then been destroyed. And the `currentScope`
         * read-then-write sat in the interruptible region, so a cancellation
         * between them stranded the scope this activation had just acquired,
         * with its `RcMap` reference, its observer and its pump still alive.
         *
         * The permit above serialises activations against each other; this is
         * what makes one activation atomic against interruption. Both are
         * needed, and neither substitutes for the other.
         */
        yield* Effect.uninterruptible(
          Effect.gen(function*() {
            // After the acquisition, so a name is only ever attached to a
            // branch that exists and is about to be published.
            if (lane !== undefined) {
              yield* Ref.update(laneOf, (all) => new Map(all).set(session.id, lane))
              yield* Ref.update(lanes, (all) => new Map(all).set(lane, node.id))
            }
            const previous = yield* Ref.get(currentScope)
            yield* Ref.set(currentScope, Option.some(scope))
            yield* SubscriptionRef.set(current, Option.some(activation))
            // Released after the new one is in place: closing first would
            // leave a window with nothing active, which a renderer would see
            // as a flicker.
            if (Option.isSome(previous)) {
              yield* Scope.close(previous.value, Exit.void)
            }
          })
        )
        return activation
      })

    const track: SessionTree<Tools, E, SE>["track"] = (session, trackOptions) =>
      Effect.gen(function*() {
        // The observer first, then the name. Writing the name before the
        // acquisition completed left a lane pointing at a session nothing was
        // watching -- the same shape as `branch` above, one size smaller.
        yield* AgentSession.observe(session, capture(session))
        if (trackOptions?.lane !== undefined) {
          yield* Effect.uninterruptible(
            Ref.update(laneOf, (all) => new Map(all).set(session.id, trackOptions.lane!))
          )
        }
      })

    return {
      commit,
      track,
      activate,
      active: Effect.gen(function*() {
        const activation = yield* SubscriptionRef.get(current)
        if (Option.isNone(activation)) return Option.none<Node>()
        // Through `at`, which is what advances as the branch records turns.
        const id = (yield* Ref.get(at)).get(activation.value.session.id)
        const found = id === undefined
          ? Option.none<NodeStore.Held>()
          : yield* store.get(id)
        return Option.some(
          Option.isSome(found) ? found.value.node : activation.value.node
        )
      }),
      node: (id) =>
        Effect.map(store.get(id), Option.map((found) => found.node)),
      events: Stream.fromPubSub(feed),
      status: Stream.switchMap(SubscriptionRef.changes(current), (activation) =>
        Option.isNone(activation)
          ? Stream.empty
          : AgentSession.state(activation.value.session).changes),
      summary,
      commonAncestor: (a, b) => Effect.map(fork(a, b), (found) => found.at),
      divergence: (a, b) => fork(a, b),
      lanes: Effect.gen(function*() {
        const named = yield* Ref.get(lanes)
        const found = yield* Effect.forEach([...named.entries()], ([name, id]) =>
          Effect.map(store.get(id), Option.map((held) => ({ name, leaf: held.node }))))
        return found.flatMap((lane) => Option.isNone(lane) ? [] : [lane.value])
      }),
      lane: (name) =>
        Effect.gen(function*() {
          const id = (yield* Ref.get(lanes)).get(name)
          if (id === undefined) return Option.none<Node>()
          const found = yield* store.get(id)
          return Option.map(found, (held) => held.node)
        }),
      branch,
      historyOf: (node) => Effect.map(find(node.id), (found) => found.history),
      path,
      // Straight through: the store answers these from indexes it keeps on
      // write, because a key-value backing cannot scan for them.
      children: (node) => store.children(node.id),
      root: Effect.map(store.roots, (roots) => Option.fromNullishOr(roots[0])),
      nodes: store.nodes
    }
  })
