import { assert, describe, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"
import { readFile } from "node:fs/promises"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"
import { Compaction } from "../src/compaction/index.js"
import { Failpoints } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Item 60d: a fresh window as a compaction decision.
 *
 * The model asks with `new_context`; the tool's only job is to put the request
 * into canonical history as its result, and the controller's transform reads
 * it back from there before the next turn. The observable in most rows is the
 * *prompt the model was actually sent* on the turn after the request, from
 * the fake model's recorder: what survived, what was gone, and what marked the
 * seam. A rollover that did nothing would leave the request's own tool result
 * in that prompt, and the first row would say so.
 */

const Ping = Tool.make("ping", { parameters: Schema.Struct({}), success: Schema.String })
const ping = Agent.tool(Ping, () => Effect.succeed("pong"))
const usage = (tokens: number) => ({ input: tokens, output: 0 })

const systemTexts = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) => (message.role === "system" ? [message.content] : []))

const toolResultNames = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.name] : []))
      : []
  )

const messageCounter = () =>
  Compaction.controller({
    policy: Compaction.whenLongerThan(50, { retain: 4 }),
    summarise: () => Effect.succeed("never asked")
  })

/** Subscribe to a controller's events; `yield* events` afterwards reads what has arrived so far. */
const collect = (events: Stream.Stream<Compaction.CompactionEvent>) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<Array<Compaction.CompactionEvent>>([])
    yield* Effect.forkScoped(Stream.runForEach(events, (event) => Ref.update(seen, (all) => [...all, event])))
    yield* Effect.yieldNow
    return { read: Effect.andThen(Effect.yieldNow, Ref.get(seen)) }
  }).pipe(Effect.map(({ read }) => read))

