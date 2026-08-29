import { describe, it, assert } from "@effect/vitest"
import { Effect, Exit, Predicate, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import { ToolSource, OpenApi } from "../src/toolSource/index.js"

const Echo = Tool.make("echo", {
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.Struct({ echoed: Schema.String })
})

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T

type _EchoParameters = Assert<
  Equal<Tool.Parameters<typeof Echo>, { readonly text: string }>
>

describe("ToolSource seam", () => {
  const fakeSource: ToolSource.ToolSource = {
    id: "fake",
    extract: Effect.succeed({
      tools: [
        {
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String })
        },
        {
          name: "add",
          description: "Add numbers",
          input: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }
        }
      ],
      skipped: [{ name: "bad_op", reason: "binary response not representable" }]
    }),
    invoke: (name, args) =>
      Effect.gen(function* () {
        if (name === "echo") {
          const text = Predicate.isObject(args) && "text" in args
            ? String(args.text)
            : ""
          return { echoed: text }
        }
        if (name === "add") {
          const a = Predicate.isObject(args) && "a" in args
            ? Number(args.a)
            : 0
          const b = Predicate.isObject(args) && "b" in args
            ? Number(args.b)
            : 0
          return { sum: a + b }
        }
        return null
      })
  }

  it("bindDiscovered creates a toolkit from extraction", async () => {
    const toolkit = await Effect.runPromise(ToolSource.bindDiscovered(fakeSource))
    // Two tools, first wins on collision, skipped not included.
    assert.isTrue("echo" in toolkit.tools)
    assert.isTrue("add" in toolkit.tools)
    assert.isFalse("bad_op" in toolkit.tools)
    const call = Effect.flatMap(
      toolkit.handle("echo", { text: "hello" }),
      Stream.runCollect
    )
    type _CallServices = Assert<Equal<Effect.Services<typeof call>, never>>
    const emitted = await Effect.runPromise(call)
    assert.deepStrictEqual(emitted[emitted.length - 1]?.result, {
      echoed: "hello"
    })
  })

  it("bind verifies declared tools against extraction", async () => {
    const binding = ToolSource.bind(fakeSource, [Echo])
    type _BindingError = Assert<
      Equal<
        Effect.Error<typeof binding>,
        ToolSource.ExtractionError | ToolSource.ToolSourceMissingError
      >
    >
    const toolkit = await Effect.runPromise(binding)
    assert.isTrue("echo" in toolkit.tools)
    const emitted = await Effect.runPromise(
      Effect.flatMap(toolkit.handle("echo", { text: "typed" }), Stream.runCollect)
    )
    assert.deepStrictEqual(emitted[emitted.length - 1]?.result, {
      echoed: "typed"
    })

    const Missing = Tool.make("missing", {
      parameters: Schema.Struct({ x: Schema.String }),
      success: Schema.String
    })

    const exit = await Effect.runPromiseExit(ToolSource.bind(fakeSource, [Missing]))
    assert.isTrue(Exit.isFailure(exit))
  })

  it("skipped is carried alongside tools", async () => {
    const extraction = await Effect.runPromise(fakeSource.extract)
    assert.strictEqual(extraction.skipped.length, 1)
    assert.strictEqual(extraction.skipped[0]!.name, "bad_op")
    assert.isTrue(extraction.skipped[0]!.reason.length > 0)
  })

  it("fromMcpConnection adapts an MCP connection", async () => {
    const source = ToolSource.fromMcpConnection("mcp-fake", {
      listTools: Effect.succeed([
        { name: "search", description: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }
      ]),
      callTool: (_name, params) =>
        Effect.succeed({
          hits: [
            Predicate.isObject(params) && "q" in params
              ? String(params.q)
              : ""
          ]
        })
    })
    const toolkit = await Effect.runPromise(ToolSource.bindDiscovered(source))
    assert.isTrue("search" in toolkit.tools)
  })

  it("OpenAPI extractor skips unsupported operations with reasons", async () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/pet": {
          get: {
            operationId: "getPet",
            description: "Get pet",
            parameters: [{ name: "id", in: "query", schema: { type: "string" }, required: true }],
            responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } } }
          },
          post: {
            operationId: "createPet",
            requestBody: {
              content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
              required: true
            },
            responses: { "200": { description: "ok" } }
          },
          delete: {
            operationId: "deletePet",
            parameters: [{ name: "id", in: "query", style: "matrix", schema: { type: "string" } }],
            responses: { "200": { description: "ok" } }
          }
        },
        "/upload": {
          post: {
            operationId: "upload",
            requestBody: { content: { "multipart/form-data": { schema: { type: "object" } } } },
            responses: { "200": { description: "ok" } }
          }
        }
      }
    }

    const extraction = OpenApi.extractOpenApi(spec)
    const names = extraction.tools.map((tool) => tool.name).sort()
    assert.deepStrictEqual(names, ["createpet", "getpet"])
    assert.strictEqual(extraction.skipped.length, 2)
    const skippedNames = extraction.skipped.map((s) => s.name).sort()
    assert.deepStrictEqual(skippedNames, ["deletepet", "upload"])
    // Non-GET carries requiresApproval
    const create = extraction.tools.find((tool) => tool.name === "createpet")
    assert.isTrue(create?.annotations?.requiresApproval === true)
    const get = extraction.tools.find((tool) => tool.name === "getpet")
    assert.isTrue(get?.annotations === undefined)
    // Cross-check via ToolSource
    const source = OpenApi.makeOpenApiSource("petstore", spec)
    const toolkit = await Effect.runPromise(ToolSource.bindDiscovered(source))
    assert.isTrue("getpet" in toolkit.tools)
    assert.isTrue("createpet" in toolkit.tools)
    assert.isFalse("upload" in toolkit.tools)
  })

  it("GraphQL extractor walks Query/Mutation and adds select", async () => {
    const introspection = {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "user",
                description: "Get user",
                args: [{ name: "id", description: "ID", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } }, defaultValue: null }],
                type: { kind: "OBJECT", name: "User" }
              },
              {
                name: "posts",
                args: [{ name: "limit", type: { kind: "SCALAR", name: "Int" }, defaultValue: null }],
                type: { kind: "LIST", ofType: { kind: "OBJECT", name: "Post" } }
              }
            ]
          },
          {
            kind: "OBJECT",
            name: "Mutation",
            fields: [
              {
                name: "createPost",
                args: [{ name: "title", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } }, defaultValue: null }],
                type: { kind: "OBJECT", name: "Post" }
              }
            ]
          },
          { kind: "OBJECT", name: "User", fields: [] },
          { kind: "OBJECT", name: "Post", fields: [] },
          { kind: "SCALAR", name: "ID" },
          { kind: "SCALAR", name: "String" },
          { kind: "SCALAR", name: "Int" }
        ]
      }
    }

    const GraphQL = await import("../src/toolSource/graphql.js")
    const extraction = GraphQL.extractGraphQL(introspection)
    const names = extraction.tools.map((tool: { name: string }) => tool.name).sort()
    assert.deepStrictEqual(names, ["createPost", "posts", "user"])
    // select control input present on each
    for (const tool of extraction.tools) {
      assert.isTrue(
        Predicate.isObject(tool.input) &&
          "properties" in tool.input &&
          Predicate.isObject(tool.input.properties) &&
          "select" in tool.input.properties
      )
    }
    // Mutation carries requiresApproval
    const create = extraction.tools.find((tool: { name: string }) => tool.name === "createPost")
    assert.isTrue(create?.annotations?.requiresApproval === true)
    const user = extraction.tools.find((tool: { name: string }) => tool.name === "user")
    assert.isTrue(user?.annotations === undefined)

    const source = GraphQL.makeGraphQLSource("api", introspection, "https://api.example.com/graphql")
    const toolkit = await Effect.runPromise(ToolSource.bindDiscovered(source))
    assert.isTrue("user" in toolkit.tools)
    assert.isTrue("createPost" in toolkit.tools)
  })

  it("OpenAPI invoke builds URL, query, and body via fetch", async () => {
    const spec = {
      openapi: "3.0.0",
      paths: {
        "/pet/{id}": {
          get: {
            operationId: "getPetById",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } }
          }
        },
        "/pet": {
          post: {
            operationId: "createPet",
            requestBody: {
              content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
              required: true
            },
            responses: { "200": { description: "ok" } }
          }
        }
      }
    }

    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url
      capturedInit = init
      return Response.json({ id: "123", name: "Fluffy" })
    }

    const source = OpenApi.makeOpenApiSource("petstore", spec, "https://api.example.com", mockFetch)
    // GET with path param
    const getResult = await Effect.runPromise(source.invoke("getpetbyid", { id: "123" }))
    assert.deepStrictEqual(getResult, { id: "123", name: "Fluffy" })
    assert.strictEqual(capturedUrl, "https://api.example.com/pet/123")
    assert.strictEqual(capturedInit?.method, "GET")

    // POST with body
    const postResult = await Effect.runPromise(source.invoke("createpet", { name: "Whiskers" }))
    assert.deepStrictEqual(postResult, { id: "123", name: "Fluffy" })
    assert.strictEqual(capturedUrl, "https://api.example.com/pet")
    assert.strictEqual(capturedInit?.method, "POST")
    const body = JSON.parse(String(capturedInit?.body))
    assert.deepStrictEqual(body, { name: "Whiskers" })
  })

  it("GraphQL invoke splices select and validates before fetch", async () => {
    const introspection = {
      __schema: {
        queryType: { name: "Query" },
        types: [
          { kind: "OBJECT", name: "Query", fields: [{ name: "user", args: [{ name: "id", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } } }], type: { kind: "OBJECT", name: "User" } }] },
          { kind: "OBJECT", name: "User", fields: [] },
          { kind: "SCALAR", name: "ID" }
        ]
      }
    }

    let capturedBody: unknown
    const mockFetch: typeof fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body))
      return Response.json({ data: { user: { id: "1", name: "Ada" } } })
    }

    const source = (await import("../src/toolSource/graphql.js")).makeGraphQLSource(
      "gql",
      introspection,
      "https://api.example.com/graphql",
      mockFetch
    )

    const result = await Effect.runPromise(source.invoke("user", { id: "1", select: "name email" }))
    assert.deepStrictEqual(result, { id: "1", name: "Ada" })
    const body = Schema.decodeUnknownSync(
      Schema.Struct({ query: Schema.String })
    )(capturedBody)
    assert.isTrue(body.query.includes("user"))
    assert.isTrue(body.query.includes("name email"))

    // Invalid select should fail before fetch
    const badFetch: typeof fetch = async () => {
      throw new Error("should not be called")
    }
    const badSource = (await import("../src/toolSource/graphql.js")).makeGraphQLSource(
      "gql2",
      introspection,
      "https://api.example.com/graphql",
      badFetch
    )
    const exit = await Effect.runPromiseExit(badSource.invoke("user", { id: "1", select: "} malicious {" }))
    assert.isTrue(Exit.isFailure(exit))
  })
})

