import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Export from "../src/export/Export.js"
import * as Replay from "../src/export/Replay.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * An export is a promise to whoever opens the file later.
 *
 * The invariants under test are the ones in `docs/plan-snapshot-export.md`:
 * a round trip changes nothing (IE1), a version is always present and an
 * unknown one is refused by name (IE2), and exporting mutates nothing (IE4).
 */

const agent = Agent.make({
  instructions: "You answer briefly.",
  loop: AgentLoop.bounded(4)
})

/** One real tool, so a recorded tool call actually reaches history. */
const readFile = Tool.make("read_file", {
  description: "Read a file.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String
})

const withTool = Agent.make({
  instructions: "You read files.",
  loop: AgentLoop.bounded(4),
  toolkit: Agent.toolkit([readFile], {
    read_file: ({ path }) => Effect.succeed(`contents of ${path}`)
  })
})

const provenance: Export.Provenance = {
  harnessVersion: "0.0.0-test",
  model: { provider: "test", modelId: "scripted" },
  tools: ["read_file", "bash"]
}

const textOf = (prompt: Prompt.Prompt): string =>
  JSON.stringify(Schema.encodeUnknownSync(Prompt.Prompt)(prompt))

describe("Export", () => {
  it.effect("round-trips a conversation unchanged (IE1)", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("the answer")
      ])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("the question")
        const exported = yield* Export.ofSession(session, provenance)
        const text = yield* Export.encode(exported)
        return { exported, text, restored: yield* Export.parse(text) }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Byte for byte through the encoded form, which is the only comparison
      // that means anything once a file has been on a disk.
      assert.strictEqual(
        textOf(Export.historyOf(out.restored)),
        textOf(Export.historyOf(out.exported))
      )
      assert.strictEqual(out.restored.session.sessionId, out.exported.session.sessionId)
      assert.strictEqual(out.restored.exportedAt, out.exported.exportedAt)
      assert.deepStrictEqual(out.restored.provenance, out.exported.provenance)
    }))

  it.effect("a restored export rebuilds a live session", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("first"),
        TestLanguageModel.text("second")
      ])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("one")
        const text = yield* Effect.flatMap(
          Export.ofSession(session, provenance),
          Export.encode
        )

        // The envelope embeds a snapshot unchanged, so restoring from an
        // export is exactly restoring from a snapshot -- which is the claim
        // that makes the envelope additive rather than a second format.
        const exported = yield* Export.parse(text)
        const restored = yield* AgentSession.restore(agent, exported.session)
        yield* restored.prompt("two")

        return {
          before: textOf(Export.historyOf(exported)),
          after: yield* restored.history
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.include(out.before, "first")
      // It continued rather than started over.
      assert.include(textOf(out.after), "first")
      assert.include(textOf(out.after), "second")
    }))

  it.effect("refuses a version it does not know, by name (IE2)", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Export.decode({ version: 99, exportedAt: 0, session: {}, provenance: {} })
      )

      assert.strictEqual(failure.reason, "unsupported-version")
      assert.strictEqual(failure.found, 99)
      // Both versions in the message: a reader has to know whether to upgrade
      // this build or re-export the file, and one number cannot say which.
      assert.include(failure.message, "99")
      assert.include(failure.message, String(Export.VERSION))
    }))

  it.effect("a version is checked before the payload", () =>
    Effect.gen(function*() {
      // Newer *and* structurally wrong for this build. Decoding first would
      // report a missing field and send the reader hunting for a bug in their
      // data instead of telling them to upgrade.
      const failure = yield* Effect.flip(
        Export.decode({ version: 99, whatever: true })
      )
      assert.strictEqual(failure.reason, "unsupported-version")
    }))

  it.effect("something with no version is not an export", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(Export.decode({ session: {}, provenance: {} }))
      assert.strictEqual(failure.reason, "malformed")
      assert.include(failure.message, "not an export")
    }))

  it.effect("truncated text fails as malformed, not as a crash", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(Export.parse(`{"version": 1, "session"`))
      assert.strictEqual(failure.reason, "malformed")
    }))

  it.effect("two exports of one session are byte-identical (determinism)", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        const snapshot = yield* AgentSession.snapshot(session)
        // The same snapshot twice: what differs between two writes of one
        // conversation must be nothing, or every fixture update is an
        // unreadable diff.
        const one = yield* Effect.flatMap(Export.of(snapshot, provenance), Export.encode)
        const two = yield* Effect.flatMap(Export.of(snapshot, provenance), Export.encode)
        return { one, two }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.one, out.two)
    }))

  it.effect("exporting leaves the session alone (IE4)", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        const before = yield* session.history
        yield* Export.ofSession(session, provenance)
        const after = yield* session.history
        const status = yield* session.status
        return { before: textOf(before), after: textOf(after), status }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.after, out.before)
      assert.strictEqual(out.status, "idle")
    }))

  it.effect("a busy session cannot be exported (IE4)", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("slow")])

      const failure = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* Effect.forkChild(session.prompt("go"))
        yield* Effect.yieldNow
        // Inherited from `snapshot`, and for its reason: a running session's
        // history is mid-turn, and an export taken then records a
        // conversation that never existed.
        return yield* Effect.flip(Export.ofSession(session, provenance))
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(failure._tag, "AgentBusyError")
    }))

  it.effect("provenance explains a mismatch without pretending to prevent it", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        return yield* Export.ofSession(session, provenance)
      }).pipe(Effect.provide(layer), Effect.scoped)

      // A transcript naming tools the importer lacks. Advisory: it says what
      // is absent, and deliberately does not refuse.
      assert.deepStrictEqual(Export.missingTools(out, ["read_file"]), ["bash"])
      assert.deepStrictEqual(Export.missingTools(out, ["read_file", "bash", "search"]), [])
    }))

  it.effect("an export with no recorded tools claims nothing", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        return yield* Export.ofSession(session, { harnessVersion: "0.0.0-test" })
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Absent is not empty: an export that recorded no tool names cannot be
      // read as an export that used none.
      assert.isUndefined(out.provenance.tools)
      assert.deepStrictEqual(Export.missingTools(out, []), [])
    }))

  it.effect("cwd is absent unless asked for", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        return yield* Export.ofSession(session, provenance)
      }).pipe(Effect.provide(layer), Effect.scoped)

      // An absolute path routinely carries a username, and an export's whole
      // purpose is to go somewhere else.
      assert.isUndefined(out.provenance.cwd)
      assert.notInclude(yield* Export.encode(out), "cwd")
    }))
})

