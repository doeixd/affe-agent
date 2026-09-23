// @vitest-environment happy-dom
/**
 * The task board, rendered over a memory store: a task is added to the
 * backlog, started into Running, and shown in Done when its attempt
 * settles, with a link to the conversation the attempt is.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Context, DateTime, Effect, Layer, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type * as Task from "../src/domain/Task.js"
import { AgentId, AgentRevisionId, ConversationId, UserId } from "../src/domain/WorkbenchIds.js"
import { TasksPage } from "../src/react/TasksPage.js"
import type { TaskActions } from "../src/react/TasksPage.js"
import * as TaskStore from "../src/store/TaskStore.js"

const owner = UserId.make("ada")
const builder = { id: AgentId.make("builder"), name: "Builder" }

/** Actions over the memory store; `start` records an attempt the way the runner would, on a fixed conversation id. */
const makeActions = async () => {
  const store = Context.get(await Effect.runPromise(Effect.scoped(Layer.build(TaskStore.memory))), TaskStore.TaskStore)
  const actions: TaskActions = {
    list: store.list(owner),
    attempts: (id) => store.attempts(id),
    create: (input) => store.create(input),
    start: (id) =>
      store.startAttempt({
        taskId: id,
        agentRevisionId: AgentRevisionId.make("builder@1"),
        conversationId: ConversationId.make(`c-${id}`),
        sessionId: `conversation-c-${id}`
      }),
    cancel: (id) => store.finishAttempt(`conversation-c-${id}`, "interrupted", "canceled")
  }
  return { store, actions }
}

function run<A>(effect: Effect.Effect<A, { readonly _tag: string }>): Promise<A> {
  return Effect.runPromise(effect)
}

const column = (name: string) => screen.getByRole("region", { name })

afterEach(() => cleanup())

describe("task board", () => {
  it("adds a task to the backlog, starts it, and shows where it went", async () => {
    const { actions, store } = await makeActions()
    render(<TasksPage actions={actions} owner={owner} agents={[builder]} run={run} pollMillis={0} />)
    await screen.findByRole("heading", { name: "Tasks" })
    expect(screen.getByRole("button", { name: "Add task" })).toHaveProperty("disabled", true)

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Ship it" } })
    fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "build and ship" } })
    fireEvent.click(screen.getByRole("button", { name: "Add task" }))
    await waitFor(() => expect(column("Backlog").textContent).toContain("Ship it"))
    const [task] = await Effect.runPromise(store.list(owner))
    if (task === undefined) throw new Error("nothing was created")
    expect(task.description).toBe("build and ship")
    expect(task.agentId).toBe(builder.id)

    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    await waitFor(() => expect(column("Running").textContent).toContain("Ship it"))
    expect(column("Backlog").textContent).not.toContain("Ship it")
    // The attempt is a conversation, linked.
    const link = screen.getByRole("link", { name: "attempt 1" })
    expect(link.getAttribute("href")).toBe(`#${encodeURIComponent(`c-${task.id}`)}`)

    // Settled by the session, elsewhere; the board reads it on its next refresh, which Stop triggers here.
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() => expect(column("Done").textContent).toContain("canceled"))
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy()
  })

  it("a refusal is shown and the board stays", async () => {
    const { actions } = await makeActions()
    const refusing: TaskActions = {
      ...actions,
      create: () => Effect.fail({ _tag: "WorkbenchStorageError" })
    }
    render(<TasksPage actions={refusing} owner={owner} agents={[builder]} run={run} pollMillis={0} />)
    await screen.findByRole("heading", { name: "Tasks" })
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Doomed" } })
    fireEvent.change(screen.getByLabelText("What to do"), { target: { value: "try" } })
    fireEvent.click(screen.getByRole("button", { name: "Add task" }))
    await screen.findByRole("alert")
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "Doomed")
  })
})

/** Unused type imports keep the file honest about what a task looks like on the page. */
export type _Shape = Task.Record & { readonly at: DateTime.Utc; readonly maybe: Option.Option<string> }
