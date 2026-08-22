import { DurableStreamTestServer } from "@durable-streams/server"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schedule, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import { AgentClient } from "../src/client/index.js"
import * as DurableAgentClient from "../src/durable/DurableAgentClient.js"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import { DurableStreams, DurableStreamsDeliveryLog } from "../src/durable-streams/index.js"
import * as FakeModel from "./FakeModel.js"
import { TestLanguageModel } from "../src/testing/index.js"
import { contract, crossProcessLive, envelope } from "./DeliveryLogContract.js"

/**
 * Durable Streams (issue #10), against the official in-process test server.
 *
 * Three layers, each tested as itself: the typed protocol wrapper (append,
 * catch-up, live tail, offsets, EOF, idempotent producer, decode failure);
 * the `DeliveryLog` over it, running the same contract as the memory and
 * SQL logs plus what only a shared remote log can show; and the durable
 * agent client with it as its delivery log, where a consumer disconnects
 * and resumes from its own offset, in another process, while the agent
 * carries on.
 */

const server = Effect.acquireRelease(
  Effect.promise(async () => {
    const instance = new DurableStreamTestServer({ port: 0 })
    const url = await instance.start()
    return { instance, url }
  }),
  ({ instance }) => Effect.promise(() => instance.stop())
)

const Counter = Schema.Struct({ n: Schema.Number })

