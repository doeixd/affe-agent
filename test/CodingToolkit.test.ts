import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as Permission from "../src/Permission.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * The coding toolkit is a battery over the sandbox seam: nothing here provides
 * anything the agent core does not already have. The handlers are exercised
 * directly against the in-memory sandbox (deterministic, no real processes),
 * the permission projections are read off the tools, and full sessions drive
 * the tools through a scripted model -- once unguarded, once behind a policy.
 */

const ws = Sandbox.workspace("test")

/** A handler context that discards preliminary results -- enough to call a handler by hand. */
const ctx = { preliminary: () => Effect.void }

/** Run an effect against a memory sandbox seeded with `files`, with an optional exec script. */
const withSandbox = <A, E>(
  files: Record<string, string>,
  use: Effect.Effect<A, E, Sandbox.Current>,
  exec?: Sandbox.Sandbox["exec"]
) =>
  use.pipe(
    Effect.provide(
      Layer.provideMerge(
        Sandbox.currentLayer(ws),
        MemorySandbox.layer({ seed: files, ...(exec === undefined ? {} : { exec }) })
      )
    ),
    Effect.scoped
  )

/** The handler failures are strings at runtime; narrow the declared `string | AiError` union. */
function assertString(value: unknown): asserts value is string {
  assert.isString(value)
}

const H = CodingToolkit.handlers

