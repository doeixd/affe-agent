/**
 * The basic settings page (plan-workbench.md W1): an agent's configuration
 * as a form, whose choices are the deployment's `Catalog` and whose Save is
 * a new revision -- never an edit in place, so a conversation already
 * running keeps the revision it started on (decisions D6).
 *
 * Plain like `ConversationPage`: the form's state is the draft, and what is
 * saved is whatever the registry answers.
 */
import { Effect, Option } from "effect"
import type { ManagedRuntime } from "effect"
import { useEffect, useState } from "react"
import { Permission } from "affe-agent"
import type { AgentRevision, AgentSpec, RevisionInput } from "../domain/AgentRevision.js"
import type { AgentId, UserId } from "../domain/WorkbenchIds.js"
import { Catalog } from "../runtime/Catalog.js"
import * as Starters from "../ui-core/Starters.js"
import type { View as CatalogView } from "../runtime/Catalog.js"
import { AgentRegistry } from "../store/AgentRegistry.js"

export interface AgentSettingsPageProps {
  readonly runtime: ManagedRuntime.ManagedRuntime<AgentRegistry | Catalog, never>
  readonly owner: UserId
  /** `None` makes a new agent. */
  readonly agentId: Option.Option<AgentId>
  readonly onSaved?: ((agent: AgentSpec, revision: AgentRevision) => void) | undefined
}

interface Draft {
  readonly name: string
  readonly instructions: string
  readonly model: string
  readonly capabilities: ReadonlySet<string>
  readonly skills: ReadonlySet<string>
  readonly maxTurns: number
  /** One starter per line, as typed. */
  readonly starters: string
}

interface Loaded {
  readonly catalog: CatalogView
  readonly agent: Option.Option<AgentSpec>
  readonly revision: Option.Option<AgentRevision>
}

type State =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed"; readonly error: { readonly _tag: string } }
  | { readonly _tag: "Ready"; readonly loaded: Loaded; readonly draft: Draft; readonly saved: Option.Option<AgentRevision> }

const draftOf = (catalog: CatalogView, agent: Option.Option<AgentSpec>, revision: Option.Option<AgentRevision>): Draft =>
  Option.match(revision, {
    onNone: () => ({
      name: "",
      instructions: "",
      model: catalog.models[0] ?? "",
      capabilities: new Set<string>(),
      skills: new Set<string>(),
      maxTurns: 8,
      starters: ""
    }),
    onSome: (current) => ({
      name: Option.match(agent, { onNone: () => "", onSome: (spec) => spec.name }),
      instructions: current.instructions,
      model: current.modelPolicy.profile,
      capabilities: new Set(current.capabilities.map((ref) => ref.id)),
      skills: new Set(current.skills.map((ref) => ref.id)),
      maxTurns: current.maxTurns,
      starters: (current.starters ?? []).join("\n")
    })
  })

const load = (agentId: Option.Option<AgentId>) =>
  Effect.gen(function*() {
    const catalog = yield* yield* Catalog
    const registry = yield* AgentRegistry
    const agent = yield* Option.match(agentId, {
      onNone: () => Effect.succeed(Option.none<AgentSpec>()),
      onSome: (id) => registry.get(id)
    })
    const revision = yield* Option.match(agent, {
      onNone: () => Effect.succeed(Option.none<AgentRevision>()),
      onSome: (spec) => registry.revision(spec.activeRevisionId)
    })
    return { catalog, agent, revision }
  })

const toggle = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

const Choices = ({ chosen, legend, names, onChange }: {
  readonly legend: string
  readonly names: ReadonlyArray<string>
  readonly chosen: ReadonlySet<string>
  readonly onChange: (next: ReadonlySet<string>) => void
}) => (
  <fieldset>
    <legend>{legend}</legend>
    {names.length === 0 ? <p>None offered.</p> : names.map((id) => (
      <label key={id} style={{ display: "block" }}>
        <input type="checkbox" checked={chosen.has(id)} onChange={(event) => onChange(toggle(chosen, id, event.target.checked))} />
        {" "}{id}
      </label>
    ))}
  </fieldset>
)

