import { Context, Effect, Layer, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../Agent.js"
import * as ContextTransform from "../ContextTransform.js"
import * as Permission from "../Permission.js"

/**
 * Skills (issue #4): an on-demand capability -- workflow guidance, reference
 * material -- that the model loads only when it needs it.
 *
 * There is deliberately no core skill concept (PLAN §39: "Do not add
 * skill-loading semantics to core"). A skill exposes its contents through the
 * two seams that already exist -- context derivation and tool availability --
 * so this package is a registry service, one `ContextTransform` and one tool,
 * and nothing in the engine changes.
 *
 * The loading strategy is the one that matters (OpenCode's): advertise only
 * metadata, never the bodies. A hundred skills cost a hundred one-line
 * descriptions in the prompt, not a hundred documents. The model reads the
 * catalogue, decides which it needs, and calls `load_skill` to pull that one
 * body -- and its supporting resources stay lazy until asked for by name.
 *
 * ```text
 * turn → advertise (metadata) → model calls load_skill → body enters context
 * ```
 *
 * Catalogue visibility and execution authorization are kept apart, as they
 * should be: everything registered is advertised, but `load_skill` carries a
 * `skill` permission projection on its id, so a policy decides which a given
 * session may actually load -- the Skills package owns no authorization itself.
 *
 * ```ts
 * const registry = Skills.layer([
 *   Skills.skill({
 *     id: "refunds",
 *     name: "Issuing refunds",
 *     description: "How to issue a refund and the policy limits on doing so.",
 *     body: "1. Verify the order... 2. Refunds over $500 need a manager..."
 *   })
 * ])
 *
 * // `install` bundles the load tool and the advertise transform so neither can
 * // be wired without the other; `loadTool` / `advertise` remain available for
 * // agents that compose them by hand.
 * const agent = Agent.make({ instructions: "..." }).pipe(Skills.install)
 * // ...provide `registry` at the session.
 * ```
 */

// ---------------------------------------------------------------------------
// A skill
// ---------------------------------------------------------------------------

/**
 * One skill: metadata that is always advertised, a body loaded on demand, and
 * any number of named resources loaded only if the model asks for them.
 *
 * `body` and each resource are Effects, not strings, so a skill can be a value
 * in code or a file read from a workspace -- laziness is the point, and an
 * Effect is what defers the read until `load_skill` runs.
 */
export interface Skill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly body: Effect.Effect<string>
  readonly resources: Readonly<Record<string, Effect.Effect<string>>>
}

const asEffect = (value: string | Effect.Effect<string>): Effect.Effect<string> =>
  typeof value === "string" ? Effect.succeed(value) : value

/** Build a skill, normalising string bodies and resources to Effects. */
export const skill = (options: {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly body: string | Effect.Effect<string>
  readonly resources?: Readonly<Record<string, string | Effect.Effect<string>>> | undefined
}): Skill => ({
  id: options.id,
  name: options.name,
  description: options.description,
  body: asEffect(options.body),
  resources: options.resources === undefined
    ? {}
    : Object.fromEntries(
      Object.entries(options.resources).map(([name, value]) => [name, asEffect(value)])
    )
})

