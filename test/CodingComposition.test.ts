import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as Permission from "../src/Permission.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Can an application take this battery and make it its own?
 *
 * The toolkit is only useful if it is a starting point rather than a package
 * deal: swap one tool's implementation, drop a tool, add one, or reuse a single
 * tool on its own. Each of these is written the way a user would write it --
 * **no casts and no hand-annotated parameters anywhere in this file**, which is
 * the actual claim being tested. If any of it needed a cast, the library's
 * signatures would be wrong.
 */

// ---------------------------------------------------------------------------
// Inference assertions. `any` compiles, so the tests below would pass even if
// every overriding handler's parameters had silently degraded -- which is the
// exact failure this file exists to rule out. These check the types instead.
// ---------------------------------------------------------------------------

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type Not<T extends boolean> = T extends true ? false : true

/** The shipped handler record, as an application would name it to extend it. */
type Handlers = typeof CodingToolkit.handlers

/** The parameters an overriding `search` handler receives. */
type SearchParams = Parameters<Handlers["search"]>[0]

export type _SearchParamsNotAny = Assert<Not<IsAny<SearchParams>>>
export type _SearchPatternIsString = Assert<SearchParams["pattern"] extends string ? true : false>
/** `include` is optional, so it must admit `undefined` rather than being lost. */
export type _SearchIncludeOptional = Assert<
  undefined extends SearchParams["include"] ? true : false
>

/** An overriding handler must still return the tool's declared success type. */
type SearchSuccess = Effect.Success<ReturnType<Handlers["search"]>>
export type _SearchSuccessNotAny = Assert<Not<IsAny<SearchSuccess>>>
export type _SearchSuccessIsString = Assert<SearchSuccess extends string ? true : false>

/** Reading a file yields a string, not `any`, through the same record. */
type ReadSuccess = Effect.Success<ReturnType<Handlers["read_file"]>>
export type _ReadSuccessIsString = Assert<ReadSuccess extends string ? true : false>

const ws = Sandbox.workspace("test")
const ctx = { preliminary: () => Effect.void }

const sandboxLayer = (files: Record<string, string>) =>
  Sandbox.currentLayer(ws).pipe(Layer.provide(MemorySandbox.layer({ seed: files })))

const withSandbox = <A, E>(files: Record<string, string>, use: Effect.Effect<A, E, Sandbox.Current>) =>
  use.pipe(Effect.provide(sandboxLayer(files)), Effect.scoped)

describe("composition: replacing one tool's implementation", () => {
  it.effect("keeps the toolkit but swaps the search handler", () =>
    Effect.gen(function* () {
      // An application with its own index answers `search` itself, and keeps
      // every other tool as shipped.
      //
      // The annotation is load-bearing, and is the one ergonomic wrinkle in
      // this file: a bare object literal has no contextual type, so the
      // override's parameters would infer as `any`. Naming the handler record's
      // type restores inference -- `pattern` below is `string`, not `any`, and
      // the call takes (params, ctx) like every other handler. Passing the
      // literal straight to `Agent.toolkit` needs no annotation at all, because
      // there the parameter position supplies the type (see the next test).
      const handlers: typeof CodingToolkit.handlers = {
        ...CodingToolkit.handlers,
        search: ({ pattern }) => Effect.succeed(`indexed answer for ${pattern}`)
      }
      const out = yield* withSandbox(
        { "a.ts": "needle" },
        Effect.gen(function* () {
          const mine = yield* handlers.search({ pattern: "needle" }, ctx)
          const theirs = yield* CodingToolkit.handlers.search({ pattern: "needle" }, ctx)
          return { mine, theirs }
        })
      )
      assert.strictEqual(out.mine, "indexed answer for needle")
      // The shipped implementation is untouched by the override.
      assert.include(out.theirs, "a.ts:")
    })
  )

  it.effect("the swapped handler runs in a real session", () =>
    Effect.gen(function* () {
      const agent = Agent.make({
        instructions: "You search.",
        toolkit: Agent.toolkit(CodingToolkit.tools, {
          ...CodingToolkit.handlers,
          search: ({ pattern }) => Effect.succeed(`INDEX HIT: ${pattern}`)
        }),
        loop: AgentLoop.bounded(4)
      })
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "s", name: "search", params: { pattern: "foo" } }] },
        TestLanguageModel.text("done")
      ])
      const history = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("find foo")
        return yield* session.history
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, sandboxLayer({ "a.ts": "foo" }))),
        Effect.scoped
      )
      const results = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      assert.include(JSON.stringify(results[0]), "INDEX HIT: foo")
    })
  )
})

