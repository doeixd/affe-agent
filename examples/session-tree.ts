import { Effect, Option } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as SessionTree from "../src/tree/SessionTree.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * A conversation as a tree: branch it, switch between branches, and render
 * the result to plain stdout (ST6 in `docs/plan-session-tree.md`).
 *
 * Runs as it is -- `npx tsx examples/session-tree.ts` -- against the scripted
 * test model, so the shape is visible without a provider. The point is that
 * the tree is a substrate: everything a UI would show (lanes, the point two
 * branches diverged, the transcript to paint on a switch) is an operation on
 * the tree, and the rendering below is just `console.log`.
 */

const agent = Agent.make({
  instructions: "You plan outings, briefly.",
  loop: AgentLoop.bounded(1)
})

// One reply per prompt, in the order the prompts below are made.
const replies = [
  "A picnic on Saturday: sandwiches, a blanket, a park with shade.",
  "At the beach instead: add sunscreen and a windbreak; skip the blanket for a mat.",
  "In the park it is: bring a frisbee and pick the spot by the pond.",
  "Beach it is, and for twelve people: three coolers and a second windbreak."
]

const textOf = (prompt: { readonly content: ReadonlyArray<{ readonly role: string; readonly content: unknown }> }) =>
  prompt.content
    .map((message) => {
      // A system message's content is the instruction text itself; the
      // others carry parts.
      const text = typeof message.content === "string"
        ? message.content
        : (Array.isArray(message.content) ? message.content : [])
          .flatMap((part: unknown) =>
            typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []
          )
          .join("")
      return `  ${message.role.padEnd(9)} ${text}`
    })
    .join("\n")

const program = Effect.gen(function* () {
  const tree = yield* SessionTree.make(agent)

  // The trunk: one exchange, then a node that names it.
  const trunk = yield* AgentSession.make(agent)
  yield* trunk.prompt("Plan a picnic for Saturday.")
  const root = yield* tree.commit(trunk)
  console.log(`trunk committed as ${root.id}`)

  // Two branches from the same node, each on its own lane. A branch is a
  // live session that starts from the node's history and goes its own way.
  const beach = yield* tree.branch(root, { lane: "beach" })
  yield* beach.prompt("Make it a beach day instead.")
  const beachTip = yield* tree.commit(beach)

  const park = yield* tree.branch(root, { lane: "park" })
  yield* park.prompt("Keep it in the park; what do we bring?")
  const parkTip = yield* tree.commit(park)

  // What a sidebar would list.
  console.log("\nlanes:")
  for (const lane of yield* tree.lanes) {
    const summary = yield* tree.summary(lane.leaf)
    console.log(`  ${lane.name.padEnd(6)} tip ${lane.leaf.id}  depth ${summary.depth}  messages ${summary.messages}`)
  }

  // Where the two lines of work parted, and how far each has gone since.
  const divergence = yield* tree.divergence(beachTip, parkTip)
  console.log(
    `\ndiverged at ${Option.match(divergence.at, { onNone: () => "(no common ancestor)", onSome: (node) => node.id })}: ` +
      `beach +${divergence.left.length}, park +${divergence.right.length}`
  )

  // Switching: activation hands back the transcript to paint and a live
  // session to keep talking to. The tree's active pointer follows.
  const activation = yield* tree.activate(beachTip)
  console.log(`\nswitched to ${activation.node.id}; transcript to paint:`)
  console.log(textOf(activation.history))

  yield* activation.session.prompt("Twelve people are coming now.")
  const grown = yield* tree.commit(activation.session)
  const active = yield* tree.active
  console.log(`\nbeach lane advanced to ${grown.id}; active is ${Option.map(active, (node) => node.id).pipe(Option.getOrElse(() => "(none)"))}`)
  console.log("\nbeach lane, in full:")
  console.log(textOf(yield* activation.session.history))
})

const main = Effect.gen(function* () {
  const { layer } = yield* TestLanguageModel.script(replies.map((reply) => TestLanguageModel.text(reply)))
  yield* program.pipe(Effect.provide(layer))
}).pipe(Effect.scoped)

Effect.runPromise(main).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