describe("Replay", () => {
  it.effect("an exported transcript replays without a provider", () =>
    Effect.gen(function*() {
      // The recording run.
      const recorded = yield* Effect.gen(function*() {
        const { layer } = yield* TestLanguageModel.script([
          TestLanguageModel.text("the first answer"),
          TestLanguageModel.text("the second answer")
        ])
        return yield* Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          yield* session.prompt("first question")
          yield* session.prompt("second question")
          return yield* Export.ofSession(session, provenance)
        }).pipe(Effect.provide(layer), Effect.scoped)
      })

      const turns = Replay.turnsOf(recorded)
      const prompts = Replay.promptsOf(recorded)

      // The replay run: the recorded model output, played back. No provider,
      // no network, nothing to flake.
      const replayed = yield* Effect.gen(function*() {
        const { layer } = yield* TestLanguageModel.script(turns)
        return yield* Effect.gen(function*() {
          const session = yield* AgentSession.make(agent)
          for (const prompt of prompts) yield* session.prompt(prompt)
          return yield* session.history
        }).pipe(Effect.provide(layer), Effect.scoped)
      })

      assert.deepStrictEqual(prompts, ["first question", "second question"])
      assert.strictEqual(turns.length, 2)
      // The conversation came out the same, which is the whole claim: a
      // session that hit a bug can be committed as a fixture that reproduces
      // it.
      assert.strictEqual(textOf(replayed), textOf(Export.historyOf(recorded)))
    }))

  it.effect("a turn that called a tool replays as a tool call", () =>
    Effect.gen(function*() {
      const recorded = yield* Effect.gen(function*() {
        const { layer } = yield* TestLanguageModel.script([
          { toolCalls: [{ id: "t1", name: "read_file", params: { path: "a.ts" } }] },
          TestLanguageModel.text("done")
        ])
        return yield* Effect.gen(function*() {
          const session = yield* AgentSession.make(withTool)
          yield* Effect.result(session.prompt("read it"))
          return yield* Export.ofSession(session, provenance)
        }).pipe(Effect.provide(layer), Effect.scoped)
      })

      const turns = Replay.turnsOf(recorded)
      const calls = turns.flatMap((turn) => turn.toolCalls ?? [])

      // The call is carried with its parameters, because that is what the
      // model produced and replaying it is the point. Its *result* is not:
      // a handler ran against a real world, and playing back what it returned
      // would turn a test of the agent into a test of nothing.
      assert.isAbove(calls.length, 0)
      assert.strictEqual(calls[0]!.name, "read_file")
      assert.deepStrictEqual(calls[0]!.params, { path: "a.ts" })
      assert.deepStrictEqual(Replay.toolsUsed(recorded), ["read_file"])
    }))

  it.effect("reports the tools a replay would need and lack", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        return yield* Export.ofSession(session, provenance)
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Read off the conversation, not off provenance: provenance says what
      // the agent *had*, and this says what the transcript actually *used*.
      // Nothing was called here, so nothing is missing -- even though
      // provenance names two tools.
      assert.deepStrictEqual(Replay.toolsUsed(out), [])
      assert.isTrue(Option.isNone(Replay.unavailable(out, [])))
    }))
})
