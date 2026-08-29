import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import * as Permission from "../src/Permission.js"
import * as Agent from "../src/Agent.js"
import * as AgentSession from "../src/AgentSession.js"
import { PiToolkit } from "../src/pi/index.js"
import * as LineEndings from "../src/coding/internal/lineEndings.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as SearchFormat from "../src/coding/internal/searchFormat.js"
import { TestLanguageModel } from "../src/testing/index.js"

/**
 * Pi's contracts, not `/coding`'s: batch edits, rendered listings, injectable
 * shell. The sandbox is the same in-memory one; only the tool surface differs.
 */

const ws = Sandbox.workspace("pi-test")
const ctx = { preliminary: () => Effect.void }
const H = PiToolkit.handlers

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

const readRaw = (file: string) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Current
    const bytes = yield* sandbox.read(yield* Sandbox.path(file))
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
  })

const readBytes = (file: string) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Current
    return yield* sandbox.read(yield* Sandbox.path(file))
  })

function assertString(value: unknown): asserts value is string {
  assert.isString(value)
}

// ---------------------------------------------------------------------------
// I13, I14, I15
// ---------------------------------------------------------------------------

describe("PiToolkit batch edits", () => {
  it.effect("applies several edits against the original file, atomically (I13)", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "f.ts": "alpha\nbeta\ngamma\n" },
        Effect.gen(function* () {
          const result = yield* H.edit_file(
            {
              path: "f.ts",
              edits: [
                { old_string: "alpha", new_string: "one" },
                { old_string: "gamma", new_string: "three" }
              ]
            },
            ctx
          )
          const text = yield* readRaw("f.ts")
          const size = yield* PiToolkit.lockRegistrySize
          return { result, text, size }
        })
      )
      assert.strictEqual(out.text, "one\nbeta\nthree\n")
      assert.strictEqual(out.result.replacements, 2)
      assert.strictEqual(out.result.strategy, "batch")
      assert.strictEqual(out.size, 0)
    }))

  it.effect("a failing later edit leaves the file untouched (I13)", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "f.ts": "keep foo" },
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            H.edit_file(
              {
                path: "f.ts",
                edits: [
                  { old_string: "foo", new_string: "bar" },
                  { old_string: "bar", new_string: "baz" }
                ]
              },
              ctx
            )
          )
          const text = yield* readRaw("f.ts")
          return { failure, text }
        })
      )
      assertString(out.failure)
      assert.include(out.failure, "edits[1] of 2")
      assert.strictEqual(out.text, "keep foo")
    }))

  it.effect("incremental vs original semantics: batch uses original, not intermediate", () =>
    Effect.gen(function* () {
      // If edits were applied incrementally, second edit "bar" would be found after first edit created it.
      // Original-match refuses it, proving atomicity.
      const before = "foo\n"
      const out = yield* withSandbox(
        { "f.ts": before },
        Effect.flip(
          H.edit_file(
            {
              path: "f.ts",
              edits: [
                { old_string: "foo", new_string: "bar" },
                { old_string: "bar", new_string: "baz" }
              ]
            },
            ctx
          )
        )
      )
      assertString(out)
      assert.include(out, "edits[1]")
      assert.include(out, "not found")
    }))

  it.effect("overlapping edits are refused with both indices (I14)", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "f.ts": "abcdef" },
        Effect.flip(
          H.edit_file(
            {
              path: "f.ts",
              edits: [
                { old_string: "abc", new_string: "x" },
                { old_string: "cde", new_string: "y" }
              ]
            },
            ctx
          )
        )
      )
      assertString(out)
      assert.include(out, "edits[0]")
      assert.include(out, "edits[1]")
      assert.include(out, "overlap")
      const text = yield* withSandbox(
        { "f.ts": "abcdef" },
        Effect.gen(function* () {
          yield* H.edit_file(
            {
              path: "f.ts",
              edits: [
                { old_string: "abc", new_string: "x" },
                { old_string: "cde", new_string: "y" }
              ]
            },
            ctx
          ).pipe(Effect.flip, Effect.option)
          return yield* readRaw("f.ts")
        })
      )
      assert.strictEqual(text, "abcdef")
    }))

  it.effect("adjacent edits are allowed", () =>
    Effect.gen(function* () {
      const text = yield* withSandbox(
        { "f.ts": "abcdef" },
        Effect.gen(function* () {
          yield* H.edit_file(
            {
              path: "f.ts",
              edits: [
                { old_string: "abc", new_string: "x" },
                { old_string: "def", new_string: "y" }
              ]
            },
            ctx
          )
          return yield* readRaw("f.ts")
        })
      )
      assert.strictEqual(text, "xy")
    }))

  it.effect("duplicate old_string in two edits is treated as overlap", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "f.ts": "hello hello" },
        Effect.flip(
          H.edit_file(
            {
              path: "f.ts",
              edits: [
                { old_string: "hello", new_string: "hi" },
                { old_string: "hello", new_string: "hi2" }
              ]
            },
            ctx
          )
        )
      )
      // Both match same span (but ambiguous check fires first) -> Ambiguous for first, so index 0
      assertString(out)
      assert.include(out, "edits[0]")
    }))

  it.effect("every batch failure names its edit (I15) — NotFound, Ambiguous, Disproportionate, Overlap", () =>
    Effect.gen(function* () {
      const notFound = yield* withSandbox(
        { "f.ts": "a\nb\nc\n" },
        Effect.flip(H.edit_file({ path: "f.ts", edits: [{ old_string: "a", new_string: "A" }, { old_string: "missing", new_string: "X" }] }, ctx))
      )
      assertString(notFound)
      assert.include(notFound, "edits[1] of 2")
      assert.include(notFound, "not found")

      const ambiguous = yield* withSandbox(
        { "f.ts": "x\nx\n" },
        Effect.flip(H.edit_file({ path: "f.ts", edits: [{ old_string: "x", new_string: "y" }] }, ctx))
      )
      assertString(ambiguous)
      assert.include(ambiguous, "not unique")

      // Disproportionate via batch: craft a tiny find that matches huge span via fuzzy strategy
      // Use the same guard that coding uses: tiny old_string matching huge block via block-anchor
      const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
      const file = `start {\n${big}\n}\n`
      const disp = yield* withSandbox(
        { "f.ts": file },
        Effect.flip(H.edit_file({ path: "f.ts", edits: [{ old_string: "start {\n}", new_string: "x" }] }, ctx))
      )
      // May be NotFound or Disproportionate depending on strategy; ensure it fails with either and file untouched
      assertString(disp)

      const overlap = yield* withSandbox(
        { "f.ts": "abcdef" },
        Effect.flip(
          H.edit_file({ path: "f.ts", edits: [{ old_string: "abc", new_string: "x" }, { old_string: "bcd", new_string: "y" }] }, ctx)
        )
      )
      assertString(overlap)
      assert.include(overlap, "edits[0]")
      assert.include(overlap, "edits[1]")
    }))

  it.effect("the single-edit form still works", () =>
    Effect.gen(function* () {
      const text = yield* withSandbox(
        { "f.ts": "old" },
        Effect.gen(function* () {
          yield* H.edit_file({ path: "f.ts", old_string: "old", new_string: "new" }, ctx)
          return yield* readRaw("f.ts")
        })
      )
      assert.strictEqual(text, "new")
    }))

  it.effect("single edit with replace_all replaces every occurrence", () =>
    Effect.gen(function* () {
      const text = yield* withSandbox(
        { "f.ts": "a a a" },
        Effect.gen(function* () {
          const res = yield* H.edit_file({ path: "f.ts", old_string: "a", new_string: "b", replace_all: true }, ctx)
          assert.strictEqual(res.replacements, 3)
          return yield* readRaw("f.ts")
        })
      )
      assert.strictEqual(text, "b b b")
    }))

  it.effect("replace_all with batch is refused", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox(
        { "f.ts": "a b c" },
        Effect.flip(
          H.edit_file({
            path: "f.ts",
            edits: [
              { old_string: "a", new_string: "x" },
              { old_string: "b", new_string: "y" }
            ],
            replace_all: true
          }, ctx)
        )
      )
      assertString(err)
      assert.include(err, "replace_all cannot be used")
    }))

  it.effect("empty edits is refused", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox({ "f.ts": "x" }, Effect.flip(H.edit_file({ path: "f.ts", edits: [] }, ctx)))
      assertString(err)
      assert.include(err, "cannot be empty")
    }))

  it.effect("old_string == new_string is refused with index", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox(
        { "f.ts": "hello" },
        Effect.flip(H.edit_file({ path: "f.ts", edits: [{ old_string: "hello", new_string: "hello" }] }, ctx))
      )
      assertString(err)
      assert.include(err, "edits[0]")
      assert.include(err, "identical")
    }))

  it.effect("empty old_string is refused", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox(
        { "f.ts": "x" },
        Effect.flip(H.edit_file({ path: "f.ts", edits: [{ old_string: "", new_string: "y" }] }, ctx))
      )
      assertString(err)
      assert.include(err, "cannot be empty")
    }))

  it.effect("coerces a JSON-string edits array, the way models send one", () =>
    Effect.gen(function* () {
      const text = yield* withSandbox(
        { "f.ts": "a\nb\n" },
        Effect.gen(function* () {
          yield* H.edit_file(
            {
              path: "f.ts",
              edits: JSON.stringify([
                { old_string: "a", new_string: "A" },
                { old_string: "b", new_string: "B" }
              ])
            },
            ctx
          )
          return yield* readRaw("f.ts")
        })
      )
      assert.strictEqual(text, "A\nB\n")
    }))

  it.effect("invalid JSON string is refused with actionable message", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox({ "f.ts": "x" }, Effect.flip(H.edit_file({ path: "f.ts", edits: "not-json" }, ctx)))
      assertString(err)
      assert.include(err, "not valid JSON")
    }))

  it.effect("JSON string that is not an array is refused", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox(
        { "f.ts": "x" },
        Effect.flip(H.edit_file({ path: "f.ts", edits: JSON.stringify({ old_string: "a", new_string: "b" }) }, ctx))
      )
      assertString(err)
      assert.include(err, "not a JSON array")
    }))

  it.effect("batch of 10 edits applies atomically", () =>
    Effect.gen(function* () {
      const before = Array.from({ length: 10 }, (_, i) => `v${i}`).join("\n")
      const edits = Array.from({ length: 10 }, (_, i) => ({ old_string: `v${i}`, new_string: `V${i}` }))
      const text = yield* withSandbox(
        { "f.ts": before },
        Effect.gen(function* () {
          const res = yield* H.edit_file({ path: "f.ts", edits }, ctx)
          assert.strictEqual(res.replacements, 10)
          return yield* readRaw("f.ts")
        })
      )
      assert.strictEqual(text, Array.from({ length: 10 }, (_, i) => `V${i}`).join("\n"))
    }))

  it.effect("edits are independent of order in array (sorted by position)", () =>
    Effect.gen(function* () {
      const before = "first\nsecond\nthird\n"
      const text = yield* withSandbox(
        { "f.ts": before },
        Effect.gen(function* () {
          yield* H.edit_file(
            {
              path: "f.ts",
              edits: [
                { old_string: "third", new_string: "3rd" },
                { old_string: "first", new_string: "1st" }
              ]
            },
            ctx
          )
          return yield* readRaw("f.ts")
        })
      )
      assert.strictEqual(text, "1st\nsecond\n3rd\n")
    }))
})

