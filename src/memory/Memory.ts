import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as AgentLoop from "../AgentLoop.js"
import * as ContextTransform from "../ContextTransform.js"
import * as Permission from "../Permission.js"

/**
 * Long-term, cross-session memory (issue #4 / ADDITIONAL §8).
 *
 * This is *not* conversation history -- that is canonical, owned by the run
 * engine and scoped to one session. Memory is what a session should still know
 * next week: a user's preferences, facts learned in an earlier conversation.
 * There is no core concept for it; memory is "a service plus a transform," and
 * this package is exactly that, over the seams that already exist.
 *
 * The contract is the minimal one (TanStack's): `recall(scope, query)` and
 * `remember(scope, entry)`. An adapter owns extraction, ranking and storage --
 * embeddings, Redis, a hosted store -- behind that interface. The in-memory
 * `layer` here is a keyword-matching built-in for tests and single-node use.
 *
 * Two things sit on top:
 *
 * - `Memory.recall(scope)` -- a `ContextTransform` that recalls against the
 *   latest user turn and injects what it finds, before the model call. It is
 *   **non-fatal**: a broken memory store degrades the reply, it does not kill
 *   the run (TanStack's default, and the sensible one).
 * - `Memory.rememberTool(scope)` -- a tool the model calls to save a durable
 *   fact, and `Memory.writer(scope, extract)` -- a loop hook that records after
 *   each turn from an extractor you supply. Deliberate, model-driven saving and
 *   automatic saving; use either or both.
 *
 * `scope` is who the memory belongs to -- a user or tenant id. Derive it from a
 * trusted application service or auth, **never** from unvalidated model output,
 * or one user's session could read another's memory.
 */

/** Whose memory: a user, tenant or conversation id, from a trusted source. */
export type MemoryScope = string

/** A store failure. Recoverable -- `recall` and `writer` treat it as non-fatal. */
export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  reason: Schema.String
}) {
  override get message() {
    return this.reason
  }
}

/** One remembered thing. Kept to its content; an adapter may attach its own metadata. */
export interface MemoryEntry {
  readonly content: string
}

/** What `recall` returns: the entries an adapter judged relevant, best first. */
export interface MemoryRecall {
  readonly entries: ReadonlyArray<MemoryEntry>
}

export interface MemoryShape {
  /** Recall entries relevant to `query` within `scope`, best first. */
  readonly recall: (scope: MemoryScope, query: string) => Effect.Effect<MemoryRecall, MemoryError>
  /** Save one entry under `scope`. */
  readonly remember: (scope: MemoryScope, entry: MemoryEntry) => Effect.Effect<void, MemoryError>
}

/**
 * The memory service. A tool, transform or loop reaches it through the
 * requirement channel; an application provides an implementation as a layer --
 * the in-memory `layer` here, or an embeddings/Redis adapter of its own.
 */
export class Memory extends Context.Service<Memory, MemoryShape>()(
  "@doeixd/effect-agent/memory/Memory"
) {}

// ---------------------------------------------------------------------------
// In-memory built-in
// ---------------------------------------------------------------------------

// Distinct words of length >= 2, lowercased. Deduped so a query that repeats a
// word ("budget budget report") does not score an entry twice for it; the
// score is how many *distinct* query words an entry contains. This is a plain
// keyword matcher for tests and single-node use -- a real adapter ranks with
// embeddings; see the module doc.
const tokens = (text: string): ReadonlyArray<string> =>
  Array.from(new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2)))

/**
 * A keyword-matching, in-process memory. Suitable for tests and single-node
 * development; the map dies with the process. `recall` scores each entry by how
 * many of the query's words it contains and returns the best `limit`. A real
 * deployment implements `Memory` with embeddings or a hosted store instead.
 */
export const layer = (options?: { readonly limit?: number }): Layer.Layer<Memory> =>
  Layer.effect(
    Memory,
    Effect.gen(function* () {
      const store = yield* Ref.make(new Map<string, ReadonlyArray<MemoryEntry>>())
      const limit = options?.limit ?? 5
      return {
        remember: (scope, entry) =>
          Ref.update(store, (map) => new Map(map).set(scope, [...(map.get(scope) ?? []), entry])),
        recall: (scope, query) =>
          Effect.map(Ref.get(store), (map) => {
            const entries = map.get(scope) ?? []
            const wanted = tokens(query)
            if (wanted.length === 0) {
              return { entries: [] }
            }
            const scored = entries
              .map((entry) => {
                const content = entry.content.toLowerCase()
                return { entry, score: wanted.filter((token) => content.includes(token)).length }
              })
              .filter((candidate) => candidate.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, limit)
            return { entries: scored.map((candidate) => candidate.entry) }
          })
      }
    })
  )

