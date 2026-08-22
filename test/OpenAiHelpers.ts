import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import type * as Agent from "../src/Agent.js"
import { AgentClient } from "../src/client/index.js"
import { OpenAiAgent, OpenAiSchema } from "../src/openai/index.js"
import * as FakeModel from "./FakeModel.js"
import type { TestLanguageModel } from "../src/testing/index.js"

/** Shared fixtures for the OpenAI adapter suites: a server, and a client that is just `fetch`. */

export const makeServer = (
  agent: Agent.AgentDefinition<any, any, any>,
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  options: Partial<OpenAiAgent.ServerOptions> = {}
) =>
  Effect.gen(function* () {
    const { layer: model, recorder } = yield* FakeModel.script(turns)
    const http = yield* Layer.build(
      HttpRouter.serve(
        OpenAiAgent.serverLayer({ model: "agent", ...options }).pipe(
          Layer.provide(AgentClient.layer(agent)),
          Layer.provide(model)
        ),
        { disableLogger: true, disableListenLog: true }
      ).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(createServer, { port: 0, disablePreemptiveShutdown: true })
        )
      )
    )
    const address = HttpServer.formatAddress(
      (yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(http))).address
    )
    return { address, recorder }
  })

export const post = (
  address: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  Effect.promise(() =>
    fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    })
  )

export const json = <A, I>(schema: Schema.Codec<A, I>) =>
  (response: Response) =>
    Effect.promise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema)))
    )

export const completion = json(OpenAiSchema.ChatCompletionResponse)
export const errorBody = json(OpenAiSchema.ErrorResponse)

/** Read an SSE body to the end and decode its `data:` payloads. */
export const readStream = (response: Response) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => response.text())
    const payloads = text
      .split("\n\n")
      .map((frame) => frame.trim())
      .filter((frame) => frame.startsWith("data:"))
      .map((frame) => frame.slice("data:".length).trim())
    const done = payloads[payloads.length - 1] === "[DONE]"
    const values = payloads.filter((p) => p !== "[DONE]").map((p) => JSON.parse(p) as unknown)
    const isError = (v: unknown) => typeof v === "object" && v !== null && "error" in v
    const chunks = yield* Effect.forEach(
      values.filter((v) => !isError(v)),
      (v) => Schema.decodeUnknownEffect(Schema.toCodecJson(OpenAiSchema.ChatCompletionChunk))(v)
    )
    const errors = yield* Effect.forEach(
      values.filter(isError),
      (v) => Schema.decodeUnknownEffect(Schema.toCodecJson(OpenAiSchema.ErrorResponse))(v)
    )
    return {
      done,
      chunks,
      errors: errors.map((e) => e.error),
      text: chunks.map((c) => c.choices[0]?.delta.content ?? "").join(""),
      finish: chunks.flatMap((c) => (c.choices[0]?.finish_reason ? [c.choices[0].finish_reason] : []))
    }
  })

