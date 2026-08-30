import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient, AgentProtocol, AgentSessionHost } from "../src/client/index.js"
import * as DeliveryLog from "../src/durable/DeliveryLog.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * The cross-adapter conformance matrix (design-assessment rec 4).
 *
 * One shared host over one real in-process client; one list of rows; one
 * driver per adapter that either runs a row through *its own wire* or
 * declares, with a reason, that its protocol has no vocabulary for it. The
 * declaration is part of the table: the point is that HTTP, RPC, AG-UI, A2A
 * and MCP are comparable on the same questions, including where the answer
 * is "cannot be asked here".
 *
 * Rows are phrased in the host's vocabulary and translated by the driver:
 * a "refusal" is whatever the protocol does when the host says capacity,
 * forbidden or busy, classified back into the matrix's words.
 */

export const Host = AgentSessionHost.Tag<string>("test/HostConformance/host")
export type HostLayer = Layer.Layer<AgentSessionHost.Service<string>>

export const rows = [
  "creation",
  "continuation",
  "capacity",
  "authorization",
  "interruption",
  "idempotency",
  "resumption"
] as const
export type Row = (typeof rows)[number]

export type Refusal = "capacity" | "forbidden" | "unauthorized" | "busy" | "other"

export type Outcome =
  | { readonly kind: "completed"; readonly status: "completed" | "interrupted"; readonly text: string }
  | { readonly kind: "refused"; readonly reason: Refusal; readonly detail: string }

/** A transport's status and message, in the matrix's words. */
export const classify = (status: number | undefined, message: string): Refusal => {
  const text = message.toLowerCase()
  if (status === 429 || text.includes("capacity")) return "capacity"
  if (status === 403 || text.includes("may not")) return "forbidden"
  if (status === 401 || text.includes("authentication is required")) return "unauthorized"
  if (status === 409 || text.includes("already running")) return "busy"
  return "other"
}

export const refused = (status: number | undefined, message: string): Outcome => ({
  kind: "refused",
  reason: classify(status, message),
  detail: message
})

export interface PromptOptions {
  /** The `authorization` header value; the driver's default when absent. */
  readonly auth?: string | undefined
  /** The caller's idempotency key, where the wire has one. */
  readonly requestId?: string | undefined
}

/** What a driver can do through its wire. */
export interface Ops {
  readonly prompt: (session: string, text: string, options?: PromptOptions) => Effect.Effect<Outcome>
  readonly interrupt?: ((session: string) => Effect.Effect<void>) | undefined
  /**
   * Sequences of the events after a cursor, up to and including the run's
   * `SubmissionCompleted`, as the wire reports them.
   */
  readonly eventsAfter?: ((session: string, after: number) => Effect.Effect<ReadonlyArray<number>>) | undefined
  /** Rows the protocol cannot express, each with the reason. */
  readonly unsupported: Partial<Record<Row, string>>
}

export interface Driver {
  readonly name: string
  /** Serve the shared host through this adapter, inside the given scope. */
  readonly make: (host: HostLayer) => Effect.Effect<Ops, never, Scope.Scope>
}

export interface Fixture {
  readonly host: HostLayer
  readonly recorder: TestLanguageModel.Recorder
  /** Completed by the model when the blocking turn is entered. */
  readonly entered: Deferred.Deferred<void>
  /** Releases the blocking turn. */
  readonly release: Deferred.Deferred<void>
  /** The durable backing's delivery log (unused by the in-process client). */
  readonly delivery: DeliveryLog.DeliveryLog
  /** The client layer the host is built over. */
  readonly client: Layer.Layer<AgentClient.AgentClient>
}

/**
 * The shared world: a real `AgentClient` over a scripted model, behind the
 * real `AgentSessionHost` with a principal resolver that requires a bearer
 * and an authorization that refuses `Bearer forbidden`.
 */
export type Backing = "memory" | "durable"

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

export const fixture = Effect.fn("HostConformance.fixture")(function* (options: {
  readonly turns: ReadonlyArray<TestLanguageModel.Turn>
  readonly maxSessions?: number | undefined
  /** The in-process client by default; the durable client where a row needs a journal. */
  readonly backing?: Backing | undefined
}) {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const { layer: model, recorder } = yield* TestLanguageModel.script(options.turns)
  const agent = Agent.make({ loop: AgentLoop.bounded(1) })
  const stores = yield* Effect.all({
    store: DurableChannels.memoryStore,
    sessionStore: DurableSessionStore.memoryStore,
    delivery: DeliveryLog.memoryLog
  })
  const client: Layer.Layer<AgentClient.AgentClient> = options.backing === "durable"
    ? DurableAgentClient.layer("HostConformance", agent, stores).pipe(Layer.provideMerge(Engine), Layer.provideMerge(model))
    : AgentClient.layer(agent).pipe(Layer.provide(model))
  const host: HostLayer = AgentSessionHost.layer(Host, {
    authorization: {
      authorize: ({ operation, principal, sessionId }) =>
        principal === "Bearer forbidden"
          ? Effect.fail(new AgentProtocol.AgentForbiddenError({ operation, sessionId }))
          : Effect.void
    },
    principal: {
      resolve: ({ headers, operation }) =>
        headers.authorization === undefined
          ? Effect.fail(new AgentProtocol.AgentUnauthorizedError({ operation }))
          : Effect.succeed(headers.authorization)
    },
    maxSessions: options.maxSessions ?? 4,
    maxRequestsPerSession: 16
  }).pipe(Layer.provide(client))
  return { host, recorder, entered, release, delivery: stores.delivery, client } satisfies Fixture
})

