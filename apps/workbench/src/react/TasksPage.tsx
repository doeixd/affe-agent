/**
 * The task board (plan-agent-product-control-plane.md §8, "Task board"):
 * the caller's tasks by column -- BACKLOG | READY | RUNNING | NEEDS YOU |
 * DONE -- a form to add one, and the two things a person does to a task,
 * start it and stop it. Every attempt is a conversation, so a task links
 * to the conversation its latest attempt is.
 *
 * Plain like the other pages: what it shows is what the server answered
 * last, refreshed after every action and on a short poll, since status is
 * settled by the session and arrives from the projection.
 */
import { Effect, Option } from "effect"
import { useEffect, useState } from "react"
import * as Task from "../domain/Task.js"
import type { AgentId, TaskId, UserId } from "../domain/WorkbenchIds.js"

/** What the page needs from the server, so a test can supply it from memory. */
export interface TaskActions {
  readonly list: Effect.Effect<ReadonlyArray<Task.Record>, { readonly _tag: string }>
  readonly attempts: (id: TaskId) => Effect.Effect<ReadonlyArray<Task.Attempt>, { readonly _tag: string }>
  readonly create: (input: Task.New) => Effect.Effect<Task.Record, { readonly _tag: string }>
  readonly start: (id: TaskId) => Effect.Effect<unknown, { readonly _tag: string }>
  /** Hand it to a worker instead of starting it now. */
  readonly queue: (id: TaskId) => Effect.Effect<unknown, { readonly _tag: string }>
  readonly cancel: (id: TaskId) => Effect.Effect<unknown, { readonly _tag: string }>
}

export interface TasksPageProps {
  readonly actions: TaskActions
  readonly owner: UserId
  /** The agents the person may run a task on, by id and name. */
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>
  readonly run: <A>(effect: Effect.Effect<A, { readonly _tag: string }>) => Promise<A>
  /** How often to re-read the board; `0` never. */
  readonly pollMillis?: number | undefined
}

const columns: ReadonlyArray<readonly [string, ReadonlyArray<Task.Status>]> = [
  ["Backlog", ["backlog"]],
  ["Ready", ["ready"]],
  ["Running", ["running"]],
  ["Needs you", ["waiting"]],
  ["Done", ["completed", "failed", "canceled"]]
]

export const TasksPage = ({ actions, agents, owner, pollMillis = 2_000, run }: TasksPageProps) => {
  const [tasks, setTasks] = useState<ReadonlyArray<Task.Record>>([])
  const [latest, setLatest] = useState<ReadonlyMap<TaskId, Task.Attempt>>(new Map())
  const [failure, setFailure] = useState(Option.none<string>())
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")

  const refresh = () => {
    void run(actions.list).then(
      async (found) => {
        setTasks(found)
        const attempts = await Promise.all(
          found.filter((task) => Task.isLive(task.status) || task.status !== "backlog").map(async (task) => {
            const all = await run(actions.attempts(task.id)).catch(() => [] as ReadonlyArray<Task.Attempt>)
            return [task.id, all[all.length - 1]] as const
          })
        )
        setLatest(new Map(attempts.flatMap(([id, attempt]) => (attempt === undefined ? [] : [[id, attempt] as const]))))
      },
      (error: unknown) => setFailure(Option.some(String(error)))
    )
  }

  useEffect(() => {
    refresh()
    if (pollMillis <= 0) return
    const timer = window.setInterval(refresh, pollMillis)
    return () => window.clearInterval(timer)
  }, [])

  const act = (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
    setFailure(Option.none())
    void run(effect).then(refresh, (error: unknown) => setFailure(Option.some(String(error))))
  }

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (agent === undefined) return
    const input: Task.New = { ownerId: owner, agentId: agent.id, title, description }
    setFailure(Option.none())
    void run(actions.create(input)).then(
      () => {
        setTitle("")
        setDescription("")
        refresh()
      },
      (error: unknown) => setFailure(Option.some(String(error)))
    )
  }

  return (
    <div>
      <h2>Tasks</h2>
      <form aria-label="New task" onSubmit={submit} style={{ display: "grid", gap: "0.5rem", maxWidth: "36rem" }}>
        <label>
          Title <input name="title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          What to do{" "}
          <textarea name="description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          Agent{" "}
          <select name="agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <button type="submit" disabled={title.trim() === "" || description.trim() === "" || agentId === ""}>Add task</button>
      </form>
      {Option.isSome(failure) ? <p role="alert">That did not work; the board may be behind. {failure.value}</p> : null}
      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        {columns.map(([name, statuses]) => (
          <section key={name} aria-label={name} style={{ minWidth: "12rem" }}>
            <h3>{name}</h3>
            <ul>
              {tasks.filter((task) => statuses.includes(task.status)).map((task) => {
                const attempt = latest.get(task.id)
                return (
                  <li key={task.id} data-status={task.status}>
                    <strong>{task.title}</strong> <em>{task.status}</em>
                    {attempt === undefined ? null : (
                      <>
                        {" "}
                        <a href={`#${encodeURIComponent(attempt.conversationId)}`}>attempt {attempt.attempt}</a>
                      </>
                    )}
                    {" "}
                    {Task.isLive(task.status) || task.status === "ready"
                      ? <button type="button" onClick={() => act(actions.cancel(task.id))}>Stop</button>
                      : (
                        <>
                          <button type="button" onClick={() => act(actions.start(task.id))}>
                            {task.status === "backlog" ? "Start" : "Run again"}
                          </button>{" "}
                          <button type="button" onClick={() => act(actions.queue(task.id))}>Queue</button>
                        </>
                      )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