/**
 * Bounds that actually bound.
 *
 * A limit checked after `response.json()` has already let the whole payload
 * into memory, which is the cost it exists to avoid. These assert the limit
 * fires on a body that never declares its length -- the chunked case, where a
 * `content-length` check cannot help.
 */
describe("OpenAPI response limits", () => {
  const pingSpec = {
    openapi: "3.0.0",
    paths: {
      "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } }
    }
  }

  /** A chunked JSON response with no content-length, of roughly `bytes`. */
  const chunked = (bytes: number): Response => {
    const chunk = new TextEncoder().encode("x".repeat(1024))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes) {
          controller.close()
          return
        }
        sent += chunk.byteLength
        controller.enqueue(chunk)
      }
    })
    return new Response(stream, {
      headers: { "content-type": "application/json" }
    })
  }

  it.effect("refuses a body that exceeds the cap without a content-length", () =>
    Effect.gen(function*() {
      const mockFetch: typeof fetch = async () => chunked(64 * 1024)
      const source = OpenApi.makeOpenApiSource("ping", pingSpec, {
        endpoint: "https://api.example.com",
        fetchImpl: mockFetch,
        maxResponseBytes: 8 * 1024
      })
      const exit = yield* Effect.exit(source.invoke("ping", {}))
      assert.isTrue(Exit.isFailure(exit))
      assert.include(JSON.stringify(exit), "too large")
    }))

  it.effect("accepts a body under the cap", () =>
    Effect.gen(function*() {
      const mockFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" }
        })
      const source = OpenApi.makeOpenApiSource("ping", pingSpec, {
        endpoint: "https://api.example.com",
        fetchImpl: mockFetch,
        maxResponseBytes: 8 * 1024
      })
      const result = yield* source.invoke("ping", {})
      assert.deepStrictEqual(result, { ok: true })
    }))

  it.effect("passes an abort signal so a timeout cancels the request", () =>
    Effect.gen(function*() {
      let observed: AbortSignal | undefined
      const mockFetch: typeof fetch = async (_input, init) => {
        observed = init?.signal ?? undefined
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" }
        })
      }
      const source = OpenApi.makeOpenApiSource("ping", pingSpec, {
        endpoint: "https://api.example.com",
        fetchImpl: mockFetch
      })
      yield* source.invoke("ping", {})
      // Without this the timeout abandons the promise and the connection is
      // held until the upstream gives up on its own.
      assert.isDefined(observed, "fetch must receive an AbortSignal")
      assert.isFalse(observed!.aborted)
    }))
})