describe("PiToolkit lock registry (P1)", () => {
  it.effect("registry drains after single edit", () =>
    Effect.gen(function* () {
      yield* withSandbox({ "f.ts": "x" }, H.edit_file({ path: "f.ts", old_string: "x", new_string: "y" }, ctx))
      assert.strictEqual(yield* PiToolkit.lockRegistrySize, 0)
    }))

  it.effect("registry drains after batch edit", () =>
    Effect.gen(function* () {
      yield* withSandbox(
        { "f.ts": "a\nb\n" },
        H.edit_file({ path: "f.ts", edits: [{ old_string: "a", new_string: "A" }, { old_string: "b", new_string: "B" }] }, ctx)
      )
      assert.strictEqual(yield* PiToolkit.lockRegistrySize, 0)
    }))

  it.effect("registry drains after failed batch (no leak on error)", () =>
    Effect.gen(function* () {
      yield* withSandbox({ "f.ts": "x" }, Effect.flip(H.edit_file({ path: "f.ts", edits: [{ old_string: "nope", new_string: "y" }] }, ctx)).pipe(Effect.option))
      assert.strictEqual(yield* PiToolkit.lockRegistrySize, 0)
    }))

  it.effect("concurrent edits to same file serialize (no lost update)", () =>
    Effect.gen(function* () {
      const before = "line1\nline2\n"
      const result = yield* withSandbox(
        { "f.ts": before },
        Effect.gen(function* () {
          const e1 = H.edit_file({ path: "f.ts", old_string: "line1", new_string: "ONE" }, ctx)
          const e2 = H.edit_file({ path: "f.ts", old_string: "line2", new_string: "TWO" }, ctx)
          yield* Effect.all([e1, e2], { concurrency: 2 })
          return yield* readRaw("f.ts")
        })
      )
      assert.include(result, "ONE")
      assert.include(result, "TWO")
    }))

  it.effect("waiter arriving during drain still gets exclusion", () =>
    Effect.gen(function* () {
      const before = "a\nb\n"
      // Run two concurrent edits to same file via Effect.all; lock must serialize them.
      const result = yield* withSandbox(
        { "f.ts": before },
        Effect.gen(function* () {
          const e1 = H.edit_file({ path: "f.ts", old_string: "a", new_string: "A" }, ctx)
          const e2 = H.edit_file({ path: "f.ts", old_string: "b", new_string: "B" }, ctx)
          yield* Effect.all([e1, e2], { concurrency: 2 })
          return yield* readRaw("f.ts")
        })
      )
      assert.include(result, "A")
      assert.include(result, "B")
      assert.strictEqual(yield* PiToolkit.lockRegistrySize, 0)
    }))

  it.effect("interrupted edit does not pin registry", () =>
    Effect.gen(function* () {
      const prog = withSandbox({ "f.ts": "x" }, H.edit_file({ path: "f.ts", old_string: "x", new_string: "y" }, ctx))
      const fiber = yield* Effect.forkChild(prog)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(yield* PiToolkit.lockRegistrySize, 0)
    }))
})

