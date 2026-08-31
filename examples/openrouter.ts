import { Config, Effect, ExecutionPlan, Layer, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { Budget } from "../src/budget/index.js"

/**
 * OpenRouter, which is not a package here and never will be.
 *
 * Typechecked, not executed -- running it needs an `OPENROUTER_API_KEY` and
 * would make live requests, exactly as `examples/anthropic.ts` does.
 *
 * A model gateway is a *provider*, and this repository's rule is that a package
 * adds a capability (`ROADMAP.md`). OpenRouter speaks the OpenAI API, so it adds
 * none: it is a `baseUrl` and a key. The whole adapter is the layer below, and
 * `src/` stays out of it. See `docs/plan-primitives.md` for why being a gateway
 * -- billing, key custody, per-tenant limits -- is a different job from this one.
 *
 * What this file is actually for is the two things a caller cannot guess from
 * that snippet: where routing lives (below, part 2) and what the gateway does
 * to accounting (part 3).
 */

// --- 1. The provider ------------------------------------------------------

/**
 * The entire integration.
 *
 * `apiUrl` is the only thing that distinguishes this from talking to OpenAI.
 * Model ids are namespaced by vendor -- `anthropic/...`, `google/...` -- and
 * are otherwise ordinary strings, so a gateway model and a first-party model
 * are the same kind of value to everything downstream.
 *
 * One detail worth recording, because it is invisible until it 404s:
 * `@effect/ai-openai@4.0.0-rc.112` speaks the **Responses** API -- it posts to
 * `/responses`, not `/chat/completions`. OpenRouter exposes `/api/v1/responses`
 * (checked against `https://openrouter.ai/openapi.json`, 2026-08-31), so this
 * works; an OpenAI-compatible gateway that only implements chat completions
 * would not, whatever the "OpenAI-compatible" label promises.
 */
const openrouter = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENROUTER_API_KEY"),
  apiUrl: Config.succeed("https://openrouter.ai/api/v1"),
  /**
   * The one gateway-specific thing, and it is optional: OpenRouter attributes
   * traffic on its leaderboards by these two headers. There is no field for
   * them because they are not part of the OpenAI API -- `transformClient` is
   * the seam for anything a gateway adds on top of the protocol it borrows.
   */
  transformClient: HttpClient.mapRequest(
    HttpClientRequest.setHeaders({
      "HTTP-Referer": "https://github.com/doeixd/effect-agent",
      "X-Title": "effect-agent"
    })
  )
}).pipe(Layer.provide(FetchHttpClient.layer))

const sonnet = OpenAiLanguageModel.layer({
  model: "anthropic/claude-sonnet-4.5"
}).pipe(Layer.provide(openrouter))

const gemini = OpenAiLanguageModel.layer({
  model: "google/gemini-2.5-flash"
}).pipe(Layer.provide(openrouter))

// --- 2. Routing belongs to ExecutionPlan ----------------------------------

/**
 * Both OpenRouter and this library can fall back to another model, and it
 * matters which one does.
 *
 * OpenRouter's routing is *inside one call*: it picks among the upstream
 * providers serving a model, and the response it returns is the one that
 * succeeded. That is provider plumbing, and it is worth leaving on --
 * nothing here can do it, because nothing here knows which of five hosts is
 * currently serving `anthropic/claude-sonnet-4.5`.
 *
 * `ExecutionPlan` is *across calls*, and it is the only one of the two that
 * can change the model, retry on this library's own failures, or apply a
 * schedule you chose. Use it whenever the fallback is a different model rather
 * than a different host for the same one.
 *
 * They compose: each rung below is still free to be routed by the gateway.
 */
const plan = ExecutionPlan.make(
  {
    provide: sonnet,
    attempts: 3,
    schedule: Schedule.exponential("200 millis")
  },
  { provide: gemini }
)

// --- 3. Usage still reaches /budget ---------------------------------------

/**
 * A gateway does not hide usage from the budget.
 *
 * `Budget.within` counts the usage the model reports on each turn, whatever
 * produced it, so a run through OpenRouter is capped exactly as a direct one
 * is -- the ceiling is enforced by the loop seam, not by the provider.
 *
 * Where `Budget.layer` is provided decides the scope, and it is provided at the
 * edge below: one 50k pool for the whole program, shared by every session it
 * makes. Move it inside `Effect.scoped` for a fresh ceiling per conversation.
 *
 * The caveat is that the unit is **tokens**, and a plan that spans vendors
 * spans prices: 50k tokens of `anthropic/claude-sonnet-4.5` and 50k of
 * `google/gemini-2.5-flash` are the same number here and very different
 * invoices at OpenRouter. If cost is what you are capping, cap it where the
 * prices are known -- OpenRouter's own credit limits -- and keep this ceiling
 * for what it is good at: bounding a runaway loop.
 */
const Researcher = Agent.make({
  instructions: "Research carefully and cite evidence.",
  loop: Budget.within(50_000, AgentLoop.untilIdle())
}).pipe(Agent.withExecutionPlan(plan))

export const program = Effect.scoped(
  Effect.flatMap(AgentSession.make(Researcher), (session) =>
    Effect.gen(function* () {
      const result = yield* AgentSession.prompt(session, "Research Effect AI.")
      const spent = yield* Effect.flatMap(Budget.Budget, (budget) => budget.spent)
      yield* Effect.log(`status=${result.status} tokens=${spent}`)
    }))
)

export const main = program.pipe(Effect.provide(Budget.layer))

// --- Type assertions -------------------------------------------------------
// Compile-time only, as in `examples/execution-plan.ts`, and for the same
// reason: the code above would look correct either way.

type Assert<T extends true> = T
type Requirements = typeof main extends Effect.Effect<any, any, infer R> ? R
  : never

/**
 * The claim, stated so the compiler can refuse it: **nothing outside part 1
 * mentions a provider**, and after the plan and `Budget.layer` are applied the
 * program needs no services at all.
 *
 * Remove `Agent.withExecutionPlan(plan)` and this line fails -- `R` becomes
 * `LanguageModel.LanguageModel`, the model the plan was supposed to supply.
 */
export type _NeedsNothing = Assert<[Requirements] extends [never] ? true : false>
