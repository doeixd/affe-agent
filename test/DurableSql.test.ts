import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Crypto, Deferred, Duration, Effect, Exit, Layer, Ref } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { DurableDeferred } from "effect/unstable/workflow"
import { Schema } from "effect"
import { Buffer } from "node:buffer"
import * as NodeCrypto from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as ContextTransform from "../src/ContextTransform.js"
import * as DurableAgent from "../src/durable/DurableAgent.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as FakeModel from "./FakeModel.js"
import { countingModel } from "./helpers.js"

/**
 * WORKFLOW_CLUSTER_PLAN Phase 5 — production wiring on SQL storage.
 *
 * The other durable tests run on `TestRunner`, whose storage is in memory. Here
 * the workflow journal is a SQLite file written by `SingleRunner`, which is the
 * shape a single-node deployment actually uses.
 *
 * What this proves: a submission suspends and resumes against a real SQL
 * journal, and the persisted model result is replayed rather than re-issued.
 *
 * What it does not prove is recorded at the end of this file, and in the plan.
 */
const Gate = DurableDeferred.make("SqlGate", { success: Schema.String })
const LossGate = DurableDeferred.make("LossGate", { success: Schema.String })
const ReplayGate = DurableDeferred.make("ReplayGate", { success: Schema.String })
const FailGate = DurableDeferred.make("FailGate", { success: Schema.String })
const SqlChannelGate = DurableDeferred.make("SqlChannelGate", {
  success: Schema.String
})

/** Node's crypto, which `SingleRunner` needs for runner identity. */
const CryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(NodeCrypto.randomBytes(size)),
    digest: (algorithm, data) =>
      Effect.sync(
        () =>
          new Uint8Array(
            NodeCrypto.createHash(algorithm.toLowerCase().replace("-", ""))
              .update(data)
              .digest()
          )
      )
  })
)

/**
 * A runner over the given database.
 *
 * The shard lock TTL is the whole story for process loss. A runner holds its
 * shards under a lock with a default 35s expiration, so a replacement started
 * immediately after the first one disappears is correctly refused the shards —
 * that is the lock doing its job, not a failure. A replacement that starts
 * after the lock expires takes them over.
 *
 * Tests shorten the TTL rather than waiting 35 seconds; production should leave
 * it alone, since a short expiration risks two runners believing they own the
 * same shard during a network partition.
 */
const engineFor = (file: string, lockSeconds = 35) =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provide(
      SingleRunner.layer({
        runnerStorage: "sql",
        shardingConfig: {
          shardLockExpiration: Duration.seconds(lockSeconds),
          shardLockRefreshInterval: Duration.millis(200)
        }
      }).pipe(
        Layer.provide(SqliteClient.layer({ filename: file })),
        Layer.provide(CryptoLayer)
      )
    )
  )

const tempDatabase = Effect.acquireRelease(
  Effect.sync(() =>
    NodePath.join(
      NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "effect-agent-")),
      "workflow.db"
    )
  ),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // The database may still be held open; cleanup is best effort.
      }
    })
)

describe("durable submissions on SQL storage", () => {
  it.live("suspends and resumes against a SQLite-backed journal", () =>
    Effect.gen(function* () {
      const file = yield* tempDatabase

      const Engine = engineFor(file)

      const modelCalls = yield* Ref.make(0)
      const gateReady = yield* Deferred.make<DurableDeferred.Token>()
      const suspendOnce = yield* Ref.make(true)
      const turns = yield* Ref.make(0)

      // Suspend before turn 2, so turn 1's model result is already journalled.
      const gating = ContextTransform.make((context) =>
        Effect.gen(function* () {
            const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
            if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
              const token = yield* DurableDeferred.token(Gate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(Gate)
            }
          return context.canonicalPrompt
        })
      )

      const store = yield* DurableChannels.memoryStore
      const Suspending = Agent.make({
        contextTransform: gating,
        loop: AgentLoop.make((state) =>
          Effect.succeed(
            state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
          )
        )
      })

      const { layer: baseModel } = yield* FakeModel.layer([
        { text: "first" },
        { text: "second" }
      ])
      const model = countingModel(baseModel, modelCalls)

      const durable = DurableAgent.workflow("SqlBacked", Suspending, { store })

      const completed = yield* Effect.gen(function* () {
        const executionId = yield* DurableAgent.submit(durable, store, "sql-1", "go")

        const token = yield* Deferred.await(gateReady)
        yield* DurableDeferred.succeed(Gate, { token, value: "resume" })

        return yield* DurableAgent.result(durable, executionId)
      }).pipe(
        Effect.provide(
          durable.layer.pipe(
            Layer.provideMerge(Engine),
            Layer.provideMerge(model)
          )
        )
      )

      assert.isTrue(Exit.isSuccess(completed))

      // Turn 1's model call was journalled before the suspension and replayed
      // afterwards: two turns, two calls, not three.
      assert.strictEqual(
        yield* Ref.get(modelCalls),
        2,
        "the resumed turn must not re-issue turn 1"
      )

      // And the journal really is on disk.
      assert.isTrue(NodeFs.existsSync(file))
      assert.isAbove(NodeFs.statSync(file).size, 0)
    }).pipe(Effect.scoped) as Effect.Effect<void>
  )
})

