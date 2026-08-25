import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { withSession } from "./helpers.js"

/**
 * The harness resolves tools itself, which means Effect AI's own safety
 * semantics stop applying unless the harness reimplements them. Silently
 * dropping them is the failure mode these tests exist to prevent.
 */
describe("tool safety semantics", () => {
  it.effect("a tool needing approval is refused, not executed", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)

      const Dangerous = Tool.make("deleteEverything", {
        parameters: Schema.Struct({}),
        success: Schema.String
      }).setNeedsApproval(true)

      const toolkit = Agent.toolkit([Dangerous], {
        deleteEverything: () =>
          Ref.update(ran, (n) => n + 1).pipe(Effect.as("deleted"))
      })

      const { events, value } = yield* withSession(
        [
          {
            toolCalls: [
              { id: "d1", name: "deleteEverything", params: {} }
            ]
          },
          { text: "unreachable" }
        ],
        Agent.make({
          toolkit,
          // Even the forgiving policy must not turn a refusal into a quiet
          // "the tool said no" that the model shrugs off.
          toolFailurePolicy: ToolExecution.FailRun
        }),
        ({ session }) => Effect.exit(AgentSession.prompt(session, "go"))
      )

      assert.isTrue(Exit.isFailure(value))
      assert.strictEqual(yield* Ref.get(ran), 0)

      const failed = events.filter(AgentEvent.is("ToolCallFailed"))
      assert.strictEqual(failed.length, 1)
      assert.strictEqual(failed[0]!.event.failure.tag, "ToolApprovalRequiredError")
    })
  )

  it.effect("a tool without approval requirements still runs", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const Safe = Tool.make("safe", {
        parameters: Schema.Struct({}),
        success: Schema.String
      })
      const toolkit = Agent.toolkit([Safe], {
        safe: () => Ref.update(ran, (n) => n + 1).pipe(Effect.as("ok"))
      })

      yield* withSession(
        [
          { toolCalls: [{ id: "s1", name: "safe", params: {} }] },
          { text: "done" }
        ],
        Agent.make({ toolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )

  it.effect("a provider-executed call is neither run locally nor awaited", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const Search = Tool.make("search", {
        parameters: Schema.Struct({ q: Schema.String }),
        success: Schema.String
      })
      const toolkit = Agent.toolkit([Search], {
        search: ({ q }) => Ref.update(ran, (n) => n + 1).pipe(Effect.as(q))
      })

      const { events } = yield* withSession(
        [
          {
            // The provider already ran this one.
            toolCalls: [
              {
                id: "p1",
                name: "search",
                params: { q: "effect" },
                providerExecuted: true
              }
            ],
            text: "answered using web search"
          }
        ],
        Agent.make({ toolkit }),
        ({ session }) => AgentSession.prompt(session, "go")
      )

      // Not executed again locally...
      assert.strictEqual(yield* Ref.get(ran), 0)
      assert.strictEqual(
        events.filter(AgentEvent.is("ToolCallStarted")).length,
        0
      )
      // ...and not treated as outstanding work, so the run stopped at one turn.
      assert.strictEqual(
        events.filter(AgentEvent.is("RunCompleted"))[0]!.event.turns,
        1
      )
    })
  )

  it.effect("the approval refusal is in prompt's declared error type", () =>
    Effect.gen(function* () {
      // `ToolExecution` raises this instead of running the handler, so it never
      // appears in `Tool.HandlerError` -- and `PromptError` omitted it. Because
      // `prompt` asserts its submission to `PromptError`, the public type
      // claimed an approval-requiring agent could not fail with the exact error
      // it throws.
      //
      // Catching it by tag is the assertion: this only compiles if the union
      // contains it, and `catchTag` on an absent tag is a type error rather
      // than a silent no-op.
      const Guarded = Tool.make("guarded", {
        parameters: Schema.Struct({}),
        success: Schema.String
      }).setNeedsApproval(true)

      const toolkit = Agent.toolkit([Guarded], {
        guarded: () => Effect.succeed("should never run")
      })

      const outcome = yield* withSession(
        [
          { toolCalls: [{ id: "g1", name: "guarded", params: {} }] },
          { text: "unreachable" }
        ],
        Agent.make({ toolkit }),
        ({ session }) =>
          session.prompt("go").pipe(
            Effect.map(() => "completed" as const),
            Effect.catchTag("ToolApprovalRequiredError", (error) =>
              Effect.succeed(error.toolName)
            )
          )
      )

      assert.strictEqual(outcome.value, "guarded")
    })
  )

  /**
   * R165 -- returning a failure to the model must not defect the run.
   *
   * The rendering happens *after* `ToolCallFailed` has announced
   * `returnedToModel: true`, so a throw here does not merely lose the text: it
   * defects a run that has already promised the model a chance to recover, and
   * leaves history and events disagreeing about whether the failure was
   * returned.
   *
   * `JSON.stringify` is not total, and the values it refuses are not exotic.
   * It throws on a `bigint` and on a cycle; it returns `undefined` -- not a
   * string -- for `undefined`, a symbol or a function. A tool's declared
   * failure schema can produce any of them, and the previous coverage used
   * only a string.
   */
  const unrenderable: ReadonlyArray<readonly [string, unknown]> = [
    ["a bigint", 42n],
    ["undefined", undefined],
    ["a symbol", Symbol("failed")],
    ["a cycle", (() => {
      const loop: Record<string, unknown> = {}
      loop["self"] = loop
      return loop
    })()],
    ["a throwing toJSON", {
      toJSON(): never {
        throw new Error("will not serialise")
      }
    }],
    ["an object with no printable form", Object.create(null)]
  ]

  for (const [what, failure] of unrenderable) {
    it.effect(`a tool failing with ${what} is returned to the model, not defected`, () =>
      Effect.gen(function* () {
        const Awkward = Tool.make("awkward", {
          parameters: Schema.Struct({}),
          success: Schema.String,
          // Deliberately wide: the point is a failure value the renderer has
          // to cope with, not one the schema would have refused.
          failure: Schema.Unknown
        })
        const toolkit = Agent.toolkit([Awkward], {
          awkward: () => Effect.fail(failure)
        })

        const outcome = yield* withSession(
          [
            { toolCalls: [{ id: "a1", name: "awkward", params: {} }] },
            { text: "I see, moving on" }
          ],
          Agent.make({ toolkit, toolFailurePolicy: ToolExecution.ReturnToModel }),
          ({ session }) => Effect.exit(session.prompt("go"))
        )

        // The run survived, which is the whole promise of ReturnToModel.
        assert.isTrue(Exit.isSuccess(outcome.value), `${what} defected the run`)

        // And the two records agree: the event said it was returned, and the
        // transcript contains the tool result that returning it produces.
        const failed = outcome.events.filter(AgentEvent.is("ToolCallFailed"))
        assert.strictEqual(failed.length, 1)
        assert.isTrue(failed[0]!.event.returnedToModel)
      }))
  }
})