describe("DurableStreams typed protocol wrapper", () => {
  it.live("append, catch up, resume from an exact offset, and tail live without gap or duplicate", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const stream = DurableStreams.make({ url: `${url}/streams/a`, schema: Counter })
      yield* stream.create
      // Creating again with the same configuration is accepted; `ensure` is
      // the same call tolerant of a server that reports it as a conflict.
      yield* stream.create
      yield* stream.ensure

      yield* stream.append({ n: 1 })
      yield* stream.append({ n: 2 })
      const caughtUp = yield* Stream.runCollect(stream.read({ live: false }))
      assert.deepStrictEqual(caughtUp.map((r) => r.value.n), [1, 2])
      const checkpoint = caughtUp[caughtUp.length - 1]!.offset

      // Resume after the checkpoint: nothing is repeated.
      yield* stream.append({ n: 3 })
      const resumed = yield* Stream.runCollect(stream.read({ after: checkpoint, live: false }))
      assert.deepStrictEqual(resumed.map((r) => r.value.n), [3])

      // Live: catch up from the checkpoint, then tail. The append lands
      // after the tail is open; the reader sees 3 then 4 and nothing twice.
      const tailed = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(stream.read({ after: checkpoint }), 2))
      )
      yield* Effect.sleep("150 millis")
      yield* stream.append({ n: 4 })
      const seen = yield* Fiber.join(tailed)
      assert.deepStrictEqual(seen.map((r) => r.value.n), [3, 4])
      // Offsets advance monotonically as strings the protocol orders.
      assert.isTrue(seen[0]!.offset < seen[1]!.offset)
      const head = yield* stream.head
      assert.isTrue(head.exists)
      assert.strictEqual(head.offset, seen[1]!.offset)
      assert.isFalse(head.closed)
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("a record's offset is always safe to resume after: mid-batch re-delivers, a boundary is exact", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const stream = DurableStreams.make({ url: `${url}/streams/offsets`, schema: Counter })
      yield* stream.ensure
      for (const n of [1, 2, 3]) yield* stream.append({ n })
      // One catch-up read delivers one batch: the first two records carry
      // the batch's start, the last its end.
      const batch = yield* Stream.runCollect(stream.read({ live: false }))
      assert.deepStrictEqual(batch.map((r) => r.value.n), [1, 2, 3])
      assert.strictEqual(batch[0]!.offset, DurableStreams.start)
      assert.strictEqual(batch[1]!.offset, DurableStreams.start)
      assert.strictEqual(batch[2]!.offset, (yield* stream.head).offset)
      // Checkpointing after record 2 and resuming loses nothing: the batch
      // comes again. Checkpointing after record 3 resumes exactly.
      const fromMid = yield* Stream.runCollect(stream.read({ after: batch[1]!.offset, live: false }))
      assert.deepStrictEqual(fromMid.map((r) => r.value.n), [1, 2, 3])
      const fromEnd = yield* Stream.runCollect(stream.read({ after: batch[2]!.offset, live: false }))
      assert.deepStrictEqual(fromEnd, [])
      // A live tail delivers one batch per append, so every tailed record
      // is a boundary and resuming after any of them is exact.
      const tailed = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(stream.read({ after: batch[2]!.offset }), 2))
      )
      yield* Effect.sleep("150 millis")
      yield* stream.append({ n: 4 })
      yield* stream.append({ n: 5 })
      const two = yield* Fiber.join(tailed)
      assert.deepStrictEqual(two.map((r) => r.value.n), [4, 5])
      assert.isTrue(two[0]!.offset < two[1]!.offset)
      assert.deepStrictEqual(
        (yield* Stream.runCollect(stream.read({ after: two[0]!.offset, live: false }))).map((r) => r.value.n),
        [5]
      )
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("close is durable EOF: a live reader ends, appends are refused, head says closed", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const stream = DurableStreams.make({ url: `${url}/streams/finite`, schema: Counter })
      yield* stream.ensure
      yield* stream.append({ n: 1 })
      const seen = yield* Ref.make<Array<number>>([])
      const reader = yield* Effect.forkChild(
        Stream.runCollect(
          stream.read().pipe(Stream.tap((r) => Ref.update(seen, (all) => [...all, r.value.n])))
        )
      )
      yield* stream.append({ n: 2 })
      // The tail has delivered everything; now the writer ends the stream.
      yield* Effect.repeat(Ref.get(seen), {
        until: (all) => all.length === 2,
        schedule: Schedule.spaced("20 millis")
      })
      yield* stream.close
      // Idempotent.
      yield* stream.close
      const all = yield* Fiber.join(reader)
      assert.deepStrictEqual(all.map((r) => r.value.n), [1, 2])
      assert.isTrue((yield* stream.head).closed)
      const refused = yield* Effect.flip(stream.append({ n: 3 }))
      assert.strictEqual(refused._tag, "DurableStreamError")
      // A catch-up read of a closed stream still returns everything, and
      // a live one ends at once.
      const later = yield* Stream.runCollect(stream.read({ live: false }))
      assert.strictEqual(later.length, 2)
      const liveLater = yield* Stream.runCollect(stream.read())
      assert.strictEqual(liveLater.length, 2)
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("a record that does not decode fails the read with the schema error, at the position before it", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const typed = DurableStreams.make({ url: `${url}/streams/bad`, schema: Counter })
      yield* typed.ensure
      yield* typed.append({ n: 1 })
      // Something else wrote a record this schema does not admit.
      const raw = DurableStreams.make({ url: typed.url, schema: Schema.Unknown })
      yield* raw.append({ nope: true })
      yield* typed.append({ n: 2 })
      const exit = yield* Effect.exit(Stream.runCollect(typed.read({ live: false })))
      assert.isTrue(exit._tag === "Failure")
      // What decoded before the bad record is still readable up to it.
      const good = yield* Stream.runCollect(Stream.take(typed.read({ live: false }), 1))
      assert.deepStrictEqual(good.map((r) => r.value.n), [1])
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("the idempotent producer survives a retried append without a duplicate record", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const stream = DurableStreams.make({ url: `${url}/streams/producer`, schema: Counter })
      yield* stream.ensure
      yield* Effect.scoped(
        Effect.gen(function* () {
          const producer = yield* stream.producer("writer-1", { epoch: 1 })
          yield* producer.append({ n: 1 })
          yield* producer.append({ n: 2 })
          yield* producer.flush
          // Flushing again re-sends nothing; the scope's own flush is a no-op too.
          yield* producer.flush
        })
      )
      // A second producer with the same id and a *newer* epoch fences the old one.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const producer = yield* stream.producer("writer-1", { epoch: 2 })
          yield* producer.append({ n: 3 })
          yield* producer.flush
        })
      )
      const all = yield* Stream.runCollect(stream.read({ live: false }))
      assert.deepStrictEqual(all.map((r) => r.value.n), [1, 2, 3])
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("interrupting a live reader releases its connection and leaves the stream untouched", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const stream = DurableStreams.make({ url: `${url}/streams/interrupt`, schema: Counter })
      yield* stream.ensure
      yield* stream.append({ n: 1 })
      const reader = yield* Effect.forkChild(Stream.runCollect(stream.read()))
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(reader)
      // Still open, still writable, nothing lost.
      const head = yield* stream.head
      assert.isFalse(head.closed)
      yield* stream.append({ n: 2 })
      assert.strictEqual((yield* Stream.runCollect(stream.read({ live: false }))).length, 2)
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("fold replays typed deltas into state and a snapshot plus the remaining deltas reaches the same state", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const Delta = Schema.Union([
        Schema.TaggedStruct("Add", { amount: Schema.Number }),
        Schema.TaggedStruct("Reset", {})
      ])
      const apply = (state: number, delta: typeof Delta.Type) =>
        delta._tag === "Add" ? state + delta.amount : 0
      const deltas = DurableStreams.make({ url: `${url}/streams/deltas`, schema: Delta })
      yield* deltas.ensure
      for (const d of [
        { _tag: "Add", amount: 5 },
        { _tag: "Add", amount: 7 },
        { _tag: "Reset" },
        { _tag: "Add", amount: 2 }
      ] as const) {
        yield* deltas.append(d)
      }
      const full = yield* DurableStreams.fold(deltas, 0, apply)
      assert.strictEqual(full.state, 2)
      // Offsets are the client's batch positions: a checkpoint is the
      // position after the batch a record arrived in. A snapshot taken at
      // `full.offset` plus nothing reaches the same state; a snapshot taken
      // at an earlier read's end plus the deltas since does too.
      const resumedAtEnd = yield* DurableStreams.fold(deltas, full.state, apply, { after: full.offset })
      assert.strictEqual(resumedAtEnd.state, full.state)
      assert.strictEqual(resumedAtEnd.offset, full.offset)
      yield* deltas.append({ _tag: "Add", amount: 40 })
      const since = yield* DurableStreams.fold(deltas, full.state, apply, { after: full.offset })
      assert.strictEqual(since.state, 42)
      assert.strictEqual(since.state, (yield* DurableStreams.fold(deltas, 0, apply)).state)
      // A corrupt delta fails the fold rather than mutating state.
      yield* DurableStreams.make({ url: deltas.url, schema: Schema.Unknown }).append({ _tag: "Multiply" })
      const corrupt = yield* Effect.exit(DurableStreams.fold(deltas, 0, apply))
      assert.isTrue(corrupt._tag === "Failure")
    }).pipe(Effect.scoped),
    15_000
  )
})

