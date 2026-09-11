import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { readFileSync } from "node:fs"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodeTool } from "../src/code/index.js"
import { Compaction } from "../src/compaction/index.js"
import { activityName, startMarkerName } from "../src/internal/toolActivity.js"
import { Memory } from "../src/memory/index.js"
import * as Permission from "../src/Permission.js"
import * as ToolScheduling from "../src/ToolScheduling.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Fixtures for five behaviour changes of 2026-09-10 that landed before
 * their measurement did (see `test/fixtures/README.md`). Each is bytes the
 * production codec or path produced, read back here; each commit that made
 * the change is named by the `Behavior-Change-Measures:` trailer of the
 * commit that added these.
 */

const read = (name: string): unknown => JSON.parse(readFileSync(`test/fixtures/${name}`, "utf8"))

describe("behaviour-change fixtures recorded after the change", () => {
  it.effect("a snapshot written before `version` existed decodes as version 1 (4acc464)", () =>
    Effect.gen(function*() {
      const snapshot = yield* Schema.decodeUnknownEffect(AgentSession.Snapshot)(read("snapshot-unversioned.json"))
      assert.strictEqual(snapshot.version, 1)
      // And a snapshot written now is that one plus exactly the version.
      const now = yield* Schema.encodeEffect(AgentSession.Snapshot)({
        version: 1,
        sessionId: "recorded",
        history: Prompt.make("hello")
      })
      const { version, ...rest } = now
      assert.strictEqual(version, 1)
      assert.deepStrictEqual(rest, read("snapshot-unversioned.json"))
    }))

  it.effect("Code Mode's per-call outcomes: the old three still decode, and the two new ones do (a35673a)", () =>
    Effect.gen(function*() {
      const recorded = Schema.decodeUnknownSync(Schema.Struct({ before: Schema.Unknown, after: Schema.Unknown }))(
        read("code-mode-outcomes.json")
      )
      const json = Schema.toCodecJson(CodeTool.Result)
      const before = yield* Schema.decodeUnknownEffect(json)(recorded.before)
      const after = yield* Schema.decodeUnknownEffect(json)(recorded.after)
      assert.deepStrictEqual(before.calls.map((c) => c.outcome), ["succeeded", "failed", "refused"])
      assert.deepStrictEqual(after.calls.map((c) => c.outcome), ["succeeded", "uncertain", "not-started"])
    }))

  it.effect("a discarded checkpoint's event, as a consumer reads it (0b289f9)", () =>
    Effect.gen(function*() {
      const event = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Compaction.CompactionEvent))(
        read("compaction-checkpoint-discarded.json")
      )
      assert.strictEqual(event._tag, "CompactionCheckpointDiscarded")
    }))

  it("a non-idempotent call's journal names: the start marker and the call (1a770eb)", () => {
    const recorded = Schema.decodeUnknownSync(Schema.Struct({ startMarker: Schema.String, call: Schema.String }))(
      read("tool-activity-names.json")
    )
    assert.strictEqual(startMarkerName(0, "refund", "r1"), recorded.startMarker)
    assert.strictEqual(activityName(0, "refund", "r1"), recorded.call)
  })

  it.effect("what the model reads when recall was cut at its limit (3783b93)", () =>
    Effect.gen(function*() {
      const { layer, recorder } = yield* TestLanguageModel.script([TestLanguageModel.text("ok")])
      yield* Effect.gen(function*() {
        const memory = yield* Memory.Memory
        for (let i = 0; i < 3; i++) yield* memory.remember("s", { content: `note ${i} about coffee` })
        yield* Effect.scoped(Effect.flatMap(
          AgentSession.make(Agent.make({ contextTransform: Memory.recall("s"), loop: AgentLoop.bounded(1) })),
          (session) => session.prompt("coffee")
        ))
      }).pipe(Effect.provide(Layer.merge(Memory.layer({ limit: 2 }), layer)))
      const [prompt] = yield* recorder.prompts
      const system = prompt!.content.filter((m) => m.role === "system").map((m) => m.content)
      assert.deepStrictEqual({ systemMessages: system }, read("memory-recall-truncated.json"))
    }))

  it("what a durable run records of its permission policy and host scheduling, and reads back (725551e, 5e13679)", () => {
    const recorded = Schema.decodeUnknownSync(Schema.Struct({
      permissionPolicy: Schema.String,
      hostScheduling: Schema.String,
      hostSchedulingSerialized: Schema.String
    }))(read("admission-descriptions.json"))
    const policy = Permission.except(
      Permission.rules([{ resource: /secret/i, decision: Permission.deny("no") }, { tool: "read", decision: Permission.allow }], {
        otherwise: Permission.ask()
      }),
      [{ action: "write", resource: /^\/workspace\//, decision: Permission.allow }]
    )
    // The description format is the journal's: a flagged pattern keeps its
    // flags (`regexp/i:`), a flagless one reads as before.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(Permission.describe(policy))), JSON.parse(recorded.permissionPolicy))
    // And what was recorded re-creates to the same decisions.
    const again = Permission.fromRecorded(recorded.permissionPolicy)
    assert.isTrue(Option.isSome(again))
    const request = (tool: string, action: string, resource: string): Permission.Request => ({
      sessionId: "s", toolCallId: "c", tool: { name: tool, params: {} }, action, resource, intrinsicApproval: false, messages: []
    })
    if (Option.isSome(again)) {
      for (const [tool, action, resource] of [["read", "tool", "SECRET.md"], ["read", "tool", "notes"], ["x", "write", "/workspace/a"], ["x", "tool", "y"]] as const) {
        assert.strictEqual(
          Effect.runSync(again.value.evaluate(request(tool, action, resource)))._tag,
          Effect.runSync(policy.evaluate(request(tool, action, resource)))._tag,
          `${tool} ${action} ${resource}`
        )
      }
    }
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(ToolScheduling.all(ToolScheduling.maxConcurrent(2), ToolScheduling.unconstrained).description)),
      JSON.parse(recorded.hostScheduling)
    )
    assert.isTrue(Option.isSome(ToolScheduling.fromRecorded(recorded.hostScheduling)))
    // A serialization keys by a function: recorded, but not re-creatable.
    assert.isTrue(Option.isNone(ToolScheduling.fromRecorded(recorded.hostSchedulingSerialized)))
  })
})