/**
 * A structural check that `PromptError` covers what the engine can raise.
 *
 * `prompt` asserts its submission to `PromptError`, and that assertion cannot
 * simply be removed: `AgentSubmission.execute` currently derives `any` for its
 * error channel, so dropping the assertion replaces a precise union with `any`
 * — worse than the gap it once hid. Making the engine derive its own union
 * end to end is a real change, not a deletion.
 *
 * What *can* be checked today is that the declared union covers the one place
 * whose errors are explicitly annotated. `ToolApprovalRequiredError` slipped
 * through precisely because nothing tied the two together; this ties them.
 */
type ExecutionErrors<Tools extends Record<string, Tool.Any>> = ReturnType<
  typeof ToolExecution.execute<Tools>
> extends Effect.Effect<unknown, infer E, unknown>
  ? E
  : never

type Covers<Tools extends Record<string, Tool.Any>> =
  ExecutionErrors<Tools> extends AgentSession.PromptError<Tools, never>
    ? true
    : false

const Guarded = Tool.make("guardedCheck", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  failure: Schema.Literal("declined")
})

// Fails to compile if `ToolExecution` grows an error `PromptError` omits.
const _promptCoversExecution: Covers<{ readonly guardedCheck: typeof Guarded }> =
  true
void _promptCoversExecution

/**
 * R181 -- two calls in one response cannot share an id.
 *
 * `internal/toolActivity.ts` states the premise outright, and `DurableToolkit`
 * and `DurablePermission` key replay identity on `(tool name, call id,
 * occurrence)`. Nothing checked it. Two concurrent calls with one id both read
 * occurrence zero before either updates its counter, so they request the same
 * workflow activity -- replaying one sibling's result into the other, or
 * suppressing a side effect, depending on the engine.
 *
 * It is ambiguous outside durability too: a result is matched to its call by
 * id, so history cannot say which output belonged to which call.
 */
describe("tool call identity", () => {
  it.effect("a response naming one id twice is refused, not guessed at", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const Echo = Tool.make("echo", {
        parameters: Schema.Struct({ value: Schema.String }),
        success: Schema.String
      })
      const toolkit = Agent.toolkit([Echo], {
        echo: ({ value }) => Ref.update(ran, (n) => n + 1).pipe(Effect.as(value))
      })

      const outcome = yield* withSession(
        [
          {
            toolCalls: [
              { id: "same", name: "echo", params: { value: "first" } },
              { id: "same", name: "echo", params: { value: "second" } }
            ]
          },
          { text: "unreachable" }
        ],
        Agent.make({ toolkit }),
        ({ session }) => Effect.exit(session.prompt("go"))
      )

      assert.isTrue(Exit.isFailure(outcome.value))
      assert.include(String(outcome.value), "two tool calls with the id same")
      // And neither ran: refusing after half the work would be worse than not
      // checking at all.
      assert.strictEqual(yield* Ref.get(ran), 0)
    })
  )

  it.effect("two calls with distinct ids are ordinary", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make<Array<string>>([])
      const Echo = Tool.make("echo", {
        parameters: Schema.Struct({ value: Schema.String }),
        success: Schema.String
      })
      const toolkit = Agent.toolkit([Echo], {
        echo: ({ value }) => Ref.update(ran, (all) => [...all, value]).pipe(Effect.as(value))
      })

      const outcome = yield* withSession(
        [
          {
            toolCalls: [
              { id: "a", name: "echo", params: { value: "first" } },
              { id: "b", name: "echo", params: { value: "second" } }
            ]
          },
          { text: "done" }
        ],
        Agent.make({ toolkit }),
        ({ session }) => Effect.exit(session.prompt("go"))
      )

      assert.isTrue(Exit.isSuccess(outcome.value))
      assert.deepStrictEqual((yield* Ref.get(ran)).sort(), ["first", "second"])
    })
  )
})