// ---------------------------------------------------------------------------
// The DeliveryLog over it
// ---------------------------------------------------------------------------

/** A log per test, on its own server. */
const streamsLog = Effect.gen(function* () {
  const { url } = yield* server
  return yield* DurableStreamsDeliveryLog.make({ baseUrl: `${url}/sessions` })
})

contract("durable-streams", streamsLog, { settle: "200 millis" })

crossProcessLive(
  "durable-streams",
  Effect.gen(function* () {
    const { url } = yield* server
    const base = `${url}/xproc`
    const one = yield* DurableStreamsDeliveryLog.make({ baseUrl: base })
    const two = yield* DurableStreamsDeliveryLog.make({ baseUrl: base })
    return [one, two] as const
  }),
  { settle: "250 millis" }
)

describe("DurableStreamsDeliveryLog across processes", () => {
  it.live("two logs over one stream agree on sequences, duplicates and conflicts", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const a = yield* DurableStreamsDeliveryLog.make({ baseUrl: `${url}/sessions` })
      const b = yield* DurableStreamsDeliveryLog.make({ baseUrl: `${url}/sessions` })
      assert.deepStrictEqual(
        yield* a.append("s", "k1", envelope(1, { _tag: "SubmissionStarted" })),
        { _tag: "Appended", sequence: 1 }
      )
      // B has never seen the session; it learns the log from the stream.
      assert.deepStrictEqual(
        yield* b.append("s", "k2", envelope(1, { _tag: "RunStarted" })),
        { _tag: "Appended", sequence: 2 }
      )
      // A's index is stale; its next append still lands at 3, because the
      // stream is counted, not the cache.
      assert.deepStrictEqual(
        yield* a.append("s", "k3", envelope(2, { _tag: "TurnStarted" })),
        { _tag: "Appended", sequence: 3 }
      )
      // A replay of k2 from A (which never wrote it) is a duplicate; a
      // disagreement is a conflict; neither adds a record a reader counts.
      assert.deepStrictEqual(
        yield* a.append("s", "k2", envelope(9, { _tag: "RunStarted" })),
        { _tag: "Duplicate" }
      )
      assert.deepStrictEqual(
        yield* b.append("s", "k1", envelope(1, { _tag: "RunStarted" })),
        { _tag: "Conflict" }
      )
      const fromA = yield* a.read("s")
      const fromB = yield* b.read("s")
      assert.deepStrictEqual(
        fromA.map((e) => [e.sequence, e.event._tag]),
        [[1, "SubmissionStarted"], [2, "RunStarted"], [3, "TurnStarted"]]
      )
      assert.deepStrictEqual(fromA, fromB)
      // The raw stream holds exactly the three accepted records: nothing
      // was written for the duplicate or the conflict.
      const raw = yield* Stream.runCollect(
        DurableStreamsDeliveryLog.streamFor({ baseUrl: `${url}/sessions` }, "s").read({ live: false })
      )
      assert.deepStrictEqual(raw.map((r) => r.value.key), ["k1", "k2", "k3"])
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("a raw duplicate record in the stream is skipped by every reader and numbered by none", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const options = { baseUrl: `${url}/sessions` }
      // Two writers that both lost their acknowledgement and retried: the
      // stream itself holds k1 twice.
      const raw = DurableStreamsDeliveryLog.streamFor(options, "dup")
      yield* raw.ensure
      yield* raw.append({ key: "k1", envelope: envelope(1, { _tag: "SubmissionStarted" }) })
      yield* raw.append({ key: "k1", envelope: envelope(1, { _tag: "SubmissionStarted" }) })
      yield* raw.append({ key: "k2", envelope: envelope(2, { _tag: "RunStarted" }) })
      const log = yield* DurableStreamsDeliveryLog.make(options)
      assert.deepStrictEqual(
        (yield* log.read("dup")).map((e) => [e.sequence, e.event._tag]),
        [[1, "SubmissionStarted"], [2, "RunStarted"]]
      )
      assert.deepStrictEqual(
        yield* log.append("dup", "k3", envelope(3, { _tag: "TurnStarted" })),
        { _tag: "Appended", sequence: 3 }
      )
    }).pipe(Effect.scoped),
    15_000
  )

  it.live("live tails from another process, and two consumers keep independent positions", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const writer = yield* DurableStreamsDeliveryLog.make({ baseUrl: `${url}/sessions` })
      const readerA = yield* DurableStreamsDeliveryLog.make({ baseUrl: `${url}/sessions` })
      const readerB = yield* DurableStreamsDeliveryLog.make({ baseUrl: `${url}/sessions` })
      yield* writer.append("s", "k1", envelope(1, { _tag: "SubmissionStarted" }))
      const tailA = yield* Effect.forkChild(Stream.runCollect(Stream.take(readerA.live("s"), 2)))
      yield* Effect.sleep("200 millis")
      yield* writer.append("s", "k2", envelope(2, { _tag: "RunStarted" }))
      yield* writer.append("s", "k3", envelope(3, { _tag: "TurnStarted" }))
      const seenA = yield* Fiber.join(tailA)
      assert.deepStrictEqual(seenA.map((e) => e.sequence), [2, 3])
      // B arrives late with its own checkpoint: catch-up is `read({ after })`,
      // and it is complete and correctly numbered from a cold process.
      const caughtUp = yield* readerB.read("s", { after: 1 })
      assert.deepStrictEqual(caughtUp.map((e) => e.sequence), [2, 3])
    }).pipe(Effect.scoped),
    15_000
  )
})