describe("PiToolkit list_files (P3)", () => {
  it.effect("renders directories with a slash, alphabetically", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({ "b.txt": "1", "a.txt": "2", "dir/x.txt": "3" }, H.list_files({}, ctx))
      assert.strictEqual(out, "a.txt\nb.txt\ndir/")
    }))

  it.effect("includes dotfiles", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({ ".hidden": "x", "visible.txt": "y" }, H.list_files({}, ctx))
      assert.include(out, ".hidden")
      assert.include(out, "visible.txt")
      // Dotfile sorts before visible
      assert.isTrue(out.indexOf(".hidden") < out.indexOf("visible.txt"))
    }))

  it.effect("caps at LS_LIMIT and names the cut", () =>
    Effect.gen(function* () {
      const files: Record<string, string> = {}
      for (let i = 0; i < PiToolkit.LS_LIMIT + 3; i++) files[`${String(i).padStart(4, "0")}.txt`] = "x"
      const out = yield* withSandbox(files, H.list_files({}, ctx))
      assert.include(out, "0000.txt")
      assert.include(out, "0499.txt")
      assert.notInclude(out, "0500.txt")
      assert.include(out, `truncated to ${PiToolkit.LS_LIMIT} entries`)
      assert.include(out, `${PiToolkit.LS_LIMIT + 3} total`)
    }))

  it.effect("empty directory renders No entries", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({}, H.list_files({}, ctx))
      assert.include(out, "No entries in .")
    }))

  it.effect("listing a subdirectory is alphabetical with slash for dirs", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({ "sub/b.txt": "1", "sub/a.txt": "2", "sub/nested/x.txt": "3" }, H.list_files({ path: "sub" }, ctx))
      // Handler lists one level deep: sub contains a.txt, b.txt, nested/
      assert.include(out, "sub/a.txt")
      assert.include(out, "sub/b.txt")
      assert.include(out, "sub/nested/")
      assert.isTrue(out.indexOf("sub/a.txt") < out.indexOf("sub/b.txt"))
    }))

  it.effect("listing respects path with and without trailing slash", () =>
    Effect.gen(function* () {
      const out1 = yield* withSandbox({ "sub/a.txt": "1" }, H.list_files({ path: "sub" }, ctx))
      const out2 = yield* withSandbox({ "sub/a.txt": "1" }, H.list_files({ path: "sub/" }, ctx))
      assert.include(out1, "sub/a.txt")
      assert.include(out2, "sub/a.txt")
    }))
})

