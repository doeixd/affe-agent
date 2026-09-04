import { Effect, Option, Schema } from "effect"
import type { LanguageModel, Tool } from "effect/unstable/ai"
import { Prompt } from "effect/unstable/ai"
import type { Scope } from "effect"
import type * as AgentEvent from "../AgentEvent.js"
import type * as AgentSession from "../AgentSession.js"
import type * as Compaction from "../compaction/Compaction.js"
import type * as NodeStore from "./NodeStore.js"
import type * as SessionTree from "./SessionTree.js"

/**
 * Carry work from an abandoned branch into another.
 *
 * When the user navigates away from one line of work and continues on
 * another, what the abandoned line learned should not simply vanish. This
 * module summarises exactly the stretch the old branch did *after* the two
 * lines parted -- `tree.divergence` names it -- and seeds a fresh branch of
 * the target with that summary, using the same `Summarise` vocabulary as
 * `/compaction` (`docs/plan-branching-and-compaction.md` §16–19).
 *
 * Deliberately a separate noun from `Compaction`, because it is not
 * compaction: nothing is projected and nothing is ephemeral. The carryover
 * message is part of the seeded history, so the new branch's first commit
 * records it and every descendant inherits it -- the `ContextTransform`
 * rule that information which must survive future turns belongs in
 * committed history, applied. The abandoned branch and the target node are
 * untouched; the tree still holds both.
 */

/**
 * The two branches have nothing between them to carry.
 *
 * Either `from` is an ancestor of `to` -- everything it did is already in
 * the target's history -- or the walk from the common ancestor to `from`
 * added no messages. A summary of nothing would seed the new branch with a
 * confidently empty carryover, which is worse than refusing.
 */
export class NothingToCarry extends Schema.TaggedError<NothingToCarry>()(
  "affe-agent/tree/NothingToCarry",
  { from: Schema.String, to: Schema.String }
) {
  override get message() {
    return `Branch ${this.from} did nothing after parting from ${this.to}'s line; there is nothing to carry`
  }
}

export interface CarryOptions<SE, SR> {
  /** The branch being navigated away from. */
  readonly from: NodeStore.Node
  /** The node the new branch starts from. */
  readonly to: NodeStore.Node
  /**
   * The same vocabulary `/compaction` uses, so one summariser serves both.
   * `Compaction.model()` works here unchanged; its `previous` is always
   * `None` -- a carryover replaces nothing.
   */
  readonly summarise: Compaction.Summarise<SE, SR>
  /** Focus text, passed to the summariser as manual instructions are. */
  readonly instructions?: string | undefined
  /** Name the new line of work, as `tree.branch` would. */
  readonly lane?: string | undefined
}

/**
 * What carrying produced, with its provenance.
 *
 * Provenance lives here rather than on a fake message protocol
 * (`plan-branching-and-compaction.md` §20): a UI that wants "context
 * imported from branch X" keeps this value; the seeded message itself
 * carries only the words.
 */
export interface Carried<Tools extends Record<string, Tool.Any>, E> {
  /** A fresh branch of `to`, its history ending with the carryover. */
  readonly session: AgentSession.AgentSession<Tools, E>
  /** The summary text that was seeded. */
  readonly summary: string
  /** What the summary cost, when the summariser reported it. */
  readonly usage: Option.Option<AgentEvent.ModelUsage>
  readonly from: NodeStore.NodeId
  readonly to: NodeStore.NodeId
  readonly commonAncestor: Option.Option<NodeStore.NodeId>
}

/** The message the new branch starts with, after the target's history. */
const carryoverMessage = (summary: string): Prompt.Message =>
  Prompt.systemMessage({
    content: `Context carried from another branch:\n\n${summary}`
  })

/**
 * Summarise what `from` did after parting from `to`'s line, and branch `to`
 * seeded with that summary.
 *
 * The stretch summarised is exactly the abandoned work: `from`'s history
 * minus the common ancestor's. The target's own messages are never
 * summarised -- the new branch has them verbatim -- and the summary becomes
 * canonical on the new branch because it is in the history the branch is
 * seeded with, so the first turn's commit records it and descendants keep
 * it. Nothing is written to `from`, `to`, or any existing node.
 */
export const branch = <
  Tools extends Record<string, Tool.Any>,
  E,
  TSE,
  SE,
  SR
>(
  tree: SessionTree.SessionTree<Tools, E, TSE>,
  options: CarryOptions<SE, SR>
): Effect.Effect<
  Carried<Tools, E>,
  SessionTree.NodeMissing | SessionTree.TreeCorrupt | NothingToCarry | TSE | SE,
  Scope.Scope | LanguageModel.LanguageModel | SR
> =>
  Effect.gen(function*() {
    const divergence = yield* tree.divergence(options.from, options.to)
    const fromHistory = yield* tree.historyOf(options.from)
    // The shared prefix is the common ancestor's conversation; history is
    // append-only below it, so the abandoned stretch is a straight slice.
    const shared = Option.isNone(divergence.at)
      ? 0
      : (yield* tree.historyOf(divergence.at.value)).content.length
    const abandoned = fromHistory.content.slice(shared)
    if (abandoned.length === 0) {
      return yield* new NothingToCarry({ from: options.from.id, to: options.to.id })
    }
    const summarised = yield* options.summarise({
      messages: Prompt.fromMessages(abandoned),
      previous: Option.none(),
      instructions: Option.fromNullishOr(options.instructions)
    })
    const summary = typeof summarised === "string"
      ? { text: summarised, usage: Option.none<AgentEvent.ModelUsage>() }
      : summarised
    const session = yield* tree.branch(options.to, {
      ...(options.lane === undefined ? {} : { lane: options.lane }),
      seed: (history) =>
        Prompt.fromMessages([...history.content, carryoverMessage(summary.text)])
    })
    return {
      session,
      summary: summary.text,
      usage: summary.usage,
      from: options.from.id,
      to: options.to.id,
      commonAncestor: Option.map(divergence.at, (node) => node.id)
    }
  })