// ---------------------------------------------------------------------------
// The durable agent client over it
// ---------------------------------------------------------------------------

const Engine = ClusterWorkflowEngine.layer.pipe(Layer.provide(TestRunner.layer))

const Search = Tool.make("search", {
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

describe("DurableAgentClient with Durable Streams delivery", () => {
  it.live("a consumer disconnects mid-run, the agent carries on, and it resumes from its offset in another process", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const baseUrl = `${url}/sessions`
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const agent = Agent.make({
        toolkit: Agent.toolkit([Search], { search: ({ query }) => Effect.succeed(`hits for ${query}`) }),
        loop: AgentLoop.bounded(4)
      })
      const stores = yield* Effect.all({
        store: DurableChannels.memoryStore,
        sessionStore: DurableSessionStore.memoryStore
      })
      const { layer: model, recorder } = yield* FakeModel.script([
        { toolCalls: [{ id: "t1", name: "search", params: { query: "effect" } }], started: entered, during: Deferred.await(release) },
        { text: "Effect is a library.", chunks: ["Effect ", "is a ", "library."] }
      ])
      // The runtime: its own delivery log instance over the shared stream.
      const runtimeDelivery = yield* DurableStreamsDeliveryLog.make({ baseUrl })
      const runtime = yield* Layer.build(
        DurableAgentClient.layer("Streams", agent, { ...stores, delivery: runtimeDelivery }).pipe(
          Layer.provideMerge(Engine),
          Layer.provideMerge(model)
        )
      )
      const client = yield* AgentClient.AgentClient.pipe(Effect.provide(runtime))
      const session = yield* Effect.scoped(client.createSession({ sessionId: "reconnect" }))

      // Consumer 1 subscribes, sees the run start, then goes away.
      const first = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(session.events, 3))
      )
      yield* Effect.sleep("200 millis")
      const running = yield* Effect.forkChild(session.prompt("what is effect?", { stream: true }))
      const firstSeen = yield* Fiber.join(first)
      const lastOffset = firstSeen[firstSeen.length - 1]!.sequence
      assert.isTrue(lastOffset >= 3)
      yield* Deferred.await(entered)

      // Nobody is connected now; the agent finishes regardless.
      yield* Deferred.succeed(release, void 0)
      const result = yield* Fiber.join(running)
      assert.strictEqual(result.text, "Effect is a library.")
      assert.strictEqual(yield* recorder.calls, 2)

      // "Another process": a delivery log with no memory of the session,
      // resuming from consumer 1's last offset. Everything after it is
      // there, ordered, nothing duplicated, tool calls and deltas included
      // -- none of which is in canonical history.
      const elsewhere = yield* DurableStreamsDeliveryLog.make({ baseUrl })
      const resumed = yield* elsewhere.read("reconnect", { after: lastOffset })
      const sequences = resumed.map((e) => e.sequence)
      assert.deepStrictEqual(sequences, sequences.map((_, i) => lastOffset + 1 + i))
      const tags = resumed.map((e) => e.event._tag)
      assert.include(tags, "ToolCallSucceeded")
      assert.include(tags, "MessageDelta")
      assert.strictEqual(tags[tags.length - 1], "SubmissionCompleted")
      const history = yield* session.history
      assert.deepStrictEqual(
        history.content.map((m) => m.role),
        ["user", "assistant", "tool", "assistant"]
      )
      // The whole log, from the start, is the union of what consumer 1 saw
      // and what the late process read: one contiguous numbering.
      const whole = yield* elsewhere.read("reconnect")
      assert.deepStrictEqual(whole.map((e) => e.sequence), whole.map((_, i) => i + 1))
      assert.strictEqual(whole.length, firstSeen.length + resumed.length)
    }).pipe(Effect.scoped),
    30_000
  )

  it.live("two clients in two processes tail the same session live and see identical events", () =>
    Effect.gen(function* () {
      const { url } = yield* server
      const baseUrl = `${url}/sessions`
      const agent = Agent.make({ loop: AgentLoop.bounded(2) })
      const stores = yield* Effect.all({
        store: DurableChannels.memoryStore,
        sessionStore: DurableSessionStore.memoryStore
      })
      const { layer: model } = yield* FakeModel.script([TestLanguageModel.text("hello")])
      const shared = { ...stores, delivery: yield* DurableStreamsDeliveryLog.make({ baseUrl }) }
      const runtime = yield* Layer.build(
        DurableAgentClient.layer("StreamsTwo", agent, shared).pipe(
          Layer.provideMerge(Engine),
          Layer.provideMerge(model)
        )
      )
      const here = yield* AgentClient.AgentClient.pipe(Effect.provide(runtime))
      // The other process: same stores and engine, its own delivery log.
      const there = yield* AgentClient.AgentClient.pipe(
        Effect.provide(
          DurableAgentClient.layer("StreamsTwo", agent, {
            ...stores,
            delivery: yield* DurableStreamsDeliveryLog.make({ baseUrl })
          }).pipe(Layer.provideMerge(Layer.succeedContext(runtime)))
        )
      )
      const session = yield* Effect.scoped(here.createSession({ sessionId: "both" }))
      const remote = yield* there.session("both")
      const takeUntilDone = (events: Stream.Stream<import("../src/AgentEvent.js").AgentEventEnvelope, unknown>) =>
        Stream.runCollect(events.pipe(Stream.takeUntil((e) => e.event._tag === "SubmissionCompleted")))
      const local = yield* Effect.forkChild(takeUntilDone(session.events))
      const far = yield* Effect.forkChild(takeUntilDone(remote.events))
      yield* Effect.sleep("250 millis")
      yield* session.prompt("hi")
      const [a, b] = yield* Effect.all([Fiber.join(local), Fiber.join(far)])
      assert.isTrue(a.length > 0)
      assert.deepStrictEqual(
        a.map((e) => [e.sequence, e.event._tag]),
        b.map((e) => [e.sequence, e.event._tag])
      )
      assert.strictEqual(a[a.length - 1]!.event._tag, "SubmissionCompleted")
    }).pipe(Effect.scoped),
    30_000
  )
})