/**
 * OpenAPI `$ref`, which real specs use for almost everything.
 *
 * Unresolved, a `$ref` parameter has no `name` and was dropped without a word,
 * and a `$ref` request body looked like an operation that takes no body. Both
 * produced a tool that was silently wrong, which is the outcome `skipped`
 * exists to replace.
 */
describe("OpenAPI reference resolution", () => {
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/pets": {
        post: {
          operationId: "createPet",
          parameters: [{ $ref: "#/components/parameters/Trace" }],
          requestBody: { $ref: "#/components/requestBodies/PetBody" },
          responses: { "200": { description: "ok" } }
        }
      }
    },
    components: {
      parameters: {
        Trace: {
          name: "traceId",
          in: "query",
          required: true,
          schema: { type: "string" }
        }
      },
      requestBodies: {
        PetBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Pet" } }
          }
        }
      },
      schemas: {
        Pet: {
          type: "object",
          properties: {
            name: { type: "string" },
            tag: { $ref: "#/components/schemas/Tag" }
          },
          required: ["name"]
        },
        Tag: { type: "object", properties: { label: { type: "string" } } }
      }
    }
  }

  it("resolves a referenced parameter instead of dropping it", () => {
    const extraction = OpenApi.extractOpenApi(spec)
    const tool = extraction.tools.find((entry) => entry.name === "createpet")
    assert.isDefined(tool)
    const input = JSON.parse(JSON.stringify(tool!.input)) as {
      properties: Record<string, unknown>
      required?: ReadonlyArray<string>
    }
    assert.property(input.properties, "traceId")
    assert.include(input.required ?? [], "traceId")
  })

  it("resolves a referenced request body into real fields", () => {
    const extraction = OpenApi.extractOpenApi(spec)
    const tool = extraction.tools.find((entry) => entry.name === "createpet")!
    const input = JSON.parse(JSON.stringify(tool.input)) as {
      properties: Record<string, unknown>
    }
    // Flattened from the referenced Pet schema, not absent because the body
    // was a pointer.
    assert.property(input.properties, "name")
    assert.property(input.properties, "tag")
  })

  it("leaves no $ref for the model to resolve", () => {
    const extraction = OpenApi.extractOpenApi(spec)
    const tool = extraction.tools.find((entry) => entry.name === "createpet")!
    const rendered = JSON.stringify(tool.input)
    assert.notInclude(
      rendered,
      "$ref",
      "the model has nothing to resolve a pointer against"
    )
    // The nested reference was expanded too, not just the top level.
    assert.include(rendered, "label")
  })

  it("skips an operation whose $ref cannot be followed", () => {
    const extraction = OpenApi.extractOpenApi({
      openapi: "3.0.0",
      paths: {
        "/x": {
          get: {
            operationId: "getX",
            parameters: [{ $ref: "https://elsewhere.example.com/p.json#/Trace" }],
            responses: { "200": { description: "ok" } }
          }
        }
      }
    })
    assert.deepStrictEqual(extraction.tools, [])
    assert.strictEqual(extraction.skipped.length, 1)
    assert.include(extraction.skipped[0]!.reason, "$ref")
  })

  it("a self-referential schema terminates instead of hanging", () => {
    const extraction = OpenApi.extractOpenApi({
      openapi: "3.0.0",
      paths: {
        "/tree": {
          post: {
            operationId: "putTree",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" }
                }
              }
            },
            responses: { "200": { description: "ok" } }
          }
        }
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              value: { type: "string" },
              children: {
                type: "array",
                items: { $ref: "#/components/schemas/Node" }
              }
            }
          }
        }
      }
    })
    const tool = extraction.tools.find((entry) => entry.name === "puttree")
    assert.isDefined(tool)
    const rendered = JSON.stringify(tool!.input)
    assert.include(rendered, "value")
    // The cycle stops at the pointer rather than expanding forever.
    assert.include(rendered, "children")
  })
})

