import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Export from "../src/export/Export.js"
import * as Replay from "../src/export/Replay.js"
import * as Redaction from "../src/redaction/Redaction.js"
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

describe("JSONL commit log", () => {
  it.effect("round-trips a conversation unchanged (IE1)", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("the answer")
      ])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("the question")
        const exported = yield* Export.ofSession(session, provenance)
        const jsonl = yield* Export.encodeJsonl(exported)
        const restored = yield* Export.parseJsonl(jsonl)
        return { exported, jsonl, restored }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(
        textOf(Export.historyOf(out.restored)),
        textOf(Export.historyOf(out.exported))
      )
      assert.strictEqual(out.restored.session.sessionId, out.exported.session.sessionId)
      assert.strictEqual(out.restored.exportedAt, out.exported.exportedAt)
      assert.deepStrictEqual(out.restored.provenance, out.exported.provenance)
      // JSONL is one value per line: a message containing a newline still
      // occupies one line, so a picker can split on "\n" without a parser.
      const lines = out.jsonl.trimEnd().split("\n")
      assert.isAtLeast(lines.length, 2)
      for (const line of lines) JSON.parse(line)
    }))

  it.effect("JSONL and JSON restore the same conversation", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCalls([{
          id: "call-1",
          name: "read_file",
          params: { path: "README.md" }
        }]),
        TestLanguageModel.text("it is a readme")
      ])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(withTool)
        yield* session.prompt("what is in README.md?")
        const exported = yield* Export.ofSession(session, provenance)
        const fromJson = yield* Effect.flatMap(Export.encode(exported), Export.parse)
        const fromJsonl = yield* Effect.flatMap(Export.encodeJsonl(exported), Export.parseJsonl)
        return { fromJson, fromJsonl }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(
        textOf(Export.historyOf(out.fromJsonl)),
        textOf(Export.historyOf(out.fromJson))
      )
    }))

  it.effect("two JSONL encodings of one session are byte-identical", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        const snapshot = yield* AgentSession.snapshot(session)
        const one = yield* Effect.flatMap(Export.of(snapshot, provenance), Export.encodeJsonl)
        const two = yield* Effect.flatMap(Export.of(snapshot, provenance), Export.encodeJsonl)
        return { one, two }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(out.one, out.two)
    }))

  it.effect("a picker reads only the first line", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        const exported = yield* Export.ofSession(session, provenance)
        const jsonl = yield* Export.encodeJsonl(exported)
        const first = jsonl.split("\n")[0] ?? ""
        // The rest of the file is truncated mid-message, the shape a crash
        // during append leaves behind.
        const truncated = `${first}\n{"role":"user"`
        return {
          full: yield* Export.headerOf(jsonl),
          firstLine: yield* Export.headerOf(first),
          truncated: yield* Export.headerOf(truncated)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.deepStrictEqual(out.firstLine, out.full)
      assert.deepStrictEqual(out.truncated, out.full)
      assert.strictEqual(out.full.version, Export.VERSION)
      assert.strictEqual(out.full.provenance.harnessVersion, provenance.harnessVersion)
    }))

  it.effect("refuses a JSONL version it does not know, by name (IE2)", () =>
    Effect.gen(function*() {
      const line = JSON.stringify({
        version: 99,
        exportedAt: 0,
        sessionId: "s",
        provenance: { harnessVersion: "x" },
        whatever: true
      })
      const failure = yield* Effect.flip(Export.headerOf(`${line}\n`))
      assert.strictEqual(failure.reason, "unsupported-version")
      assert.strictEqual(failure.found, 99)
      assert.include(failure.message, "99")
      assert.include(failure.message, String(Export.VERSION))
    }))

  it.effect("an empty file is not a JSONL export", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(Export.headerOf(""))
      assert.strictEqual(failure.reason, "malformed")
      assert.include(failure.message, "empty")
    }))

  it.effect("a header-only file is an empty conversation, not a malformation", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])
      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        const jsonl = yield* Effect.flatMap(
          Export.ofSession(session, provenance),
          Export.encodeJsonl
        )
        // Strip every commit, leave the header. A picker created this file
        // and nothing has been said yet -- that is an empty conversation,
        // not a malformation.
        const header = (jsonl.split("\n")[0] ?? "") + "\n"
        return { restored: yield* Export.parseJsonl(header) }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.strictEqual(Export.historyOf(out.restored).content.length, 0)
    }))

  it.effect("append adds messages without rewriting the header", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([TestLanguageModel.text("hi")])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("hello")
        const exported = yield* Export.ofSession(session, provenance)
        const jsonl = yield* Export.encodeJsonl(exported)
        const extra = Prompt.fromMessages([
          Prompt.userMessage({ content: [Prompt.textPart({ text: "and another thing" })] })
        ])
        const extended = yield* Export.append(jsonl, extra)
        return {
          before: yield* Export.headerOf(jsonl),
          after: yield* Export.headerOf(extended),
          restored: yield* Export.parseJsonl(extended)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.deepStrictEqual(out.after, out.before)
      assert.include(textOf(Export.historyOf(out.restored)), "hello")
      assert.include(textOf(Export.historyOf(out.restored)), "and another thing")
    }))

  it.effect("append refuses a file whose header is unreadable", () =>
    Effect.gen(function*() {
      const extra = Prompt.fromMessages([
        Prompt.userMessage({ content: [Prompt.textPart({ text: "x" })] })
      ])
      const failure = yield* Effect.flip(Export.append("not json\n", extra))
      assert.strictEqual(failure.reason, "malformed")
    }))

  /**
   * The case the header check was believed to cover and did not.
   *
   * A crash mid-append leaves one partial line, at the end -- which is exactly
   * the shape `parseJsonlRecovering` repairs, and it repairs it only there,
   * because that is the only place a crash can put one. Appending to such a
   * file terminated the partial line with a newline and buried it under the
   * new records, so a log that recovered every complete message before the
   * crash became one that parses to nothing at all. The header was intact
   * throughout, so nothing refused it.
   */
  it.effect("append refuses a log that ends in a crash-truncated line", () =>
    Effect.gen(function*() {
      const exported = yield* Export.of(
        {
          sessionId: "s1",
          history: Prompt.fromMessages([
            Prompt.userMessage({ content: [Prompt.textPart({ text: "one" })] }),
            Prompt.userMessage({ content: [Prompt.textPart({ text: "two" })] })
          ])
        },
        { harnessVersion: "test" }
      )
      const jsonl = yield* Export.encodeJsonl(exported)
      // A write that stopped part-way through the final record.
      const truncated = jsonl.slice(0, jsonl.length - 12)
      const extra = Prompt.fromMessages([
        Prompt.userMessage({ content: [Prompt.textPart({ text: "three" })] })
      ])

      const failure = yield* Effect.flip(Export.append(truncated, extra))
      assert.strictEqual(failure.reason, "malformed")

      // And the log is still what it was: the complete records recover, with
      // the partial line handed back rather than lost.
      const recovered = yield* Export.parseJsonlRecovering(truncated)
      assert.strictEqual(recovered.export.session.history.content.length, 1)
      assert.isTrue(Option.isSome(recovered.truncatedTail))

      // A complete log -- the same bytes plus the newline the crash never
      // reached -- is still extended.
      const extended = yield* Export.append(jsonl, extra)
      const restored = yield* Export.parseJsonl(extended)
      assert.strictEqual(Export.historyOf(restored).content.length, 3)
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
          // Seeded with what came before the model first spoke, then given
          // the prompts that came after. The two partition the user's side
          // exactly, which is what stops the opening prompt being submitted
          // twice -- `seedOf` used to keep only the first message of the
          // whole conversation and `promptsOf` re-sent it.
          const session = yield* AgentSession.make(agent, {
            history: Replay.seedOf(recorded)
          })
          for (const prompt of prompts) yield* session.prompt(prompt)
          return yield* session.history
        }).pipe(Effect.provide(layer), Effect.scoped)
      })

      // Both prompts, each as a whole message -- and the seed holds the
      // system context they were asked against, so nothing is sent twice.
      assert.strictEqual(prompts.length, 2)
      assert.include(textOf(prompts[0]!), "first question")
      assert.include(textOf(prompts[1]!), "second question")
      assert.include(textOf(Replay.seedOf(recorded)), "You answer briefly")
      assert.notInclude(textOf(Replay.seedOf(recorded)), "first question")
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

  /**
   * R79 -- a redaction that rewrites structure fails instead of shipping.
   *
   * `deep` rewrites every string, and some strings in an encoded transcript
   * are structure: a message's `"user"` role, a part's `"text"` type, an
   * `Option`'s tag. `literal("user")` is an entirely ordinary rule -- a
   * username is exactly the sort of thing someone redacts -- and it used to
   * produce a file that no longer parsed, silently. The old "does not corrupt"
   * test happened to pick a secret that was not a discriminator.
   */
  it.effect("a rule that matches a discriminator is refused, not written", () =>
    Effect.gen(function*() {
      const exported = yield* Export.of(
        {
          sessionId: "s1",
          history: Prompt.fromMessages([
            Prompt.userMessage({ content: [Prompt.textPart({ text: "hello" })] })
          ])
        },
        { harnessVersion: "test" }
      )

      /**
       * Every structural literal an encoded transcript might contain.
       *
       * The invariant is stated as a disjunction on purpose: some of these do
       * not appear in this particular transcript, so redacting them is a
       * no-op and the encode rightly succeeds. What must never happen is the
       * third case -- a file handed back that does not parse.
       */
      for (const structural of ["user", "text", "Some", "None", "assistant"]) {
        const outcome = yield* Effect.exit(
          Export.encode(exported, {
            redact: Redaction.make(Redaction.literal(structural))
          })
        )
        if (outcome._tag === "Success") {
          // Then it round-trips. Nothing was quietly broken.
          yield* Export.parse(outcome.value)
        } else {
          assert.include(String(outcome.cause), "rewrote structure")
        }
      }
      // And at least one of them really does hit structure, or this loop is
      // asserting nothing.
      const roleRedacted = yield* Effect.exit(
        Export.encode(exported, { redact: Redaction.make(Redaction.literal("user")) })
      )
      assert.strictEqual(roleRedacted._tag, "Failure")

      // And an ordinary content rule still works, and round-trips.
      const text = yield* Export.encode(exported, {
        redact: Redaction.make(Redaction.literal("hello"))
      })
      const back = yield* Export.parse(text)
      assert.isFalse(text.includes("hello"))
      assert.strictEqual(back.session.sessionId, "s1")
    }))

  /**
   * R83 -- what the extraction used to drop on the floor.
   *
   * Three losses, each silent:
   *
   * - `promptsOf` concatenated the text parts of a user message, so a prompt
   *   carrying a file or an image came back as its caption -- and a prompt
   *   with no text at all came back as nothing, taking its position in the
   *   sequence with it.
   * - An assistant message with neither text nor tool calls was dropped, so
   *   every later turn moved up one and the script answered the wrong prompt
   *   from that point on.
   * - `seedOf` kept the first message of the conversation, so a run that
   *   opened with a prompt had that prompt replayed twice.
   *
   * Built as a literal transcript: these are precisely the shapes a scripted
   * run does not produce.
   */
  it.effect("keeps non-text prompts, empty turns, and the seed boundary", () =>
    Effect.gen(function*() {
      const exported = yield* Export.of(
        {
          sessionId: "s1",
          history: Prompt.fromMessages([
            Prompt.systemMessage({ content: "be brief" }),
            Prompt.userMessage({
              content: [
                Prompt.textPart({ text: "look at this" }),
                Prompt.filePart({
                  mediaType: "text/plain",
                  data: new Uint8Array([1, 2, 3])
                })
              ]
            }),
            // A turn where the model said nothing at all.
            Prompt.assistantMessage({ content: [] }),
            Prompt.userMessage({ content: [Prompt.textPart({ text: "and now?" })] }),
            Prompt.assistantMessage({ content: [Prompt.textPart({ text: "done" })] })
          ])
        },
        { harnessVersion: "test" }
      )

      // Both export forms are real process boundaries, not just projections
      // over the in-memory value. Each must restore the bytes variant.
      const fullRoundTrip = yield* Effect.flatMap(
        Export.encode(exported),
        Export.parse
      )
      const jsonlRoundTrip = yield* Effect.flatMap(
        Export.encodeJsonl(exported),
        Export.parseJsonl
      )
      for (const roundTrip of [fullRoundTrip, jsonlRoundTrip]) {
        const message = roundTrip.session.history.content[1]
        assert.strictEqual(message?.role, "user")
        const data = message?.role === "user"
          ? message.content.flatMap((part) => part.type === "file" ? [part.data] : [])[0]
          : undefined
        assert.isTrue(data instanceof Uint8Array)
        if (data instanceof Uint8Array) {
          assert.deepStrictEqual(Array.from(data), [1, 2, 3])
        }
      }

      const prompts = Replay.promptsOf(fullRoundTrip)
      assert.strictEqual(prompts.length, 2)
      // The file survived: the prompt is the message, not its caption.
      const first = prompts[0]!.content[0]!
      assert.strictEqual(first.role, "user")
      if (first.role === "user") assert.strictEqual(first.content.length, 2)

      // The empty turn is still a turn, so the second answer stays second.
      const turns = Replay.turnsOf(fullRoundTrip)
      assert.strictEqual(turns.length, 2)
      assert.strictEqual(turns[0]?.text, "")
      assert.strictEqual(turns[1]?.text, "done")

      // The seed is the system message and nothing else: no prompt is in both.
      const seed = Replay.seedOf(fullRoundTrip)
      assert.strictEqual(seed.content.length, 1)
      assert.strictEqual(seed.content[0]?.role, "system")
    }))

  /**
   * A version bump protects an old reader from a new file. It is not licence
   * to refuse an old one.
   *
   * `VERSION` went to 2 for the `PromptWire` file-data representation, and a
   * strict `!==` made every export written before that unopenable -- including
   * the majority that contain no file part and so differ from a v2 export in
   * nothing but the number. `PromptWire.FileDataWireRead` accepts the untagged
   * form v1 wrote precisely so this would not happen, and the gate was
   * throwing that away before the codec was ever consulted.
   *
   * The fixtures below are literal, not built from `Export.VERSION`. A test
   * written against the constant it is testing follows the next bump
   * automatically and can never detect a compatibility break -- which is why
   * nothing here caught it.
   */
  describe("reading older versions", () => {
    const v1Envelope = {
      version: 1,
      exportedAt: 0,
      session: { sessionId: "old-session", history: { content: [] } },
      provenance: {
        harnessVersion: "0.0.0-test",
        model: { provider: "test", modelId: "scripted" },
        tools: ["read_file", "bash"]
      }
    }

    it.effect("reads a v1 export written before the PromptWire rollout", () =>
      Effect.gen(function*() {
        const restored = yield* Export.decode(v1Envelope)
        assert.strictEqual(restored.version, 1)
        assert.strictEqual(restored.session.sessionId, "old-session")
      }))

    it.effect("reads a v1 export carrying an untagged file part", () =>
      Effect.gen(function*() {
        // v1 wrote file data as a bare string, with no runtime-variant tag.
        const restored = yield* Export.decode({
          ...v1Envelope,
          session: {
            sessionId: "old-session",
            history: {
              content: [{
                role: "user",
                content: [{
                  type: "file",
                  mediaType: "text/plain",
                  data: "legacy-untagged-payload"
                }]
              }]
            }
          }
        })
        const message = restored.session.history.content[0]
        assert.strictEqual(message?.role, "user")
        if (message?.role !== "user") return
        const part = message.content[0]
        assert.strictEqual(part?.type, "file")
        if (part?.type !== "file") return
        // The variant is unrecoverable, so it stays a string -- readable, which
        // is the whole point, rather than refused.
        assert.strictEqual(part.data, "legacy-untagged-payload")
      }))

    it.effect("reads a v1 JSONL export through the same gate", () =>
      Effect.gen(function*() {
        const header = JSON.stringify({
          version: 1,
          exportedAt: 0,
          sessionId: "old-session",
          provenance: v1Envelope.provenance
        })
        const restored = yield* Export.parseJsonl(`${header}\n`)
        assert.strictEqual(restored.version, 1)
        assert.strictEqual(restored.session.sessionId, "old-session")
      }))

    it.effect("still refuses a version from the future, by name", () =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          Export.decode({ ...v1Envelope, version: Export.VERSION + 1 })
        )
        assert.strictEqual(failure.reason, "unsupported-version")
        assert.strictEqual(failure.found, Export.VERSION + 1)
        // Both bounds in the message, so a reader knows to upgrade rather than
        // to go looking for a bug in their file.
        assert.include(failure.message, String(Export.VERSION))
        assert.include(failure.message, String(Export.MINIMUM_READABLE_VERSION))
      }))

    it.effect("refuses a version below the readable floor", () =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          Export.decode({
            ...v1Envelope,
            version: Export.MINIMUM_READABLE_VERSION - 1
          })
        )
        assert.strictEqual(failure.reason, "unsupported-version")
      }))
  })

  /**
   * The JSONL form is the append-only commit log, so the one corruption a
   * crash actually produces is a partial final line. Failing the whole file
   * for it discards every complete message before it, which is the opposite of
   * what putting the header first was for.
   *
   * A bad line anywhere else is not a shape a crash makes -- an interrupted
   * append cannot corrupt a line it already flushed -- so that still fails.
   */
  describe("recovering a crash-truncated JSONL log", () => {
    const logWithMessages = Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text("first"),
        TestLanguageModel.text("second")
      ])
      return yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("one")
        yield* session.prompt("two")
        const exported = yield* Export.ofSession(session, provenance)
        return yield* Export.encodeJsonl(exported)
      }).pipe(Effect.provide(layer), Effect.scoped)
    })

    it.effect("keeps every complete message before the partial tail", () =>
      Effect.gen(function*() {
        const jsonl = yield* logWithMessages
        const whole = yield* Export.parseJsonl(jsonl)
        const truncated = `${jsonl}{"role":"user","content":[{"type":"te`

        const recovered = yield* Export.parseJsonlRecovering(truncated)
        assert.isTrue(
          Option.isSome(recovered.truncatedTail),
          "the dropped text is reported, not silently discarded"
        )
        assert.strictEqual(
          recovered.export.session.history.content.length,
          whole.session.history.content.length,
          "every message written before the crash survives"
        )
        assert.deepStrictEqual(
          recovered.export.session.history,
          whole.session.history
        )
      }))

    it.effect("a clean log reports no truncation", () =>
      Effect.gen(function*() {
        const jsonl = yield* logWithMessages
        const clean = yield* Export.parseJsonlRecovering(jsonl)
        assert.isTrue(Option.isNone(clean.truncatedTail))
      }))

    it.effect("still fails on a bad line in the middle", () =>
      Effect.gen(function*() {
        const jsonl = yield* logWithMessages
        const lines = jsonl.split("\n").filter((line) => line.length > 0)
        assert.isAtLeast(lines.length, 3, "need a header and two messages")
        // Corrupt a line that is not the last, and terminate the file properly
        // so the truncation path cannot claim it.
        const corrupted = [lines[0], `{"role":"user"`, ...lines.slice(2)]
          .join("\n")
          .concat("\n")
        const failure = yield* Effect.flip(Export.parseJsonl(corrupted))
        assert.strictEqual(failure.reason, "malformed")
      }))

    it.effect("a partial line is not recovered when the file ends in a newline", () =>
      Effect.gen(function*() {
        const jsonl = yield* logWithMessages
        // A completed append always terminates its line, so a trailing newline
        // means the bad line was flushed, not interrupted.
        const failure = yield* Effect.flip(
          Export.parseJsonl(`${jsonl}{"role":"user"\n`)
        )
        assert.strictEqual(failure.reason, "malformed")
      }))

    it.effect("names the file line a bad message is on, counting blanks", () =>
      Effect.gen(function*() {
        const jsonl = yield* logWithMessages
        const lines = jsonl.split("\n").filter((line) => line.length > 0)
        // A blank line before the corrupt one: the reported number has to be
        // the line in the file, not an index into the filtered array.
        const withBlank = [lines[0], "", `{"role":"user"`, ...lines.slice(2)]
          .join("\n")
          .concat("\n")
        const failure = yield* Effect.flip(Export.parseJsonl(withBlank))
        assert.include(failure.message, "line 3")
      }))
  })
})
