import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import { Compaction } from "../src/compaction/index.js"
import * as ToolContracts from "../src/durable/ToolContracts.js"
import * as ToolExposure from "../src/ToolExposure.js"

/**
 * The library's own control tools, frozen by contract digest (item 107,
 * T15.3).
 *
 * A durable journal records these tools' calls and results like any other,
 * so changing one's parameters or result shape makes every recorded run
 * that used it unreplayable -- refused by name, but refused. This test is
 * where that change is noticed: a digest that moved fails here until its
 * author either (a) annotates the tool with `ToolContracts.CompatibleWith`
 * and the old digest, when the new contract reads what was recorded, so
 * recorded runs finish; or (b) accepts that they will be refused, and says
 * so in the commit. Then update the fixture.
 */

const controlTools = {
  new_context: Compaction.NewContext,
  search_context: Compaction.SearchContext,
  read_context: Compaction.ReadContext,
  context_remaining: Compaction.ContextRemaining,
  discover_tools: ToolExposure.DiscoverTools
}

const fixture = "test/fixtures/control-tool-digests.json"

describe("control tool contracts are frozen (item 107)", () => {
  it.effect("each built-in control tool's digest is the one recorded", () =>
    Effect.gen(function*() {
      const current: Record<string, string> = {}
      for (const [name, tool] of Object.entries(controlTools)) current[name] = yield* ToolContracts.digestOf(tool)
      const frozen = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(JSON.parse(readFileSync(fixture, "utf8")))
      assert.deepStrictEqual(
        current,
        frozen,
        "a control tool's contract changed: declare the old digest compatible (ToolContracts.CompatibleWith) " +
          "if the new contract reads what was recorded, or accept that recorded runs are refused -- then update " +
          fixture
      )
    }))
})