describe("CodingToolkit handlers", () => {
  it.effect("read_file numbers lines, and honours offset and limit", () =>
    Effect.gen(function* () {
      const whole = yield* withSandbox({ "a.txt": "one\ntwo\nthree" }, H.read_file({ path: "a.txt" }, ctx))
      assert.strictEqual(whole, "1\tone\n2\ttwo\n3\tthree")
      const middle = yield* withSandbox(
        { "a.txt": "one\ntwo\nthree\nfour" },
        H.read_file({ path: "a.txt", offset: 2, limit: 2 }, ctx)
      )
      assert.strictEqual(middle, "2\ttwo\n3\tthree")
      // A non-positive offset means the top, not slice(-1)'s last line.
      const clamped = yield* withSandbox(
        { "a.txt": "one\ntwo\nthree" },
        H.read_file({ path: "a.txt", offset: 0, limit: 2 }, ctx)
      )
      assert.strictEqual(clamped, "1\tone\n2\ttwo")
      // A traversal path is a model-facing string, not a defect.
      const bad = yield* Effect.flip(withSandbox({}, H.read_file({ path: "../escape" }, ctx)))
      assertString(bad)
      assert.include(bad, "..")
    })
  )

  it.effect("write_file creates a file that read_file can then see", () =>
    Effect.gen(function* () {
      const result = yield* withSandbox(
        {},
        Effect.gen(function* () {
          const wrote = yield* H.write_file({ path: "new.txt", content: "hello" }, ctx)
          const read = yield* H.read_file({ path: "new.txt" }, ctx)
          return { wrote, read }
        })
      )
      assert.include(result.wrote, "wrote new.txt")
      assert.strictEqual(result.read, "1\thello")
    })
  )

  it.effect("edit_file replaces exact, refuses ambiguous or missing, and replace_all does all", () =>
    Effect.gen(function* () {
      const edited = yield* withSandbox(
        { "f.ts": "const x = 1\nconst y = 2" },
        Effect.gen(function* () {
          const msg = yield* H.edit_file({ path: "f.ts", old_string: "const x = 1", new_string: "const x = 42" }, ctx)
          const after = yield* H.read_file({ path: "f.ts" }, ctx)
          return { msg, after }
        })
      )
      assert.include(edited.msg, "1 replacement")
      assert.include(edited.after, "const x = 42")
      // Ambiguous without replace_all: refused, file untouched.
      const ambiguous = yield* Effect.flip(
        withSandbox({ "f.ts": "a\na\na" }, H.edit_file({ path: "f.ts", old_string: "a", new_string: "b" }, ctx))
      )
      assertString(ambiguous)
      assert.include(ambiguous, "not unique")
      // replace_all does all of them.
      const all = yield* withSandbox(
        { "f.ts": "a\na\na" },
        Effect.gen(function* () {
          const msg = yield* H.edit_file({ path: "f.ts", old_string: "a", new_string: "b", replace_all: true }, ctx)
          const after = yield* H.read_file({ path: "f.ts" }, ctx)
          return { msg, after }
        })
      )
      assert.include(all.msg, "3 replacements")
      assert.strictEqual(all.after, "1\tb\n2\tb\n3\tb")
      // Not found.
      const missing = yield* Effect.flip(
        withSandbox({ "f.ts": "hello" }, H.edit_file({ path: "f.ts", old_string: "nope", new_string: "x" }, ctx))
      )
      assertString(missing)
      assert.include(missing, "was not found")
      // A `$` in new_string is literal, not a String.replace special pattern.
      const dollars = yield* withSandbox(
        { "f.ts": "price = OLD" },
        Effect.gen(function* () {
          yield* H.edit_file({ path: "f.ts", old_string: "OLD", new_string: "$&{amount}" }, ctx)
          return yield* H.read_file({ path: "f.ts" }, ctx)
        })
      )
      assert.strictEqual(dollars, "1\tprice = $&{amount}")
    })
  )

  it.effect("list_files returns the workspace entries", () =>
    Effect.gen(function* () {
      const entries = yield* withSandbox({ "a.txt": "1", "dir/b.txt": "2" }, H.list_files({}, ctx))
      const byPath = [...entries].sort((x, y) => (x.path < y.path ? -1 : 1))
      assert.deepStrictEqual(byPath, [
        { path: "a.txt", type: "file" },
        { path: "dir", type: "directory" }
      ])
    })
  )

  it.effect("search walks the tree and returns matching lines with their positions", () =>
    Effect.gen(function* () {
      const hits = yield* withSandbox(
        {
          "src/a.ts": "const foo = 1\nconst bar = 2",
          "src/b.ts": "function foo() {}",
          "readme.md": "no match here"
        },
        H.search({ pattern: "foo" }, ctx)
      )
      assert.deepStrictEqual([...hits].sort((x, y) => (x.path < y.path ? -1 : 1)), [
        { path: "src/a.ts", line: 1, text: "const foo = 1" },
        { path: "src/b.ts", line: 1, text: "function foo() {}" }
      ])
      // Scoped to a subtree.
      const scoped = yield* withSandbox(
        { "src/a.ts": "foo", "other/c.ts": "foo" },
        H.search({ pattern: "foo", path: "other" }, ctx)
      )
      assert.deepStrictEqual([...scoped], [{ path: "other/c.ts", line: 1, text: "foo" }])
      // An invalid regex is a string, not a defect.
      const bad = yield* Effect.flip(withSandbox({}, H.search({ pattern: "(" }, ctx)))
      assertString(bad)
      assert.include(bad, "invalid regular expression")
    })
  )

  it.effect("bash runs the command through the sandbox exec as bash -lc", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{ executable: string; args: ReadonlyArray<string> } | undefined>(undefined)
      const result = yield* withSandbox(
        {},
        H.bash({ command: "echo hi" }, ctx),
        (cmd) =>
          Ref.set(seen, { executable: cmd.executable, args: cmd.args }).pipe(
            Effect.as({ exitCode: 0, stdout: "hi\n", stderr: "" })
          )
      )
      assert.deepStrictEqual(result, { exit_code: 0, stdout: "hi\n", stderr: "" })
      // The command reached exec as a shell invocation, not split into argv.
      assert.deepStrictEqual(yield* Ref.get(seen), { executable: "bash", args: ["-lc", "echo hi"] })
    })
  )
})

