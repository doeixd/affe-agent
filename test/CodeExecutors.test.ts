import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Ref, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodeMode, CodeTool } from "../src/code/index.js"
import { withSession } from "./helpers.js"

/**
 * The executor seam (`docs/plan-code-mode-executors.md` step 1).
 *
 * Two claims, and the second is the one that needed the widening: the
 * owned interpreter never suspends, and an executor that *can* suspend
 * has somewhere to say so -- state out to the host, a reason out to the
 * model, and settled work reused on the way back in.
 *
 * The stub executor here is not a toy standing in for a real one. It is
 * the shape a plan-compiling engine has (CallScript is the worked
 * example, step 4): pause, hand the host an opaque serialisable value,
 * continue from it in another process. Testing the seam against a real
 * engine would test the engine.
 */

const Echo = Tool.make("echo", {
  description: "Echo the text",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String
})

const groups = Effect.gen(function*() {
  const data = yield* Agent.toolkit([Echo], {
    echo: ({ text }) => Effect.succeed(text)
  })
  return { data }
})

/** What the stub executor persists. Opaque to everything above it. */
const SECRET_STATE = { cursor: 7, note: "opaque-executor-state" }

/**
 * An executor that suspends the first time and completes on resume.
 *
 * It calls the host's `invoke` before suspending, so the test can tell
 * the difference between "resumed" and "started again": a run that
 * re-executed from the top would call the tool twice.
 */
const suspendingOnce: CodeMode.CodeExecutor = {
  run: (_code, hooks) =>
    Effect.gen(function*() {
      if (hooks.resumeFrom === undefined) {
        yield* hooks.invoke(["data", "echo"], { text: "before" })
        return {
          _tag: "Suspended" as const,
          state: SECRET_STATE,
          reason: "waiting on the approval gate; resume when it is answered",
          logs: [["paused"]]
        }
      }
      return {
        _tag: "Completed" as const,
        result: Option.some({ resumedWith: hooks.resumeFrom }),
        logs: [["continued"]]
      }
    })
}

describe("code-mode executors", () => {
  it.effect("the owned interpreter never suspends", () =>
    Effect.gen(function*() {
      // Engine-plan decision 7 is not reopened by step 1, and the way to
      // keep a negative claim true is to assert it rather than to leave
      // it as something nobody happened to do. Break once by returning
      // `Suspended` from `CodeMode.interpreted` and this fails.
      const { data } = yield* groups
      const runtime = CodeMode.make({ tools: { data } })
      const programs = [
        "return 1",
        "const one = await tools.data.echo({ text: \"x\" })\nreturn one.value",
        "for (const n of [1, 2]) { await tools.data.echo({ text: String(n) }) }\nreturn \"done\"",
        "throw new Error(\"boom\")",
        "class Nope {}",
        "await tools.data.echo({ text: \"x\" })"
      ]
      for (const program of programs) {
        const out = yield* runtime.execute(program)
        assert.notStrictEqual(
          out.outcome._tag,
          "Suspended",
          `interpreted executor suspended on: ${program}`
        )
      }
    })
  )

  it.effect("an executor that suspends reports it, and the host gets the state", () =>
    Effect.gen(function*() {
      const { data } = yield* groups
      const held = yield* Ref.make<Option.Option<{ readonly state: unknown; readonly reason: string }>>(
        Option.none()
      )
      const runtime = CodeMode.make({ tools: { data }, executor: suspendingOnce })

      const out = yield* runtime.execute("anything", {
        onSuspend: (suspension) => Ref.set(held, Option.some(suspension))
      })

      assert.strictEqual(out.outcome._tag, "Suspended")
      if (out.outcome._tag === "Suspended") {
        assert.deepStrictEqual(out.outcome.state, SECRET_STATE)
        assert.include(out.outcome.reason, "approval gate")
      }
      // The hook fires as well as the return value carrying it: `CodeTool`
      // has only the hook, because its handler returns the model's result.
      const seen = yield* Ref.get(held)
      assert.deepStrictEqual(Option.getOrUndefined(seen)?.state, SECRET_STATE)

      // A suspended run is not an empty one: what it did before pausing
      // is reported, because a host that shows nothing for a paused
      // program is showing the wrong thing.
      assert.deepStrictEqual(out.logs, [["paused"]])
      assert.deepStrictEqual(out.calls, [
        { path: ["data", "echo"], input: { text: "before" }, outcome: "succeeded" }
      ])
    })
  )

  it.effect("resuming continues from the state rather than starting again", () =>
    Effect.gen(function*() {
      const { data } = yield* groups
      const runtime = CodeMode.make({ tools: { data }, executor: suspendingOnce })

      const first = yield* runtime.execute("anything")
      assert.strictEqual(first.outcome._tag, "Suspended")
      const state = first.outcome._tag === "Suspended" ? first.outcome.state : undefined

      const second = yield* runtime.execute("anything", { resumeFrom: state })

      // Break once by dropping `resumeFrom` on the way through
      // `CodeMode.execute` and this suspends a second time instead.
      assert.deepStrictEqual(second.outcome, {
        _tag: "Returned",
        value: { resumedWith: SECRET_STATE }
      })
      // The tool was called once, on the first attempt. A resumed run
      // that re-executed from the top would have called it again, which
      // is the whole difference between resumption and a retry.
      assert.deepStrictEqual(second.calls, [])
    })
  )

  it.effect("the model is told it paused and is never handed the state", () =>
    Effect.gen(function*() {
      const held = yield* Ref.make<unknown>(undefined)
      const bound = yield* CodeTool.tool({
        tools: yield* groups,
        executor: suspendingOnce,
        onSuspend: ({ state }) => Ref.set(held, state)
      })

      const { events } = yield* withSession(
        [
          { toolCalls: [{ id: "c1", name: "execute", params: { program: "return 1" } }] },
          { text: "done" }
        ],
        Agent.make({ tools: [bound] }),
        ({ session }) => AgentSession.prompt(session, "do it")
      )

      const succeeded = events.filter(AgentEvent.is("ToolCallSucceeded"))
      assert.strictEqual(succeeded.length, 1)
      const result = succeeded[0]!.event.result
      assert.strictEqual((result as { readonly outcome: string }).outcome, "suspended")
      // The reason is what the model gets, in place of a fix: it is the
      // thing it could act on.
      assert.include((result as { readonly fix: string }).fix, "approval gate")

      // Structural, not by reading the mapping: no field of the
      // model-visible result carries the executor's state, however it
      // might have been nested. Break once by adding `state` to the
      // returned object in `CodeTool` and this fails.
      assert.notInclude(JSON.stringify(result), "opaque-executor-state")

      // The host has it, which is why the model does not need it.
      assert.deepStrictEqual(yield* Ref.get(held), SECRET_STATE)
    })
  )
})