/**
 * The GraphQL source, adversarially.
 *
 * These are the cases that previously either produced a valid-but-wrong
 * document or crashed before reaching the network. They assert behaviour --
 * the exact bytes sent, or the failure returned -- because a source that
 * builds a request is only correct if you look at the request.
 */
describe("GraphQL source hardening", () => {
  const introspection = {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          fields: [
            {
              name: "user",
              args: [
                { name: "id", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } } },
                { name: "status", type: { kind: "ENUM", name: "Status" } },
                { name: "where", type: { kind: "INPUT_OBJECT", name: "Filter" } }
              ],
              type: { kind: "OBJECT", name: "User" }
            }
          ]
        },
        {
          kind: "OBJECT",
          name: "Mutation",
          fields: [
            {
              name: "deleteEverything",
              args: [],
              type: { kind: "SCALAR", name: "Boolean" }
            }
          ]
        },
        { kind: "OBJECT", name: "User", fields: [] },
        {
          kind: "ENUM",
          name: "Status",
          enumValues: [{ name: "ACTIVE" }, { name: "BANNED" }]
        },
        {
          // Self-referential, the shape Hasura/Prisma/Shopify emit.
          kind: "INPUT_OBJECT",
          name: "Filter",
          inputFields: [
            { name: "eq", type: { kind: "SCALAR", name: "String" } },
            {
              name: "and",
              type: { kind: "LIST", ofType: { kind: "INPUT_OBJECT", name: "Filter" } }
            }
          ]
        },
        { kind: "SCALAR", name: "ID" },
        { kind: "SCALAR", name: "String" },
        { kind: "SCALAR", name: "Boolean" }
      ]
    }
  }

  /** Capture the exact request body a call produces. */
  const capturing = async (
    args: Record<string, unknown>,
    response: unknown = { data: { user: { id: "1" } } }
  ) => {
    let body: { query: string; variables: Record<string, unknown> } | undefined
    const mockFetch: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json(response)
    }
    const GraphQL = await import("../src/toolSource/graphql.js")
    const source = GraphQL.makeGraphQLSource(
      "gql",
      introspection,
      "https://api.example.com/graphql",
      mockFetch
    )
    const exit = await Effect.runPromiseExit(source.invoke("user", args))
    return { body, exit }
  }

  it("extracts a self-referential input type without overflowing", async () => {
    const GraphQL = await import("../src/toolSource/graphql.js")
    // Before `$defs` hoisting this threw RangeError during extraction, with no
    // network call involved at all.
    const extraction = GraphQL.extractGraphQL(introspection)
    const user = extraction.tools.find((tool) => tool.name === "user")
    assert.isDefined(user)
    const input = JSON.parse(JSON.stringify(user!.input)) as {
      $defs?: Record<string, unknown>
      properties: Record<string, { $ref?: string }>
    }
    assert.isDefined(input.$defs, "named input types must be hoisted")
    assert.property(input.$defs!, "Filter")
    assert.strictEqual(
      input.properties["where"]?.$ref,
      "#/$defs/Filter",
      "the argument references the definition rather than inlining it"
    )
    // The cycle is a reference back to the same definition, not an expansion.
    const filter = input.$defs!["Filter"] as {
      properties: { and: { items: { $ref?: string } } }
    }
    assert.strictEqual(filter.properties.and.items.$ref, "#/$defs/Filter")
  })

  /**
   * A field name is the one part of the document a variable cannot carry, so
   * it is the one place a hostile introspection answer can rewrite the
   * request. Before this check, this exact schema produced
   * `query { ok) { secret } q2: other(x: 1 { id } }`.
   */
  it("skips a root field whose name is not a GraphQL name", async () => {
    const GraphQL = await import("../src/toolSource/graphql.js")
    const hostile = {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              { name: "ok) { secret } q2: other(x: 1", args: [], type: { kind: "SCALAR", name: "Int" } },
              { name: "safe", args: [], type: { kind: "SCALAR", name: "Int" } }
            ]
          }
        ]
      }
    }
    const extraction = GraphQL.extractGraphQL(hostile)
    assert.deepStrictEqual(extraction.tools.map((tool) => tool.name), ["safe"])
    assert.deepStrictEqual(extraction.skipped, [
      { name: "ok) { secret } q2: other(x: 1", reason: "field name is not a GraphQL name" }
    ])
  })

  /** The same rule for an argument name, which is written as `$name` twice. */
  it("drops an argument whose name is not a GraphQL name", async () => {
    const GraphQL = await import("../src/toolSource/graphql.js")
    const hostile = {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "search",
                args: [
                  { name: "q", type: { kind: "SCALAR", name: "String" } },
                  { name: "x: 1) { secret } y(z", type: { kind: "SCALAR", name: "String" } }
                ],
                type: { kind: "SCALAR", name: "Int" }
              }
            ]
          },
          { kind: "SCALAR", name: "String" }
        ]
      }
    }
    const extraction = GraphQL.extractGraphQL(hostile)
    assert.deepStrictEqual(extraction.skipped, [
      {
        name: "search",
        reason: "arguments that cannot be sent as variables are not exposed: x: 1) { secret } y(z"
      }
    ])
    const input = JSON.parse(JSON.stringify(extraction.tools[0]!.input)) as {
      properties: Record<string, unknown>
    }
    assert.deepStrictEqual(Object.keys(input.properties), ["q", "select"])
  })

  /**
   * `ofType` nesting is remote input and about thirty bytes a level. Unbounded
   * recursion turned a 1.5MB answer into `RangeError: Maximum call stack size
   * exceeded`, thrown synchronously out of `makeGraphQLSource` with no Effect
   * in scope to catch it.
   */
  it("bounds a deeply wrapped argument type instead of overflowing", async () => {
    const GraphQL = await import("../src/toolSource/graphql.js")
    let wrapped: unknown = { kind: "SCALAR", name: "Int" }
    for (let i = 0; i < 50_000; i++) wrapped = { kind: "LIST", ofType: wrapped }
    const deep = {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              { name: "f", args: [{ name: "a", type: wrapped }], type: { kind: "SCALAR", name: "Int" } }
            ]
          }
        ]
      }
    }
    const extraction = GraphQL.extractGraphQL(deep)
    assert.deepStrictEqual(extraction.skipped, [
      { name: "f", reason: "arguments that cannot be sent as variables are not exposed: a" }
    ])
    const input = JSON.parse(JSON.stringify(extraction.tools[0]!.input)) as {
      properties: Record<string, unknown>
    }
    // The argument is not offered at all: it cannot be sent as a variable, and
    // this module never interpolates.
    assert.deepStrictEqual(Object.keys(input.properties), ["select"])
  })

  it("sends argument values as variables, never in the document", async () => {
    const { body } = await capturing({ id: "42", select: "id name" })
    assert.isDefined(body)
    assert.deepStrictEqual(body!.variables, { id: "42" })
    assert.strictEqual(
      body!.query,
      'query($id: ID!) { user(id: $id) { id name } }'
    )
    // The value itself must not appear as a literal anywhere in the document.
    assert.notInclude(body!.query, "42")
  })

  it("declares an enum argument as a variable rather than quoting it", async () => {
    const { body } = await capturing({ id: "1", status: "ACTIVE" })
    assert.isDefined(body)
    // Interpolation emitted `status: "ACTIVE"`, which every server rejects
    // because an enum literal is unquoted. As a variable the server coerces it.
    assert.notInclude(body!.query, '"ACTIVE"')
    assert.include(body!.query, "$status: Status")
    assert.deepStrictEqual(body!.variables["status"], "ACTIVE")
  })

  it("a crafted argument key cannot reach a second root field", async () => {
    // The original interpolation turned this key into:
    //   query { user(id: 1, x: 1) { adminToken } deleteEverything(y: 2) { id } }
    const { body, exit } = await capturing({
      id: "1",
      "x: 1) { adminToken } deleteEverything(y": 2
    })
    assert.isTrue(Exit.isFailure(exit), "an undeclared argument must be refused")
    assert.isUndefined(body, "nothing may be sent")
    if (Exit.isFailure(exit)) {
      assert.include(JSON.stringify(exit), "unknown argument")
    }
  })

  it("a nested object value cannot reach the document either", async () => {
    // Keys inside an input object were interpolated by the same code path.
    const { body } = await capturing({
      id: "1",
      where: { "eq: 1) { adminToken } q(x": "boom" }
    })
    assert.isDefined(body)
    assert.notInclude(body!.query, "adminToken")
    // The whole object travels as a variable value, uninterpreted.
    assert.deepStrictEqual(body!.variables["where"], {
      "eq: 1) { adminToken } q(x": "boom"
    })
  })

  describe("select validation", () => {
    const rejected: ReadonlyArray<readonly [string, string]> = [
      ["} deleteEverything {", "a leading brace closes the field"],
      ["id } deleteEverything { ok", "a balanced sibling root field"],
      ["id # }", "a comment can hide a brace from a counter"],
      ['id(first: 1)', "arguments are not field names"],
      ["id @skip(if: true)", "directives change the request"],
      ["...FragmentSpread", "fragments reference undeclared definitions"],
      ["id { name", "unbalanced braces"]
    ]

    for (const [select, why] of rejected) {
      it(`rejects ${JSON.stringify(select)} — ${why}`, async () => {
        const { body, exit } = await capturing({ id: "1", select })
        assert.isTrue(Exit.isFailure(exit), why)
        assert.isUndefined(body, "a rejected select must not be sent")
      })
    }

    const accepted: ReadonlyArray<string> = [
      "id name",
      "id author { name email }",
      "alias: id",
      "id, name",
      "a { b { c } }"
    ]

    for (const select of accepted) {
      it(`accepts ${JSON.stringify(select)}`, async () => {
        const { body, exit } = await capturing({ id: "1", select })
        assert.isTrue(Exit.isSuccess(exit))
        assert.include(body!.query, select)
      })
    }
  })

  describe("the response envelope", () => {
    it("reports GraphQL errors as a tool failure, not a success", async () => {
      const { exit } = await capturing({ id: "1" }, {
        errors: [{ message: "Field 'user' is not accessible" }]
      })
      assert.isTrue(
        Exit.isFailure(exit),
        "a query that failed must not look successful to the harness"
      )
      const rendered = JSON.stringify(exit)
      assert.include(rendered, "ToolSourceToolError")
      assert.include(rendered, "not accessible")
    })

    it("keeps partial data alongside the errors", async () => {
      const { exit } = await capturing({ id: "1" }, {
        data: { user: null },
        errors: [{ message: "partial failure" }]
      })
      assert.isTrue(Exit.isFailure(exit))
      // Whatever did resolve is still carried, rather than discarded.
      assert.include(JSON.stringify(exit), "\"data\"")
    })

    it("a null data field is a typed failure, not a defect", async () => {
      const { exit } = await capturing({ id: "1" }, { data: null })
      assert.isTrue(Exit.isFailure(exit))
      const rendered = JSON.stringify(exit)
      assert.include(rendered, "ToolSourceInvocationError")
      assert.notInclude(
        rendered,
        "TypeError",
        "indexing null must not escape as a defect"
      )
    })

    it("a field that resolves to null returns null, not the envelope", async () => {
      const { exit } = await capturing({ id: "1" }, { data: { user: null } })
      assert.isTrue(Exit.isSuccess(exit))
      if (Exit.isSuccess(exit)) assert.isNull(exit.value)
    })
  })
})