describe("CodingToolkit permission projections", () => {
  it.effect("every tool projects to a policy-meaningful action and resource", () => {
    const read = Permission.projectionOf(CodingToolkit.ReadFile)
    assert.strictEqual(read.action, "read")
    assert.strictEqual(read.resource({ path: "src/a.ts" }), "src/a.ts")
    const write = Permission.projectionOf(CodingToolkit.WriteFile)
    assert.strictEqual(write.action, "write")
    assert.strictEqual(write.resource({ path: "src/a.ts", content: "x" }), "src/a.ts")
    const edit = Permission.projectionOf(CodingToolkit.EditFile)
    assert.strictEqual(edit.action, "write")
    assert.strictEqual(edit.resource({ path: "src/a.ts", old_string: "a", new_string: "b" }), "src/a.ts")
    const list = Permission.projectionOf(CodingToolkit.ListFiles)
    assert.strictEqual(list.action, "read")
    assert.strictEqual(list.resource({}), ".")
    const search = Permission.projectionOf(CodingToolkit.Search)
    assert.strictEqual(search.action, "read")
    assert.strictEqual(search.resource({ pattern: "foo" }), "foo")
    const bash = Permission.projectionOf(CodingToolkit.Bash)
    assert.strictEqual(bash.action, "shell")
    assert.strictEqual(bash.resource({ command: "git push" }), "git push")
    return Effect.void
  })
})

describe("CodingToolkit in a session", () => {
  // The model plus a `Current` sandbox over a memory provider seeded with one
  // file -- the same composition the sandbox's own tests use to drive a session.
  const env = <ROut>(model: Layer.Layer<ROut>) =>
    Layer.mergeAll(
      model,
      Sandbox.currentLayer(ws).pipe(
        Layer.provide(MemorySandbox.layer({ seed: { "src/x.ts": "const value = 1" } }))
      )
    )

  const fileNow = Effect.gen(function* () {
    const sandbox = yield* Sandbox.Current
    return yield* Sandbox.readText(sandbox)(yield* Sandbox.path("src/x.ts"))
  })

  it.effect("a scripted model reads and edits a file through the toolkit", () =>
    Effect.gen(function* () {
      const agent = Agent.make({ instructions: "You edit code.", toolkit: CodingToolkit.toolkit(), loop: AgentLoop.bounded(6) })
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "r", name: "read_file", params: { path: "src/x.ts" } }] },
        {
          toolCalls: [
            { id: "e", name: "edit_file", params: { path: "src/x.ts", old_string: "const value = 1", new_string: "const value = 2" } }
          ]
        },
        TestLanguageModel.text("done: value is now 2")
      ])
      const out = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const result = yield* session.prompt("bump value to 2")
        return { text: result.text, file: yield* fileNow }
      }).pipe(Effect.provide(env(layer)), Effect.scoped)
      assert.strictEqual(out.text, "done: value is now 2")
      assert.strictEqual(out.file, "const value = 2")
    })
  )

  it.effect("a permission policy gates the toolkit: the read runs, the write is refused and told to the model", () =>
    Effect.gen(function* () {
      const agent = Agent.make({
        instructions: "You edit code.",
        toolkit: CodingToolkit.toolkit(),
        loop: AgentLoop.bounded(6),
        // Reads allowed, writes denied -- the projection is what the policy gates on.
        permission: Permission.rules([{ action: "write", decision: Permission.deny("read-only session") }], {
          otherwise: Permission.allow
        }),
        toolDenialPolicy: ToolExecution.ReturnToModel
      })
      const { layer } = yield* TestLanguageModel.script([
        { toolCalls: [{ id: "r", name: "read_file", params: { path: "src/x.ts" } }] },
        { toolCalls: [{ id: "w", name: "write_file", params: { path: "src/x.ts", content: "hacked" } }] },
        TestLanguageModel.text("could not write")
      ])
      const out = yield* Effect.gen(function* () {
        const session = yield* AgentSession.make(agent)
        const probe = yield* AgentProbe.make(session)
        const result = yield* session.prompt("try to edit")
        return { text: result.text, file: yield* fileNow, events: yield* probe.events }
      }).pipe(Effect.provide(env(layer)), Effect.scoped)
      assert.strictEqual(out.text, "could not write")
      // The write was denied: the file is unchanged on disk.
      assert.strictEqual(out.file, "const value = 1")
      // And the model was told, with the reason, rather than the run failing.
      const failed = out.events.find(AgentEventIsToolFailed)
      assert.isDefined(failed)
    })
  )
})

const AgentEventIsToolFailed = (e: { readonly event: { readonly _tag: string } }): boolean =>
  e.event._tag === "ToolCallFailed"