/** What is advertised for a skill: enough to choose it, never the body. */
export interface Metadata {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly resources: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The set of skills a session can see and load.
 *
 * A service, so a skill tool and the advertise transform reach it through the
 * requirement channel, and an application can back it with anything -- a fixed
 * list, a directory, an HTTP catalogue -- behind the same interface. Only the
 * fixed-list `layer` ships here; a source is an ordinary layer over this tag.
 */
export interface SkillRegistryShape {
  /** Every skill's metadata, for the catalogue. */
  readonly list: Effect.Effect<ReadonlyArray<Metadata>>
  /** A skill's body by id, or `None` if there is no such skill. */
  readonly load: (id: string) => Effect.Effect<Option.Option<string>>
  /** A skill's named resource, or `None` if the skill or resource is unknown. */
  readonly loadResource: (
    id: string,
    resource: string
  ) => Effect.Effect<Option.Option<string>>
}

export class SkillRegistry extends Context.Service<SkillRegistry, SkillRegistryShape>()(
  "affe-agent/skills/SkillRegistry"
) {}

/** Build a registry from a fixed set of skills. Duplicate ids are a configuration error. */
export const layer = (skills: ReadonlyArray<Skill>): Layer.Layer<SkillRegistry> => {
  const byId = new Map<string, Skill>()
  for (const one of skills) {
    if (byId.has(one.id)) {
      // Two skills under one id would make `load` ambiguous, which nothing
      // downstream could detect -- fail loudly at construction instead.
      throw new Error(`Skills: duplicate skill id "${one.id}"`)
    }
    byId.set(one.id, one)
  }
  const metadata: ReadonlyArray<Metadata> = skills.map((one) => ({
    id: one.id,
    name: one.name,
    description: one.description,
    resources: Object.keys(one.resources)
  }))
  return Layer.succeed(SkillRegistry, {
    list: Effect.succeed(metadata),
    load: (id) => {
      const found = byId.get(id)
      return found === undefined ? Effect.succeed(Option.none()) : Effect.map(found.body, Option.some)
    },
    loadResource: (id, resource) => {
      const found = byId.get(id)
      const source = found === undefined ? undefined : found.resources[resource]
      return source === undefined ? Effect.succeed(Option.none()) : Effect.map(source, Option.some)
    }
  })
}

// ---------------------------------------------------------------------------
// Advertising: the catalogue as a system message
// ---------------------------------------------------------------------------

const renderCatalogue = (skills: ReadonlyArray<Metadata>): string => {
  if (skills.length === 0) {
    return "No skills are available."
  }
  const lines = skills.map((one) => {
    const resources = one.resources.length === 0
      ? ""
      : ` (resources: ${one.resources.join(", ")})`
    return `- ${one.id}: ${one.name} — ${one.description}${resources}`
  })
  return [
    "You have skills available. Each is a set of instructions you can load on",
    "demand -- call the load_skill tool with a skill's id before using it, and",
    "load a named resource with the resource argument. Do not guess a skill's",
    "contents; load it.",
    "",
    ...lines
  ].join("\n")
}

/**
 * A `ContextTransform` that advertises the catalogue -- metadata only -- as a
 * system message each turn. Derived, so canonical history never carries it and
 * it stays in step with the registry.
 */
export const advertise: ContextTransform.ContextTransform<never, SkillRegistry> =
  ContextTransform.appendSystem(() =>
    Effect.map(Effect.flatMap(SkillRegistry, (registry) => registry.list), renderCatalogue)
  )

// ---------------------------------------------------------------------------
// Loading: the tool the model calls
// ---------------------------------------------------------------------------

const Parameters = Schema.Struct({
  skill_id: Schema.String,
  /** A named resource of the skill to load instead of its body. Omit for the body. */
  resource: Schema.optional(Schema.String)
})

/**
 * The tool that loads a skill's body -- or one named resource -- into context.
 *
 * Projected as `skill` on the id, so a `Permission` policy gates which skills a
 * session may load without knowing anything about this tool. A missing skill or
 * resource is a string the model can correct, not a defect.
 */
export const LoadSkill = Permission.annotate(
  Tool.make("load_skill", {
    description:
      "Load a skill's instructions before using it, or one of its named resources with the resource argument.",
    parameters: Parameters,
    success: Schema.String,
    failure: Schema.String,
    dependencies: [SkillRegistry]
  }),
  { action: "skill", resource: (params) => params.skill_id }
)

const loadHandler: Agent.Handler<typeof LoadSkill> = ({ resource, skill_id }) =>
  Effect.flatMap(SkillRegistry, (registry) =>
    resource === undefined
      ? registry.load(skill_id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(`no skill "${skill_id}"`),
            onSome: (value) => Effect.succeed(value)
          })
        )
      )
      : registry.loadResource(skill_id, resource).pipe(
        Effect.flatMap(
          Option.match({
            // None covers both a missing skill and a missing resource; say so
            // rather than asserting the skill exists.
            onNone: () => Effect.fail(`no skill "${skill_id}", or it has no resource "${resource}"`),
            onSome: (value) => Effect.succeed(value)
          })
        )
      ))

/** The `load_skill` tool bound to its handler, ready for `Agent.make({ tools: [...] })`. */
export const loadTool = Agent.tool(LoadSkill, loadHandler)

/**
 * Install skills into an agent in one step: add the `load_skill` tool *and*
 * compose the {@link advertise} transform. Bundling the two removes the footgun
 * of wiring one without the other -- advertise without the tool shows the model
 * a catalogue it cannot open; the tool without advertise means it never learns
 * the catalogue exists, and nothing type-checks that pairing. Provide
 * `Skills.layer(...)` at the session to satisfy the `SkillRegistry` this adds.
 *
 * ```ts
 * const agent = Agent.make({ instructions: "..." }).pipe(Skills.install)
 * // ...then Effect.provide(Skills.layer([docsSkill, refactorSkill]))
 * ```
 */
export const install = <Tools extends Record<string, Tool.Any>, E, R>(
  agent: Agent.AgentDefinition<Tools, E, R>
) =>
  agent.pipe(
    Agent.withTools(loadTool),
    Agent.updateContextTransform((current) => ContextTransform.compose(current, advertise))
  )