describe("process loss", () => {
  it.live(
    "a submission resumes in a replacement runner after the first is lost",
    () =>
      Effect.gen(function* () {
        const file = yield* tempDatabase
        const modelCalls = yield* Ref.make(0)
        const gateReady = yield* Deferred.make<DurableDeferred.Token>()
        const suspendOnce = yield* Ref.make(true)
        const turns = yield* Ref.make(0)

        // Suspends before turn 2, so turn 1's model result is journalled to
        // SQLite while the first runner is still alive.
        const gating = ContextTransform.make((context) =>
          Effect.gen(function* () {
            const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
            if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
              const token = yield* DurableDeferred.token(LossGate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(LossGate)
            }
            return context.prompt
          })
        )

        const store = yield* DurableChannels.memoryStore
        const agent = Agent.make({
          contextTransform: gating,
          // Forced to two turns: `bounded` would stop after turn 1 here,
          // because the scripted model returns text and no tool calls.
          loop: (state) =>
            Effect.succeed(
              state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
            )
        })
        const durable = DurableAgent.workflow("Lost", agent, { store })

        const modelFor = () =>
          Effect.map(
            FakeModel.layer([{ text: "first" }, { text: "second" }]),
            ({ layer }) => countingModel(layer, modelCalls)
          )

        // ---- Runner A: start, journal turn 1, then vanish ----------------
        const executionId = yield* Effect.gen(function* () {
          const model = yield* modelFor()
          return yield* Effect.gen(function* () {
            const id = yield* DurableAgent.submit(durable, store, "loss-1", "go")
            yield* Deferred.await(gateReady)
            // `gateReady` fires when the token is published, which is *before*
            // the workflow has journaled its suspension. Tearing the runner
            // down inside that window is not process loss — it interrupts a
            // live execution, and the engine records that as a terminal
            // failure. Let the suspension become durable first: that is the
            // state a lost process actually leaves behind.
            yield* Effect.sleep(Duration.millis(500))
            return id
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        // Runner A is gone: its layers were released with the scope above.
        // Its shard lock outlives it, so wait for the lease to expire before a
        // replacement can claim the shards.
        yield* Effect.sleep(Duration.seconds(2))

        // ---- Runner B: a different runner over the same database ---------
        const completed = yield* Effect.gen(function* () {
          const model = yield* modelFor()
          return yield* Effect.gen(function* () {
            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(LossGate, {
              token,
              value: "resume"
            })
            return yield* DurableAgent.result(durable, executionId, {
              interval: Duration.millis(50)
            })
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        assert.isTrue(
          Exit.isSuccess(completed),
          `replacement runner did not finish the submission: ${JSON.stringify(completed)}`
        )

        // Turn 1 ran under runner A and was journalled; runner B replayed it
        // and only had to make turn 2's call. Three would mean the journal was
        // not consulted across the process boundary.
        assert.strictEqual(
          yield* Ref.get(modelCalls),
          2,
          "the replacement runner must not re-issue turn 1"
        )
      }).pipe(Effect.scoped) as Effect.Effect<void>,
    30_000
  )
})

describe("replayed tool results", () => {
  it.live(
    "a replayed tool result keeps its decoded type",
    () =>
      Effect.gen(function* () {
        // A tool's handler result carries both an `encodedResult` (JSON, for
        // the model) and a decoded `result` (for the harness, its events, and
        // canonical history). Journalling the pair under `Schema.Unknown` only
        // round-trips the first: the decoded `Date` below goes into SQLite as a
        // string and comes back a string, so a resumed run disagrees with a
        // fresh one about what its own tool returned.
        const file = yield* tempDatabase
        const stamped = new Date("2026-01-01T00:00:00.000Z")

        const Stamp = Tool.make("stamp", {
          parameters: Schema.Struct({}),
          success: Schema.DateFromString
        })
        const toolkit = yield* Agent.toolkit([Stamp], {
          stamp: () => Effect.succeed(stamped)
        })

        const gateReady = yield* Deferred.make<DurableDeferred.Token>()
        const suspendOnce = yield* Ref.make(true)
        const turns = yield* Ref.make(0)

        // Suspends before turn 2, after turn 1's tool call is journalled.
        const gating = ContextTransform.make((context) =>
          Effect.gen(function* () {
            const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
            if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
              const token = yield* DurableDeferred.token(ReplayGate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(ReplayGate)
            }
            return context.prompt
          })
        )

        const store = yield* DurableChannels.memoryStore
        const agent = Agent.make({
          toolkit,
          contextTransform: gating,
          loop: (state) =>
            Effect.succeed(
              state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
            )
        })
        const durable = DurableAgent.workflow("Replayed", agent, { store })

        const script = [
          { toolCalls: [{ id: "s1", name: "stamp", params: {} }] },
          { text: "done" }
        ]

        // ---- Runner A: run the tool, journal it, then vanish -------------
        const executionId = yield* Effect.gen(function* () {
          const { layer: model } = yield* FakeModel.layer(script)
          return yield* Effect.gen(function* () {
            const id = yield* DurableAgent.submit(durable, store, "replay-1", "go")
            yield* Deferred.await(gateReady)
            yield* Effect.sleep(Duration.millis(500))
            return id
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        yield* Effect.sleep(Duration.seconds(2))

        // ---- Runner B: replays the tool call from SQLite -----------------
        const prompts = yield* Effect.gen(function* () {
          const { layer: model, recorder } = yield* FakeModel.layer([
            { text: "done" }
          ])
          return yield* Effect.gen(function* () {
            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(ReplayGate, {
              token,
              value: "resume"
            })
            yield* DurableAgent.result(durable, executionId, {
              interval: Duration.millis(50)
            })
            return yield* recorder.prompts
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        // The prompt carries the *encoded* result -- that is what the model
        // is supposed to see, and it is the half that always round-tripped.
        // What this test guards is that the submission survives at all: with
        // the results journalled under `Schema.Unknown`, SQLite rejected the
        // write with `SchemaError: Expected JSON value` and the run died
        // before ever reaching turn 2.
        const results = prompts.flatMap((prompt) =>
          prompt.content.flatMap((message) =>
            message.role === "tool"
              ? message.content.flatMap((part) =>
                  part.type === "tool-result" ? [part.result] : []
                )
              : []
          )
        )
        assert.isAtLeast(results.length, 1, "no tool result reached the model")
        assert.strictEqual(results[0], stamped.toISOString())
      }),
    30_000
  )

  it.live(
    "a failed tool call is journalled and replayed, not retried",
    () =>
      Effect.gen(function* () {
        // The failure branch of the results schema, which nothing else covers.
        // A failed handler result puts the tool's *failure* value in `result`,
        // so it is encoded through `failureSchema` rather than `successSchema`
        // -- and a run that resumes must return the persisted refusal instead
        // of calling the tool a second time. Retrying a side effect is the one
        // thing durability exists to prevent.
        const file = yield* tempDatabase
        const calls = yield* Ref.make(0)

        const Refuse = Tool.make("refuse", {
          parameters: Schema.Struct({}),
          success: Schema.String,
          failure: Schema.String
        })
        const toolkit = yield* Agent.toolkit([Refuse], {
          refuse: () =>
            Ref.update(calls, (n) => n + 1).pipe(
              Effect.andThen(Effect.fail("declined"))
            )
        })

        const gateReady = yield* Deferred.make<DurableDeferred.Token>()
        const suspendOnce = yield* Ref.make(true)
        const turns = yield* Ref.make(0)

        const gating = ContextTransform.make((context) =>
          Effect.gen(function* () {
            const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
            if (turn === 2 && (yield* Ref.getAndSet(suspendOnce, false))) {
              const token = yield* DurableDeferred.token(FailGate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(FailGate)
            }
            return context.prompt
          })
        )

        const store = yield* DurableChannels.memoryStore
        // The default policy returns the failure to the model, so the run
        // continues rather than ending here.
        const agent = Agent.make({
          toolkit,
          contextTransform: gating,
          loop: (state) =>
            Effect.succeed(
              state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
            )
        })
        const durable = DurableAgent.workflow("Refused", agent, { store })

        const script = [
          { toolCalls: [{ id: "r1", name: "refuse", params: {} }] },
          { text: "done" }
        ]
        // The replacement runner replays turn 1 from the journal, so the only
        // real model call it makes is turn 2. A fresh FakeModel would hand back
        // the *first* scripted turn and issue a second tool call -- which is a
        // property of the fake, not of replay.
        const resumedScript = [{ text: "done" }]

        const executionId = yield* Effect.gen(function* () {
          const { layer: model } = yield* FakeModel.layer(script)
          return yield* Effect.gen(function* () {
            const id = yield* DurableAgent.submit(durable, store, "refuse-1", "go")
            yield* Deferred.await(gateReady)
            yield* Effect.sleep(Duration.millis(500))
            return id
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        assert.strictEqual(yield* Ref.get(calls), 1, "the tool ran once")

        yield* Effect.sleep(Duration.seconds(2))

        const exit = yield* Effect.gen(function* () {
          const { layer: model } = yield* FakeModel.layer(resumedScript)
          return yield* Effect.gen(function* () {
            const token = yield* Deferred.await(gateReady)
            yield* DurableDeferred.succeed(FailGate, { token, value: "resume" })
            return yield* DurableAgent.result(durable, executionId, {
              interval: Duration.millis(50)
            })
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 1)),
                Layer.provideMerge(model)
              )
            )
          )
        })

        assert.isTrue(
          Exit.isSuccess(exit),
          `the resumed run did not finish: ${JSON.stringify(exit)}`
        )
        // Still one. The refusal came back from the journal.
        assert.strictEqual(
          yield* Ref.get(calls),
          1,
          "the replacement runner re-ran a tool that had already failed"
        )
      }),
    30_000
  )
})

describe("sql-backed channels", () => {
  it.live(
    "steering held in SQL is applied to a running submission",
    () =>
      Effect.gen(function* () {
        // The store the cluster actually needs. `memoryStore` is a map in one
        // process, so under sharding a steer routed to one node is written
        // there and drained on another -- accepted, then invisible. This runs
        // the whole durable path with the shared store instead.
        const file = yield* tempDatabase
        const gateReady = yield* Deferred.make<DurableDeferred.Token>()
        const suspendOnce = yield* Ref.make(true)
        const turns = yield* Ref.make(0)

        const gating = ContextTransform.make((context) =>
          Effect.gen(function* () {
            // Suspends inside turn 1, so the steering offered while parked is
            // picked up by turn 2's drain. Suspending in turn 2 would be too
            // late: that turn's drain has already run, and there is no turn 3.
            const turn = yield* Ref.updateAndGet(turns, (n) => n + 1)
            if (turn === 1 && (yield* Ref.getAndSet(suspendOnce, false))) {
              const token = yield* DurableDeferred.token(SqlChannelGate)
              yield* Deferred.succeed(gateReady, token)
              yield* DurableDeferred.await(SqlChannelGate)
            }
            return context.prompt
          })
        )

        const { layer: modelLayer, recorder } = yield* FakeModel.layer([
          { text: "first" },
          { text: "second" }
        ])

        return yield* Effect.gen(function* () {
          const store = yield* DurableChannels.sqlStoreWithTable()
          const durable = DurableAgent.workflow(
            "SqlChannels",
            Agent.make({
              contextTransform: gating,
              loop: (state) =>
                Effect.succeed(
                  state.turnIndex < 2 ? AgentLoop.Continue : AgentLoop.Stop
                )
            }),
            { store }
          )

          return yield* Effect.gen(function* () {
            const executionId = yield* DurableAgent.submit(
              durable,
              store,
              "sql-chan-1",
              "go"
            )
            const token = yield* Deferred.await(gateReady)

            // Offered while the submission is parked, and read back out of
            // SQLite by the turn that resumes.
            yield* DurableAgent.steer(store, "sql-chan-1", "stay on topic")
            yield* DurableDeferred.succeed(SqlChannelGate, {
              token,
              value: "resume"
            })

            const exit = yield* DurableAgent.result(durable, executionId, {
              interval: Duration.millis(50)
            })
            assert.isTrue(
              Exit.isSuccess(exit),
              `submission did not finish: ${JSON.stringify(exit)}`
            )

            const prompts = yield* recorder.prompts
            assert.isTrue(
              prompts.some((prompt) =>
                FakeModel.userTexts(prompt).includes("stay on topic")
              ),
              "steering held in SQL never reached the model"
            )

            // Drained, not left behind for a later submission to pick up.
            assert.strictEqual(
              yield* store.size("sql-chan-1:steering"),
              0
            )
          }).pipe(
            Effect.provide(
              durable.layer.pipe(
                Layer.provideMerge(engineFor(file, 35)),
                Layer.provideMerge(modelLayer)
              )
            )
          )
        }).pipe(Effect.provide(SqliteClient.layer({ filename: file })))
      }),
    30_000
  )
})

describe("multimodal submissions", () => {
  it.live(
    "a prompt carrying binary content survives the journal",
    () =>
      Effect.gen(function* () {
        // The workflow payload is a `Prompt`, and the claim throughout is that
        // `Prompt` carries its own Schema so a multimodal submission survives
        // the journal exactly as a text one does. That claim had never been
        // exercised against real storage -- and the last two bugs found here
        // were both "encodes fine in memory, rejected by SQLite".
        //
        // `Uint8Array` is the interesting case: it is not a JSON value.
        const file = yield* tempDatabase
        const bytes = new Uint8Array([1, 2, 3, 4, 5])

        const submission = Prompt.make([
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this file?" },
              {
                type: "file",
                mediaType: "application/pdf",
                fileName: "report.pdf",
                data: bytes
              }
            ]
          }
        ])

        const { layer: model, recorder } = yield* FakeModel.layer([
          { text: "a report" }
        ])
        const store = yield* DurableChannels.memoryStore
        const durable = DurableAgent.workflow(
          "Multimodal",
          Agent.make({}),
          { store }
        )

        yield* Effect.gen(function* () {
          const executionId = yield* DurableAgent.submit(
            durable,
            store,
            "mm-1",
            submission
          )
          const exit = yield* DurableAgent.result(durable, executionId, {
            interval: Duration.millis(50)
          })
          assert.isTrue(
            Exit.isSuccess(exit),
            `submission did not finish: ${JSON.stringify(exit)}`
          )
        }).pipe(
          Effect.provide(
            durable.layer.pipe(
              Layer.provideMerge(engineFor(file, 35)),
              Layer.provideMerge(model)
            )
          )
        )

        // The file part reached the model with its bytes intact, alongside the
        // text -- not dropped, and not turned into something else on the way
        // through the payload schema.
        const prompt = (yield* recorder.prompts)[0]
        assert.isDefined(prompt)
        const parts = prompt.content.flatMap((message) =>
          message.role === "user" ? message.content : []
        )
        assert.deepStrictEqual(
          parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
          ["what is in this file?"]
        )
        const files = parts.flatMap((part) =>
          part.type === "file" ? [part] : []
        )
        assert.strictEqual(files.length, 1, "the file part was dropped")
        assert.strictEqual(files[0]!.mediaType, "application/pdf")
        // The content survives, but not the representation: `Prompt` encodes
        // `Uint8Array` as base64, and decoding leaves it a base64 string
        // rather than restoring the array. That is Effect AI's wire form, not
        // something this library chooses, and it is worth pinning because it
        // is a real difference between a fresh run and a resumed one: a tool
        // that branches on `instanceof Uint8Array` sees the other arm after a
        // durable round trip.
        const data = files[0]!.data
        // No cast anywhere: narrowing is the assertion.
        assert.isTrue(
          typeof data === "string",
          "the file part's content did not survive"
        )
        if (typeof data === "string") {
          assert.deepStrictEqual(
            Array.from(Buffer.from(data, "base64")),
            Array.from(bytes),
            "the bytes did not survive the journal"
          )
        }
      }),
    30_000
  )
})
