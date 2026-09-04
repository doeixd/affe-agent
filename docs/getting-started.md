# Getting started

One typed agent, running, with no API key. The code below is
[`examples/getting-started.ts`](../examples/getting-started.ts) with the
package imports in place of the repository's relative ones;
`test/GettingStarted.test.ts` keeps the two identical.

## Install

```sh
npm install affe-agent effect
```

`effect` is a peer dependency. Pin it, this library and any `@effect/ai-*`
provider to exact versions and upgrade them together — all three track the
Effect 4 release candidate ([Install](../README.md#install) has the table).

## A bug classifier

An agent is a value: instructions, tools, a stopping rule, and — here — the
shape it must answer in. It names no model.

```ts
import { Effect, Layer, Option, Schema } from "effect"
import { Agent, AgentLoop, AgentOutput } from "affe-agent"
import { TestLanguageModel } from "affe-agent/testing"

// What the agent must answer with. The schema is the contract: the model is
// handed it as a tool, and the value comes back decoded, not re-parsed.
const Triage = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  explanation: Schema.String
})

const Classifier = Agent.make({
  instructions:
    "Classify the bug report. Report its severity and a one-sentence" +
    " explanation with the tool provided.",
  output: AgentOutput.make(Triage, { name: "record_triage" }),
  // Stop when the model stops calling tools, and never past two turns.
  loop: AgentLoop.bounded(2)
})

// `Agent.run` opens a session for one prompt and closes it at quiescence.
// The result's `value` is an `Option`: a model can stop without answering,
// and the signature says so rather than the docs.
export const classify = (report: string) =>
  Effect.map(Agent.run(Classifier, report), (result) => result.value)

// An agent names no model. This one is scripted -- it plays the provider's
// part -- so the program runs with no key. Swap the layer for a real
// provider and nothing above changes.
const ScriptedModel = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      TestLanguageModel.toolCall("record_triage", {
        severity: "critical",
        explanation: "Every sign-in fails, so nobody can use the product."
      })
    ]),
    ({ layer }) => layer
  )
)

export const main = classify("All users get a 500 error when signing in").pipe(
  Effect.map((verdict) =>
    Option.match(verdict, {
      onNone: () => "the model gave no verdict",
      onSome: (triage) => `${triage.severity}: ${triage.explanation}`
    })
  ),
  Effect.tap((line) => Effect.log(line)),
  Effect.provide(ScriptedModel)
)
```

Run it and the log line is `critical: Every sign-in fails, so nobody can use
the product.` — the value is the schema's type, not `unknown`, and nothing
above needed a cast or a hand-written annotation. That is the rule this
library holds itself to; if a call site ever needs one, that is a defect in
the library, not in your code.

## A real model

Provide a provider layer where the scripted one was. Nothing about the agent
changes:

```ts
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { FetchHttpClient } from "effect/unstable/http"
import { Config, Layer } from "effect"

const Anthropic = AnthropicLanguageModel.layer({ model: "claude-sonnet-4-5" }).pipe(
  Layer.provide(AnthropicClient.layerConfig({ apiKey: Config.redacted("ANTHROPIC_API_KEY") })),
  Layer.provide(FetchHttpClient.layer)
)

classify("…").pipe(Effect.provide(Anthropic))
```

## Where next

- **Tools.** `Agent.make({ tools: [Agent.tool(Search, handler)] })`, or
  `Agent.toolkit`, both in the README's [Quickstart](../README.md#quickstart).
  Tool names, parameters and failures stay typed through to `prompt`'s
  error channel.
- **A conversation, not a call.** `AgentSession.make` gives a handle with
  `prompt`, `steer`, `followUp`, `interrupt` and an event stream —
  [Steering](../README.md#steering-without-cancellation) onward.
- **Limits.** Turns, tokens and money: `AgentLoop`, `/budget`, and the
  README's [Limits](../README.md#limits) table for every bound you can hit.
- **Where it runs.** [platforms.md](./platforms.md) — Node, Cloudflare
  Workers, and what is durable on each.
- **Which module does X.** [MODULES.md](./MODULES.md).
