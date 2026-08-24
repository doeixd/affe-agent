import {
  Clock,
  Effect,
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

export const NodeId = Schema.String.pipe(
  Schema.brand("@doeixd/effect-agent/tree/NodeId")
)
export type NodeId = typeof NodeId.Type

// The brand exists to stop a bare string being passed where a node id belongs;
// minting one is this module's own business, so the assertion is absorbed here
// exactly as `internal/ids.ts` does for session and run ids.
const nodeId = (value: string): NodeId => value as NodeId

/**
 * Distinguishes one tree's nodes from another's.
 *
 * Without it every tree starts counting at one, so two trees mint the same
 * ids and `historyOf` happily answers for a node that belongs to a different
 * tree -- returning the wrong conversation rather than refusing. Ids are
 * unique per process, which is all an in-memory tree needs; a persisted tree
 * (T5) needs ids that survive one.
 */
let trees = 0

/** Why a node exists. A renderer picks a glyph from this. */
export type NodeCause = "root" | "prompt" | "fork" | "manual"

/**
 * A point in the conversation.
 *
 * **Bounded metadata lives on the value; unbounded content lives behind an
 * operation.** There is deliberately no `history` or `snapshot` field: a field
 * would force every node to hold a fully materialised transcript for ever and
 * would make delta storage a breaking change. `SessionTree.historyOf` is an
 * `Effect` instead, so a store can hold whole snapshots, walk deltas to the
 * root, or read a database -- and can fail when a node is gone, which a field
 * cannot express.
 */
export interface Node {
  readonly id: NodeId
  readonly parent: Option.Option<NodeId>
  readonly cause: NodeCause
  /** When the node was captured, in epoch milliseconds. */
  readonly at: number
  readonly label: Option.Option<string>
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

export interface SessionTree<Tools extends Record<string, Tool.Any>, E> {
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
  ) => Effect.Effect<Node, SessionBusy | SessionClosed>

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
  readonly summary: (node: Node) => Effect.Effect<Summary, NodeMissing>

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
  ) => Effect.Effect<Option.Option<Node>, NodeMissing>

  /**
   * Where two branches parted, and what each did after.
   *
   * Built from one pair of walks rather than by calling `commonAncestor` and
   * then walking again: the fork and the two suffixes all fall out of the same
   * two paths.
   */
  readonly divergence: (a: Node, b: Node) => Effect.Effect<Divergence, NodeMissing>

  /** Every named leaf, in the order the lanes were first named. */
  readonly lanes: Effect.Effect<ReadonlyArray<Lane>>

  /** One named leaf. */
  readonly lane: (name: string) => Effect.Effect<Option.Option<Node>>

  /**
   * Put a branch in front of the user, releasing the one that was.
   *
   * Branches are reference counted, so switching away releases a branch only
   * when nobody else holds it -- and switching *back* to one somebody still
   * holds finds it live rather than rebuilding it. A branch taken with
   * `branch` is the caller's to hold and is unaffected by activation.
   */
  readonly activate: (
    node: Node
  ) => Effect.Effect<Activation<Tools, E>, NodeMissing>

  /**
   * Where the active branch is *now*, if any.
   *
   * Not the node that was activated. That node is where the branch started;
   * every turn since has recorded another, and a caller asking "what is in
   * front of the user" means the latest -- it is what "go back one turn"
   * counts back from, and answering with the branch point would make rewind
   * refuse from the second turn onwards.
   */
  readonly active: Effect.Effect<Option.Option<Node>>

  /**
   * The node with this id, if the tree still holds it.
   *
   * `Node.parent` is an id rather than a node -- a node holding its parent
   * would make the tree a graph of objects that cannot be serialised or
   * shared -- so anything walking upwards needs this. Rewind is the obvious
   * case: "the turn before this one" is a parent id and nothing else.
   */
  readonly node: (id: NodeId) => Effect.Effect<Option.Option<Node>>

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
    NodeMissing,
    Scope.Scope | LanguageModel.LanguageModel
  >

  /** A node's conversation. For rendering; `branch` does not need it. */
  readonly historyOf: (node: Node) => Effect.Effect<Prompt.Prompt, NodeMissing>

  /** From the root down to this node. */
  readonly path: (node: Node) => Effect.Effect<ReadonlyArray<Node>, NodeMissing>

  readonly children: (node: Node) => Effect.Effect<ReadonlyArray<Node>>

  readonly root: Effect.Effect<Option.Option<Node>>

  /** Every node, oldest first. */
  readonly nodes: Effect.Effect<ReadonlyArray<Node>>
}

