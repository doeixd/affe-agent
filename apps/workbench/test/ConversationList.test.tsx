// @vitest-environment happy-dom
/**
 * The conversation sidebar, rendered over memory stores: a new conversation
 * runs the agent picked, and each conversation can be renamed, archived out
 * of the list and back, and deleted -- the last only after a second click.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { Permission } from "affe-agent"
import { TestLanguageModel } from "affe-agent/testing"
import type { ConversationId } from "../src/domain/WorkbenchIds.js"
import { UserId } from "../src/domain/WorkbenchIds.js"
import { ConversationList } from "../src/react/ConversationList.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as AgentResolver from "../src/runtime/AgentResolver.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"

const owner = UserId.make("ada")

const setup = async () => {
  const { layer: scripted } = await Effect.runPromise(TestLanguageModel.script([TestLanguageModel.text("ok")]))
  const bindings = Layer.succeed(AgentResolver.AgentBindings, { models: { scripted }, capabilities: {}, skills: {} })
  const runtime = ManagedRuntime.make(
    ConversationSessions.layer.pipe(
      Layer.provideMerge(AgentDirectory.layer),
      Layer.provideMerge(AgentResolver.layer),
      Layer.provideMerge(Layer.mergeAll(ConversationStore.memory, AgentRegistry.memory)),
      Layer.provide(bindings)
    )
  )
  const revision = {
    instructions: "",
    modelPolicy: { profile: "scripted" },
    capabilities: [],
    skills: [],
    permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
    maxTurns: 1
  }
  const agents = await runtime.runPromise(Effect.gen(function*() {
    const registry = yield* AgentRegistry.AgentRegistry
    const builder = yield* registry.create({ ownerId: owner, name: "Builder", revision })
    const writer = yield* registry.create({ ownerId: owner, name: "Writer", revision })
    return [builder.spec, writer.spec].map(({ id, name }) => ({ id, name }))
  }))
  const opened: Array<ConversationId> = []
  let closed = 0
  render(
    <ConversationList
      runtime={runtime}
      owner={owner}
      agents={agents}
      models={["scripted"]}
      selected={Option.none()}
      onOpen={(id) => opened.push(id)}
      onClosed={() => closed++}
    />
  )
  return { runtime, agents, opened, closedCount: () => closed }
}

const list = () => within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("list")
const stored = (runtime: ManagedRuntime.ManagedRuntime<ConversationStore.ConversationStore, never>, includeArchived = true) =>
  runtime.runPromise(Effect.flatMap(ConversationStore.ConversationStore, (store) => store.list({ ownerId: owner, includeArchived })))

afterEach(() => cleanup())

describe("conversation list", () => {
  it("starts a conversation on the agent picked, and renames, archives and deletes one", async () => {
    const { agents, opened, runtime } = await setup()
    try {
      // On the second agent, not the default.
      fireEvent.change(screen.getByLabelText("Agent"), { target: { value: agents[1]?.id } })
      fireEvent.click(screen.getByRole("button", { name: "New conversation" }))
      await waitFor(() => expect(opened.length).toBe(1))
      const [conversation] = await stored(runtime)
      if (conversation === undefined) throw new Error("nothing was created")
      expect(conversation.agentId).toBe(agents[1]?.id)
      expect(opened).toEqual([conversation.id])
      await waitFor(() => expect(list().textContent).toContain(conversation.title))

      // Renamed in place.
      fireEvent.click(screen.getByRole("button", { name: `Rename ${conversation.title}` }))
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Plans" } })
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await waitFor(() => expect(list().textContent).toContain("Plans"))
      expect((await stored(runtime))[0]?.title).toBe("Plans")

      // Archived: out of the list, back with "Show archived", and unarchived.
      fireEvent.click(screen.getByRole("button", { name: "Archive Plans" }))
      await waitFor(() => expect(list().textContent).not.toContain("Plans"))
      fireEvent.click(screen.getByLabelText("Show archived"))
      await waitFor(() => expect(list().textContent).toContain("(archived)"))
      fireEvent.click(screen.getByRole("button", { name: "Unarchive Plans" }))
      await waitFor(() => expect(list().textContent).not.toContain("(archived)"))
      expect((await stored(runtime))[0]?.archived).toBe(false)

      // Deleted only on the second click; "Keep" backs out.
      fireEvent.click(screen.getByRole("button", { name: "Delete Plans" }))
      fireEvent.click(screen.getByRole("button", { name: "Keep" }))
      expect((await stored(runtime)).length).toBe(1)
      fireEvent.click(screen.getByRole("button", { name: "Delete Plans" }))
      fireEvent.click(screen.getByRole("button", { name: "Confirm delete Plans" }))
      await waitFor(() => expect(list().textContent).not.toContain("Plans"))
      expect(await stored(runtime)).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it("a new conversation records the model picked, and the agent's own when none is", async () => {
    const { opened, runtime } = await setup()
    try {
      fireEvent.click(screen.getByRole("button", { name: "New conversation" }))
      await waitFor(() => expect(opened.length).toBe(1))
      fireEvent.change(screen.getByLabelText("Model"), { target: { value: "scripted" } })
      fireEvent.click(screen.getByRole("button", { name: "New conversation" }))
      await waitFor(() => expect(opened.length).toBe(2))
      const byId = new Map((await stored(runtime)).map((conversation) => [conversation.id, conversation.modelProfile]))
      expect(opened.map((id) => byId.get(id))).toEqual([Option.none(), Option.some("scripted")])
    } finally {
      await runtime.dispose()
    }
  })

  it("an empty title is not saved", async () => {
    const { opened, runtime } = await setup()
    try {
      fireEvent.click(screen.getByRole("button", { name: "New conversation" }))
      await waitFor(() => expect(opened.length).toBe(1))
      const [conversation] = await stored(runtime)
      if (conversation === undefined) throw new Error("nothing was created")
      await waitFor(() => expect(list().textContent).toContain(conversation.title))
      fireEvent.click(screen.getByRole("button", { name: `Rename ${conversation.title}` }))
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } })
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      expect((await stored(runtime))[0]?.title).toBe(conversation.title)
    } finally {
      await runtime.dispose()
    }
  })
})
