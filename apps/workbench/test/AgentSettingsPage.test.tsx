// @vitest-environment happy-dom
/**
 * The basic settings page (W1), rendered: its choices are the catalog, a
 * save is a new revision that the registry answers with, and an edit made
 * on the page is what the next conversation runs.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { Permission } from "affe-agent"
import { TestLanguageModel } from "affe-agent/testing"
import { AgentId, UserId } from "../src/domain/WorkbenchIds.js"
import { AgentSettingsPage } from "../src/react/AgentSettingsPage.js"
import * as AgentResolver from "../src/runtime/AgentResolver.js"
import * as Catalog from "../src/runtime/Catalog.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"

const owner = UserId.make("ada")

const makeRuntime = async () => {
  const { layer: fast } = await Effect.runPromise(TestLanguageModel.script([TestLanguageModel.text("ok")]))
  const { layer: careful } = await Effect.runPromise(TestLanguageModel.script([TestLanguageModel.text("ok")]))
  const bindings = Layer.succeed(AgentResolver.AgentBindings, {
    models: { fast, careful },
    capabilities: { workshop: [], web: [] },
    skills: {}
  })
  return ManagedRuntime.make(
    Layer.mergeAll(Catalog.layer, AgentRegistry.memory).pipe(Layer.provide(bindings))
  )
}

const registryOf = (runtime: ManagedRuntime.ManagedRuntime<AgentRegistry.AgentRegistry | Catalog.Catalog, never>) =>
  runtime.runPromise(AgentRegistry.AgentRegistry)

const select = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

afterEach(() => cleanup())

describe("catalog", () => {
  it("names what the bindings offer, sorted", async () => {
    const runtime = await makeRuntime()
    const view = await runtime.runPromise(Effect.gen(function*() {
      return yield* yield* Catalog.Catalog
    }))
    expect(view).toEqual({ models: ["careful", "fast"], capabilities: ["web", "workshop"], skills: [] })
  })
})

describe("agent settings page", () => {
  it("creates an agent from the form, with only what the catalog offers", async () => {
    const runtime = await makeRuntime()
    const saved: Array<AgentId> = []
    render(
      <AgentSettingsPage runtime={runtime} owner={owner} agentId={Option.none()} onSaved={(spec) => saved.push(spec.id)} />
    )
    await screen.findByRole("heading", { name: "New agent" })
    // The choices come from the catalog, not from anywhere on the page.
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["careful", "fast"])
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent?.trim())).toEqual(["web", "workshop"])
    // Nothing to create until it has a name.
    expect(screen.getByRole("button", { name: "Create" })).toHaveProperty("disabled", true)

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Researcher" } })
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Find things out." } })
    select("Model", "fast")
    fireEvent.click(screen.getByLabelText("web"))
    fireEvent.change(screen.getByLabelText("Max turns"), { target: { value: "3" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))

    await screen.findByRole("status")
    expect(screen.getByRole("status").textContent).toContain("Saved revision 1")
    expect(screen.getByRole("heading", { name: "Researcher" })).toBeTruthy()

    const registry = await registryOf(runtime)
    const [spec] = await runtime.runPromise(registry.list(owner))
    if (spec === undefined) throw new Error("nothing was created")
    expect(spec.name).toBe("Researcher")
    expect(saved).toEqual([spec.id])
    const revision = await runtime.runPromise(registry.revision(spec.activeRevisionId))
    expect(Option.getOrUndefined(revision)).toMatchObject({
      revision: 1,
      instructions: "Find things out.",
      modelPolicy: { profile: "fast" },
      capabilities: [{ id: "web" }],
      skills: [],
      maxTurns: 3,
      createdBy: owner
    })
  })

  it("an edit is a new revision; the old one is kept and the policy carried over", async () => {
    const runtime = await makeRuntime()
    const registry = await registryOf(runtime)
    const policy = { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) }
    const { spec } = await runtime.runPromise(registry.create({
      ownerId: owner,
      name: "Builder",
      revision: {
        instructions: "Build.",
        modelPolicy: { profile: "careful" },
        capabilities: [{ id: "workshop" }],
        skills: [],
        permission: policy,
        maxTurns: 4
      }
    }))
    render(<AgentSettingsPage runtime={runtime} owner={owner} agentId={Option.some(spec.id)} />)
    await screen.findByRole("heading", { name: "Builder" })
    // The form shows the active revision.
    expect(screen.getByLabelText("Instructions")).toHaveProperty("value", "Build.")
    expect(screen.getByLabelText("Model")).toHaveProperty("value", "careful")
    expect(screen.getByLabelText("workshop")).toHaveProperty("checked", true)
    expect(screen.getByLabelText("web")).toHaveProperty("checked", false)
    expect(screen.getByText("Revision 1 is active.")).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Build carefully." } })
    fireEvent.click(screen.getByLabelText("workshop"))
    fireEvent.click(screen.getByLabelText("web"))
    fireEvent.click(screen.getByRole("button", { name: "Save as new revision" }))
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Saved revision 2"))

    const revisions = await runtime.runPromise(registry.revisions(spec.id))
    expect(revisions.map((r) => [r.revision, r.instructions, r.capabilities.map((c) => c.id)])).toEqual([
      [1, "Build.", ["workshop"]],
      [2, "Build carefully.", ["web"]]
    ])
    expect(revisions[1]?.permission).toEqual(policy)
    const current = await runtime.runPromise(registry.get(spec.id))
    expect(Option.map(current, (found) => found.activeRevisionId)).toEqual(Option.some(revisions[1]?.id))
  })

  it("an agent that does not exist says so", async () => {
    const runtime = await makeRuntime()
    render(<AgentSettingsPage runtime={runtime} owner={owner} agentId={Option.some(AgentId.make("nobody"))} />)
    await screen.findByRole("alert")
    expect(screen.getByRole("alert").textContent).toBe("No such agent.")
  })
})