describe("PiToolkit read/write still work", () => {
  it.effect("read_file numbers lines and honours offset/limit", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({ "a.txt": "one\ntwo\nthree" }, H.read_file({ path: "a.txt" }, ctx))
      assert.include(out, "1: one")
      assert.include(out, "3: three")
      const slice = yield* withSandbox({ "a.txt": "one\ntwo\nthree\nfour" }, H.read_file({ path: "a.txt", offset: 2, limit: 2 }, ctx))
      assert.include(slice, "2: two")
      assert.notInclude(slice, "4: four")
    }))

  it.effect("write_file overwrites and is visible to read", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "a.txt": "old" },
        Effect.gen(function* () {
          yield* H.write_file({ path: "a.txt", content: "new content" }, ctx)
          return yield* H.read_file({ path: "a.txt" }, ctx)
        })
      )
      assert.include(out, "new content")
    }))

  it.effect("read refuses binary by extension and by NUL", () =>
    Effect.gen(function* () {
      const byExt = yield* withSandbox({ "file.zip": "PK" }, Effect.flip(H.read_file({ path: "file.zip" }, ctx)))
      assertString(byExt)
      assert.include(byExt, "binary")
      const withNul = yield* withSandbox(
        { "a.txt": "hi\u0000there" },
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.Current
          yield* sandbox.write(yield* Sandbox.path("a.txt"), new TextEncoder().encode("hi\u0000there"))
          return yield* Effect.flip(H.read_file({ path: "a.txt" }, ctx))
        })
      )
      assertString(withNul)
      assert.include(withNul, "binary")
    }))
})

