/**
 * Slash commands (W2 `CommandRegistry`) as pure functions: a line is a
 * message or an action, `//` escapes, an unknown command is refused by name
 * rather than sent to the model, and partial lines suggest their commands.
 */
import { assert, describe, it } from "@effect/vitest"
import * as Commands from "../src/ui-core/Commands.js"

describe("slash commands", () => {
  it("a line without a slash is a message, and a blank one is nothing", () => {
    assert.deepStrictEqual(Commands.parse("  hello  "), { _tag: "Send", text: "hello" })
    assert.isUndefined(Commands.parse("   "))
  })

  it("each command parses to its action, in any case", () => {
    assert.deepStrictEqual(Commands.parse("/help"), { _tag: "Help" })
    assert.deepStrictEqual(Commands.parse("/RETRY"), { _tag: "Retry" })
    assert.deepStrictEqual(Commands.parse("/stop"), { _tag: "Stop" })
    assert.deepStrictEqual(Commands.parse("/model  alternate "), { _tag: "ContinueOn", model: "alternate" })
  })

  it("a command missing its argument, or one that does not exist, is refused -- never sent", () => {
    assert.strictEqual(Commands.parse("/model")?._tag, "Refused")
    const unknown = Commands.parse("/deploy now")
    assert.strictEqual(unknown?._tag, "Refused")
    assert.include(unknown?._tag === "Refused" ? unknown.reason : "", "/deploy")
  })

  it("// sends a message that starts with a slash", () => {
    assert.deepStrictEqual(Commands.parse("//etc/hosts is odd"), { _tag: "Send", text: "/etc/hosts is odd" })
  })

  it("a partial line suggests the commands it could become, and a message suggests none", () => {
    assert.deepStrictEqual(Commands.matching("/").map((c) => c.name), ["help", "retry", "stop", "model"])
    assert.deepStrictEqual(Commands.matching("/re").map((c) => c.name), ["retry"])
    assert.deepStrictEqual(Commands.matching("/model x"), [])
    assert.deepStrictEqual(Commands.matching("//"), [])
    assert.deepStrictEqual(Commands.matching("hello"), [])
  })
})
