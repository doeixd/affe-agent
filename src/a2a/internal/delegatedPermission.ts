import { Effect, Option, Schema } from "effect"
import * as Elicitation from "../../Elicitation.js"
import * as Permission from "../../Permission.js"

/**
 * One decision, for every delegated runtime.
 *
 * Claude Code asks over `--permission-prompt-tool` and wants
 * `{behavior, updatedInput|message}`; OpenCode asks over its event bus and
 * wants `once | always | reject`. Those are two encodings of the same answer,
 * and the answer is the part worth having exactly once: the fail-closed rules
 * below are the ones you do not want two copies of, quietly diverging.
 *
 * So this module decides, and each bridge encodes.
 */

/** What a delegated tool call *is*, for policy purposes. */
export interface Projected {
  readonly action: string
  readonly resource: string
  readonly subject?: string | undefined
}

/**
 * The answer, before any runtime's spelling of it.
 *
 * `remember` is the "and don't ask again" half. It always reaches the policy's
 * own `remember`; whether the *delegated runtime* is also told depends on
 * whether it has a way to be -- OpenCode does (`always`), Claude Code's prompt
 * tool does not, and neither bridge pretends otherwise.
 */
export interface Verdict {
  readonly allow: boolean
  readonly remember: boolean
  readonly reason?: string | undefined
}

export interface Options<R = never> {
  readonly policy: Permission.Policy<R>
  readonly elicitor?: Elicitation.Elicitor | undefined
  readonly sessionId?: string | undefined
}

export interface Prompt {
  /** The delegated runtime's own name for the call, for the elicitation id. */
  readonly callId: string
  /** The tool as that runtime names it. */
  readonly toolName: string
  /** Its arguments, as far as they are known. */
  readonly params: unknown
  readonly projected: Projected
  /** Namespaces the elicitation id, so two bridges cannot collide. */
  readonly origin: string
}

export const decide = <R = never>(
  options: Options<R>
) =>
(prompt: Prompt): Effect.Effect<Verdict, never, R> =>
  Effect.gen(function* () {
    const request: Permission.Request = {
      sessionId: options.sessionId ?? prompt.origin,
      toolCallId: prompt.callId,
      tool: { name: prompt.toolName, params: prompt.params },
      action: prompt.projected.action,
      resource: prompt.projected.resource,
      // A delegated runtime asks only for calls its own rules did not already
      // approve, so by the time one arrives here it *is* approval-requiring.
      // Saying so lets a policy tighten on it and never loosens anything.
      intrinsicApproval: true,
      ...(prompt.projected.subject === undefined ? {} : { subject: prompt.projected.subject }),
      // The delegated agent's conversation is its own; this side has never seen
      // it. An empty history is the truthful answer, and a policy that needs
      // the transcript to decide cannot be used here -- which is better than
      // one that silently decides on a transcript that is not the real one.
      messages: []
    }

    const decision = yield* options.policy.evaluate(request)
    if (decision._tag === "Deny") {
      return { allow: false, remember: false, reason: decision.reason ?? "denied by policy" }
    }
    if (decision._tag === "Allow") {
      return { allow: true, remember: false }
    }

    const elicitor = options.elicitor
    if (elicitor === undefined) {
      // Fail closed. `Elicitation.denied` is the harness's own default for the
      // same reason: a question nobody can answer must not become a yes.
      return {
        allow: false,
        remember: false,
        reason: decision.reason ??
          "approval is required and no elicitor is wired, so the request was refused"
      }
    }

    const detail: Permission.ApprovalDetail = {
      toolName: prompt.toolName,
      toolCallId: prompt.callId,
      action: prompt.projected.action,
      resource: prompt.projected.resource,
      ...(prompt.projected.subject === undefined ? {} : { subject: prompt.projected.subject }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason })
    }
    // The same `kind` the harness uses for its own approvals, so an application
    // that already renders one renders this: from the answering side, a
    // delegated agent asking to write a file is the same question as a local
    // tool asking to.
    const answer = yield* elicitor.elicit(
      { id: `${prompt.origin}:${prompt.callId}`, kind: "tool-approval", detail },
      Effect.void
    )
    if (!answer.granted) {
      return { allow: false, remember: false, reason: "the request was refused" }
    }
    // "Allow always" is two things: this answer, and a grant the policy keeps.
    const remembered = Schema.decodeUnknownOption(Permission.ApprovalValue)(answer.value)
    const remember = Option.isSome(remembered) && remembered.value.remember
    if (remember && options.policy.remember !== undefined) {
      yield* options.policy.remember(request)
    }
    return { allow: true, remember }
  })
