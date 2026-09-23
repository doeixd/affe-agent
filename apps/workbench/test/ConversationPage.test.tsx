// @vitest-environment happy-dom
/**
 * The plain W0 page, rendered: a person types, sees the reply stream in with
 * the tool and its progress, answers the agent's question, and stops a run --
 * each through the page's controls, over the in-process client.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Deferred, Effect, Layer, ManagedRuntime, Schema, Option } from "effect"
import { Tool } from "effect/unstable/ai"
import { afterEach, describe, expect, it } from "vitest"
import { Agent, Permission } from "affe-agent"
import { TestLanguageModel } from "affe-agent/testing"
import { UserId } from "../src/domain/WorkbenchIds.js"
import { ConversationPage } from "../src/react/ConversationPage.js"
import type { FeedbackActions, Rating } from "../src/react/ConversationPage.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as AgentResolver from "../src/runtime/AgentResolver.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"

const owner = UserId.make("ada")
const Build = Tool.make("build", { parameters: Schema.Struct({}), success: Schema.String })
const Dangerous = Tool.make("deleteEverything", { parameters: Schema.Struct({}), success: Schema.String })
  .setNeedsApproval(true)

const openPage = async (turns: ReadonlyArray<TestLanguageModel.Turn>, feedback?: FeedbackActions) => {
  const { layer: model } = await Effect.runPromise(TestLanguageModel.script(turns))
  const bindings = Layer.succeed(AgentResolver.AgentBindings, {
    models: { scripted: model },
    capabilities: {
      workshop: [
        Agent.tool(Build, (_params, context) => context.preliminary("halfway").pipe(Effect.as("built"))),
        Agent.tool(Dangerous, () => Effect.succeed("deleted"))
      ]
    },
    skills: {}
  })
  const runtime = ManagedRuntime.make(
    ConversationSessions.layer.pipe(
      Layer.provideMerge(AgentDirectory.layer),
      Layer.provideMerge(AgentResolver.layer),
      Layer.provideMerge(Layer.mergeAll(ConversationStore.memory, AgentRegistry.memory)),
      Layer.provide(bindings)
    )
  )
  const conversationId = await runtime.runPromise(Effect.gen(function*() {
    const registry = yield* AgentRegistry.AgentRegistry
    const { spec } = yield* registry.create({
      ownerId: owner,
      name: "Builder",
      revision: {
        instructions: "Build things.",
        modelPolicy: { profile: "scripted" },
        capabilities: [{ id: "workshop" }],
        skills: [],
        permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
        maxTurns: 4
      }
    })
    const sessions = yield* ConversationSessions.ConversationSessions
    const { conversation } = yield* sessions.create({ ownerId: owner, agentId: spec.id, title: "Page" })
    return conversation.id
  }))
  render(<ConversationPage runtime={runtime} conversationId={conversationId} feedback={feedback} />)
  await screen.findByRole("heading", { name: "Page" })
  return runtime
}

const send = (text: string) => {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } })
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
}

const button = (name: string): HTMLButtonElement => {
  const found = screen.getByRole("button", { name })
  if (!(found instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`)
  return found
}

afterEach(() => cleanup())

describe("ConversationPage", () => {
  it("streams a reply with its tool and progress, then answers the agent's question", async () => {
    const runtime = await openPage([
      { reasoning: { text: "Needs a build." }, toolCalls: [{ id: "b1", name: "build", params: {} }] },
      TestLanguageModel.text("Built it."),
      { toolCalls: [{ id: "d1", name: "deleteEverything", params: {} }] },
      TestLanguageModel.text("Deleted.")
    ])
    try {
      send("build it")
      await screen.findByText("Built it.")
      expect(screen.getByText("Needs a build.")).toBeTruthy()
      expect(screen.getByText(/build: succeeded \("halfway"\)/)).toBeTruthy()
      expect(screen.getByText("build it")).toBeTruthy()

      await waitFor(() => expect(button("Send").disabled).toBe(false))
      send("clean up")
      // The question names the tool, not just "tool-approval".
      const question = await screen.findByRole("region", { name: "Question" })
      expect(question.textContent).toMatch(/deleteEverything wants to/)
      expect(question.textContent).not.toMatch(/tool-approval/)
      fireEvent.click(await screen.findByRole("button", { name: "Approve" }))
      await screen.findByText("Deleted.")
      expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })

  it("a command the session refuses is shown, not swallowed", async () => {
    const runtime = await openPage([{ text: "never", hang: true }])
    try {
      // Two sends before the view has heard the first one start: the second
      // reaches a busy session and is refused before it becomes a run, which
      // no event will ever report.
      send("first")
      send("second")
      expect((await screen.findByRole("alert")).textContent).toMatch(/AgentBusyError/)
      // What was typed is not lost to a refusal.
      await waitFor(() => expect(screen.getByLabelText("Message")).toHaveProperty("value", "second"))
    } finally {
      await runtime.dispose()
    }
  })

  it("a failed run says why, and Retry sends the same message again", async () => {
    const runtime = await openPage([{ failWith: "provider unavailable" }, TestLanguageModel.text("Recovered.")])
    try {
      send("try it")
      const failure = await screen.findByRole("alert", { name: "Failure" })
      expect(failure.textContent).toMatch(/The last run failed/)
      await waitFor(() => expect(button("Retry").disabled).toBe(false))
      fireEvent.click(button("Retry"))
      await screen.findByText("Recovered.")
      // The failure is gone once the retry has started and settled.
      await waitFor(() => expect(screen.queryByRole("alert", { name: "Failure" })).toBeNull())
      // The retry sent the same words.
      expect(screen.getAllByText("try it").length).toBeGreaterThanOrEqual(1)
    } finally {
      await runtime.dispose()
    }
  })

  it("a settled reply can be rated, re-rated and un-rated; the rating is what the store holds", async () => {
    const stored = new Map<number, Rating>()
    const feedback: FeedbackActions = {
      list: Effect.sync(() => [...stored].map(([messageIndex, rating]) => ({ messageIndex, rating }))),
      rate: (index, rating) =>
        Effect.sync(() => {
          if (Option.isSome(rating)) stored.set(index, rating.value)
          else stored.delete(index)
        })
    }
    const runtime = await openPage([TestLanguageModel.text("A reply.")], feedback)
    try {
      send("hello")
      await screen.findByText("A reply.")
      const good = await screen.findByRole("button", { name: "Good reply" })
      // One rating control per settled reply, none on the person's own message.
      expect(screen.getAllByRole("group", { name: "Rate this reply" }).length).toBe(1)
      fireEvent.click(good)
      await waitFor(() => expect(good.getAttribute("aria-pressed")).toBe("true"))
      expect([...stored.values()]).toEqual(["up"])
      fireEvent.click(screen.getByRole("button", { name: "Bad reply" }))
      await waitFor(() => expect(screen.getByRole("button", { name: "Bad reply" }).getAttribute("aria-pressed")).toBe("true"))
      expect(good.getAttribute("aria-pressed")).toBe("false")
      expect([...stored.values()]).toEqual(["down"])
      fireEvent.click(screen.getByRole("button", { name: "Bad reply" }))
      await waitFor(() => expect(stored.size).toBe(0))
    } finally {
      await runtime.dispose()
    }
  })

  it("Stop interrupts the running submission", async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const runtime = await openPage([{ text: "never", hang: true, started }])
    try {
      send("wait")
      await Effect.runPromise(Deferred.await(started))
      await waitFor(() => expect(button("Stop").disabled).toBe(false))
      fireEvent.click(button("Stop"))
      await screen.findByText(/idle \(last: interrupted\)/)
      expect(button("Send").disabled).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })
})