describe("a fresh window as a compaction decision", () => {
  it.effect("a new_context result in history rolls the window over before the next turn", () =>
    Effect.gen(function* () {
      const compaction = yield* messageCounter()
      const events = yield* collect(compaction.events)
      const agent = Agent.make({
        instructions: "Be terse.",
        tools: [compaction.tools.newContext, ping],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(4)
      })
      const { layer, recorder } = yield* FakeModel.script([
        { toolCalls: [{ id: "p1", name: "ping", params: {} }] },
        { toolCalls: [{ id: "n1", name: "new_context", params: { handoff: "Resume by pinging once more." } }] },
        { text: "done" }
      ])
      const checkpoint = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          yield* session.prompt("go")
          return yield* compaction.checkpoint(session.id)
        })
      ).pipe(Effect.provide(layer))

      const prompts = yield* recorder.prompts
      assert.strictEqual(prompts.length, 3)
      const before = prompts[1]!
      const after = prompts[2]!
      // The turn that asked still saw everything: the ping exchange included.
      assert.deepStrictEqual(toolResultNames(before), ["ping"])
      // The turn after saw the instructions, the marker with the handoff, and
      // nothing that came before the request: not the ping, not the request.
      assert.deepStrictEqual(toolResultNames(after), [])
      assert.deepStrictEqual(systemTexts(after), [
        "Be terse.",
        "Context window 1: the conversation before this point was cleared. " +
          "Handoff note from the previous window:\n\nResume by pinging once more."
      ])
      assert.deepStrictEqual(FakeModel.roles(after), ["system", "system"])

      // The decision was recorded as a checkpoint of the rollover kind, and
      // announced under its own trigger with the same checkpoint.
      assert.isTrue(Option.isSome(checkpoint))
      if (Option.isSome(checkpoint) && Compaction.isRollover(checkpoint.value)) {
        assert.strictEqual(checkpoint.value.window, 1)
        assert.deepStrictEqual(checkpoint.value.handoff, Option.some("Resume by pinging once more."))
        // Instructions, prompt, ping call, ping result, request call, request result.
        assert.strictEqual(checkpoint.value.coveredThrough, 6)
        assert.deepStrictEqual(checkpoint.value.tokensBefore, Option.none())
      } else assert.fail("expected a rollover checkpoint")
      const completed = (yield* events).filter((event) => event._tag === "CompactionCompleted")
      assert.deepStrictEqual(completed.map((event) => event.trigger), ["requested"])
      if (completed[0]?._tag === "CompactionCompleted") {
        assert.deepStrictEqual(completed[0].checkpoint, Option.getOrThrow(checkpoint))
      }
    })
  )

  it.effect("a second request starts window 2, and the first window's marker does not survive it", () =>
    Effect.gen(function* () {
      const compaction = yield* messageCounter()
      const agent = Agent.make({
        instructions: "Be terse.",
        tools: [compaction.tools.newContext, ping],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(6)
      })
      const { layer, recorder } = yield* FakeModel.script([
        { toolCalls: [{ id: "n1", name: "new_context", params: { handoff: "first" } }] },
        { toolCalls: [{ id: "p1", name: "ping", params: {} }] },
        { toolCalls: [{ id: "n2", name: "new_context", params: {} }] },
        { text: "done" }
      ])
      const checkpoint = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          yield* session.prompt("go")
          return yield* compaction.checkpoint(session.id)
        })
      ).pipe(Effect.provide(layer))

      const prompts = yield* recorder.prompts
      assert.strictEqual(prompts.length, 4)
      assert.deepStrictEqual(systemTexts(prompts[1]!), [
        "Be terse.",
        "Context window 1: the conversation before this point was cleared. Handoff note from the previous window:\n\nfirst"
      ])
      // Window 2 says so, carries no handoff, and window 1's marker is gone
      // with the rest: a marker is a projection, never a canonical message.
      assert.deepStrictEqual(systemTexts(prompts[3]!), [
        "Be terse.",
        "Context window 2: the conversation before this point was cleared."
      ])
      assert.deepStrictEqual(toolResultNames(prompts[3]!), [])
      if (Option.isSome(checkpoint) && Compaction.isRollover(checkpoint.value)) {
        assert.strictEqual(checkpoint.value.window, 2)
        assert.deepStrictEqual(checkpoint.value.handoff, Option.none())
      } else assert.fail("expected a rollover checkpoint")
    })
  )

  it.effect("a request the checkpoint already covers is not acted on again", () =>
    Effect.gen(function* () {
      // The transform reads only the uncovered tail. After the rollover, the
      // request sits behind `coveredThrough`; two more turns pass with no new
      // request and nothing else is recorded. Without that bound, every turn
      // after a request would roll over again.
      const compaction = yield* messageCounter()
      const events = yield* collect(compaction.events)
      const agent = Agent.make({
        tools: [compaction.tools.newContext, ping],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(6)
      })
      const { layer } = yield* FakeModel.script([
        { toolCalls: [{ id: "n1", name: "new_context", params: {} }] },
        { toolCalls: [{ id: "p1", name: "ping", params: {} }] },
        { toolCalls: [{ id: "p2", name: "ping", params: {} }] },
        { text: "done" }
      ])
      const checkpoints = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          yield* session.prompt("go")
          const first = yield* compaction.checkpoint(session.id)
          yield* session.prompt("again")
          const second = yield* compaction.checkpoint(session.id)
          return [first, second] as const
        })
      ).pipe(Effect.provide(layer))
      assert.deepStrictEqual(checkpoints[1], checkpoints[0])
      assert.deepStrictEqual((yield* events).map((event) => event._tag), ["CompactionCompleted"])
    })
  )

  it.effect("a rollover clears the model's context, not the run's budget", () =>
    Effect.gen(function* () {
      // Their `newContext` resets both; ours never touches `Budget`, which
      // meters the run. The spend after a rollover is the sum of every turn.
      const compaction = yield* messageCounter()
      const agent = Agent.make({
        tools: [compaction.tools.newContext, ping],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(4)
      })
      const { layer } = yield* FakeModel.script([
        { toolCalls: [{ id: "p1", name: "ping", params: {} }], usage: usage(100) },
        { toolCalls: [{ id: "n1", name: "new_context", params: {} }], usage: usage(50) },
        { text: "done", usage: usage(7) }
      ])
      const spent = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          yield* session.prompt("go")
          return yield* (yield* Budget.Budget).spent
        })
      ).pipe(Effect.provide(Layer.merge(layer, Budget.layer)))
      assert.strictEqual(spent, 157)
    })
  )

  it.effect("under pressure a summary that cannot fit rolls over instead, only when asked to", () =>
    Effect.gen(function* () {
      // The shape of `Compaction.test.ts`'s giving-up row: per-message cost
      // 1 alone, 3 each otherwise; the summary never fits. The default keeps
      // that failure. `onCannotHelp: "rollover"` turns it into a window cut at
      // the last user message, so the turn being answered is what survives.
      const build = (onCannotHelp: "fail" | "rollover") =>
        Compaction.controller({
          policy: Compaction.tokens({
            budget: { contextWindow: 6, reserveTokens: 1, keepRecentTokens: 2 },
            estimate: (prompt) => Effect.succeed(prompt.content.length === 1 ? 1 : prompt.content.length * 3)
          }),
          summarise: () => Effect.succeed("a summary far too large for the budget"),
          onCannotHelp
        })
      const run = (compaction: Effect.Success<ReturnType<typeof build>>) =>
        Effect.gen(function* () {
          const { layer, recorder } = yield* FakeModel.script([FakeModel.text("one"), FakeModel.text("two")])
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* AgentSession.make(
                Agent.make({ contextTransform: compaction.transform, loop: AgentLoop.bounded(1) })
              )
              yield* session.prompt("a")
              yield* session.prompt("b")
              return yield* compaction.checkpoint(session.id)
            })
          ).pipe(Effect.exit, Effect.provide(layer))
          return { exit, prompts: yield* recorder.prompts }
        })

      const failing = yield* run(yield* build("fail"))
      assert.isTrue(Exit.isFailure(failing.exit))
      if (Exit.isFailure(failing.exit)) {
        assert.instanceOf(Cause.squash(failing.exit.cause), Compaction.CompactionCannotHelpError)
      }

      const rolling = yield* build("rollover")
      const events = yield* collect(rolling.events)
      const rolled = yield* run(rolling)
      assert.isTrue(Exit.isSuccess(rolled.exit), Exit.isFailure(rolled.exit) ? Cause.pretty(rolled.exit.cause) : "")
      if (Exit.isSuccess(rolled.exit) && Option.isSome(rolled.exit.value) && Compaction.isRollover(rolled.exit.value.value)) {
        const checkpoint = rolled.exit.value.value
        // History was "a", "one", "b": the cut keeps "b", the prompt being answered.
        assert.strictEqual(checkpoint.coveredThrough, 2)
        assert.deepStrictEqual(checkpoint.handoff, Option.none())
        assert.strictEqual(checkpoint.window, 1)
        assert.deepStrictEqual(checkpoint.tokensBefore, Option.some(9))
      } else assert.fail("expected the fallback to record a rollover")
      assert.deepStrictEqual(FakeModel.userTexts(rolled.prompts[1]!), ["b"])
      assert.deepStrictEqual(FakeModel.roles(rolled.prompts[1]!), ["system", "user"])
      // Announced as a completed automatic compaction -- the kind is on the
      // checkpoint, not the event -- and not as a failure: nothing failed.
      assert.deepStrictEqual(
        (yield* events).map((event) => [event._tag, event.trigger]),
        [["CompactionStarted", "automatic"], ["CompactionCompleted", "automatic"]]
      )
    })
  )

  it("a summary checkpoint recorded before rollovers existed still decodes, as a summary", async () => {
    // `test/fixtures/compaction-checkpoint.json`: a persisted checkpoint
    // encoded at `d6e4a69`, before `Checkpoint` became a union. It has no
    // `kind`, and that absence is what names it a `Summary` now. A store
    // written by the previous release keeps its summaries.
    const bytes = await readFile(new URL("./fixtures/compaction-checkpoint.json", import.meta.url), "utf8")
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(Compaction.Checkpoint))(JSON.parse(bytes))
    assert.isTrue(Compaction.isSummary(decoded))
    if (Compaction.isSummary(decoded)) {
      assert.strictEqual(decoded.coveredThrough, 6)
      assert.strictEqual(decoded.summary, "The user asked for a deployment plan; three services were inspected.")
      assert.deepStrictEqual(decoded.tokensAfter, Option.some(900))
    }
    // And it round-trips to the same bytes: the summary's wire shape did not move.
    const encoded = Schema.encodeSync(Schema.toCodecJson(Compaction.Checkpoint))(decoded)
    assert.deepStrictEqual(encoded, JSON.parse(bytes))
  })

  it.effect("new_context is idempotent, and says so", () =>
    Effect.gen(function* () {
      assert.isTrue(Context.get(Compaction.NewContext.annotations, Tool.Idempotent))
      // Its handler hands the request straight back: that echo is the record.
      const compaction = yield* messageCounter()
      const agent = Agent.make({
        tools: [compaction.tools.newContext],
        contextTransform: compaction.transform,
        loop: AgentLoop.bounded(2)
      })
      const { layer, recorder } = yield* FakeModel.script([
        { toolCalls: [{ id: "n1", name: "new_context", params: { handoff: "note" } }] },
        { text: "done" }
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent)
          yield* session.prompt("go")
        })
      ).pipe(Effect.provide(layer))
      // The recorded result is the request itself, decodable as one.
      const history = (yield* recorder.prompts)[1]!
      assert.deepStrictEqual(toolResultNames(history), [])
      assert.deepStrictEqual(systemTexts(history), [
        "Context window 1: the conversation before this point was cleared. Handoff note from the previous window:\n\nnote"
      ])
    })
  )

  it.effect("a crash on either side of the checkpoint write, and the next pass ends in the same window", () =>
    Effect.gen(function* () {
      /**
       * The two boundaries `Compaction.failpoints` declares. A crash before
       * the write leaves the request uncovered in history, so the next pass
       * finds it and rolls over then; a crash after it leaves the checkpoint
       * saved, so the next pass loads it and the request is already covered.
       * Either way the second pass sends the model window 1 with the handoff
       * and nothing before it, and exactly one rollover is on record.
       * `covered` dies by name if the driver stops reaching a boundary.
       */
      const rows = yield* Failpoints.covered(Compaction.failpoints, (location) =>
        Effect.gen(function* () {
          const compaction = yield* messageCounter()
          const agent = Agent.make({
            instructions: "Be terse.",
            tools: [compaction.tools.newContext],
            contextTransform: compaction.transform,
            loop: AgentLoop.bounded(3)
          })
          const { layer, recorder } = yield* FakeModel.script([
            { toolCalls: [{ id: "n1", name: "new_context", params: { handoff: "carry on" } }] },
            { text: "crashed before this" },
            { text: "done" }
          ])
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* AgentSession.make(agent)
              const crashed = yield* Effect.exit(session.prompt("go"))
              assert.isTrue(Exit.isFailure(crashed), `the pass did not stop at ${location}`)
              // The next pass: no crash. The session's history still holds the request.
              yield* session.prompt("again")
              const checkpoint = yield* compaction.checkpoint(session.id)
              const prompts = yield* recorder.prompts
              const last = prompts[prompts.length - 1]!
              assert.deepStrictEqual(systemTexts(last), [
                "Be terse.",
                "Context window 1: the conversation before this point was cleared. Handoff note from the previous window:\n\ncarry on"
              ])
              assert.deepStrictEqual(toolResultNames(last), [])
              assert.deepStrictEqual(FakeModel.userTexts(last), ["again"])
              if (Option.isSome(checkpoint) && Compaction.isRollover(checkpoint.value)) {
                return checkpoint.value.window
              }
              return assert.fail(`no rollover on record after a crash at ${location}`)
            })
          ).pipe(Effect.provide(layer))
        }))
      assert.deepStrictEqual(rows.map((row) => row.location), Compaction.failpoints.all)
      assert.isTrue(rows.every((row) => row.reached >= 1))
      const windows = rows.map((row) =>
        Exit.isSuccess(row.exit) ? row.exit.value : `${row.location}: ${Cause.pretty(row.exit.cause)}`
      )
      assert.deepStrictEqual(windows, [1, 1])
    })
  )
})
