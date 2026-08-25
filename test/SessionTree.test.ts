import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Option, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as NodeStore from "../src/tree/NodeStore.js"
import * as SessionTree from "../src/tree/SessionTree.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A tree of conversations over the ordinary session primitives.
 *
 * The invariants under test are the ones in `docs/plan-session-tree.md`:
 * a node is only ever captured at a turn boundary (IT1), a branch never reuses
 * a session id (IT2), a branch cannot affect its ancestors (IT3), and the tree
 * hands back precisely typed sessions (IT5).
 */

// ---------------------------------------------------------------------------
// IT5, at compile time. `any` compiles, so the runtime tests below would pass
// just as well against a tree that had erased its tool types.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Not<T extends boolean> = T extends true ? false : true

type Tree = Effect.Success<ReturnType<typeof SessionTree.make<Record<string, never>, never, never>>>
type Branched = Effect.Success<ReturnType<Tree["branch"]>>

export type _BranchIsNotAny = Assert<Not<IsAny<Branched>>>
export type _BranchIsASession = Assert<
  Branched extends AgentSession.AgentSession<Record<string, never>, never> ? true : false
>
/** A node carries metadata only: history is reached through an operation. */
export type _NodeHasNoHistory = Assert<
  "history" extends keyof SessionTree.Node ? false : true
>
export type _NodeHasNoSnapshot = Assert<
  "snapshot" extends keyof SessionTree.Node ? false : true
>

const agent = Agent.make({
  instructions: "You answer briefly.",
  loop: AgentLoop.bounded(2)
})

const script = (...replies: ReadonlyArray<string>) =>
  TestLanguageModel.script(replies.map((reply) => TestLanguageModel.text(reply)))

const textOf = (prompt: { readonly content: ReadonlyArray<unknown> }): string =>
  JSON.stringify(prompt.content)

/**
 * Wait until the tracking fibre has recorded `count` nodes.
 *
 * `prompt` returning means the turn committed and the event was published, not
 * that the consumer has run. Yielding until the count is reached is
 * cooperative scheduling rather than timing, so it is deterministic; the bound
 * exists so a genuine failure reports as a failed assertion instead of
 * hanging.
 */
const settle = <Tools extends Record<string, never>, E, SE>(
  tree: SessionTree.SessionTree<Tools, E, SE>,
  count: number
): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((yield* Effect.orDie(tree.nodes)).length >= count) return
      yield* Effect.yieldNow
    }
  })