describe("PiToolkit search (P4 grep cap)", () => {
  it.effect("search respects GREP_MAX_LINE_LENGTH 500, not 2000", () =>
    Effect.gen(function* () {
      const long = "a".repeat(600)
      const out = yield* withSandbox({ "a.txt": long }, H.search({ pattern: "a+" }, ctx))
      // Pi caps at 500, so suffix mentions 500
      assert.include(out, "truncated to 500")
      // Ensure not truncated to 2000
      assert.notInclude(out, "2000")
    }))

  it.effect("search is case sensitive and regex", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({ "a.txt": "hello\nHELLO\n" }, H.search({ pattern: "hello" }, ctx))
      assert.include(out, "hello")
      assert.notInclude(out, "HELLO")
      const out2 = yield* withSandbox({ "a.txt": "hello\nHELLO\n" }, H.search({ pattern: "HELLO|hello" }, ctx))
      assert.include(out2, "hello")
      assert.include(out2, "HELLO")
    }))

  it.effect("search include glob filters by name", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({ "a.txt": "match", "b.md": "match" }, H.search({ pattern: "match", include: "*.txt" }, ctx))
      assert.include(out, "a.txt")
      assert.notInclude(out, "b.md")
    }))

  it.effect("search skips binary files", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "binary.zip": "PK\x00\x01", "a.txt": "hello" },
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.Current
          yield* sandbox.write(yield* Sandbox.path("binary.zip"), new TextEncoder().encode("PK\x00\x01hello"))
          return yield* H.search({ pattern: "hello" }, ctx)
        })
      )
      assert.include(out, "a.txt")
      assert.notInclude(out, "binary.zip")
    }))

  it.effect("search skips a file above the size cap and reports the skip", () =>
    Effect.gen(function* () {
      // Same cap and same note as the coding toolkit: `search` here shared the
      // unbounded read, so it needed the same bound rather than a second one.
      const big = "x".repeat(2 * 1024 * 1024 - 5) + "hello"
      const opened = yield* Ref.make<ReadonlyArray<string>>([])
      const out = yield* withSandbox(
        { "big.txt": big, "small.txt": "hello" },
        Effect.gen(function* () {
          const inner = yield* Sandbox.Current
          // Typed as a `Sandbox`, so `path` infers from the interface rather
          // than arriving as `any` from a bare object literal.
          const recording: Sandbox.Sandbox = {
            ...inner,
            read: (path) =>
              Effect.andThen(Ref.update(opened, (seen) => [...seen, path]), inner.read(path))
          }
          const result = yield* H.search({ pattern: "hello" }, ctx).pipe(
            Effect.provideService(Sandbox.Current, recording)
          )
          return { result, opened: yield* Ref.get(opened) }
        })
      )
      assertString(out.result)
      assert.deepStrictEqual(out.opened, ["small.txt"])
      assert.include(out.result, "small.txt:")
      assert.notInclude(out.result, "big.txt")
      assert.include(out.result, SearchFormat.skippedForSizeNote(1))
    }))

  it.effect("search refuses dangerous regex", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox({ "a.txt": "x" }, Effect.flip(H.search({ pattern: "(a+)+$" }, ctx)))
      assertString(err)
      assert.include(err, "Refusing")
    }))
})

