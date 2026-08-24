import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Stream } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
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
const settle = <Tools extends Record<string, never>, E>(
  tree: SessionTree.SessionTree<Tools, E>,
  count: number
): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((yield* tree.nodes).length >= count) return
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
          path: last === undefined ? [] : yield* tree.path(last)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Rewind can reach every turn, which is the point: a tree that only
      // captured explicit commits could reach none of them.
      assert.strictEqual(out.nodes.length, 3)
      // And they form a chain, not a fan.
      assert.strictEqual(out.path.length, 3)
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
})