export const AgentSettingsPage = ({ agentId, onSaved, owner, runtime }: AgentSettingsPageProps) => {
  const [state, setState] = useState<State>({ _tag: "Loading" })
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(Option.none<string>())

  useEffect(() => {
    setState({ _tag: "Loading" })
    let live = true
    void runtime.runPromiseExit(load(agentId)).then((exit) => {
      if (!live) return
      if (exit._tag === "Success") {
        const loaded = exit.value
        setState({ _tag: "Ready", loaded, draft: draftOf(loaded.catalog, loaded.agent, loaded.revision), saved: Option.none() })
      } else {
        setState({ _tag: "Failed", error: { _tag: "Unavailable" } })
      }
    })
    return () => {
      live = false
    }
  }, [runtime, Option.getOrUndefined(agentId)])

  if (state._tag === "Loading") return <p>Loading…</p>
  if (state._tag === "Failed") return <p role="alert">Could not load the agent ({state.error._tag}).</p>
  if (Option.isSome(agentId) && Option.isNone(state.loaded.agent)) return <p role="alert">No such agent.</p>

  const { draft, loaded } = state
  const setDraft = (patch: Partial<Draft>) => setState({ ...state, draft: { ...draft, ...patch } })

  const save = () => {
    setSaving(true)
    setSaveFailed(Option.none())
    const input: RevisionInput = {
      instructions: draft.instructions,
      modelPolicy: { profile: draft.model },
      capabilities: [...draft.capabilities].sort().map((id) => ({ id })),
      skills: [...draft.skills].sort().map((id) => ({ id })),
      // A revision keeps the policy it had; a new agent starts permissive, which is W1's one policy.
      permission: Option.match(loaded.revision, {
        onNone: () => ({ recorded: JSON.stringify(Permission.describe(Permission.allowAll)) }),
        onSome: (current) => current.permission
      }),
      maxTurns: draft.maxTurns,
      starters: Starters.normalize(draft.starters.split("\n"))
    }
    const write = Effect.gen(function*() {
      const registry = yield* AgentRegistry
      return yield* Option.match(loaded.agent, {
        onNone: () => registry.create({ ownerId: owner, name: draft.name, revision: input }),
        onSome: (spec) =>
          Effect.map(registry.revise(spec.id, input, owner), (revision) => ({
            spec: { ...spec, activeRevisionId: revision.id },
            revision
          }))
      })
    })
    void runtime.runPromiseExit(write).then((exit) => {
      setSaving(false)
      if (exit._tag === "Success") {
        const { revision, spec } = exit.value
        setState({
          _tag: "Ready",
          loaded: { ...loaded, agent: Option.some(spec), revision: Option.some(revision) },
          draft: { ...draft, name: spec.name },
          saved: Option.some(revision)
        })
        onSaved?.(spec, revision)
      } else {
        // The draft is kept: what was typed is not lost to a store that could not take it.
        setSaveFailed(Option.some(exit.cause.toString()))
      }
    })
  }

  const isNew = Option.isNone(loaded.agent)
  const cannotSave = saving || draft.model === "" || (isNew && draft.name.trim() === "")

  return (
    <form
      aria-label="Agent settings"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
      style={{ display: "grid", gap: "0.75rem", maxWidth: "36rem" }}
    >
      <h2>{Option.match(loaded.agent, { onNone: () => "New agent", onSome: (spec) => spec.name })}</h2>
      {isNew
        ? (
          <label>
            Name{" "}
            <input name="name" value={draft.name} onChange={(event) => setDraft({ name: event.target.value })} />
          </label>
        )
        : null}
      <label>
        Instructions{" "}
        <textarea
          name="instructions"
          rows={6}
          value={draft.instructions}
          onChange={(event) => setDraft({ instructions: event.target.value })}
        />
      </label>
      <label>
        Model{" "}
        <select name="model" value={draft.model} onChange={(event) => setDraft({ model: event.target.value })}>
          {loaded.catalog.models.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <Choices legend="Capabilities" names={loaded.catalog.capabilities} chosen={draft.capabilities} onChange={(capabilities) => setDraft({ capabilities })} />
      <Choices legend="Skills" names={loaded.catalog.skills} chosen={draft.skills} onChange={(skills) => setDraft({ skills })} />
      <label>
        Starter prompts, one per line{" "}
        <textarea name="starters" rows={3} value={draft.starters} onChange={(event) => setDraft({ starters: event.target.value })} />
      </label>
      <label>
        Max turns{" "}
        <input
          name="maxTurns"
          type="number"
          min={1}
          value={draft.maxTurns}
          onChange={(event) => setDraft({ maxTurns: Math.max(1, Math.floor(Number(event.target.value)) || 1) })}
        />
      </label>
      <div>
        <button type="submit" disabled={cannotSave}>{isNew ? "Create" : "Save as new revision"}</button>
        {Option.isSome(saveFailed) ? <p role="alert">Could not save; the draft is kept. Try again.</p> : null}
        {Option.match(state.saved, {
          onNone: () => Option.match(loaded.revision, { onNone: () => null, onSome: (r) => <span> Revision {r.revision} is active.</span> }),
          onSome: (r) => <span role="status"> Saved revision {r.revision}.</span>
        })}
      </div>
    </form>
  )
}
