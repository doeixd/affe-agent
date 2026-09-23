/**
 * What an agent is asking, in words a person can answer (plan-workbench.md
 * W2, "pending approvals").
 *
 * An `Elicitation.Request` carries a `kind` and an opaque `detail`. For a
 * `tool-approval` the detail is the kernel's `Permission.ApprovalDetail`, so
 * the page can say *which* tool wants to do *what* -- not "the agent is
 * asking: tool-approval". Anything else, or a detail that does not decode,
 * is shown as its kind and whatever text the detail has: an unrecognized
 * question is still answerable, never hidden.
 *
 * UI-neutral and pure, so every adapter renders the same question.
 */
import { Option, Schema } from "effect"
import { Permission } from "affe-agent"
import type * as Elicitation from "affe-agent/elicitation"

export type QuestionView =
  | {
    readonly _tag: "ToolApproval"
    readonly id: string
    readonly tool: string
    readonly action: string
    /** The invocation when it is narrower than the scope, else the scope. */
    readonly target: string
    readonly reason: Option.Option<string>
    /** Delegating tools, outermost first; empty for the session's own. */
    readonly via: ReadonlyArray<string>
  }
  | { readonly _tag: "Other"; readonly id: string; readonly kind: string; readonly text: Option.Option<string> }

const decodeApproval = Schema.decodeUnknownOption(Schema.toCodecJson(Permission.ApprovalDetail))

const textOf = (detail: unknown): Option.Option<string> =>
  typeof detail === "string" && detail !== ""
    ? Option.some(detail)
    : detail === undefined || detail === null
    ? Option.none()
    : Option.some(JSON.stringify(detail))

export const describe = (request: Elicitation.Request): QuestionView => {
  if (request.kind === "tool-approval") {
    const decoded = decodeApproval(request.detail)
    if (Option.isSome(decoded)) {
      const detail = decoded.value
      return {
        _tag: "ToolApproval",
        id: request.id,
        tool: detail.toolName,
        action: detail.action,
        target: detail.subject ?? detail.resource,
        reason: Option.fromNullishOr(detail.reason),
        via: detail.via ?? []
      }
    }
  }
  return { _tag: "Other", id: request.id, kind: request.kind, text: textOf(request.detail) }
}

/** One line for a list: "build wants to shell: rm -rf dist". */
export const headline = (question: QuestionView): string =>
  question._tag === "ToolApproval"
    ? `${question.tool} wants to ${question.action}: ${question.target}`
    : Option.match(question.text, { onNone: () => question.kind, onSome: (text) => `${question.kind}: ${text}` })
