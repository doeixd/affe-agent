/**
 * A conversation's starter prompts: its *pinned* revision's, so a
 * conversation offers what the agent offered when it began, as it runs
 * what the agent ran then (D6). Nothing found is none; a page with no
 * starters still works.
 */
import { Effect, Option } from "effect"
import type { ConversationId } from "../domain/WorkbenchIds.js"
import { AgentRegistry } from "../store/AgentRegistry.js"
import { ConversationStore } from "../store/ConversationStore.js"
import * as Starters from "../ui-core/Starters.js"

export const of = (id: ConversationId): Effect.Effect<ReadonlyArray<string>, never, ConversationStore | AgentRegistry> =>
  Effect.gen(function*() {
    const conversation = yield* (yield* ConversationStore).get(id)
    if (Option.isNone(conversation)) return []
    const revision = yield* (yield* AgentRegistry).revision(conversation.value.agentRevisionId)
    return Option.match(revision, { onNone: () => [], onSome: (found) => Starters.normalize(found.starters ?? []) })
  }).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])))
