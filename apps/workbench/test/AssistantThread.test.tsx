// @vitest-environment happy-dom
/**
 * The assistant-ui adapter (W0's separate adapter proof): the same session
 * and presenter the plain page drives, through assistant-ui's external-store
 * runtime. A person sends through assistant-ui's composer, the reply streams
 * in, the agent's question reads as the plain page reads it, and Stop
 * interrupts.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { afterEach, describe, expect, it } from "vitest"
import { Agent, Permission } from "affe-agent"
import { TestLanguageModel } from "affe-agent/testing"
import { AssistantThread, textOf, toThreadMessage } from "../src/assistant-ui/AssistantThread.js"
import { UserId } from "../src/domain/WorkbenchIds.js"
import * as AgentDirectory from "../src/runtime/AgentDirectory.js"
import * as AgentResolver from "../src/runtime/AgentResolver.js"
import * as ConversationSessions from "../src/runtime/ConversationSessions.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as ConversationStore from "../src/store/ConversationStore.js"

const owner = UserId.make("ada")
const Dangerous = Tool.make("deleteEverything", { parameters: Schema.Struct({}), success: Schema.String }).setNeedsApproval(true)

const openThread = async (turns: ReadonlyArray<TestLanguageModel.Turn>, starters?: ReadonlyArray<string>) => {
  const { layer: model } = await Effect.runPromise(TestLanguageModel.script(turns))
  const bindings = Layer.succeed(AgentResolver.AgentBindings, {
    models: { scripted: model },
    capabilities: { workshop: [Agent.tool(Dangerous, () => Effect.succeed("deleted"))] },
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
    const { spec } = yield* (yield* AgentRegistry.AgentRegistry).create({
      ownerId: owner,
      name: "Builder",
      revision: {
        instructions: "Build.",
        modelPolicy: { profile: "scripted" },
        capabilities: [{ id: "workshop" }],
        skills: [],
        permission: { recorded: JSON.stringify(Permission.describe(Permission.allowAll)) },
        maxTurns: 4
      }
    })
    const { conversation } = yield* (yield* ConversationSessions.ConversationSessions)
      .create({ ownerId: owner, agentId: spec.id, title: "Through assistant-ui" })
    return conversation.id
  }))
  render(<AssistantThread runtime={runtime} conversationId={conversationId} starters={starters} />)
  await screen.findByRole("heading", { name: "Through assistant-ui" })
  return runtime
}

const send = async (text: string) => {
  const box = screen.getByLabelText("Message")
  fireEvent.change(box, { target: { value: text } })
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false))
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
}

afterEach(() => cleanup())

describe("assistant-ui message conversion", () => {
  it("carries text, reasoning and a status assistant-ui knows", () => {
    const view = (state: "streaming" | "complete" | "interrupted" | "failed") =>
      toThreadMessage({ role: "assistant", text: "t", reasoning: "r", files: [], state }, 3)
    expect(view("complete")).toEqual({
      id: "m-3",
      role: "assistant",
      content: [{ type: "reasoning", text: "r" }, { type: "text", text: "t" }],
      status: { type: "complete", reason: "stop" }
    })
    expect(view("streaming").status).toEqual({ type: "running" })
    expect(view("interrupted").status).toEqual({ type: "incomplete", reason: "cancelled" })
    expect(view("failed").status).toEqual({ type: "incomplete", reason: "error" })
    const user = toThreadMessage({ role: "user", text: "hi", reasoning: "", files: [], state: "complete" }, 0)
    expect(user).toEqual({ id: "m-0", role: "user", content: [{ type: "text", text: "hi" }] })
    expect(textOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab")
  })
})

describe("assistant-ui thread", () => {
  it("sends through assistant-ui's composer, shows the reply, and answers the question as the plain page does", async () => {
    const runtime = await openThread([
      TestLanguageModel.text("First reply."),
      { toolCalls: [{ id: "d1", name: "deleteEverything", params: {} }] },
      TestLanguageModel.text("Deleted.")
    ])
    try {
      await send("hello")
      await screen.findByText("First reply.")
      expect(screen.getByText("hello")).toBeTruthy()
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("idle"))

      await send("clean up")
      const question = await screen.findByRole("region", { name: "Question" })
      // The shared question module's words, not assistant-ui's or the kernel's kind.
      expect(question.textContent).toMatch(/deleteEverything wants to/)
      fireEvent.click(screen.getByRole("button", { name: "Approve" }))
      await screen.findByText("Deleted.")
      expect(screen.queryByRole("region", { name: "Question" })).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })

  it("offers the same starters as assistant-ui suggestions, and one sends it", async () => {
    const runtime = await openThread([TestLanguageModel.text("Planned.")], ["Plan my week", "Summarize a PDF"])
    try {
      await screen.findByRole("button", { name: "Suggested: Plan my week" })
      expect(screen.getByRole("button", { name: "Suggested: Summarize a PDF" })).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Suggested: Plan my week" }))
      await screen.findByText("Planned.")
      await waitFor(() => expect(screen.queryByRole("button", { name: "Suggested: Plan my week" })).toBeNull())
    } finally {
      await runtime.dispose()
    }
  })

  it("honours the same slash commands through assistant-ui's composer", async () => {
    const runtime = await openThread([TestLanguageModel.text("First."), TestLanguageModel.text("Again.")])
    try {
      await send("/stop")
      expect((await screen.findByRole("note", { name: "Command" })).textContent).toMatch(/Nothing is running/)
      await send("hello")
      await screen.findByText("First.")
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("idle"))
      await send("/retry")
      await screen.findByText("Again.")
      await send("/model other")
      expect((await screen.findByRole("note", { name: "Command" })).textContent).toMatch(/not available on this page/)
      // The commands were never sent to the model as messages.
      expect(screen.queryByText("/stop")).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })

  it("Stop interrupts the running reply", async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const runtime = await openThread([{ text: "never", hang: true, started }])
    try {
      await send("wait")
      await Effect.runPromise(Deferred.await(started))
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("running"))
      // assistant-ui takes the running state on its next render: Stop enables then, as a person would see it.
      await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty("disabled", false))
      fireEvent.click(screen.getByRole("button", { name: "Stop" }))
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("idle"))
    } finally {
      await runtime.dispose()
    }
  })
})