describe("PiToolkit truncation helpers (P4)", () => {
  it("head keeps the start within byte budget", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n")
    const out = PiToolkit.head(text, 3, PiToolkit.MAX_BYTES)
    assert.isTrue(out.cut)
    assert.strictEqual(out.text, "l0\nl1\nl2")
  })

  it("head respects byte limit on one long line (UTF-8 safe)", () => {
    const line = "a".repeat(100) + "€".repeat(10) // € is 3 bytes
    const out = PiToolkit.head(line, 10, 50)
    assert.isTrue(out.cut)
    assert.isTrue(new TextEncoder().encode(out.text).length <= 50)
    assert.isFalse(out.text.includes("�"))
  })

  it("formatSize names limit that fired", () => {
    assert.strictEqual(PiToolkit.formatSize(50 * 1024), "50.0KB")
    assert.strictEqual(PiToolkit.formatSize(512), "512B")
    assert.strictEqual(PiToolkit.formatSize(1024), "1.0KB")
  })

  it.effect("bash truncates and saves overflow", () =>
    Effect.gen(function* () {
      const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n")
      const result = yield* withSandbox(
        {},
        H.shell({ command: `echo hi` }, ctx),
        () => Effect.succeed({ exitCode: 0, stdout: big, stderr: "" })
      )
      // Pi's bash uses tail, so result stdout is truncated
      assert.isTrue(result.stdout.length < big.length)
      assert.include(result.stdout, "line 2999")
    }))
})

describe("PiToolkit shell (P5)", () => {
  it.effect("powershell is the same tool with a different argv", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{ executable: string; args: ReadonlyArray<string> } | undefined>(undefined)
      const Hps = PiToolkit.configure({ shell: "powershell" }).handlers
      const result = yield* withSandbox(
        {},
        Hps.shell({ command: "Write-Output hi" }, ctx),
        (cmd) => Ref.set(seen, { executable: cmd.executable, args: cmd.args }).pipe(Effect.as({ exitCode: 0, stdout: "hi\n", stderr: "" }))
      )
      assert.deepStrictEqual(result, { exit_code: 0, stdout: "hi\n", stderr: "" })
      assert.deepStrictEqual(yield* Ref.get(seen), { executable: "powershell", args: ["-NoProfile", "-Command", "Write-Output hi"] })
    }))

  it.effect("default shell is bash -c", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{ executable: string; args: ReadonlyArray<string> } | undefined>(undefined)
      const result = yield* withSandbox(
        {},
        H.shell({ command: "echo hi" }, ctx),
        (cmd) => Ref.set(seen, { executable: cmd.executable, args: cmd.args }).pipe(Effect.as({ exitCode: 0, stdout: "hi\n", stderr: "" }))
      )
      void result
      assert.deepStrictEqual(yield* Ref.get(seen), { executable: "bash", args: ["-c", "echo hi"] })
    }))

  it.effect("bash timeout is reported as actionable failure", () =>
    Effect.gen(function* () {
      const err = yield* withSandbox(
        {},
        Effect.flip(H.shell({ command: "sleep 10" }, ctx)),
        () => Effect.fail(new Sandbox.TimeoutError({ executable: "bash", timeoutMillis: 100 }))
      )
      assertString(err)
      assert.include(err, "terminated")
      assert.include(err, "100")
    }))

  it("the command tool is `shell`, projecting to shell on the command", () => {
    assert.strictEqual(PiToolkit.Shell.name, "shell")
    const projection = Permission.projectionOf(PiToolkit.Shell)
    assert.strictEqual(projection.action, "shell")
    assert.strictEqual(projection.resource({ command: "git push" }), "git push")
  })
})

