import { assert, describe, it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as Permission from "../src/Permission.js"
import { turnFailpoints } from "../src/internal/turnFailpoints.js"
import { DurableEquivalence } from "../src/testing/index.js"

/**
 * Item 105, I17.3 (plan Q6): a recovered attempt does not run under a
 * permission policy other than the one its submission was admitted with. A
 * run crashes after the model asked for a refund and before the policy
 * decided it; a replacement deployed with a *wider* policy must not
 * authorise it retroactively.
 */

const database = Effect.acquireRelease(
  Effect.sync(() => NodePath.join(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "policy-")), "agent.db")),
  (file) =>
    Effect.sync(() => {
      try {
        NodeFs.rmSync(NodePath.dirname(file), { recursive: true, force: true })
      } catch {
        // Still held open on Windows.
      }
    })
).pipe(Effect.map((file) => SqliteClient.layer({ filename: file })))

const Refund = Tool.make("refund", { parameters: Schema.Struct({}), success: Schema.String })
const onlyReads = Permission.rules([{ tool: "lookup", decision: Permission.allow }], { otherwise: Permission.deny("not allowed") })

const refunds = Permission.rules([{ tool: "refund", decision: Permission.allow }], { otherwise: Permission.deny("not allowed") })

const scenarioFor = (first: Permission.Policy, second: Permission.Policy) =>
  DurableEquivalence.scenario({
    agent: (effects, process) =>
      Agent.make({
        tools: [Agent.tool(Refund, () => Effect.as(effects.record("refunded"), "ok"))],
        permission: process === "first" ? first : second,
        loop: AgentLoop.bounded(3)
      }),
    turns: [{ toolCalls: [{ id: "r1", name: "refund", params: {} }] }, { text: "done" }],
    prompt: "refund it"
  })

const custom = (name: string, decision: Permission.Decision): Permission.Policy =>
  Permission.make(() => Effect.succeed(decision), { _tag: "Custom", name })

describe("a recovered attempt runs under the stricter of its admitted and current policy (item 105)", () => {
  it.live("a wider replacement policy does not reach back: the admitted rules still deny, and the refund never runs", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        DurableEquivalence.crashed(scenarioFor(onlyReads, Permission.allowAll), {
          database,
          at: turnFailpoints.qualified("after-model-response")
        })
      )
      assert.isTrue(Exit.isFailure(exit), "the replacement authorised the call under its own, wider policy")
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "ToolPermissionDeniedError")
    }), 90_000)

  it.live("a narrower replacement policy applies: a revocation since the crash still holds", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        DurableEquivalence.crashed(scenarioFor(refunds, Permission.denyAll), {
          database,
          at: turnFailpoints.qualified("after-model-response")
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "ToolPermissionDeniedError")
    }), 90_000)

  it.live("the same policy in the replacement recovers as if nothing happened", () =>
    Effect.gen(function*() {
      const recovered = yield* DurableEquivalence.crashed(scenarioFor(refunds, refunds), {
        database,
        at: turnFailpoints.qualified("after-model-response")
      })
      assert.deepStrictEqual(recovered.observation.effects, ["refunded"])
      assert.strictEqual(recovered.observation.text, "done")
    }), 90_000)

  it.live("a changed policy that cannot be re-created is refused by name", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        DurableEquivalence.crashed(scenarioFor(custom("v1", Permission.allow), custom("v2", Permission.allow)), {
          database,
          at: turnFailpoints.qualified("after-model-response")
        })
      )
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "PermissionPolicyChangedError")
    }), 90_000)
})

describe("Permission.fromDescription", () => {
  const request = (tool: string, resource: string): Permission.Request => ({
    sessionId: "s",
    toolCallId: "c",
    tool: { name: tool, params: {} },
    action: "tool",
    resource,
    intrinsicApproval: false,
    messages: []
  })
  const decide = (policy: Permission.Policy, tool: string, resource: string) =>
    Effect.runSync(policy.evaluate(request(tool, resource)))._tag

  it("re-creates rules, carve-outs and a case-insensitive pattern so they decide as the original did", () => {
    const original = Permission.except(
      Permission.rules([{ resource: /secret/i, decision: Permission.deny("no") }], { otherwise: Permission.allow }),
      [{ tool: "audit", decision: Permission.ask() }]
    )
    const again = Permission.fromDescription(Permission.describe(original))
    assert.isTrue(Option.isSome(again))
    if (Option.isSome(again)) {
      for (const [tool, resource] of [["read", "SECRET.txt"], ["read", "notes"], ["audit", "notes"]] as const) {
        assert.strictEqual(decide(again.value, tool, resource), decide(original, tool, resource), `${tool} ${resource}`)
      }
    }
  })

  it("has no answer for a function matcher or a custom policy", () => {
    assert.isTrue(Option.isNone(Permission.fromDescription(Permission.describe(
      Permission.rules([{ resource: (r) => r.length > 3, decision: Permission.deny() }], { otherwise: Permission.allow })
    ))))
    assert.isTrue(Option.isNone(Permission.fromDescription(Permission.describe(custom("x", Permission.allow)))))
  })
})