/** A turn that blocks inside the model until the fixture releases it. */
export const blocking = (fixture: Pick<Fixture, "entered" | "release">, text: string): TestLanguageModel.Turn => ({
  text,
  started: fixture.entered,
  during: Deferred.await(fixture.release)
})

const cell = (driver: Driver, row: Row, body: (ops: Ops, fixture: Fixture) => Effect.Effect<void>, options?: {
  readonly turns?: ReadonlyArray<TestLanguageModel.Turn>
  readonly maxSessions?: number
  readonly blocking?: boolean
  readonly backing?: Backing
}) =>
  it.live(row, () =>
    Effect.gen(function* () {
      // The fixture's own deferreds are created first so a blocking turn can
      // refer to them; the model script is then built around them.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const turns = options?.turns ?? (options?.blocking
        ? [blocking({ entered, release }, "held")]
        : [TestLanguageModel.text("one"), TestLanguageModel.text("two")])
      const world = yield* fixture({
        turns,
        ...(options?.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
        ...(options?.backing === undefined ? {} : { backing: options.backing })
      })
      const full: Fixture = { ...world, entered, release }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const ops = yield* driver.make(world.host)
          const reason = ops.unsupported[row]
          if (reason !== undefined) {
            // Declared, not skipped: the row is in the table with its reason.
            process.stdout.write(`  [matrix] ${driver.name} / ${row}: not expressible -- ${reason}\n`)
            return
          }
          yield* body(ops, full)
        })
      )
    }).pipe(Effect.provide(Layer.empty)),
    30_000
  )

/**
 * Run the matrix for one driver. Every row is a test; a row the driver
 * declares unsupported passes by declaration and says so.
 */
export const run = (driver: Driver): void => {
  describe(`host conformance (${driver.name})`, () => {
    cell(driver, "creation", (ops) =>
      Effect.gen(function* () {
        const outcome = yield* ops.prompt("s-create", "hello")
        assert.strictEqual(outcome.kind, "completed")
        if (outcome.kind === "completed") assert.strictEqual(outcome.text, "one")
      })
    )

    cell(driver, "continuation", (ops, world) =>
      Effect.gen(function* () {
        yield* ops.prompt("s-continue", "first")
        const second = yield* ops.prompt("s-continue", "second")
        assert.strictEqual(second.kind, "completed")
        // The proof is what the model saw, not what the wire returned: the
        // second call carried the first exchange.
        const prompts = yield* world.recorder.prompts
        assert.strictEqual(prompts.length, 2)
        assert.deepStrictEqual(TestLanguageModel.userTexts(prompts[1]!), ["first", "second"])
      })
    )

    cell(driver, "capacity", (ops) =>
      Effect.gen(function* () {
        const first = yield* ops.prompt("s-cap-1", "one")
        assert.strictEqual(first.kind, "completed")
        const second = yield* ops.prompt("s-cap-2", "two")
        assert.deepStrictEqual(
          second.kind === "refused" ? second.reason : second,
          "capacity",
          JSON.stringify(second)
        )
      }), { maxSessions: 1 })

    cell(driver, "authorization", (ops) =>
      Effect.gen(function* () {
        const forbidden = yield* ops.prompt("s-auth", "hello", { auth: "Bearer forbidden" })
        assert.deepStrictEqual(forbidden.kind === "refused" ? forbidden.reason : forbidden, "forbidden", JSON.stringify(forbidden))
        // And nothing ran for it.
        const allowed = yield* ops.prompt("s-auth-ok", "hello")
        assert.strictEqual(allowed.kind, "completed")
      })
    )

    cell(driver, "interruption", (ops, world) =>
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(ops.prompt("s-int", "block"))
        yield* Deferred.await(world.entered)
        yield* ops.interrupt!("s-int")
        const outcome = yield* Fiber.join(running)
        assert.strictEqual(outcome.kind, "completed")
        if (outcome.kind === "completed") assert.strictEqual(outcome.status, "interrupted")
        yield* Deferred.succeed(world.release, void 0)
      }), { blocking: true })

    cell(driver, "idempotency", (ops, world) =>
      Effect.gen(function* () {
        const [a, b] = yield* Effect.all(
          [
            ops.prompt("s-idem", "once", { requestId: "same-key" }),
            ops.prompt("s-idem", "once", { requestId: "same-key" })
          ],
          { concurrency: "unbounded" }
        )
        assert.strictEqual(a.kind, "completed")
        assert.deepStrictEqual(b, a)
        // One run: the script has one turn, so a second run would have
        // exhausted it, and the recorder counts one call.
        assert.strictEqual(yield* world.recorder.calls, 1)
      }), { turns: [TestLanguageModel.text("once")] })

    cell(driver, "resumption", (ops) =>
      Effect.gen(function* () {
        const done = yield* ops.prompt("s-resume", "hello")
        assert.strictEqual(done.kind, "completed")
        const all = yield* ops.eventsAfter!("s-resume", 0)
        assert.isAbove(all.length, 2)
        const cursor = all[1]!
        const rest = yield* ops.eventsAfter!("s-resume", cursor)
        // Exactly the events after the cursor, in order, nothing repeated.
        assert.deepStrictEqual(rest, all.filter((sequence) => sequence > cursor))
        assert.strictEqual(rest[0], cursor + 1)
      // A cursor is a property of the backing: the in-process client has no
      // journal and refuses `after` outright, so this row runs on the durable
      // client, where the delivery log answers it.
      }), { backing: "durable" })
  })
}
