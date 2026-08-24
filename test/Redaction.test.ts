import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Export from "../src/export/Export.js"
import * as Redaction from "../src/redaction/Redaction.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * IE3 -- redaction is total where applied.
 *
 * The invariant is worded that way for a reason. A redactor that covers tool
 * results and misses the truncation banner quoting them has not reduced the
 * risk, it has hidden it: the reader now believes the file is safe. So the
 * tests below check for *any* occurrence anywhere in the artefact, not for the
 * fields somebody remembered.
 */

const SECRET = "sk-live-4f9a2c7e"

describe("Redaction", () => {
  it("replaces every occurrence, not the first", () => {
    const redaction = Redaction.make(Redaction.literal(SECRET))
    const text = `${SECRET} and again ${SECRET} and ${SECRET}`
    // A redactor that stops at the first match is worse than none, because it
    // looks like it worked.
    assert.notInclude(redaction.redact(text), SECRET)
  })

  it("a pattern without the global flag still replaces every match", () => {
    // The caller wrote `/…/` and means every occurrence. Honouring the flag
    // literally would leave the second one in the file.
    const redaction = Redaction.make(Redaction.pattern(/token=\w+/))
    const out = redaction.redact("token=aaa then token=bbb")
    assert.strictEqual(out, "[redacted] then [redacted]")
  })

  it("reaches into nested structures, arrays included", () => {
    const redaction = Redaction.make(Redaction.literal(SECRET))
    const out = Redaction.deep(
      {
        result: { stdout: `export KEY=${SECRET}` },
        notes: [`saw ${SECRET}`, { deeper: SECRET }]
      },
      redaction
    )
    assert.notInclude(JSON.stringify(out), SECRET)
  })

  it("leaves object keys alone", () => {
    const redaction = Redaction.make(Redaction.literal("path"))
    const out = Redaction.deep({ path: "path/to/file" }, redaction) as Record<string, unknown>
    // A key is structure. Rewriting one produces a document that no longer
    // decodes, which loses the data rather than protecting it.
    assert.deepStrictEqual(Object.keys(out), ["path"])
    assert.strictEqual(out.path, "[redacted]/to/file")
  })

  it("the shipped matchers do something, and do not pretend to be a scanner", () => {
    const bearer = Redaction.make(Redaction.bearerTokens)
    assert.strictEqual(
      bearer.redact("Authorization: Bearer abc123def456"),
      "Authorization: Bearer [redacted]"
    )

    const env = Redaction.make(Redaction.environmentSecrets)
    assert.strictEqual(env.redact("AWS_SECRET_KEY=hunter2"), "AWS_SECRET_KEY=[redacted]")

    // And plainly does not catch this, which is the honest half of the claim:
    // two matchers are two matchers.
    assert.include(env.redact(`the key is ${SECRET}`), SECRET)
  })

  it("does nothing by default", () => {
    assert.strictEqual(Redaction.none.redact(SECRET), SECRET)
  })

  it("one rule serves the tracer's hook and the exporter alike", () => {
    const redaction = Redaction.make(Redaction.literal(SECRET))
    // `Observability.RedactionPolicy.redact` is `(value) => unknown`, and its
    // span variant takes a key as well. Both come from the same rule, which is
    // why this module belongs to neither package.
    const hook = Redaction.asHook(redaction)
    const spanHook = Redaction.asSpanHook(redaction)
    assert.notInclude(JSON.stringify(hook({ params: { key: SECRET } })), SECRET)
    assert.notInclude(JSON.stringify(spanHook("parameters", [SECRET])), SECRET)
  })
})

// ---------------------------------------------------------------------------
// IE3 against a real transcript
// ---------------------------------------------------------------------------

/**
 * A tool whose result quotes its own input.
 *
 * Contrived on purpose: it puts the secret in the call parameters, in the
 * result, and in a banner that mentions both. That is what a `bash` call
 * reading an environment variable actually looks like, and it is where a
 * field-by-field redactor leaks.
 */
const runCommand = Tool.make("run_command", {
  description: "Run a command.",
  parameters: Schema.Struct({ command: Schema.String }),
  success: Schema.Struct({
    stdout: Schema.String,
    banner: Schema.String
  })
})

const agent = Agent.make({
  instructions: "You run commands.",
  loop: AgentLoop.bounded(4),
  toolkit: Agent.toolkit([runCommand], {
    run_command: ({ command }) =>
      Effect.succeed({
        stdout: `KEY=${SECRET}`,
        banner: `output of \`${command}\` truncated; full text saved`
      })
  })
})

describe("Export redaction (IE3)", () => {
  it.effect("a redacted export contains the secret nowhere at all", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        {
          toolCalls: [{
            id: "t1",
            name: "run_command",
            // In the parameters, which a redactor aimed at results misses.
            params: { command: `echo ${SECRET}` }
          }]
        },
        TestLanguageModel.text(`I saw ${SECRET} in the output.`)
      ])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt(`run echo ${SECRET}`)
        const exported = yield* Export.ofSession(session, {
          harnessVersion: "0.0.0-test"
        })
        return {
          plain: yield* Export.encode(exported),
          redacted: yield* Export.encode(exported, {
            redact: Redaction.make(Redaction.literal(SECRET))
          })
        }
      }).pipe(Effect.provide(layer), Effect.scoped)

      // The control: without redaction it is all there, in five places.
      assert.isAbove(out.plain.split(SECRET).length - 1, 4)

      // The invariant: not once, anywhere. Not in the user's message, the
      // assistant's text, the call parameters, the tool result, or the banner
      // that quotes the command.
      assert.notInclude(out.redacted, SECRET)
    }))

  it.effect("redaction does not corrupt the file", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text(`the key is ${SECRET}`)
      ])

      const out = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("tell me")
        const exported = yield* Export.ofSession(session, { harnessVersion: "0.0.0-test" })
        const text = yield* Export.encode(exported, {
          redact: Redaction.make(Redaction.literal(SECRET))
        })
        // A redactor that produced something unreadable would have lost the
        // transcript rather than protected it.
        return { text, parsed: yield* Export.parse(text) }
      }).pipe(Effect.provide(layer), Effect.scoped)

      assert.notInclude(out.text, SECRET)
      assert.isAbove(out.parsed.session.history.content.length, 0)
      assert.include(JSON.stringify(out.parsed.session.history), "[redacted]")
    }))

  it.effect("an export is unredacted unless asked, and says so", () =>
    Effect.gen(function*() {
      const { layer } = yield* TestLanguageModel.script([
        TestLanguageModel.text(`the key is ${SECRET}`)
      ])

      const text = yield* Effect.gen(function*() {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("tell me")
        const exported = yield* Export.ofSession(session, { harnessVersion: "0.0.0-test" })
        return yield* Export.encode(exported)
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Documented rather than implied. A caller should have to know that
      // nothing was removed, which is why the default is not a guess at one.
      assert.include(text, SECRET)
    }))
})
