import type { Cause } from "effect"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { Observability } from "../src/observability/index.js"

/**
 * Tracing an agent with the standard semantic conventions.
 *
 * Typechecked, not executed. `Observability.trace` observes the public event
 * stream and emits one telemetry record per event under stable `agent.*` /
 * `ai.*` attribute names -- no wrapping of the run, and metadata only unless a
 * redaction policy opts content in. Fork it alongside the prompt; the default
 * sink logs structured records that any Effect tracing exporter captures.
 */

const Assistant = Agent.make({ instructions: "You are helpful." })

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* AgentSession.make(Assistant)

    // Observe the whole run: metadata by default, content scrubbed if enabled.
    yield* Effect.forkScoped(
      Observability.trace(AgentSession.events(session), {
        policy: { ...Observability.withContent, redact: (value) => (typeof value === "string" ? value.slice(0, 200) : value) },
        attributes: { [Observability.attributeNames.durable]: false }
      })
    )

    return yield* AgentSession.prompt(session, "Summarise the release notes.")
  })
)

export const main = program.pipe(
  Effect.provide(
    AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
      Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
      Layer.provide(FetchHttpClient.layer)
    )
  )
)

/**
 * The original `Cause` of a tool failure the model recovered from.
 *
 * `ToolCallFailed` carries a *projection* -- a name, a message, and whether it
 * was a defect -- because it has to survive a wire and a journal. That is the
 * right thing on the stream and the wrong thing for an operator, who wants the
 * typed error with its fields and the cause's structure.
 *
 * The cause never leaves the process, so it is read where it is raised: a
 * handler is an ordinary `Effect`, and `Effect.tapCause` observes it and
 * re-raises it, changing nothing about the result. That fires exactly once per
 * attempt.
 *
 * What the handler cannot see is the submission, the run, the turn, or what the
 * failure policy decided to do about the failure. The event carries all four.
 * The two join on the tool call id, which the handler is given as
 * `context.toolCallId` and the event reports as `ToolCallFailed.id`.
 *
 * This is a recipe rather than a seam on purpose: `plan-run-stream-start.md`
 * §8.1 asks whether telemetry can already get the cause exactly once per
 * attempt without changing run semantics, and it can.
 * `test/ToolFailureObservation.test.ts` is the audit, so this stays true.
 */
export const observedTool = <Args, Success, Error, Requirements>(
  handler: (input: Args, context: { readonly toolCallId?: string | undefined }) =>
    Effect.Effect<Success, Error, Requirements>,
  report: (failure: {
    readonly toolCallId: string | undefined
    readonly cause: Cause.Cause<Error>
  }) => Effect.Effect<void>
) =>
(input: Args, context: { readonly toolCallId?: string | undefined }) =>
  handler(input, context).pipe(
    Effect.tapCause((cause) => report({ toolCallId: context.toolCallId, cause }))
  )
