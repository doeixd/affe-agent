/**
 * What an agent is asking, described (W2), and the failure the page shows: a tool approval by its tool,
 * action and target; anything else by its kind and text; a tool approval
 * whose detail does not decode is still shown, never hidden.
 */
import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Permission } from "affe-agent"
import type { AgentEvent } from "affe-agent"
import { AgentProtocol } from "affe-agent/client"
import * as ConversationProjection from "../src/ui-core/ConversationProjection.js"
import * as Question from "../src/ui-core/Question.js"

const encode = Schema.encodeSync(Schema.toCodecJson(Permission.ApprovalDetail))

describe("question", () => {
  it("a tool approval names the tool, the action and the narrowest target", () => {
    const question = Question.describe({
      id: "q1",
      kind: "tool-approval",
      detail: encode({
        toolName: "shell",
        toolCallId: "c1",
        action: "shell:exec",
        resource: "shell:*",
        subject: "rm -rf dist",
        reason: "writes outside the workspace",
        via: ["research"]
      })
    })
    assert.deepStrictEqual(question, {
      _tag: "ToolApproval",
      id: "q1",
      tool: "shell",
      action: "shell:exec",
      target: "rm -rf dist",
      reason: Option.some("writes outside the workspace"),
      via: ["research"]
    })
    assert.strictEqual(Question.headline(question), "shell wants to shell:exec: rm -rf dist")
  })

  it("without a subject, the target is the resource; without via, it is the session's own", () => {
    const question = Question.describe({
      id: "q2",
      kind: "tool-approval",
      detail: encode({ toolName: "write", toolCallId: "c2", action: "write", resource: "src/a.ts" })
    })
    assert.strictEqual(question._tag, "ToolApproval")
    if (question._tag === "ToolApproval") {
      assert.strictEqual(question.target, "src/a.ts")
      assert.deepStrictEqual(question.via, [])
      assert.isTrue(Option.isNone(question.reason))
    }
  })

  it("another kind, or an approval that does not decode, is shown by kind and text", () => {
    assert.deepStrictEqual(Question.describe({ id: "q3", kind: "question", detail: "Which branch?" }), {
      _tag: "Other",
      id: "q3",
      kind: "question",
      text: Option.some("Which branch?")
    })
    const broken = Question.describe({ id: "q4", kind: "tool-approval", detail: { nope: true } })
    assert.strictEqual(broken._tag, "Other")
    assert.strictEqual(Question.headline(broken), `tool-approval: {"nope":true}`)
    assert.strictEqual(Question.headline(Question.describe({ id: "q5", kind: "confirm", detail: null })), "confirm")
  })
})

// -- The failure the page shows --------------------------------------------------------

let sequence = 0
const envelope = (event: AgentEvent.StreamedEvent): AgentEvent.AgentEventEnvelope => ({
  sessionId: AgentProtocol.SessionId.make("s"),
  submissionId: Option.some(AgentProtocol.SubmissionId.make("sub")),
  runId: Option.none(),
  turn: Option.none(),
  sequence: ++sequence,
  event
})

describe("conversation projection's failure", () => {
  it("is the failed submission's, until the next one starts", () => {
    const failure = { tag: "InternalProviderError", message: "provider unavailable", isDefect: false }
    const start = ConversationProjection.initial(Prompt.empty, [], "idle")
    assert.isTrue(Option.isNone(start.failure))
    const failed = [
      envelope({ _tag: "SubmissionStarted" }),
      envelope({ _tag: "SubmissionFailed", failure })
    ].reduce(ConversationProjection.transition, start)
    assert.deepStrictEqual(failed.failure, Option.some(failure))
    assert.deepStrictEqual(failed.outcome, Option.some("failed"))
    const retried = ConversationProjection.transition(failed, envelope({ _tag: "SubmissionStarted" }))
    assert.isTrue(Option.isNone(retried.failure))
    const completed = ConversationProjection.transition(retried, envelope({ _tag: "SubmissionCompleted", runs: 1 }))
    assert.isTrue(Option.isNone(completed.failure))
  })
})
