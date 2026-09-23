/**
 * `AgentEvent` -> UI-neutral conversation state (plan-workbench.md §13).
 *
 * Pure and deterministic, so the same function drives React, a TUI, a test
 * or a screenshot. It holds no execution state of its own: status, pending
 * questions and messages are what the session reported, never a guess about
 * what it will do next.
 *
 * Messages come from two places on purpose. Canonical history is the
 * authority, and `fromHistory` rebuilds from it; deltas are observational
 * and only show a message forming until history has it.
 */
import { Option } from "effect"
import type { Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import type { AgentEvent } from "affe-agent"
import type { AgentClient } from "affe-agent/client"
import type * as Elicitation from "affe-agent/elicitation"

/** As a remote session reports it; the kernel's own `Status` is not a public export. */
export type SessionStatus = Effect.Success<AgentClient.RemoteSession["status"]>

export interface MessageView {
  readonly role: "user" | "assistant"
  readonly text: string
  readonly reasoning: string
  /** `streaming` only for a message still forming from deltas. */
  readonly state: "streaming" | "complete" | "interrupted" | "failed"
}

export interface ToolView {
  readonly _tag: "Tool"
  readonly id: string
  readonly name: string
  readonly params: unknown
  readonly progress: ReadonlyArray<unknown>
  readonly state: "running" | "succeeded" | "failed" | "interrupted"
}

/** An event from a newer peer, kept by name rather than dropped or fatal. */
export interface UnrecognizedView {
  readonly _tag: "Unrecognized"
  readonly originalTag: string
  readonly sequence: number
}

export type ActivityView = ToolView | UnrecognizedView

export type Outcome = "completed" | "failed" | "interrupted"

export interface ConversationView {
  readonly messages: ReadonlyArray<MessageView>
  readonly activity: ReadonlyArray<ActivityView>
  readonly pending: ReadonlyArray<Elicitation.Request>
  readonly status: SessionStatus
  /** How the latest submission ended, once one has. */
  readonly outcome: Option.Option<Outcome>
  /** Why the last submission failed, while it is the last one; cleared when the next starts. */
  readonly failure: Option.Option<AgentEvent.Failure>
  /** The last sequence applied: what a reconnect resumes after. */
  readonly lastSequence: Option.Option<number>
}

const messagesOf = (history: Prompt.Prompt): ReadonlyArray<MessageView> =>
  history.content.flatMap((message): ReadonlyArray<MessageView> => {
    if (message.role !== "user" && message.role !== "assistant") return []
    let text = ""
    let reasoning = ""
    for (const part of message.content) {
      if (part.type === "text") text += part.text
      else if (part.type === "reasoning") reasoning += part.text
    }
    // An assistant message that only called tools has nothing to read; its
    // calls are activity.
    return text === "" && reasoning === "" ? [] : [{ role: message.role, text, reasoning, state: "complete" }]
  })

export const initial = (
  history: Prompt.Prompt,
  pending: ReadonlyArray<Elicitation.Request>,
  status: SessionStatus
): ConversationView => ({
  messages: messagesOf(history),
  activity: [],
  pending,
  status,
  outcome: Option.none(),
  failure: Option.none(),
  lastSequence: Option.none()
})

/**
 * Replace the messages with canonical history, dropping any still forming:
 * history is committed at the end of a turn, so after a submission settles it
 * holds everything the deltas showed, and the user's own prompt besides.
 */
export const fromHistory = (state: ConversationView, history: Prompt.Prompt): ConversationView => ({
  ...state,
  messages: messagesOf(history)
})

const updateLast = (
  messages: ReadonlyArray<MessageView>,
  f: (message: MessageView) => MessageView
): ReadonlyArray<MessageView> => {
  const last = messages.at(-1)
  return last === undefined || last.role !== "assistant" || last.state !== "streaming"
    ? messages
    : [...messages.slice(0, -1), f(last)]
}

const updateTool = (
  activity: ReadonlyArray<ActivityView>,
  id: string,
  f: (tool: ToolView) => ToolView
): ReadonlyArray<ActivityView> => activity.map((entry) => (entry._tag === "Tool" && entry.id === id ? f(entry) : entry))

const settle = (state: ConversationView, outcome: Outcome): ConversationView => ({
  ...state,
  status: "idle",
  outcome: Option.some(outcome),
  messages: updateLast(state.messages, (message) => ({
    ...message,
    state: outcome === "completed" ? "complete" : outcome
  }))
})

/** Whether an envelope ends a submission, after which history is worth re-reading. */
export const settles = (envelope: AgentEvent.AgentEventEnvelope): boolean =>
  envelope.event._tag === "SubmissionCompleted" ||
  envelope.event._tag === "SubmissionFailed" ||
  envelope.event._tag === "SubmissionInterrupted"

export const transition = (
  state: ConversationView,
  envelope: AgentEvent.AgentEventEnvelope
): ConversationView => {
  const next = step(state, envelope)
  return { ...next, lastSequence: Option.some(envelope.sequence) }
}

const step = (state: ConversationView, envelope: AgentEvent.AgentEventEnvelope): ConversationView => {
  const event = envelope.event
  switch (event._tag) {
    case "SubmissionStarted":
      return { ...state, status: "running", outcome: Option.none(), failure: Option.none() }
    case "SubmissionCompleted":
      return settle(state, "completed")
    case "SubmissionFailed":
      return { ...settle(state, "failed"), failure: Option.some(event.failure) }
    case "SubmissionInterrupted":
      return settle(state, "interrupted")
    case "SessionClosed":
      return { ...state, status: "closed" }
    case "MessageStarted":
      return {
        ...state,
        messages: [...state.messages, { role: "assistant", text: "", reasoning: "", state: "streaming" }]
      }
    case "MessageDelta":
      return {
        ...state,
        messages: updateLast(state.messages, (message) =>
          event.kind === "text"
            ? { ...message, text: message.text + event.delta }
            : { ...message, reasoning: message.reasoning + event.delta })
      }
    case "MessageCompleted":
      // Without streaming there were no deltas and no open message; the
      // committed text is the message.
      return state.messages.at(-1)?.state === "streaming"
        ? { ...state, messages: updateLast(state.messages, (message) => ({ ...message, text: event.text, state: "complete" })) }
        : event.text === ""
        ? state
        : { ...state, messages: [...state.messages, { role: "assistant", text: event.text, reasoning: "", state: "complete" }] }
    case "MessageInterrupted":
      return { ...state, messages: updateLast(state.messages, (message) => ({ ...message, state: "interrupted" })) }
    case "MessageFailed":
      return { ...state, messages: updateLast(state.messages, (message) => ({ ...message, state: "failed" })) }
    case "ToolCallStarted":
      return {
        ...state,
        activity: [
          ...state.activity,
          { _tag: "Tool", id: event.id, name: event.name, params: event.params, progress: [], state: "running" }
        ]
      }
    case "ToolCallProgress":
      return {
        ...state,
        activity: updateTool(state.activity, event.id, (tool) => ({ ...tool, progress: [...tool.progress, event.encodedResult] }))
      }
    case "ToolCallSucceeded":
      return { ...state, activity: updateTool(state.activity, event.id, (tool) => ({ ...tool, state: "succeeded" })) }
    case "ToolCallFailed":
      return { ...state, activity: updateTool(state.activity, event.id, (tool) => ({ ...tool, state: "failed" })) }
    case "ToolCallInterrupted":
      return { ...state, activity: updateTool(state.activity, event.id, (tool) => ({ ...tool, state: "interrupted" })) }
    case "ElicitationRequested":
      return state.pending.some((request) => request.id === event.id)
        ? state
        : { ...state, pending: [...state.pending, { id: event.id, kind: event.kind, detail: event.detail }] }
    case "ElicitationResolved":
      return { ...state, pending: state.pending.filter((request) => request.id !== event.id) }
    case "UnknownEvent":
      return {
        ...state,
        activity: [...state.activity, { _tag: "Unrecognized", originalTag: event.originalTag, sequence: envelope.sequence }]
      }
    default:
      // Known events with nothing to show yet: turns, model calls, steering,
      // delegation. Listed by omission rather than by a catch-all branch per
      // tag, because the view has no field any of them would change.
      return state
  }
}