interface Held {
  readonly node: Node
  readonly history: Prompt.Prompt
}

/**
 * Build a tree over one agent.
 *
 * `R` is absorbed here: the agent's own requirements are satisfied when a
 * branch is created, which is why `branch` asks only for a scope and a model.
 */
export const make = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: AgentDefinition<Tools, E, R>,
  options?: {
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
): Effect.Effect<SessionTree<Tools, E>, never, R | Scope.Scope | LanguageModel.LanguageModel> =>
  Effect.gen(function*() {
    const environment = yield* Effect.context<R>()
    const prefix = `t${++trees}`
    const held = yield* Ref.make(new Map<string, Held>())
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
          const found = (yield* Ref.get(held)).get(id)
          if (found === undefined) return yield* new NodeMissing({ id })
          const n = yield* Ref.updateAndGet(branchCounter, (value) => value + 1)
          const sessionId = `${id}-active-${n}`
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

    const find = (id: NodeId): Effect.Effect<Held, NodeMissing> =>
      Effect.flatMap(Ref.get(held), (all) => {
        const found = all.get(id)
        return found === undefined
          ? Effect.fail(new NodeMissing({ id }))
          : Effect.succeed(found)
      })

    /**
     * Record a node from a conversation already known to be at a boundary.
     *
     * Shared by `commit`, which reaches a boundary by waiting for idle, and by
     * `track`, which is told about one by `TurnCompleted`.
     *
     * Nothing new since the session's current node means no node: history is
     * append-only, so an unchanged length is a sound proxy for "this turn
     * added nothing", and it keeps a manual commit next to an automatic one
     * from leaving two nodes holding the same conversation.
     */
    const record = (
      sessionId: string,
      history: Prompt.Prompt,
      commitOptions?: CommitOptions
    ): Effect.Effect<Option.Option<Node>> =>
      Effect.gen(function*() {
        const parentId = (yield* Ref.get(at)).get(sessionId)
        const parent = Option.fromNullishOr(parentId)
        if (parentId !== undefined) {
          const existing = (yield* Ref.get(held)).get(parentId)
          if (existing !== undefined && existing.history.content.length === history.content.length) {
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
        yield* Ref.update(held, (all) => new Map(all).set(id, { node, history }))
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

    const commit: SessionTree<Tools, E>["commit"] = (session, commitOptions) =>
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
          ? undefined
          : (yield* Ref.get(held)).get(current)
        if (existing !== undefined) {
          if (commitOptions?.label === undefined && commitOptions?.cause === undefined) {
            return existing.node
          }
          const marked: Node = {
            ...existing.node,
            ...(commitOptions.cause === undefined ? {} : { cause: commitOptions.cause }),
            ...(commitOptions.label === undefined
              ? {}
              : { label: Option.some(commitOptions.label) })
          }
          yield* Ref.update(held, (all) =>
            new Map(all).set(marked.id, { node: marked, history: existing.history }))
          return marked
        }
        // Only reachable for an empty conversation with no prior node.
        return yield* Effect.map(
          record(captured.sessionId, captured.history, { ...commitOptions, cause: "root" }),
          Option.getOrThrow
        )
      })

    const branch: SessionTree<Tools, E>["branch"] = (node, branchOptions) =>
      Effect.gen(function*() {
        const { history } = yield* find(node.id)
        const n = yield* Ref.updateAndGet(branchCounter, (value) => value + 1)
        const sessionId = options?.sessionIds?.(node, n) ?? `${node.id}-branch-${n}`
        const session = yield* AgentSession.make(agent, {
          ...options?.session,
          history,
          sessionId
        }).pipe(Effect.provide(environment))
        yield* Ref.update(at, (all) => new Map(all).set(sessionId, node.id))
        if (branchOptions?.lane !== undefined) {
          yield* Ref.update(laneOf, (all) => new Map(all).set(sessionId, branchOptions.lane!))
          // A new lane starts at the node it branched from, so it points
          // somewhere real before its first turn completes.
          yield* Ref.update(lanes, (all) => new Map(all).set(branchOptions.lane!, node.id))
        }
        return session
      })

    const path: SessionTree<Tools, E>["path"] = (node) =>
      Effect.gen(function*() {
        const all = yield* Ref.get(held)
        const walked: Array<Node> = []
        let current: Option.Option<NodeId> = Option.some(node.id)
        while (Option.isSome(current)) {
          const found = all.get(current.value)
          if (found === undefined) return yield* new NodeMissing({ id: current.value })
          walked.push(found.node)
          current = found.node.parent
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

    const summary: SessionTree<Tools, E>["summary"] = (node) =>
      Effect.gen(function*() {
        const found = yield* find(node.id)
        const all = yield* Ref.get(held)
        // The parent's size, so `added` is this turn's contribution rather
        // than the whole conversation.
        const before = Option.isNone(node.parent)
          ? 0
          : all.get(node.parent.value)?.history.content.length ?? 0
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
      NodeMissing
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
          Effect.asVoid(record(session.id, history)))
        : Effect.void

    const activate: SessionTree<Tools, E>["activate"] = (node) =>
      Effect.gen(function*() {
        const { history } = yield* find(node.id)
        // A scope of the tree's own, so the reference is dropped on the next
        // switch rather than when some caller's scope happens to end.
        const scope = yield* Scope.make()
        return yield* Effect.onExit(
          install(node, history, scope),
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
      history: Prompt.Prompt,
      scope: Scope.Closeable
    ): Effect.Effect<Activation<Tools, E>, NodeMissing> =>
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

        // Serialised by the permit above, so this read-then-write cannot
        // interleave with another activation's.
        const previous = yield* Ref.get(currentScope)
        yield* Ref.set(currentScope, Option.some(scope))
        const activation: Activation<Tools, E> = { node, session, history }
        yield* SubscriptionRef.set(current, Option.some(activation))
        // Released after the new one is in place: closing first would leave a
        // window with nothing active, which a renderer would see as a flicker.
        if (Option.isSome(previous)) {
          yield* Scope.close(previous.value, Exit.void)
        }
        return activation
      })

    const track: SessionTree<Tools, E>["track"] = (session, trackOptions) =>
      Effect.gen(function*() {
        if (trackOptions?.lane !== undefined) {
          yield* Ref.update(laneOf, (all) => new Map(all).set(session.id, trackOptions.lane!))
        }
        yield* AgentSession.observe(session, capture(session))
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
        const held_ = yield* Ref.get(held)
        const found = id === undefined ? undefined : held_.get(id)
        return Option.some(found?.node ?? activation.value.node)
      }),
      node: (id) =>
        Effect.map(Ref.get(held), (all) => Option.fromNullishOr(all.get(id)?.node)),
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
        const all = yield* Ref.get(held)
        return [...named.entries()].flatMap(([name, id]) => {
          const found = all.get(id)
          return found === undefined ? [] : [{ name, leaf: found.node }]
        })
      }),
      lane: (name) =>
        Effect.gen(function*() {
          const id = (yield* Ref.get(lanes)).get(name)
          if (id === undefined) return Option.none<Node>()
          const found = (yield* Ref.get(held)).get(id)
          return found === undefined ? Option.none<Node>() : Option.some(found.node)
        }),
      branch,
      historyOf: (node) => Effect.map(find(node.id), (found) => found.history),
      path,
      children: (node) =>
        Effect.map(Ref.get(held), (all) =>
          [...all.values()]
            .map((entry) => entry.node)
            .filter((candidate) =>
              Option.isSome(candidate.parent) && candidate.parent.value === node.id
            )),
      root: Effect.map(Ref.get(held), (all) =>
        Option.fromNullishOr(
          [...all.values()].map((entry) => entry.node).find((node) =>
            Option.isNone(node.parent)
          )
        )),
      nodes: Effect.map(Ref.get(held), (all) => [...all.values()].map((entry) => entry.node))
    }
  })