describe("composition: taking a subset", () => {
  it.effect("a read-only toolkit is just a shorter array", () =>
    Effect.gen(function* () {
      const readOnly = Agent.toolkit(
        [CodingToolkit.ReadFile, CodingToolkit.ListFiles],
        {
          read_file: CodingToolkit.handlers.read_file,
          list_files: CodingToolkit.handlers.list_files
        }
      )
      const agent = Agent.make({
        instructions: "You read.",
        toolkit: readOnly,
        loop: AgentLoop.bounded(4)
      })
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "r", name: "read_file", params: { path: "a.ts" } }] },
        TestLanguageModel.text("read it")
      ])
      const text = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("read a.ts")
        return result.text
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, sandboxLayer({ "a.ts": "hello" }))),
        Effect.scoped
      )
      assert.strictEqual(text, "read it")
    })
  )
})

describe("composition: adding a tool of your own", () => {
  it.effect("an application tool sits beside the battery", () =>
    Effect.gen(function* () {
      const Deploy = Tool.make("deploy", {
        description: "Deploy the current build.",
        parameters: Schema.Struct({ environment: Schema.String }),
        success: Schema.String,
        failure: Schema.String
      })

      const agent = Agent.make({
        instructions: "You ship code.",
        toolkit: Agent.toolkit([...CodingToolkit.tools, Deploy], {
          ...CodingToolkit.handlers,
          deploy: ({ environment }) => Effect.succeed(`deployed to ${environment}`)
        }),
        loop: AgentLoop.bounded(4)
      })
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "d", name: "deploy", params: { environment: "prod" } }] },
        TestLanguageModel.text("shipped")
      ])
      const history = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        yield* session.prompt("ship it")
        return yield* session.history
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, sandboxLayer({}))),
        Effect.scoped
      )
      const results = history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      assert.include(JSON.stringify(results[0]), "deployed to prod")
    })
  )
})

describe("composition: one tool on its own", () => {
  it.effect("a single bound tool carries its own handler", () =>
    Effect.gen(function* () {
      // The form `examples/full-stack-agent.ts` uses: pick a tool, bind it, and
      // put it in an unrelated agent.
      const readFile = Agent.tool(CodingToolkit.ReadFile, CodingToolkit.handlers.read_file)
      const agent = Agent.make({
        instructions: "You answer questions about files.",
        tools: [readFile],
        loop: AgentLoop.bounded(4)
      })
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "r", name: "read_file", params: { path: "a.ts" } }] },
        TestLanguageModel.text("it says hello")
      ])
      const text = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("what is in a.ts?")
        return result.text
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, sandboxLayer({ "a.ts": "hello" }))),
        Effect.scoped
      )
      assert.strictEqual(text, "it says hello")
    })
  )

  it.effect("a replacement tool can be re-annotated for policy", () =>
    Effect.gen(function* () {
      // An application replacing `search` with a remote index may want it
      // gated as a network call rather than a read. The projection is the
      // tool's, so re-annotating is how that is said.
      const Remote = Permission.annotate(
        Tool.make("search", {
          description: "Search the company index.",
          parameters: Schema.Struct({ pattern: Schema.String }),
          success: Schema.String,
          failure: Schema.String
        }),
        { action: "net", resource: (params) => params.pattern }
      )
      const projection = Permission.projectionOf(Remote)
      assert.strictEqual(projection.action, "net")
      assert.strictEqual(projection.resource({ pattern: "foo" }), "foo")
      // And the shipped one still projects as a read.
      assert.strictEqual(Permission.projectionOf(CodingToolkit.Search).action, "read")
      return yield* Effect.void
    })
  )
})
