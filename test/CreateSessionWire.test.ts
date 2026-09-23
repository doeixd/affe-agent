/**
 * The create-session wire, recorded.
 *
 * `fixtures/create-session-request.json` holds an unseeded request -- the
 * shape every client sent before `history` existed -- and a seeded one. The
 * unseeded request is byte-identical to what it always was, so an old client
 * is still understood; the seeded one carries its history in the prompt
 * wire's encoding, the same codec a prompt's input uses. A change to either
 * expectation is a wire change and should be treated as one.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as fs from "node:fs"
import { AgentProtocol } from "../src/client/index.js"

const fixture = JSON.parse(fs.readFileSync("test/fixtures/create-session-request.json", "utf8")) as {
  readonly plain: unknown
  readonly seeded: unknown
}

const codec = Schema.toCodecJson(AgentProtocol.CreateSessionRequest)

describe("the create-session wire", () => {
  it.effect("an unseeded request is unchanged, and a seeded one carries its history", () =>
    Effect.gen(function* () {
      const plain = yield* Schema.encodeEffect(codec)({
        requestId: AgentProtocol.RequestId.make("c-1"),
        sessionId: AgentProtocol.SessionId.make("s-1")
      })
      assert.strictEqual(JSON.stringify(plain), JSON.stringify(fixture.plain))

      const seeded = yield* Schema.encodeEffect(codec)({
        requestId: AgentProtocol.RequestId.make("c-2"),
        sessionId: AgentProtocol.SessionId.make("s-2"),
        history: Prompt.make([
          { role: "system", content: "branch system" },
          { role: "user", content: [{ type: "text", text: "earlier" }] }
        ])
      })
      assert.strictEqual(JSON.stringify(seeded), JSON.stringify(fixture.seeded))
    }))

  it.effect("both recorded requests decode, and the unseeded one has no history", () =>
    Effect.gen(function* () {
      const plain = yield* Schema.decodeUnknownEffect(codec)(fixture.plain)
      assert.isUndefined(plain.history)
      const seeded = yield* Schema.decodeUnknownEffect(codec)(fixture.seeded)
      const roles = Option.fromNullishOr(seeded.history).pipe(
        Option.map((history) => history.content.map((message) => message.role))
      )
      assert.deepStrictEqual(roles, Option.some(["system", "user"]))
    }))
})
