import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { Headers } from "effect/unstable/http"
import * as AgentEvent from "../src/AgentEvent.js"
import * as McpToolkit from "../src/mcp/McpToolkit.js"
import { OpenApi, ToolSource } from "../src/toolSource/index.js"
import * as GraphQL from "../src/toolSource/graphql.js"

/**
 * Regression guards for findings that were fixed.
 *
 * **Every assertion here is behavioural.** An earlier version of this file
 * checked the fixes by reading the source and asserting that a substring was
 * present -- `src.includes("Reflect.get(response.usage")`, and nineteen more
 * like it. That does not test the fix, it tests the spelling of the fix: it
 * breaks when a local is renamed and passes when the bug returns by another
 * route. Several of those assertions could not fail at all, because the mock
 * whose absence they were asserting was never wired to anything.
 *
 * So the rule for this file is that a guard runs the code and looks at what it
 * produced. Where that is hard, the difficulty is a finding about the seam,
 * not a licence to inspect the source instead.
 */

const petSpec = {
  openapi: "3.0.0",
  paths: {
    "/pet/{id}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "ok" } }
      }
    }
  }
}

describe("regression guards", () => {
  describe("credentials reach the wire without entering the tool schema", () => {
    it.effect("an OpenAPI source sends resolved headers per invocation", () =>
      Effect.gen(function*() {
        let resolutions = 0
        const captured: Array<Record<string, string>> = []
        const mockFetch: typeof fetch = async (_input, init) => {
          captured.push((init?.headers ?? {}) as Record<string, string>)
          return Response.json({ ok: true })
        }
        const source = OpenApi.makeOpenApiSource("pets", petSpec, {
          endpoint: "https://api.example.com",
          fetchImpl: mockFetch,
          headers: Effect.sync(() => {
            resolutions += 1
            return Headers.fromInput({
              authorization: `Bearer token-${resolutions}`
            })
          })
        })

        const extraction = yield* source.extract
        for (const tool of extraction.tools) {
          assert.notInclude(
            JSON.stringify(tool.input),
            "authorization",
            "a credential must never become a model-visible parameter"
          )
        }

        yield* source.invoke("getpet", { id: "1" })
        yield* source.invoke("getpet", { id: "2" })

        // Per invocation, not once at extract: a token that rotates between
        // calls has to be picked up, and a resolver consulted once cannot.
        assert.strictEqual(resolutions, 2)
        assert.deepStrictEqual(
          captured.map((headers) => headers["authorization"]),
          ["Bearer token-1", "Bearer token-2"]
        )
      }))

    it.effect("a GraphQL source does the same", () =>
      Effect.gen(function*() {
        let resolutions = 0
        let seen: Record<string, string> | undefined
        const mockFetch: typeof fetch = async (_input, init) => {
          seen = (init?.headers ?? {}) as Record<string, string>
          return Response.json({ data: { ping: "pong" } })
        }
        const source = GraphQL.makeGraphQLSource("gql", {
          __schema: {
            queryType: { name: "Query" },
            types: [
              {
                kind: "OBJECT",
                name: "Query",
                fields: [
                  { name: "ping", args: [], type: { kind: "SCALAR", name: "String" } }
                ]
              },
              { kind: "SCALAR", name: "String" }
            ]
          }
        }, {
          endpoint: "https://api.example.com/graphql",
          fetchImpl: mockFetch,
          headers: Effect.sync(() => {
            resolutions += 1
            return Headers.fromInput({ authorization: "Bearer secret" })
          })
        })

        const extraction = yield* source.extract
        for (const tool of extraction.tools) {
          assert.notInclude(JSON.stringify(tool.input), "authorization")
        }
        const result = yield* source.invoke("ping", {})
        assert.strictEqual(result, "pong")
        assert.strictEqual(resolutions, 1)
        assert.strictEqual(seen?.["authorization"], "Bearer secret")
      }))
  })

  describe("a hostile source cannot crash the fiber", () => {
    const hostile: ToolSource.ToolSource = {
      id: "hostile",
      extract: Effect.succeed({
        tools: [
          { name: "bad\nname", description: "a newline in a tool name" },
          { name: "x".repeat(400), description: "a very long tool name" },
          { name: "ok_tool", input: Schema.String }
        ],
        skipped: [{ name: "also\nbad", reason: "should not throw either" }]
      }),
      invoke: () => Effect.succeed("x")
    }

    it.effect("bindDiscovered keeps the good tool and drops the rest", () =>
      Effect.gen(function*() {
        const toolkit = yield* ToolSource.bindDiscovered(hostile)
        assert.isTrue("ok_tool" in toolkit.tools)
        assert.isFalse("bad\nname" in toolkit.tools)
        assert.isFalse("x".repeat(400) in toolkit.tools)
      }))

    /**
     * The asymmetry is the point, so both halves are pinned.
     *
     * A name in a `Tool.make` the application wrote is programmer error, and a
     * defect is this repository's convention for that -- the same call
     * `positiveInteger` makes. A name a *remote server* offered is untrusted
     * input arriving over a socket, and crashing the fiber that was merely
     * wiring the source is the wrong answer for it.
     */
    it.effect("a bad remote name is typed; the tool is simply not offered", () =>
      Effect.gen(function*() {
        const Declared = Tool.make("ok_tool", {
          parameters: Schema.Struct({}),
          success: Schema.String
        })
        // `ok_tool` *is* offered, so this succeeds despite the source also
        // offering two names that would once have thrown during extraction.
        const bound = yield* ToolSource.bind(hostile, [Declared])
        assert.isTrue("ok_tool" in bound.tools)

        const Missing = Tool.make("not_offered", {
          parameters: Schema.Struct({}),
          success: Schema.String
        })
        const exit = yield* Effect.exit(ToolSource.bind(hostile, [Missing]))
        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) {
          assert.isFalse(
            Cause.hasDies(exit.cause),
            "a source that does not offer a tool is a typed failure"
          )
          const rendered = JSON.stringify(exit)
          assert.include(rendered, "ToolSourceMissingError")
          // The malformed names are excluded from `offered` rather than
          // reported as available.
          assert.notInclude(rendered, "bad\\nname")
        }
      }))
  })

  describe("MCP errors keep their kind across the seam", () => {
    const connectionFailing = (
      error:
        | McpToolkit.McpTransportError
        | McpToolkit.McpToolError
        | McpToolkit.McpUnsupportedContentError
    ): McpToolkit.Connection => ({
      listTools: Effect.succeed([
        { name: "search", inputSchema: { type: "object" } }
      ]),
      callTool: () => Effect.fail(error)
    })

    it.effect("a transport error becomes an InvocationError", () =>
      Effect.gen(function*() {
        const source = ToolSource.fromMcpConnection(
          "mcp",
          connectionFailing(new McpToolkit.McpTransportError({ detail: "boom" }))
        )
        const exit = yield* Effect.exit(source.invoke("search", {}))
        assert.isTrue(Exit.isFailure(exit))
        const rendered = JSON.stringify(exit)
        assert.include(rendered, "ToolSourceInvocationError")
        assert.include(rendered, "boom")
      }))

    it.effect("a tool error stays a tool error, so FailurePolicy can see it", () =>
      Effect.gen(function*() {
        const source = ToolSource.fromMcpConnection(
          "mcp",
          connectionFailing(
            new McpToolkit.McpToolError({ error: { reason: "bad input" } })
          )
        )
        const exit = yield* Effect.exit(source.invoke("search", {}))
        assert.isTrue(Exit.isFailure(exit))
        const rendered = JSON.stringify(exit)
        assert.include(rendered, "ToolSourceToolError")
        assert.include(rendered, "bad input")
      }))

    it.effect("an unsupported-content error is transport, not tool", () =>
      Effect.gen(function*() {
        const source = ToolSource.fromMcpConnection(
          "mcp",
          connectionFailing(
            new McpToolkit.McpUnsupportedContentError({
              toolName: "search",
              contentTypes: ["image/png"]
            })
          )
        )
        const exit = yield* Effect.exit(source.invoke("search", {}))
        assert.include(JSON.stringify(exit), "ToolSourceInvocationError")
      }))
  })

  describe("OpenAPI request building", () => {
    it.effect("substitutes a path parameter used more than once", () =>
      Effect.gen(function*() {
        let url = ""
        const mockFetch: typeof fetch = async (input) => {
          url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url
          return Response.json({ ok: true })
        }
        const source = OpenApi.makeOpenApiSource("repeat", {
          openapi: "3.0.0",
          paths: {
            "/a/{id}/b/{id}": {
              get: {
                operationId: "getA",
                parameters: [
                  { name: "id", in: "path", required: true, schema: { type: "string" } }
                ],
                responses: { "200": { description: "ok" } }
              }
            }
          }
        }, {
          endpoint: "https://api.example.com",
          fetchImpl: mockFetch
        })
        yield* source.invoke("geta", { id: "7" })
        assert.strictEqual(url, "https://api.example.com/a/7/b/7")
      }))

    it("an array where an object belongs is skipped, not turned into tools", () => {
      const extraction = OpenApi.extractOpenApi({
        openapi: "3.0.0",
        paths: [] as unknown
      })
      assert.deepStrictEqual(extraction.tools, [])
      assert.isAtLeast(extraction.skipped.length, 1)
    })

    it.effect("an unrecognised argument is reported, not dropped", () =>
      Effect.gen(function*() {
        let called = false
        const mockFetch: typeof fetch = async () => {
          called = true
          return Response.json({})
        }
        const source = OpenApi.makeOpenApiSource("pets", petSpec, {
          endpoint: "https://api.example.com",
          fetchImpl: mockFetch
        })
        const exit = yield* Effect.exit(
          source.invoke("getpet", { id: "1", unknownParam: "evil" })
        )
        assert.isTrue(Exit.isFailure(exit))
        assert.include(JSON.stringify(exit), "unknownParam")
        assert.isFalse(called, "a request missing an argument must not be sent")
      }))
  })

  describe("model usage is a count, and counts are natural", () => {
    it("rejects NaN, negatives and fractions", () => {
      const decode = Schema.decodeUnknownSync(AgentEvent.ModelUsage)
      assert.deepStrictEqual(
        decode({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
        { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
      )
      for (const bad of [
        { inputTokens: -1, outputTokens: 0, totalTokens: 0 },
        { inputTokens: Number.NaN, outputTokens: 0, totalTokens: 0 },
        { inputTokens: 0, outputTokens: 0, totalTokens: -5 },
        { inputTokens: 1.5, outputTokens: 0, totalTokens: 0 }
      ]) {
        assert.throws(
          () => decode(bad),
          undefined,
          undefined,
          `${JSON.stringify(bad)} is not a token count`
        )
      }
    })
  })

  describe("an object-valued parameter is serialised, not stringified (#64)", () => {
    /**
     * The bug was `String(value)` on an object: the request carried the
     * literal `[object Object]`. Each case below asserts the *whole* URL or
     * header value, because a substring assertion would have passed against
     * `?filter=%5Bobject+Object%5D` too.
     */
    const objectSpec = (paramIn: string, explode: boolean | undefined) => ({
      openapi: "3.0.0",
      paths: {
        [paramIn === "path" ? "/search/{filter}" : "/search"]: {
          get: {
            operationId: "search",
            parameters: [
              {
                name: "filter",
                in: paramIn,
                required: true,
                ...(explode === undefined ? {} : { explode }),
                schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } }
              }
            ],
            responses: { "200": { description: "ok" } }
          }
        }
      }
    })

    // `seen.headers` is normalised through the platform `Headers` rather than
    // kept as the raw `HeadersInit`, so the assertion compares one shape
    // whatever form the caller happened to build the init in.
    const capturing = () => {
      const seen: { url: string; headers: Record<string, string> } = { url: "", headers: {} }
      const fetchImpl: typeof fetch = async (input, init) => {
        seen.url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        seen.headers = {}
        for (const [key, value] of new globalThis.Headers(init?.headers)) seen.headers[key] = value
        return Response.json({ ok: true })
      }
      return { seen, fetchImpl }
    }

    it("form + explode true (the query default) spreads the object's entries", async () => {
      const { fetchImpl, seen } = capturing()
      const source = OpenApi.makeOpenApiSource("s", objectSpec("query", undefined), "https://api.example.com", fetchImpl)
      await Effect.runPromise(source.invoke("search", { filter: { a: "1", b: "2" } }))
      assert.strictEqual(seen.url, "https://api.example.com/search?a=1&b=2")
    })

    it("form + explode false joins the object under the parameter's own name", async () => {
      const { fetchImpl, seen } = capturing()
      const source = OpenApi.makeOpenApiSource("s", objectSpec("query", false), "https://api.example.com", fetchImpl)
      await Effect.runPromise(source.invoke("search", { filter: { a: "1", b: "2" } }))
      assert.strictEqual(seen.url, "https://api.example.com/search?filter=a%2C1%2Cb%2C2")
    })

    it("simple + explode false (the path default) writes a,1,b,2 into the path", async () => {
      const { fetchImpl, seen } = capturing()
      const source = OpenApi.makeOpenApiSource("s", objectSpec("path", undefined), "https://api.example.com", fetchImpl)
      await Effect.runPromise(source.invoke("search", { filter: { a: "1", b: "2" } }))
      assert.strictEqual(seen.url, "https://api.example.com/search/a,1,b,2")
    })

    it("simple + explode true writes a=1,b=2 into the header", async () => {
      const { fetchImpl, seen } = capturing()
      const source = OpenApi.makeOpenApiSource("s", objectSpec("header", true), "https://api.example.com", fetchImpl)
      await Effect.runPromise(source.invoke("search", { filter: { a: "1", b: "2" } }))
      assert.deepStrictEqual(seen.headers, { filter: "a=1,b=2" })
    })

    it("refuses a nested object at extraction, naming the parameter", () => {
      const nested = {
        openapi: "3.0.0",
        paths: {
          "/search": {
            get: {
              operationId: "search",
              parameters: [
                {
                  name: "filter",
                  in: "query",
                  schema: { type: "object", properties: { deep: { type: "object", properties: { a: { type: "string" } } } } }
                }
              ],
              responses: { "200": { description: "ok" } }
            }
          }
        }
      }
      const extraction = OpenApi.extractOpenApi(nested)
      assert.deepStrictEqual(extraction.tools, [])
      assert.deepStrictEqual(extraction.skipped, [{
        name: "search",
        reason:
          'object parameter "filter" has nested member(s) deep — only flat objects can be encoded as form'
      }])
    })
  })

  describe("$ref chains are depth-bounded and the size fallback counts bytes (#65)", () => {
    it("a 10,000-link $ref chain reports the pointer instead of overflowing", () => {
      const parameters: Record<string, unknown> = {}
      for (let i = 0; i < 10_000; i++) {
        parameters[`p${i}`] = { $ref: `#/components/parameters/p${i + 1}` }
      }
      parameters["p10000"] = { name: "id", in: "query", schema: { type: "string" } }
      const spec = {
        openapi: "3.0.0",
        components: { parameters },
        paths: {
          "/thing": {
            get: {
              operationId: "getThing",
              parameters: [{ $ref: "#/components/parameters/p0" }],
              responses: { "200": { description: "ok" } }
            }
          }
        }
      }
      const extraction = OpenApi.extractOpenApi(spec)
      assert.deepStrictEqual(extraction.tools, [])
      assert.strictEqual(extraction.skipped.length, 1)
      const reason = extraction.skipped[0]?.reason ?? ""
      // The pointer, not the stack: the reason must name where it gave up.
      assert.match(reason, /^unresolvable parameter \$ref: #\/components\/parameters\/p\d+$/)
    })

    it("refuses a multi-byte body over the byte cap on the non-stream path", async () => {
      // `body` is null, so `readBounded` takes the `text()` fallback -- the
      // path that used to compare UTF-16 code units against a byte cap.
      // 50 three-byte characters: 44 code units of JSON, 144 bytes of it.
      const payload = JSON.stringify({ a: "€".repeat(50) })
      assert.isBelow(payload.length, 100)
      assert.isAbove(new TextEncoder().encode(payload).byteLength, 100)
      const fetchImpl: typeof fetch = async () => {
        const response = new Response(payload, { headers: { "content-type": "application/json" } })
        // `defineProperty` rather than a subclass: `Response.body` is a
        // prototype getter, and a subclass field would be an accessor
        // overriding a property -- which does not typecheck and would have
        // needed a cast. Shadowing the instance is honest and cast-free.
        Object.defineProperty(response, "body", { value: null })
        return response
      }
      const source = OpenApi.makeOpenApiSource("s", petSpec, {
        endpoint: "https://api.example.com",
        fetchImpl,
        maxResponseBytes: 100
      })
      const exit = await Effect.runPromiseExit(source.invoke("getpet", { id: "1" }))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(JSON.stringify(exit), "response too large: exceeded 100 bytes")
    })
  })
})