// ---------------------------------------------------------------------------
// Recall: inject relevant memory before a model call
// ---------------------------------------------------------------------------

const latestUserText = (prompt: Prompt.Prompt): string => {
  for (let i = prompt.content.length - 1; i >= 0; i = i - 1) {
    const message = prompt.content[i]!
    if (message.role === "user") {
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      if (text !== "") {
        return text
      }
    }
  }
  return ""
}

const systemMessage = (text: string): Prompt.Prompt =>
  Prompt.fromMessages([Prompt.systemMessage({ content: text })])

const defaultRender = (recall: MemoryRecall): string =>
  ["Relevant memories from earlier conversations:", ...recall.entries.map((entry) => `- ${entry.content}`)]
    .join("\n")

/**
 * A `ContextTransform` that recalls memory for `scope` and injects it as a
 * system message before the model call. The query defaults to the latest user
 * turn; the rendering to a short bulleted list.
 *
 * Non-fatal by design: if the store fails, the failure is logged and the prompt
 * passes through unchanged, so a broken memory backend degrades the reply
 * rather than failing the run. Nothing is injected when the query is empty or
 * nothing is recalled.
 */
export const recall = (
  scope: MemoryScope,
  options?: {
    /** How to derive the recall query from the prompt. Defaults to the latest user turn. */
    readonly query?: ((prompt: Prompt.Prompt) => string) | undefined
    /** How to render recalled entries into the injected message. */
    readonly render?: ((recall: MemoryRecall) => string) | undefined
  }
): ContextTransform.ContextTransform<never, Memory> => {
  const derive = options?.query ?? latestUserText
  const render = options?.render ?? defaultRender
  return ContextTransform.make((context) =>
    Effect.flatMap(Memory, (memory) => {
      const query = derive(context.prompt)
      if (query.trim() === "") {
        return Effect.succeed(context.prompt)
      }
      return memory.recall(scope, query).pipe(
        Effect.map((recalled) =>
          recalled.entries.length === 0
            ? context.prompt
            : Prompt.concat(context.prompt, systemMessage(render(recalled)))
        ),
        Effect.catchTag("MemoryError", (error) =>
          Effect.logWarning(`Memory recall failed for scope "${scope}": ${error.message}`).pipe(
            Effect.as(context.prompt)
          )
        )
      )
    })
  )
}

// ---------------------------------------------------------------------------
// Writing: a tool the model calls, and a loop hook that records automatically
// ---------------------------------------------------------------------------

/**
 * A tool the model calls to save a durable fact -- the model deciding what is
 * worth keeping, which is usually better than blind extraction. Projected as
 * `memory` on the content, so a policy can gate what gets written; a store
 * failure is returned to the model as a string, not a defect.
 */
export const rememberTool = (scope: MemoryScope) => {
  const RememberMemory = Permission.annotate(
    Tool.make("remember", {
      description: "Save a durable fact to long-term memory, to recall in a later conversation.",
      parameters: Schema.Struct({ content: Schema.String }),
      success: Schema.String,
      failure: Schema.String,
      dependencies: [Memory]
    }),
    { action: "memory", resource: (params) => params.content }
  )
  const handler: Agent.Handler<typeof RememberMemory> = ({ content }) =>
    Effect.flatMap(Memory, (memory) => memory.remember(scope, { content })).pipe(
      Effect.as("remembered"),
      Effect.catchTag("MemoryError", (error) => Effect.fail(error.message))
    )
  return Agent.tool(RememberMemory, handler)
}

/**
 * A loop hook that records to memory after each turn, from an extractor you
 * supply -- extraction being an adapter's concern, not the harness's. The
 * extractor sees the completed turn and returns an entry to save, or `None` to
 * save nothing. Writing is non-fatal: a store failure is logged, never stops
 * the run, and the hook always continues.
 *
 * Compose it *before* the stopping policy so it runs on every turn, including
 * the last: `AgentLoop.and(Memory.writer(scope, extract), AgentLoop.bounded(n))`.
 * (`and` short-circuits on the first `Stop`, so a writer placed after a policy
 * that stops would miss that turn.)
 */
export const writer = <Tools extends Record<string, Tool.Any>>(
  scope: MemoryScope,
  extract: (state: AgentLoop.State<Tools>) => Option.Option<MemoryEntry>
): AgentLoop.AgentLoop<never, Memory, Tools> =>
  AgentLoop.make((state) =>
    Option.match(extract(state), {
      onNone: () => Effect.succeed(AgentLoop.Continue),
      onSome: (entry) =>
        Effect.flatMap(Memory, (memory) => memory.remember(scope, entry)).pipe(
          Effect.catchTag("MemoryError", (error) =>
            Effect.logWarning(`Memory write failed for scope "${scope}": ${error.message}`)
          ),
          Effect.as(AgentLoop.Continue)
        )
    })
  )
