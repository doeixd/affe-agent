/**
 * Unattended resumption: a task whose run was in flight when the server
 * stopped finishes after a restart without anyone opening its conversation.
 * Before this, a durable run resumed only when a person reopened it, so a
 * task -- which nobody watches -- stayed "running" for ever.
 */
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Context, Duration, Effect, Layer, Option, Schedule } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { HttpClient } from "effect/unstable/http"
import { UserId } from "../src/domain/WorkbenchIds.js"
import type { TaskId } from "../src/domain/WorkbenchIds.js"
import { tokens } from "../src/server/Authentication.js"
import { serve } from "../src/server/app.js"
import * as AgentRegistry from "../src/store/AgentRegistry.js"
import * as HttpStores from "../src/store/http.js"

const ada = UserId.make("ada")
const firstPort = 8778
const secondPort = 8777

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "workbench-resume-")), "resume.db")),
  (file) => Effect.sync(() => NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true }))
)

const http = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.provide(effect, FetchHttpClient.layer)

describe("unattended resumption", () => {
  it.live("a task in flight at a restart completes afterwards, with nobody opening it", () =>
    Effect.scoped(Effect.gen(function*() {
      const database = yield* tempDatabase
      const server = (port: number) =>
        serve({
          port,
          database,
          durability: { shardLockExpiration: Duration.seconds(1), shardLockRefreshInterval: Duration.millis(200) }
        }).pipe(Layer.provide(tokens({ "ada-token": "ada" })))
      const at = (port: number) => ({ baseUrl: `http://localhost:${port}`, token: "ada-token" })

      // First server: start a task, and stop the server while its build tool is still running.
      const taskId: TaskId = yield* Effect.scoped(Effect.gen(function*() {
        yield* Layer.build(server(firstPort))
        const registry = Context.get(
          yield* Layer.build(HttpStores.agentRegistry(at(firstPort)).pipe(Layer.provideMerge(FetchHttpClient.layer))),
          AgentRegistry.AgentRegistry
        )
        const [agent] = yield* registry.list(ada)
        if (agent === undefined) return yield* Effect.die("no agent")
        const task = yield* http(HttpStores.createTask(at(firstPort), { ownerId: ada, agentId: agent.id, title: "Survive", description: "build it" }))
        const attempt = yield* http(HttpStores.startTask(at(firstPort), task.id))
        // The build tool has started and is sleeping: the run is mid-flight.
        yield* http(HttpStores.sessionSummary(at(firstPort), attempt.conversationId)).pipe(
          Effect.repeat({
            until: (found) => Option.exists(found, (summary) => summary.stats.tools.started >= 1),
            schedule: Schedule.spaced("20 millis")
          }),
          Effect.timeout("10 seconds")
        )
        const before = yield* http(HttpStores.task(at(firstPort), task.id))
        assert.deepStrictEqual(Option.map(before, ({ task }) => task.status), Option.some("running"))
        return task.id
      }))

      // Second server, same database. Nobody opens the conversation; the task finishes.
      yield* Layer.build(server(secondPort))
      const status = yield* http(HttpStores.task(at(secondPort), taskId)).pipe(
        Effect.map((found) => Option.map(found, ({ task }) => task.status).pipe(Option.getOrUndefined)),
        Effect.repeat({ until: (s) => s === "completed" || s === "failed", schedule: Schedule.spaced("200 millis") }),
        Effect.timeout("45 seconds")
      )
      assert.strictEqual(status, "completed")
    })), 120_000)
})