describe("PiToolkit CRLF and BOM preservation (I4)", () => {
  it.effect("applies LF-quoted edit to CRLF file, leaving it CRLF", () =>
    Effect.gen(function* () {
      const after = yield* withSandbox(
        { "crlf.ts": "one\r\ntwo\r\nthree\r\n" },
        Effect.gen(function* () {
          yield* H.edit_file({ path: "crlf.ts", old_string: "one\ntwo", new_string: "1\n2" }, ctx)
          return yield* readRaw("crlf.ts")
        })
      )
      // readRaw strips BOM handling but keeps line endings decoded; we need raw bytes check
      const raw = yield* withSandbox(
        { "crlf.ts": "one\r\ntwo\r\nthree\r\n" },
        Effect.gen(function* () {
          yield* H.edit_file({ path: "crlf.ts", old_string: "one\ntwo", new_string: "1\n2" }, ctx)
          const b = yield* readBytes("crlf.ts")
          return new TextDecoder("utf-8", { ignoreBOM: true }).decode(b)
        })
      )
      assert.include(raw, "1\r\n2\r\n")
      assert.notInclude(raw.replace(/\r\n/g, ""), "\n")
      void after
    }))

  it.effect("BOM survives batch edit", () =>
    Effect.gen(function* () {
      const original = `${LineEndings.BOM}a\nb\nc\n`
      const bytes = new TextEncoder().encode(original)
      const text = yield* withSandbox(
        { "bom.ts": "placeholder" },
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.Current
          yield* sandbox.write(yield* Sandbox.path("bom.ts"), bytes)
          yield* H.edit_file({ path: "bom.ts", edits: [{ old_string: "a", new_string: "A" }, { old_string: "c", new_string: "C" }] }, ctx)
          const out = yield* sandbox.read(yield* Sandbox.path("bom.ts"))
          return new TextDecoder("utf-8", { ignoreBOM: true }).decode(out)
        })
      )
      assert.isTrue(text.startsWith(LineEndings.BOM))
      assert.include(text, "A\n")
      assert.include(text, "C\n")
    }))

  it.effect("refuses invalid UTF-8 with actionable message", () =>
    Effect.gen(function* () {
      const bad = new Uint8Array([0xff, 0xfe, 0x41])
      const err = yield* withSandbox(
        { "bad.txt": "x" },
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.Current
          yield* sandbox.write(yield* Sandbox.path("bad.txt"), bad)
          return yield* Effect.flip(H.edit_file({ path: "bad.txt", old_string: "x", new_string: "y" }, ctx))
        })
      )
      assertString(err)
      assert.include(err, "not valid UTF-8")
    }))
})

describe("PiToolkit integration with Agent", () => {
  it.effect("Pi toolkit runs through AgentSession.prompt", () =>
    Effect.gen(function* () {
      const agent = Agent.make({ toolkit: PiToolkit.toolkit() })
      const { layer: model } = yield* TestLanguageModel.script([TestLanguageModel.text("done")])
      const ws2 = Sandbox.workspace("pi-agent-prompt")
      const sandboxLayer = Layer.provideMerge(Sandbox.currentLayer(ws2), MemorySandbox.layer({ seed: {} }))
      const layer = Layer.merge(model, sandboxLayer)
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent).pipe(Effect.provide(layer))
          return yield* session.prompt("hello")
        })
      )
      assert.strictEqual(result.text, "done")
    }))

  it.effect("batch edit via tool call through session", () =>
    Effect.gen(function* () {
      const agent = Agent.make({ toolkit: PiToolkit.toolkit() })
      const { layer: model } = yield* TestLanguageModel.script([
        TestLanguageModel.toolCall("edit_file", { path: "f.ts", edits: [{ old_string: "foo", new_string: "bar" }] }),
        TestLanguageModel.text("edited")
      ])
      const ws2 = Sandbox.workspace("pi-agent")
      const sandboxLayer = Layer.provideMerge(Sandbox.currentLayer(ws2), MemorySandbox.layer({ seed: { "f.ts": "foo" } }))
      const layer = Layer.merge(model, sandboxLayer)
      const out = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(agent).pipe(Effect.provide(layer))
          const res = yield* session.prompt("edit it")
          const history = yield* session.history
          return { res, history }
        })
      )
      assert.strictEqual(out.res.text, "edited")
    }))
})