describe("SessionTree", () => {
  it.effect("two branches diverge from one node, and the trunk is untouched", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk answer", "left answer", "right answer")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("start here")

        const node = yield* tree.commit(trunk)

        const left = yield* tree.branch(node)
        yield* left.prompt("go left")

        const right = yield* tree.branch(node)
        yield* right.prompt("go right")

        return {
          node,
          left: yield* left.history,
          right: yield* right.history,
          trunk: yield* trunk.history,
          leftId: left.id,
          rightId: right.id,
          trunkId: trunk.id
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Each branch has the shared prefix and only its own continuation.
      assert.include(textOf(out.left), "start here")
      assert.include(textOf(out.right), "start here")
      assert.include(textOf(out.left), "go left")
      assert.notInclude(textOf(out.left), "go right")
      assert.include(textOf(out.right), "go right")
      assert.notInclude(textOf(out.right), "go left")

      // IT3: nothing a branch did reached the trunk.
      assert.notInclude(textOf(out.trunk), "go left")
      assert.notInclude(textOf(out.trunk), "go right")

      // IT2: branching is a different conversation, so a different identity.
      assert.notStrictEqual(out.leftId, out.trunkId)
      assert.notStrictEqual(out.rightId, out.trunkId)
      assert.notStrictEqual(out.leftId, out.rightId)

      // The root has no parent.
      assert.isTrue(Option.isNone(out.node.parent))
      assert.strictEqual(out.node.cause, "root")
    })
  )

  it.effect("a node cannot be captured from a running session (IT1)", () =>
    Effect.gen(function*() {
      // A turn commits an assistant message and its tool results as one unit,
      // so a node taken mid-turn would record a conversation that never
      // existed -- and every branch from it would start from one.
      const { layer } = yield* TestLanguageModel.script([
        { text: "never finishes", hang: true }
      ])

      const outcome = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* Effect.forkChild(session.prompt("go"))
        // Let the run reach the model before asking for a node.
        yield* Effect.yieldNow
        return yield* Effect.result(tree.commit(session))
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(outcome._tag, "Failure")
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure._tag, "@doeixd/effect-agent/tree/SessionBusy")
      }
    })
  )

  it.effect("commits from one session chain rather than fan out", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("one", "two")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)

        yield* session.prompt("first")
        const first = yield* tree.commit(session)
        yield* session.prompt("second")
        const second = yield* tree.commit(session)

        return {
          first,
          second,
          path: yield* tree.path(second),
          children: yield* tree.children(first),
          root: yield* tree.root
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The second commit hangs off the first, not off nothing.
      assert.isTrue(Option.isSome(out.second.parent))
      assert.strictEqual(Option.getOrThrow(out.second.parent), out.first.id)
      assert.strictEqual(out.second.cause, "prompt")

      // A path reads root-first.
      assert.deepStrictEqual(out.path.map((node) => node.id), [
        out.first.id,
        out.second.id
      ])
      assert.deepStrictEqual(out.children.map((node) => node.id), [out.second.id])
      assert.strictEqual(Option.getOrThrow(out.root).id, out.first.id)
    })
  )

  it.effect("branching twice from one node makes two children", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("a", "b", "c")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("start")
        const node = yield* tree.commit(trunk)

        const left = yield* tree.branch(node)
        yield* left.prompt("left")
        const leftNode = yield* tree.commit(left)

        const right = yield* tree.branch(node)
        yield* right.prompt("right")
        const rightNode = yield* tree.commit(right)

        return {
          node,
          children: yield* tree.children(node),
          leftPath: yield* tree.path(leftNode),
          rightPath: yield* tree.path(rightNode),
          nodes: yield* tree.nodes
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.children.length, 2)
      // Both branches share the node they came from, and nothing after it.
      assert.strictEqual(out.leftPath.length, 2)
      assert.strictEqual(out.rightPath.length, 2)
      assert.strictEqual(out.leftPath[0]?.id, out.node.id)
      assert.strictEqual(out.rightPath[0]?.id, out.node.id)
      assert.notStrictEqual(out.leftPath[1]?.id, out.rightPath[1]?.id)
      assert.strictEqual(out.nodes.length, 3)
    })
  )

  it.effect("history is an operation, and a foreign node is refused", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("answered")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const node = yield* tree.commit(session)

        // A node from a different tree is not in this one, and saying so is
        // something a `history` *field* could never have expressed.
        const other = yield* SessionTree.make(agent)
        const otherSession = yield* AgentSession.make(agent)
        const foreign = yield* other.commit(otherSession)

        return {
          history: yield* tree.historyOf(node),
          missing: yield* Effect.result(tree.historyOf(foreign))
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.include(textOf(out.history), "ask")
      assert.strictEqual(out.missing._tag, "Failure")
    })
  )

  it.effect("tracking captures a node per turn, with no explicit commit", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("first", "second", "third")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* tree.track(session)

        yield* session.prompt("one")
        yield* session.prompt("two")
        yield* session.prompt("three")
        yield* settle(tree, 3)

        const nodes = yield* tree.nodes
        const last = nodes[nodes.length - 1]
        return {
          nodes,
          path: last === undefined ? [] : yield* tree.path(last),
          // Each node must hold the conversation as it stood at *its* turn.
          sizes: yield* Effect.forEach(nodes, (node) =>
            Effect.map(tree.historyOf(node), (history) => history.content.length))
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Rewind can reach every turn, which is the point: a tree that only
      // captured explicit commits could reach none of them.
      assert.strictEqual(out.nodes.length, 3)
      // And they form a chain, not a fan.
      assert.strictEqual(out.path.length, 3)
      // Strictly growing, which is the property that catches a *lagging*
      // recorder. `TurnCompleted` carries no payload, so capture has to read
      // the session's history -- and one driven from a stream subscription
      // reads it whenever that fibre happens to run. Three turns then record
      // the same final conversation three times, and dedup hides two of them.
      // Hence an observer, which runs under the publishing permit.
      assert.deepStrictEqual(
        out.sizes,
        [...out.sizes].sort((a, b) => a - b),
        "histories must grow with their turns"
      )
      assert.strictEqual(new Set(out.sizes).size, 3)
    })
  )

  it.effect("an explicit commit after a tracked turn adds nothing", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("answered")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* tree.track(session)

        yield* session.prompt("ask")
        yield* settle(tree, 1)
        const afterTurn = (yield* tree.nodes).length

        // Nothing has happened since, so this is the node that already exists.
        const node = yield* tree.commit(session)
        return { afterTurn, afterCommit: (yield* tree.nodes).length, node }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.afterTurn, 1)
      // History is append-only, so an unchanged length means nothing to record.
      assert.strictEqual(out.afterCommit, 1)
      assert.isDefined(out.node)
    })
  )

  it.effect("a lane names a line of work and follows its tip", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("start")
        const node = yield* tree.commit(trunk)

        const left = yield* tree.branch(node, { lane: "left" })
        yield* tree.track(left, { lane: "left" })
        const right = yield* tree.branch(node, { lane: "right" })
        yield* tree.track(right, { lane: "right" })

        // A lane points somewhere real before its first turn finishes.
        const atBranch = yield* tree.lane("left")

        yield* left.prompt("one")
        yield* settle(tree, 2)
        const afterOne = yield* tree.lane("left")

        yield* left.prompt("two")
        yield* settle(tree, 3)
        const afterTwo = yield* tree.lane("left")

        yield* right.prompt("one")
        yield* settle(tree, 4)

        return {
          node,
          atBranch,
          afterOne,
          afterTwo,
          lanes: yield* tree.lanes,
          rightLane: yield* tree.lane("right"),
          missing: yield* tree.lane("nope")
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Starts at the branch point, then advances with each turn.
      assert.strictEqual(Option.getOrThrow(out.atBranch).id, out.node.id)
      assert.notStrictEqual(Option.getOrThrow(out.afterOne).id, out.node.id)
      assert.notStrictEqual(
        Option.getOrThrow(out.afterTwo).id,
        Option.getOrThrow(out.afterOne).id
      )

      // Two lanes, each on its own leaf -- which is what a selector lists.
      assert.deepStrictEqual(out.lanes.map((lane) => lane.name), ["left", "right"])
      assert.notStrictEqual(
        Option.getOrThrow(out.rightLane).id,
        Option.getOrThrow(out.afterTwo).id
      )
      assert.isTrue(Option.isNone(out.missing))
    })
  )

  it.effect("activating hands back the history to paint and a live session", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk answer", "branch answer")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const node = yield* tree.commit(session)

        const before = yield* tree.active
        const activation = yield* tree.activate(node)
        const after = yield* tree.active

        // The session handed back is live, not a transcript.
        yield* activation.session.prompt("again")

        return {
          before,
          after,
          node,
          painted: textOf(activation.history),
          // Painting the history then following the stream must not double up:
          // the history is what existed at the node, not what came after.
          grew: (yield* activation.session.history).content.length >
            activation.history.content.length
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.isTrue(Option.isNone(out.before))
      assert.strictEqual(Option.getOrThrow(out.after).id, out.node.id)
      assert.include(out.painted, "trunk answer")
      assert.notInclude(out.painted, "branch answer")
      assert.isTrue(out.grew)
    })
  )

  it.effect("the active node advances with the branch, not with the switch", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "one", "two")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const start = yield* tree.commit(session)

        const activation = yield* tree.activate(start)
        const atActivation = yield* tree.active

        yield* activation.session.prompt("one")
        yield* settle(tree, 2)
        const afterOne = yield* tree.active

        yield* activation.session.prompt("two")
        yield* settle(tree, 3)
        const afterTwo = yield* tree.active

        return {
          start,
          atActivation,
          afterOne,
          afterTwo,
          depth: yield* tree.path(Option.getOrThrow(afterTwo))
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(Option.getOrThrow(out.atActivation).id, out.start.id)
      // The branch point is where this line of work *started*. Answering with
      // it forever would make "go back one turn" count back from the wrong
      // place -- and refuse outright from the second turn on, since the branch
      // point's own parent is where the caller already is.
      assert.notStrictEqual(Option.getOrThrow(out.afterOne).id, out.start.id)
      assert.notStrictEqual(
        Option.getOrThrow(out.afterTwo).id,
        Option.getOrThrow(out.afterOne).id
      )
      // And the chain is walkable, which is what a rewind actually needs.
      assert.strictEqual(out.depth.length, 3)
    })
  )

  it.effect("switching branches releases the one it switched away from", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left", "right")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const first = yield* tree.commit(session)
        const left = yield* tree.branch(first, { lane: "left" })
        yield* left.prompt("left")
        const second = yield* tree.commit(left)

        // Identity is the observable: a released branch is rebuilt on the way
        // back, a retained one is not. Counting live sessions directly would
        // mean an API that exists only for this test.
        const a1 = yield* tree.activate(first)
        const b = yield* tree.activate(second)
        const a2 = yield* tree.activate(first)
        return { one: a1.session.id, two: b.session.id, three: a2.session.id }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.notStrictEqual(out.one, out.two)
      // Switching away dropped the last reference, so coming back built a new
      // one -- which is the leak not happening.
      assert.notStrictEqual(out.three, out.one)
    })
  )

  /**
   * A property, not a regression test.
   *
   * This passes with the serialisation removed, and it is recorded here that
   * it does: between `activate`'s read of the current scope and its write
   * there is no suspension point, so two fibres cannot interleave there today
   * and the interleaving a review anticipated is not reachable. The permit is
   * kept because "no suspension point in these four lines" is a property of
   * the current body rather than of the design, and one added `yield*` would
   * make it false silently. What follows asserts the invariant either way.
   */
  it.effect("concurrent activations leave exactly one branch forwarding", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left", "right")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const first = yield* tree.commit(session)
        const left = yield* tree.branch(first, { lane: "left" })
        yield* left.prompt("left")
        const second = yield* tree.commit(left)

        // Identity of each envelope, not just its sender. A stranded scope
        // usually forwards the *same* session -- branches are cached per node,
        // so activating one twice hands back one session -- and what shows up
        // is therefore not a foreign id but the same envelope arriving twice.
        const seen: Array<string> = []
        yield* Effect.forkScoped(
          Stream.runForEach(tree.events, (envelope) =>
            Effect.sync(() => {
              seen.push(`${envelope.sessionId}#${envelope.sequence}`)
            }))
        )
        yield* Effect.yieldNow

        // What a held Ctrl+R does: several switches in flight at once, each
        // its own fibre, none waiting for the last.
        yield* Effect.all(
          [
            tree.activate(first),
            tree.activate(second),
            tree.activate(first),
            tree.activate(second)
          ],
          { concurrency: "unbounded" }
        )

        // Whichever won, only it should still be forwarding. A loser whose
        // scope was never closed keeps pumping its own branch into the same
        // feed, and the two interleave.
        const winner = Option.getOrThrow(yield* tree.active)
        const activation = yield* tree.activate(winner)
        yield* activation.session.prompt("after")
        for (let i = 0; i < 40; i++) yield* Effect.yieldNow

        return { seen, live: activation.session.id }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // One pump, so each envelope appears once. Two surviving scopes both
      // forward into the same feed, and every consumer downstream renders the
      // turn twice.
      assert.isAbove(out.seen.length, 0)
      assert.deepStrictEqual(
        out.seen.filter((id, index) => out.seen.indexOf(id) !== index),
        [],
        "no envelope should be forwarded more than once"
      )
      assert.isTrue(out.seen.some((id) => id.startsWith(out.live)))
    })
  )

  it.effect("a branch the caller still holds survives being switched away from", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left", "right")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const first = yield* tree.commit(session)
        const left = yield* tree.branch(first, { lane: "left" })
        yield* left.prompt("left")
        const second = yield* tree.commit(left)

        // Two activations of the same node overlap, so the reference count
        // never reaches zero and the second finds the session already there.
        const a1 = yield* tree.activate(first)
        const a2 = yield* tree.activate(first)
        yield* tree.activate(second)
        return { one: a1.session.id, two: a2.session.id }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.one, out.two)
    })
  )

  it.effect("one subscription follows the active branch across a switch", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left", "on first", "on second")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const first = yield* tree.commit(session)
        const left = yield* tree.branch(first, { lane: "left" })
        yield* left.prompt("left")
        const second = yield* tree.commit(left)

        const seen: Array<string> = []
        // Subscribed once, before anything is active -- which is how a
        // renderer starts up.
        yield* Effect.forkScoped(
          Stream.runForEach(tree.events, (envelope) =>
            Effect.sync(() => {
              seen.push(envelope.sessionId)
            }))
        )
        yield* Effect.yieldNow

        const a = yield* tree.activate(first)
        yield* a.session.prompt("one")
        const b = yield* tree.activate(second)
        yield* b.session.prompt("two")
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow

        return { seen, a: a.session.id, b: b.session.id }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Both branches reached the same subscriber, and neither needed the
      // caller to resubscribe.
      assert.isTrue(out.seen.includes(out.a))
      assert.isTrue(out.seen.includes(out.b))
      // In order: nothing from the second branch arrived before the switch.
      assert.isTrue(out.seen.indexOf(out.a) < out.seen.indexOf(out.b))
    })
  )

  it.effect("a summary describes a node without handing over the conversation", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("first answer", "second answer")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* tree.track(session)

        yield* session.prompt("what is in the workspace?")
        yield* settle(tree, 1)
        yield* session.prompt("and now?")
        yield* settle(tree, 2)

        const nodes = yield* tree.nodes
        return {
          first: yield* tree.summary(nodes[0]!),
          second: yield* tree.summary(nodes[1]!)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The user's words, not the model's: a branch is remembered by what was
      // asked of it.
      assert.strictEqual(Option.getOrThrow(out.first.preview), "what is in the workspace?")
      assert.strictEqual(Option.getOrThrow(out.second.preview), "and now?")

      assert.strictEqual(out.first.depth, 1)
      assert.strictEqual(out.second.depth, 2)

      // `added` is this turn's contribution; `messages` is the whole
      // conversation. Conflating them would make every node look identical
      // once the transcript is long.
      assert.isAbove(out.second.messages, out.first.messages)
      assert.isAbove(out.second.added, 0)
      assert.isBelow(out.second.added, out.second.messages)
      // History is append-only, so a node holds at least what its parent did.
      assert.strictEqual(
        out.second.messages - out.first.messages,
        out.second.added
      )
    })
  )

  it.effect("a preview collapses to one line", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("answered")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* tree.track(session)
        // What a pasted stack trace looks like: it must occupy one row in a
        // selector, not thirty.
        yield* session.prompt("fix this:\n  at foo (a.ts:1)\n\n  at bar (b.ts:2)")
        yield* settle(tree, 1)
        const nodes = yield* tree.nodes
        return yield* tree.summary(nodes[0]!)
      }).pipe(Effect.provide(layer), Effect.scoped)

      const preview = Option.getOrThrow(out.preview)
      assert.notInclude(preview, "\n")
      assert.strictEqual(preview, "fix this: at foo (a.ts:1) at bar (b.ts:2)")
    })
  )

  it.effect("two branches share an ancestor and diverge below it", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("trunk", "left one", "left two", "right one")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const trunk = yield* AgentSession.make(agent)
        yield* trunk.prompt("start")
        const at = yield* tree.commit(trunk)

        const left = yield* tree.branch(at, { lane: "left" })
        yield* tree.track(left, { lane: "left" })
        const right = yield* tree.branch(at, { lane: "right" })
        yield* tree.track(right, { lane: "right" })

        yield* left.prompt("one")
        yield* settle(tree, 2)
        yield* left.prompt("two")
        yield* settle(tree, 3)
        yield* right.prompt("one")
        yield* settle(tree, 4)

        const leftTip = Option.getOrThrow(yield* tree.lane("left"))
        const rightTip = Option.getOrThrow(yield* tree.lane("right"))
        return {
          at,
          leftTip,
          rightTip,
          ancestor: yield* tree.commonAncestor(leftTip, rightTip),
          split: yield* tree.divergence(leftTip, rightTip),
          // A node against itself: the fork is the node, and neither side
          // went anywhere.
          self: yield* tree.divergence(leftTip, leftTip),
          // An ancestor against its own descendant: one side is empty.
          lineage: yield* tree.divergence(at, leftTip)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(Option.getOrThrow(out.ancestor).id, out.at.id)
      assert.strictEqual(Option.getOrThrow(out.split.at).id, out.at.id)

      // Two turns on the left, one on the right -- which is what a diff view
      // draws side by side.
      assert.strictEqual(out.split.left.length, 2)
      assert.strictEqual(out.split.right.length, 1)
      // The fork itself belongs to neither side.
      assert.notInclude(out.split.left.map((node) => node.id), out.at.id)
      assert.strictEqual(out.split.left[out.split.left.length - 1]!.id, out.leftTip.id)
      assert.strictEqual(out.split.right[0]!.id, out.rightTip.id)

      assert.strictEqual(Option.getOrThrow(out.self.at).id, out.leftTip.id)
      assert.deepStrictEqual([out.self.left.length, out.self.right.length], [0, 0])

      // A node is its own descendant's ancestor, so the fork is the ancestor
      // and only the descendant's side has anything below it.
      assert.strictEqual(Option.getOrThrow(out.lineage.at).id, out.at.id)
      assert.strictEqual(out.lineage.left.length, 0)
      assert.strictEqual(out.lineage.right.length, 2)
    })
  )

  it.effect("unrelated roots share no ancestor, and that is not an error", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("one", "two")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        // One tree, two sessions that never met. A tree records whatever it is
        // given, so this is representable and must answer rather than fail.
        const a = yield* AgentSession.make(agent)
        const b = yield* AgentSession.make(agent)
        yield* a.prompt("first")
        yield* b.prompt("second")
        const rootA = yield* tree.commit(a)
        const rootB = yield* tree.commit(b)
        return {
          ancestor: yield* tree.commonAncestor(rootA, rootB),
          split: yield* tree.divergence(rootA, rootB)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.isTrue(Option.isNone(out.ancestor))
      assert.isTrue(Option.isNone(out.split.at))
      // Both sides are whole: nothing is shared, so nothing is trimmed.
      assert.strictEqual(out.split.left.length, 1)
      assert.strictEqual(out.split.right.length, 1)
    })
  )

  it.effect("a tree rebuilt over the same store remembers its nodes", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("first", "second", "third")

      const out = yield* Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore.use(Effect.succeed).pipe(
          Effect.provide(KeyValueStore.layerMemory)
        )
        const store = NodeStore.keyValue(kv)

        const before = yield* SessionTree.make(agent, { store })
        const session = yield* AgentSession.make(agent)
        yield* before.track(session)
        yield* session.prompt("one")
        yield* settle(before, 1)
        yield* session.prompt("two")
        yield* settle(before, 2)

        const original = yield* before.nodes
        const originalPath = yield* before.path(original[original.length - 1]!)

        // A second tree over the same backing, holding nothing of its own --
        // which is what a restart looks like from in here.
        const after = yield* SessionTree.make(agent, { store })
        const restored = yield* after.nodes
        const leaf = restored[restored.length - 1]!

        return {
          original: original.map((node) => node.id),
          restored: restored.map((node) => node.id),
          originalDepth: originalPath.length,
          restoredDepth: (yield* after.path(leaf)).length,
          history: (yield* after.historyOf(leaf)).content.length,
          root: yield* after.root,
          // And it can be worked from, not merely read: branching needs the
          // stored conversation to be a real prompt again, not a shape.
          branched: yield* after.branch(leaf)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.deepStrictEqual(out.restored, out.original)
      assert.strictEqual(out.restoredDepth, out.originalDepth)
      assert.isAbove(out.history, 0)
      assert.isTrue(Option.isSome(out.root))
      assert.isDefined(out.branched.id)
    })
  )

  it.effect("a store failure reaches the caller who asked", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("answered")

      const out = yield* Effect.gen(function*() {
        // Everything fails. What matters is not the message but that `commit`
        // reports it rather than swallowing it or reporting "no such node":
        // storage being unavailable is not the same answer as an empty tree.
        const broken: NodeStore.NodeStore<NodeStore.StoreError> = {
          put: () => Effect.fail(new NodeStore.StoreError({ operation: "write", detail: "disk" })),
          get: () => Effect.fail(new NodeStore.StoreError({ operation: "read", detail: "disk" })),
          children: () => Effect.fail(new NodeStore.StoreError({ operation: "read", detail: "disk" })),
          roots: Effect.fail(new NodeStore.StoreError({ operation: "read", detail: "disk" })),
          nodes: Effect.fail(new NodeStore.StoreError({ operation: "read", detail: "disk" }))
        }
        const tree = yield* SessionTree.make(agent, { store: broken })
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        return yield* Effect.flip(tree.commit(session))
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The store's own error, not a `NodeMissing` and not a `SessionBusy`:
      // storage being unavailable is a different answer from an empty tree.
      assert.strictEqual(out._tag, "@doeixd/effect-agent/tree/StoreError")
    })
  )

  it.effect("a label is carried, and is absent unless given", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("answered")

      const out = yield* Effect.gen(function*() {
        const tree = yield* SessionTree.make(agent)
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ask")
        const plain = yield* tree.commit(session)
        const named = yield* tree.commit(session, { label: "before refactor", cause: "manual" })
        return { plain, named, count: (yield* tree.nodes).length }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.isTrue(Option.isNone(out.plain.label))
      assert.strictEqual(Option.getOrThrow(out.named.label), "before refactor")
      assert.strictEqual(out.named.cause, "manual")
      // Marking an unchanged point labels the node that is there rather than
      // adding a second one holding the same conversation.
      assert.strictEqual(out.count, 1)
      assert.strictEqual(out.named.id, out.plain.id)
    })
  )

  /**
   * R78 -- a walk through a store the caller supplied must terminate.
   *
   * `NodeStore` is public: an application can write its own, and a persistent
   * one can be damaged. Neither can produce a cycle through the tree's own
   * operations -- a parent is fixed at insertion and every node is inserted
   * below an existing one -- but `path` followed parent pointers with no
   * memory, so a node that is its own ancestor was not a wrong answer, it was
   * a hang, with `summary`, `commonAncestor` and `divergence` behind it.
   *
   * The fixture is a store, not a tree: this is precisely the state the tree
   * cannot reach on its own.
   */
  it.effect("a cyclic store is refused rather than walked forever", () =>
    Effect.gen(function*() {
      // Nothing is asked of the model here; the tree just needs one to exist.
      const { layer } = yield* script("unused")
      const node = (id: string, parent: string): SessionTree.Node => ({
        id: id as SessionTree.NodeId,
        parent: Option.some(parent as SessionTree.NodeId),
        cause: "prompt",
        at: 0,
        label: Option.none()
      })
      const empty = Prompt.fromMessages([])

      const store = yield* NodeStore.memory
      // Its own parent.
      yield* store.put(node("self", "self"), empty)
      // And a two-node ring, because a self-loop is the easy case and a
      // visited set that only compared against the starting node would pass it.
      yield* store.put(node("a", "b"), empty)
      yield* store.put(node("b", "a"), empty)

      const tree = yield* SessionTree.make(agent, { store }).pipe(Effect.provide(layer))

      for (const id of ["self", "a", "b"]) {
        const found = Option.getOrThrow(yield* store.get(id as SessionTree.NodeId))
        const outcome = yield* Effect.flip(tree.path(found.node))
        assert.strictEqual(outcome._tag, "@doeixd/effect-agent/tree/TreeCorrupt")
        // And everything built on the walk answers the same way rather than
        // inheriting the hang.
        const summarised = yield* Effect.flip(tree.summary(found.node))
        assert.strictEqual(summarised._tag, "@doeixd/effect-agent/tree/TreeCorrupt")
      }
    }).pipe(Effect.scoped))

  /**
   * R22 -- two commits of one session are not two nodes.
   *
   * `record` reads where the session sits, decides whether the conversation
   * moved, allocates an id, writes, and then updates two more maps. Run twice
   * concurrently for one idle session, both used to pass the "has anything
   * changed" check and create sibling nodes holding the same conversation --
   * with one of them reachable only as an orphan, because only one could win
   * the race to become the tip.
   */
  it.effect("concurrent commits of one session record one node", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("an answer")
      yield* Effect.gen(function*() {
        const inner = yield* NodeStore.memory
        /**
         * A store that yields before answering.
         *
         * With a synchronous store the two commits simply run one after the
         * other and the test cannot fail however the tree is written. Any
         * real store -- a file, a socket, a database -- suspends, and that is
         * where the second commit gets in between the first one's check and
         * its write.
         */
        const store: NodeStore.NodeStore = {
          ...inner,
          get: (id) => Effect.andThen(Effect.yieldNow, inner.get(id)),
          put: (node, history) => Effect.andThen(Effect.yieldNow, inner.put(node, history))
        }
        const tree = yield* SessionTree.make(agent, { store })
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("say something")

        const both = yield* Effect.all(
          [tree.commit(session), tree.commit(session)],
          { concurrency: "unbounded" }
        )

        // The same node, twice -- not two siblings holding one conversation.
        assert.strictEqual(both[0].id, both[1].id)
        assert.strictEqual((yield* inner.nodes).length, 1)
      }).pipe(Effect.provide(layer), Effect.scoped)
    }))

  /**
   * R44 -- capture absorbs a store failure, and nothing else.
   *
   * It ran under `catchCause`, which also swallowed interruption: closing a
   * tracking scope while a write was in flight turned the cancellation into a
   * log line and left the observer running. A defect from the tree, a codec
   * or the store read the same way -- as an ordinary missed snapshot.
   *
   * The store here fails every write with its declared error, which must be
   * absorbed: a full disk cannot be allowed to kill the agent mid-turn.
   */
  it.effect("a failing store does not take the agent down with it", () =>
    Effect.gen(function*() {
      const { layer } = yield* script("an answer")
      yield* Effect.gen(function*() {
        const memory = yield* NodeStore.memory
        const failing: NodeStore.NodeStore<NodeStore.StoreError> = {
          ...memory,
          put: () =>
            Effect.fail(
              new NodeStore.StoreError({ operation: "write", detail: "the disk is full" })
            )
        }
        const tree = yield* SessionTree.make(agent, { store: failing })
        const session = yield* AgentSession.make(agent)
        yield* tree.track(session)

        // The turn completes: the capture failed, and said so, and that is all.
        const result = yield* Effect.exit(session.prompt("say something"))
        assert.strictEqual(result._tag, "Success")
        // Nothing was recorded, which is the real and lesser loss.
        assert.deepStrictEqual(yield* failing.nodes, [])
      }).pipe(Effect.provide(layer), Effect.scoped)
    }))

  /**
   * R127 -- a committed turn is always a turn the tree saw.
   *
   * The history commit was uninterruptible and the two events that announce it
   * were not. `capture` records a node only when it observes `TurnCompleted`,
   * so an interrupt landing after the write but before that event left a real
   * committed turn with no tree node -- and no way to recover the boundary,
   * because a later turn's capture folds both into one snapshot. The
   * submission could also report itself interrupted while its response was
   * already canonical.
   *
   * Driven by interrupting repeatedly at every point the scheduler offers.
   *
   * **It does not reproduce the window, and passes without the fix.** The gap
   * is between an uninterruptible commit and the emission that follows it,
   * which is a handful of instructions; an interrupt issued from outside lands
   * before or after, not inside. What the test does catch is a coarse
   * regression -- capture failing, or the turn count and the node count
   * diverging for any other reason -- and it is labelled so it does not read
   * as proof of the narrow one.
   */
  it.effect("history and the tree never disagree about how many turns happened", () =>
    Effect.gen(function*() {
      const { layer } = yield* script(
        ...Array.from({ length: 30 }, (_, index) => `answer ${index}`)
      )

      yield* Effect.gen(function*() {
        const store = yield* NodeStore.memory
        const tree = yield* SessionTree.make(agent, { store })
        const session = yield* AgentSession.make(agent)
        yield* tree.track(session)

        for (let attempt = 0; attempt < 12; attempt++) {
          const running = yield* Effect.forkChild(
            Effect.exit(session.prompt(`turn ${attempt}`))
          )
          // A different number of scheduler passes each time, so the interrupt
          // lands at a different point in the turn.
          yield* Effect.forEach(
            Array.from({ length: attempt }),
            () => Effect.yieldNow,
            { discard: true }
          )
          yield* session.interrupt().pipe(Effect.ignore)
          yield* Fiber.join(running)
        }
        yield* Effect.yieldNow

        // An assistant message in history is a completed turn.
        const history = yield* session.history
        const completed = history.content.filter((message) => message.role === "assistant").length
        // The root node is not a turn; every other node is one.
        const nodes = (yield* store.nodes).length

        assert.strictEqual(
          nodes,
          completed,
          "a turn was committed to history without the tree recording a node for it"
        )
      }).pipe(Effect.provide(layer), Effect.scoped)
    }))
})
