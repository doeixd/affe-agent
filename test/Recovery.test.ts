import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as DurableChannels from "../src/durable/DurableChannels.js"
import * as DurableSessionStore from "../src/durable/DurableSessionStore.js"
import * as DurableToolkit from "../src/durable/DurableToolkit.js"
import * as Recovery from "../src/durable/Recovery.js"

/**
 * Item 135: what a durable session's recovery owes, as a table. The
 * reconciliation runs this decision; `DurableAgentClient`'s own tests hold
 * it to what each branch then does.
 */

const record = (claim: Option.Option<{ readonly executionId?: string }>): DurableSessionStore.SessionRecord => ({
  sessionId: "s",
  status: Option.isSome(claim) ? "running" : "idle",
  submissionCount: 1,
  claim: Option.map(claim, (c) => ({
    submissionId: "s:submission-1",
    prompt: "[]",
    stream: false,
    ...(c.executionId === undefined ? {} : { executionId: c.executionId })
  })),
  history: "[]"
})

const evidence = (overrides: Partial<Recovery.Evidence>): Recovery.Evidence => ({
  record: Option.some(record(Option.none())),
  ended: false,
  answers: [],
  pending: [],
  ...overrides
})

const held = Option.some(record(Option.some({ executionId: "exec-1" })))

describe("Recovery.classify (item 135)", () => {
  const rows: ReadonlyArray<readonly [string, Recovery.Evidence, Recovery.Decision]> = [
    ["a missing session", evidence({ record: Option.none() }), { _tag: "Missing" }],
    ["an idle session", evidence({}), { _tag: "Idle" }],
    [
      "an idle session is idle whatever the marker says",
      evidence({ ended: true }),
      { _tag: "Idle" }
    ],
    [
      "claimed, never dispatched",
      evidence({ record: Option.some(record(Option.some({}))) }),
      { _tag: "Dispatch", submissionId: "s:submission-1" }
    ],
    [
      "claimed, never dispatched, even with the marker closed: no run has ended",
      evidence({ record: Option.some(record(Option.some({}))), ended: true }),
      { _tag: "Dispatch", submissionId: "s:submission-1" }
    ],
    [
      "dispatched and ended, the claim still held",
      evidence({ record: held, ended: true }),
      { _tag: "FinishEnded", submissionId: "s:submission-1", executionId: "exec-1" }
    ],
    [
      "ended wins over undelivered answers: there is no run to deliver them to",
      evidence({ record: held, ended: true, answers: [{ id: "a1", granted: true }] }),
      { _tag: "FinishEnded", submissionId: "s:submission-1", executionId: "exec-1" }
    ],
    [
      "running with answers accepted and not delivered",
      evidence({ record: held, answers: [{ id: "a1", granted: true }, { id: "a2", granted: false }] }),
      { _tag: "DeliverAnswers", submissionId: "s:submission-1", executionId: "exec-1", answers: ["a1", "a2"] }
    ],
    [
      "running and owed nothing",
      evidence({ record: held }),
      { _tag: "Running", submissionId: "s:submission-1", executionId: "exec-1" }
    ]
  ]
  for (const [name, input, expected] of rows) {
    it(name, () => {
      assert.deepStrictEqual(Recovery.classify(input), expected)
    })
  }
})

describe("Recovery.explain and findings", () => {
  const outcome = { id: "tool-charge-c1:outcome", kind: DurableToolkit.unknownOutcomeKind, detail: {} }
  const approval = { id: "s:submission-1:elicit-1", kind: "tool-approval", detail: {} }

  it("a run waiting on an unknown outcome says so, by request id", () => {
    const input = evidence({ record: held, pending: [outcome, approval] })
    const text = Recovery.explain(Recovery.classify(input), input)
    assert.include(text, "1 tool call(s) whose outcome is unknown")
    assert.include(text, outcome.id)
    assert.include(text, "1 other question(s)")
    assert.deepStrictEqual(Recovery.parked(input), [outcome])
  })

  it("a consistent store has no findings", () => {
    assert.deepStrictEqual(Recovery.findings(evidence({})), [])
    assert.deepStrictEqual(Recovery.findings(evidence({ record: held, pending: [approval] })), [])
  })

  it("status and claim disagreeing, and orphaned questions and answers, are found", () => {
    const disagree = evidence({ record: Option.some({ ...record(Option.none()), status: "running" }) })
    assert.deepStrictEqual(Recovery.findings(disagree), ["the session is marked running, but no submission holds it"])
    const orphans = evidence({ pending: [approval], answers: [{ id: "a1", granted: true }] })
    assert.strictEqual(Recovery.findings(orphans).length, 2)
    assert.deepStrictEqual(
      Recovery.findings(evidence({ record: Option.none(), answers: [{ id: "a1", granted: true }] })),
      ["questions or answers are recorded for a session that does not exist"]
    )
  })
})

describe("Recovery.inspect", () => {
  it.effect("reads the stores, and changes nothing", () =>
    Effect.gen(function*() {
      const stores = { store: yield* DurableChannels.memoryStore, sessionStore: yield* DurableSessionStore.memoryStore }
      assert.strictEqual((yield* Recovery.inspect(stores, "s")).decision._tag, "Missing")
      yield* stores.sessionStore.getOrCreate("s", Prompt.make([]))
      yield* stores.sessionStore.claim("s", { prompt: Prompt.make("go"), stream: false })
      const before = yield* stores.sessionStore.get("s")
      const inspection = yield* Recovery.inspect(stores, "s")
      assert.deepStrictEqual(inspection.decision, { _tag: "Dispatch", submissionId: "s:submission-1" })
      assert.include(inspection.explanation, "never started")
      assert.deepStrictEqual(inspection.findings, [])
      assert.deepStrictEqual(yield* stores.sessionStore.get("s"), before)
    }))
})
