import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import * as Agent from "../src/Agent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import { CodingToolkit } from "../src/coding/index.js"
import * as Glob from "../src/coding/internal/glob.js"
import * as ReadFormat from "../src/coding/internal/readFormat.js"
import * as SearchFormat from "../src/coding/internal/searchFormat.js"
import * as Truncate from "../src/coding/internal/truncate.js"
import * as Permission from "../src/Permission.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as RegexSafety from "../src/coding/internal/regexSafety.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { TestLanguageModel } from "../src/testing/index.js"

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

/**
 * The file's exact text: not filtered through read_file's line numbering, and
 * decoded with `ignoreBOM` so a byte-order mark is observable rather than
 * silently dropped by the decoder before the assertion sees it.
 */
const readRaw = (file: string) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.Current
    const bytes = yield* sandbox.read(yield* Sandbox.path(file))
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
  })

const H = CodingToolkit.handlers

describe("CodingToolkit handlers", () => {
  it.effect("read_file numbers lines, and honours offset and limit", () =>
    Effect.gen(function* () {
      const whole = yield* withSandbox({ "a.txt": "one\ntwo\nthree" }, H.read_file({ path: "a.txt" }, ctx))
      assert.strictEqual(
        whole,
        "<path>a.txt</path>\n<type>file</type>\n<content>\n1: one\n2: two\n3: three\n\n(End of file - total 3 lines)\n</content>"
      )
      const middle = yield* withSandbox(
        { "a.txt": "one\ntwo\nthree\nfour" },
        H.read_file({ path: "a.txt", offset: 2, limit: 2 }, ctx)
      )
      assert.include(middle, "2: two\n3: three")
      // A window that stops short says exactly how to continue.
      assert.include(middle, "(Showing lines 2-3 of 4. Use offset=4 to continue.)")
      // A non-positive offset means the top, not slice(-1)'s last line.
      const clamped = yield* withSandbox(
        { "a.txt": "one\ntwo\nthree" },
        H.read_file({ path: "a.txt", offset: 0, limit: 2 }, ctx)
      )
      assert.include(clamped, "1: one\n2: two")
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
      assert.include(result.read, "1: hello")
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
      assert.strictEqual(edited.msg.replacements, 1)
      assert.strictEqual(edited.msg.path, "f.ts")
      assert.strictEqual(edited.msg.strategy, "simple")
      // An exact match replaced exactly what was asked for.
      assert.strictEqual(edited.msg.matched, "const x = 1")
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
      assert.strictEqual(all.msg.replacements, 3)
      assert.include(all.after, "1: b\n2: b\n3: b")
      // Not found.
      const missing = yield* Effect.flip(
        withSandbox({ "f.ts": "hello" }, H.edit_file({ path: "f.ts", old_string: "nope", new_string: "x" }, ctx))
      )
      assertString(missing)
      assert.include(missing, "was not found")
      // An empty old_string is refused, not treated as matching everywhere --
      // and the refusal names the tool that does mean "replace the whole file".
      const emptyOld = yield* Effect.flip(
        withSandbox({ "f.ts": "hello" }, H.edit_file({ path: "f.ts", old_string: "", new_string: "x" }, ctx))
      )
      assertString(emptyOld)
      assert.include(emptyOld, "cannot be empty")
      assert.include(emptyOld, "write_file")
      // A `$` in new_string is literal, not a String.replace special pattern.
      const dollars = yield* withSandbox(
        { "f.ts": "price = OLD" },
        Effect.gen(function* () {
          yield* H.edit_file({ path: "f.ts", old_string: "OLD", new_string: "$&{amount}" }, ctx)
          return yield* H.read_file({ path: "f.ts" }, ctx)
        })
      )
      assert.include(dollars, "1: price = $&{amount}")
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
      // A path scopes the listing to that subtree.
      const scoped = yield* withSandbox(
        { "dir/b.txt": "2", "dir/c.txt": "3", "a.txt": "1" },
        H.list_files({ path: "dir" }, ctx)
      )
      assert.deepStrictEqual([...scoped].sort((x, y) => (x.path < y.path ? -1 : 1)), [
        { path: "dir/b.txt", type: "file" },
        { path: "dir/c.txt", type: "file" }
      ])
    })
  )

  it.effect("search groups matches by file, with line numbers", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        {
          "src/a.ts": "const foo = 1\nconst bar = 2\nfoo again",
          "src/b.ts": "function foo() {}",
          "readme.md": "no match here"
        },
        H.search({ pattern: "foo" }, ctx)
      )
      assertString(out)
      assert.strictEqual(
        out,
        [
          "Found 3 matches",
          "src/a.ts:",
          "  Line 1: const foo = 1",
          "  Line 3: foo again",
          "",
          "src/b.ts:",
          "  Line 1: function foo() {}"
        ].join("\n")
      )
    })
  )

  it.effect("search scopes to a subtree, reports nothing found, and refuses a bad regex", () =>
    Effect.gen(function* () {
      const scoped = yield* withSandbox(
        { "src/a.ts": "foo", "other/c.ts": "foo" },
        H.search({ pattern: "foo", path: "other" }, ctx)
      )
      assertString(scoped)
      assert.include(scoped, "other/c.ts:")
      assert.notInclude(scoped, "src/a.ts")

      const none = yield* withSandbox({ "a.ts": "nothing" }, H.search({ pattern: "zzz" }, ctx))
      assert.strictEqual(none, SearchFormat.NO_RESULTS)

      // An invalid regex is a string the model can act on, not a defect.
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

  it.effect("bash reports a non-zero exit and stderr as a success value, and forwards a timeout", () =>
    Effect.gen(function* () {
      const opts = yield* Ref.make<unknown>(undefined)
      const result = yield* withSandbox(
        {},
        H.bash({ command: "false", timeout_ms: 500 }, ctx),
        (_cmd, options) =>
          Ref.set(opts, options).pipe(Effect.as({ exitCode: 2, stdout: "", stderr: "boom" }))
      )
      // A non-zero exit is not a run failure -- it is a success the model reads.
      assert.deepStrictEqual(result, { exit_code: 2, stdout: "", stderr: "boom" })
      // timeout_ms is forwarded to exec as a timeout option.
      assert.deepStrictEqual(yield* Ref.get(opts), { timeout: 500 })
    })
  )
})

describe("CodingToolkit read_file: caps, continuation and refusals", () => {
  it.effect("caps a long line and says it did", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "long.txt": "x".repeat(ReadFormat.MAX_LINE_LENGTH + 500) },
        H.read_file({ path: "long.txt" }, ctx)
      )
      assertString(out)
      assert.include(out, ReadFormat.MAX_LINE_SUFFIX)
      // The line itself is cut at the limit, not merely annotated.
      assert.notInclude(out, "x".repeat(ReadFormat.MAX_LINE_LENGTH + 1))
    })
  )

  it.effect("caps the whole read by bytes, and the footer quotes the byte limit", () =>
    Effect.gen(function* () {
      // Each line is 1 KB, so the 50 KB budget runs out long before any line
      // limit does.
      const file = Array.from({ length: 200 }, () => "y".repeat(1023)).join("\n")
      const out = yield* withSandbox({ "big.txt": file }, H.read_file({ path: "big.txt" }, ctx))
      assertString(out)
      assert.include(out, `Output capped at ${ReadFormat.MAX_BYTES_LABEL}`)
      assert.include(out, "Use offset=")
      // A byte-capped read stopped early, so it quotes no total: it does not
      // know one, and inventing it would mislead.
      assert.notInclude(out, "of 200")
    })
  )

  it.effect("following the footer's offset walks the whole file exactly once", () =>
    Effect.gen(function* () {
      const file = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n")
      const seen = yield* withSandbox(
        { "walk.txt": file },
        Effect.gen(function* () {
          const collected: Array<string> = []
          let offset = 1
          for (let step = 0; step < 20; step++) {
            const page = yield* H.read_file({ path: "walk.txt", offset, limit: 7 }, ctx)
            for (const line of page.split("\n")) {
              const numbered = /^(\d+): (.*)$/.exec(line)
              if (numbered !== null) collected.push(numbered[2] ?? "")
            }
            const next = /Use offset=(\d+) to continue/.exec(page)
            if (next === null) break
            offset = Number(next[1])
          }
          return collected
        })
      )
      // Every line, in order, no repeats and no gaps.
      assert.deepStrictEqual(seen, file.split("\n"))
    })
  )

  it.effect("an offset past the end says how many lines there are", () =>
    Effect.gen(function* () {
      const out = yield* Effect.flip(
        withSandbox({ "a.txt": "one\ntwo" }, H.read_file({ path: "a.txt", offset: 9 }, ctx))
      )
      assertString(out)
      assert.strictEqual(out, "Offset 9 is out of range for this file (2 lines)")
      // An empty file read from the top is not an error, and has no lines --
      // not one empty line, which is what a naive split would report.
      const empty = yield* withSandbox({ "e.txt": "" }, H.read_file({ path: "e.txt" }, ctx))
      assertString(empty)
      assert.include(empty, "total 0 lines")
      assert.notInclude(empty, "1: ")
    })
  )

  it.effect("a missing file names the neighbours it might have meant", () =>
    Effect.gen(function* () {
      const out = yield* Effect.flip(
        withSandbox(
          { "src/config.ts": "a", "src/configuration.md": "b", "src/unrelated.ts": "c" },
          // The extension was left off -- the common near miss this catches.
          H.read_file({ path: "src/config" }, ctx)
        )
      )
      assertString(out)
      assert.include(out, "File not found: src/config")
      assert.include(out, "Did you mean")
      assert.include(out, "src/config.ts")
      assert.include(out, "src/configuration.md")
      // A name sharing nothing with the request is not offered.
      assert.notInclude(out, "unrelated")
    })
  )

  it("suggestions match by containment, not by spelling", () => {
    // Worth pinning because it bounds what the hint can do: a name that merely
    // *resembles* the request is not offered, so a misspelling gets a plain
    // not-found rather than a confident wrong guess.
    const siblings = ["src/config.ts", "src/configuration.md", "src/unrelated.ts"]
    assert.deepStrictEqual(ReadFormat.suggestions("src/config", siblings), [
      "src/config.ts",
      "src/configuration.md"
    ])
    assert.deepStrictEqual(ReadFormat.suggestions("src/confg.ts", siblings), [])
    // At most three, however many match.
    const many = Array.from({ length: 9 }, (_, i) => `src/thing${i}.ts`)
    assert.strictEqual(ReadFormat.suggestions("src/thing", many).length, 3)
  })

  it.effect("a missing file with nothing like it just says so", () =>
    Effect.gen(function* () {
      const out = yield* Effect.flip(
        withSandbox({ "src/alpha.ts": "a" }, H.read_file({ path: "src/zzzzz.ts" }, ctx))
      )
      assertString(out)
      assert.strictEqual(out, "File not found: src/zzzzz.ts")
    })
  )

  it.effect("refuses a binary file, by content and by extension", () =>
    Effect.gen(function* () {
      // A NUL byte settles it whatever the extension.
      const nul = yield* Effect.flip(
        withSandbox({}, Effect.gen(function* () {
          const sandbox = yield* Sandbox.Current
          yield* sandbox.write(yield* Sandbox.path("blob.txt"), new Uint8Array([104, 105, 0, 104]))
          return yield* H.read_file({ path: "blob.txt" }, ctx)
        }))
      )
      assertString(nul)
      assert.include(nul, "Cannot read binary file: blob.txt")
      // An archive extension is trusted even when its bytes look like text.
      const byExtension = yield* Effect.flip(
        withSandbox({ "bundle.zip": "this is plainly text" }, H.read_file({ path: "bundle.zip" }, ctx))
      )
      assertString(byExtension)
      assert.include(byExtension, "Cannot read binary file: bundle.zip")
    })
  )

  it.effect("points at list_files when handed a directory", () =>
    Effect.gen(function* () {
      const out = yield* Effect.flip(
        withSandbox({ "dir/a.txt": "x" }, H.read_file({ path: "dir" }, ctx))
      )
      assertString(out)
      assert.include(out, "is a directory")
      assert.include(out, "list_files")
    })
  )
})

describe("CodingToolkit edit_file: the replacer chain", () => {
  it.effect("tolerates trailing-whitespace drift the model did not reproduce", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "f.ts": "function f() {\n  return 1;   \n}\n" },
        Effect.gen(function* () {
          const msg = yield* H.edit_file(
            { path: "f.ts", old_string: "  return 1;\n", new_string: "  return 2;\n" },
            ctx
          )
          return { msg, after: yield* readRaw("f.ts") }
        })
      )
      // The edit landed, and the result names the strategy so the model can
      // tell its quotation was not literal.
      assert.strictEqual(out.msg.strategy, "line-trimmed")
      // The point of reporting the matched span: it is what was *actually*
      // replaced, which under a fuzzy strategy is not what was asked for.
      // Here the file had trailing spaces the caller did not reproduce.
      assert.strictEqual(out.msg.matched, "  return 1;   \n")
      assert.notStrictEqual(out.msg.matched, "  return 1;\n")
      assert.strictEqual(out.after, "function f() {\n  return 2;\n}\n")
    })
  )

  it.effect("reports the change in lines a reader would count", () =>
    Effect.gen(function* () {
      // The matched span carries the newline that ends the line, but replacing
      // one line is a change of one line, not two.
      const single = yield* withSandbox(
        { "f.ts": "alpha\nbeta\n" },
        H.edit_file({ path: "f.ts", old_string: "alpha\n", new_string: "ALPHA\n" }, ctx)
      )
      assert.strictEqual(single.added, 1)
      assert.strictEqual(single.removed, 1)
      // Two lines becoming three.
      const grown = yield* withSandbox(
        { "f.ts": "a\nb\nc\n" },
        H.edit_file({ path: "f.ts", old_string: "a\nb", new_string: "x\ny\nz" }, ctx)
      )
      assert.strictEqual(grown.added, 3)
      assert.strictEqual(grown.removed, 2)
    })
  )

  it.effect("applies a multi-line LF-quoted edit to a CRLF file, leaving it CRLF", () =>
    Effect.gen(function* () {
      // The old_string must span lines: a single-line quotation contains no
      // newline to reconcile, so it would pass even with the conversion gone.
      const after = yield* withSandbox(
        { "crlf.ts": "one\r\ntwo\r\nthree\r\n" },
        Effect.gen(function* () {
          yield* H.edit_file(
            { path: "crlf.ts", old_string: "one\ntwo", new_string: "1\n2" },
            ctx
          )
          return yield* readRaw("crlf.ts")
        })
      )
      assert.strictEqual(after, "1\r\n2\r\nthree\r\n")
      // Not one bare LF was introduced.
      assert.notInclude(after.replace(/\r\n/g, ""), "\n")
    })
  )

  it.effect("leaves every byte outside the replaced span alone", () =>
    Effect.gen(function* () {
      // A BOM, and a stray LF in an otherwise-CRLF file: both must survive.
      const original = "\uFEFFa\r\nb\r\nc\nd\r\n"
      const after = yield* withSandbox(
        { "mixed.ts": original },
        Effect.gen(function* () {
          yield* H.edit_file({ path: "mixed.ts", old_string: "b", new_string: "B" }, ctx)
          return yield* readRaw("mixed.ts")
        })
      )
      assert.strictEqual(after, "\uFEFFa\r\nB\r\nc\nd\r\n")
    })
  )

  it.effect("refuses an identical edit, and points at write_file for an empty old_string", () =>
    Effect.gen(function* () {
      const same = yield* Effect.flip(
        withSandbox(
          { "f.ts": "x" },
          H.edit_file({ path: "f.ts", old_string: "x", new_string: "x" }, ctx)
        )
      )
      assertString(same)
      assert.include(same, "identical")
    })
  )

  it.effect("refuses a match far larger than old_string rather than applying it", () =>
    Effect.gen(function* () {
      const body = Array.from({ length: 40 }, (_, i) => `  line ${i}`).join("\n")
      const file = `start {\n${body}\n}\nstart {\n  line a\n}`
      const out = yield* withSandbox(
        { "big.ts": file },
        Effect.gen(function* () {
          const result = yield* Effect.result(
            H.edit_file(
              { path: "big.ts", old_string: "start {\n  line a\n}", new_string: "start {}" },
              ctx
            )
          )
          return { result, after: yield* readRaw("big.ts") }
        })
      )
      // Whether it matched the small block or refused outright, the forty-line
      // block is still there: a fuzzy strategy never swallowed it.
      assert.include(out.after, "  line 39")
      if (out.result._tag === "Failure") {
        assertString(out.result.failure)
        assert.include(out.result.failure, "Re-read")
      }
    })
  )

  it.effect("an interleaved read cannot lose an update: the lock covers read-to-write", () =>
    Effect.gen(function* () {
      // `read` yields control *after* fetching, so the gap that matters -- the
      // one between reading and writing -- is where the fibres interleave.
      // Without the per-path lock both edits then hold the original text and
      // whichever writes second silently discards the other's change. The
      // yield is cooperative scheduling, not a sleep: it interleaves every run.
      const contended = (inner: Sandbox.Sandbox): Sandbox.Sandbox => ({
        ...inner,
        read: (path) => Effect.flatMap(inner.read(path), (bytes) => Effect.as(Effect.yieldNow, bytes))
      })
      const after = yield* withSandbox(
        { "f.ts": "alpha\nbeta\n" },
        Effect.gen(function* () {
          const gated = contended(yield* Sandbox.Current)
          yield* Effect.all(
            [
              H.edit_file({ path: "f.ts", old_string: "alpha", new_string: "ALPHA" }, ctx),
              H.edit_file({ path: "f.ts", old_string: "beta", new_string: "BETA" }, ctx)
            ],
            { concurrency: "unbounded" }
          ).pipe(Effect.provideService(Sandbox.Current, gated))
          return yield* readRaw("f.ts")
        })
      )
      // Both edits survive. Either one alone would mean an update was lost.
      assert.strictEqual(after, "ALPHA\nBETA\n")
    })
  )

  it.effect("edits to one file never interleave: read/write pairs stay whole", () =>
    Effect.gen(function* () {
      // The exact operation sequence, not merely the final content: two edits
      // must produce read,write,read,write -- never read,read,write,write.
      const ops = yield* Ref.make<ReadonlyArray<string>>([])
      const recording = (inner: Sandbox.Sandbox): Sandbox.Sandbox => ({
        ...inner,
        read: (path) =>
          Ref.update(ops, (all) => [...all, `read ${path}`]).pipe(
            Effect.andThen(inner.read(path)),
            // Yield between read and write: the window a lost update needs.
            Effect.tap(() => Effect.yieldNow)
          ),
        write: (path, content) =>
          Ref.update(ops, (all) => [...all, `write ${path}`]).pipe(
            Effect.andThen(inner.write(path, content))
          )
      })
      yield* withSandbox(
        { "f.ts": "alpha\nbeta\n" },
        Effect.gen(function* () {
          const gated = recording(yield* Sandbox.Current)
          yield* Effect.all(
            [
              H.edit_file({ path: "f.ts", old_string: "alpha", new_string: "ALPHA" }, ctx),
              H.edit_file({ path: "f.ts", old_string: "beta", new_string: "BETA" }, ctx)
            ],
            { concurrency: "unbounded" }
          ).pipe(Effect.provideService(Sandbox.Current, gated))
        })
      )
      assert.deepStrictEqual(yield* Ref.get(ops), [
        "read f.ts",
        "write f.ts",
        "read f.ts",
        "write f.ts"
      ])
    })
  )

  /**
   * The registry used to be a plain `Map` that only ever grew, and its comment
   * said evicting safely would need reference counting -- dropping a lock
   * somebody holds silently ends the mutual exclusion. It is now a `TxRef`, so
   * "last holder leaves" and "entry removed" are one transaction.
   *
   * These three tests are the ones that could not be written before.
   */
  it.effect("the lock registry drains: an edited path leaves no entry behind", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* CodingToolkit.lockRegistrySize, 0)
      yield* withSandbox(
        { "a.ts": "alpha\n", "b.ts": "beta\n" },
        Effect.gen(function* () {
          yield* H.edit_file({ path: "a.ts", old_string: "alpha", new_string: "ALPHA" }, ctx)
          yield* H.edit_file({ path: "b.ts", old_string: "beta", new_string: "BETA" }, ctx)
          // Held only for the duration of the edit, never after it.
          assert.strictEqual(yield* CodingToolkit.lockRegistrySize, 0)
        })
      )
      assert.strictEqual(yield* CodingToolkit.lockRegistrySize, 0)
    })
  )

  it.effect("a waiter arriving as the lock drains still gets exclusion", () =>
    Effect.gen(function* () {
      // The hazard the old comment named, made concrete. The second edit is
      // released the instant the first finishes its write, so it arrives
      // exactly in the window where a check-then-delete registry would have
      // removed the entry -- leaving it to mint a second semaphore and edit
      // under a lock the first never respected.
      const firstWrote = yield* Deferred.make<void>()
      const ops = yield* Ref.make<ReadonlyArray<string>>([])
      const recording = (inner: Sandbox.Sandbox): Sandbox.Sandbox => ({
        ...inner,
        read: (path) =>
          Ref.update(ops, (all) => [...all, "read"]).pipe(
            Effect.andThen(inner.read(path)),
            Effect.tap(() => Effect.yieldNow)
          ),
        write: (path, content) =>
          Ref.update(ops, (all) => [...all, "write"]).pipe(
            Effect.andThen(inner.write(path, content)),
            Effect.tap(() => Deferred.succeed(firstWrote, undefined))
          )
      })
      const after = yield* withSandbox(
        { "f.ts": "alpha\nbeta\n" },
        Effect.gen(function* () {
          const gated = recording(yield* Sandbox.Current)
          yield* Effect.all(
            [
              H.edit_file({ path: "f.ts", old_string: "alpha", new_string: "ALPHA" }, ctx),
              // Waits for the first write, then races the drain.
              Deferred.await(firstWrote).pipe(
                Effect.andThen(
                  H.edit_file({ path: "f.ts", old_string: "beta", new_string: "BETA" }, ctx)
                )
              )
            ],
            { concurrency: "unbounded" }
          ).pipe(Effect.provideService(Sandbox.Current, gated))
          return yield* readRaw("f.ts")
        })
      )
      // Both edits landed, and the pairs never interleaved.
      assert.strictEqual(after, "ALPHA\nBETA\n")
      assert.deepStrictEqual(yield* Ref.get(ops), ["read", "write", "read", "write"])
      assert.strictEqual(yield* CodingToolkit.lockRegistrySize, 0)
    })
  )

  /**
   * R55 -- `write_file` and `edit_file` mutate the same file, so they need
   * the same lock.
   *
   * The concurrency suite covered edit against edit. `write_file` went
   * straight to the sandbox, so a write landing between an edit's read and
   * its write was overwritten by a value derived from content that no longer
   * existed -- and the write reported success.
   *
   * The edit is held open on a Deferred after its read, and the write is
   * released into that window. Under one lock the write cannot start there,
   * so the file ends up carrying both changes rather than one.
   */
  it.effect("a write cannot land inside an edit's read-modify-write", () =>
    Effect.gen(function* () {
      const editRead = yield* Deferred.make<void>()
      const writeDone = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()

      const gated = (inner: Sandbox.Sandbox): Sandbox.Sandbox => ({
        ...inner,
        read: (path) =>
          Effect.andThen(
            inner.read(path),
            (bytes) =>
              // Announce the read, then stall inside the edit's critical
              // section for as long as the test wants.
              Deferred.succeed(editRead, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(bytes)
              )
          )
      })

      const after = yield* withSandbox(
        { "f.ts": "alpha\n" },
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.Current
          const edit = yield* Effect.forkChild(
            H.edit_file({ path: "f.ts", old_string: "alpha", new_string: "ALPHA" }, ctx).pipe(
              Effect.provideService(Sandbox.Current, gated(sandbox))
            )
          )
          // The edit has read and is holding the lock.
          yield* Deferred.await(editRead)

          const write = yield* Effect.forkChild(
            H.write_file({ path: "f.ts", content: "written\n" }, ctx).pipe(
              Effect.andThen(Deferred.succeed(writeDone, undefined))
            )
          )
          // Give the write every chance to get in: several scheduler passes
          // while the edit is deliberately stuck.
          yield* Effect.forEach([1, 2, 3, 4, 5], () => Effect.yieldNow, { discard: true })
          const wroteInsideTheEdit = yield* Deferred.isDone(writeDone)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(edit)
          yield* Fiber.join(write)

          return { wroteInsideTheEdit, text: yield* readRaw("f.ts") }
        })
      )

      assert.isFalse(
        after.wroteInsideTheEdit,
        "the write completed while the edit held the lock"
      )
      // The write went second, so it is what the file says -- and crucially
      // it was not silently reverted by the edit finishing afterwards.
      assert.strictEqual(after.text, "written\n")
      assert.strictEqual(yield* CodingToolkit.lockRegistrySize, 0)
    })
  )

  it.effect("an interrupted edit does not pin its lock entry", () =>
    Effect.gen(function* () {
      // `acquireUseRelease`, not a bare `withPermit`: a caller interrupted
      // mid-edit must still decrement, or the entry is pinned forever and the
      // leak is back in a subtler form.
      const reading = yield* Deferred.make<void>()
      const stalling = (inner: Sandbox.Sandbox): Sandbox.Sandbox => ({
        ...inner,
        read: (path) =>
          Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.andThen(inner.read(path))
          )
      })
      yield* withSandbox(
        { "f.ts": "alpha\n" },
        Effect.gen(function* () {
          const gated = stalling(yield* Sandbox.Current)
          const fiber = yield* Effect.forkChild(
            H.edit_file({ path: "f.ts", old_string: "alpha", new_string: "ALPHA" }, ctx).pipe(
              Effect.provideService(Sandbox.Current, gated)
            )
          )
          yield* Deferred.await(reading)
          assert.strictEqual(yield* CodingToolkit.lockRegistrySize, 1)
          yield* Fiber.interrupt(fiber)
          assert.strictEqual(yield* CodingToolkit.lockRegistrySize, 0)
        })
      )
    })
  )

  it.effect("edits to different files still run concurrently: the lock is per path", () =>
    Effect.gen(function* () {
      // Both edits must be in flight at once, so a lock that is per file rather
      // than global is what lets this finish at all.
      const bothReading = yield* Deferred.make<void>()
      const seen = yield* Ref.make(0)
      const rendezvous = (inner: Sandbox.Sandbox): Sandbox.Sandbox => ({
        ...inner,
        read: (path) =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(seen, (n) => n + 1)
            if (count === 2) yield* Deferred.succeed(bothReading, void 0)
            // Neither edit may proceed until both have read: a global lock
            // would deadlock here, and the test would time out.
            yield* Deferred.await(bothReading)
            return yield* inner.read(path)
          })
      })
      const out = yield* withSandbox(
        { "a.ts": "alpha", "b.ts": "beta" },
        Effect.gen(function* () {
          const gated = rendezvous(yield* Sandbox.Current)
          yield* Effect.all(
            [
              H.edit_file({ path: "a.ts", old_string: "alpha", new_string: "ALPHA" }, ctx),
              H.edit_file({ path: "b.ts", old_string: "beta", new_string: "BETA" }, ctx)
            ],
            { concurrency: "unbounded" }
          ).pipe(Effect.provideService(Sandbox.Current, gated))
          return { a: yield* readRaw("a.ts"), b: yield* readRaw("b.ts") }
        })
      )
      assert.deepStrictEqual(out, { a: "ALPHA", b: "BETA" })
    })
  )
})

describe("CodingToolkit search: bounds, filters and skips", () => {
  it.effect("stops at the limit, says so, and does not read the rest of the tree", () =>
    Effect.gen(function* () {
      // Far more matches than the limit, spread across far more files than the
      // search should need to open.
      const files: Record<string, string> = {}
      for (let i = 0; i < 400; i++) files[`f${String(i).padStart(3, "0")}.ts`] = "needle"
      const opened = yield* Ref.make(0)
      const counting = (inner: Sandbox.Sandbox): Sandbox.Sandbox => ({
        ...inner,
        read: (path) => Effect.andThen(Ref.update(opened, (n) => n + 1), inner.read(path))
      })
      const out = yield* withSandbox(
        files,
        Effect.gen(function* () {
          const gated = counting(yield* Sandbox.Current)
          const result = yield* H.search({ pattern: "needle" }, ctx).pipe(
            Effect.provideService(Sandbox.Current, gated)
          )
          return { result, opened: yield* Ref.get(opened) }
        })
      )
      assertString(out.result)
      assert.include(out.result, `Found ${SearchFormat.SEARCH_LIMIT} matches`)
      assert.include(out.result, "(more matches available)")
      assert.include(out.result, "(Results truncated. Consider using a more specific path or pattern.)")
      // The point of the bound: it stopped looking, rather than reading 400
      // files and throwing most of the work away.
      assert.strictEqual(out.opened, SearchFormat.SEARCH_LIMIT)
      assert.isBelow(out.opened, 400)
    })
  )

  it.effect("does not descend into build or dependency directories", () =>
    Effect.gen(function* () {
      // Without this rule the walk is alphabetical, so `dist` and
      // `node_modules` fill the whole result budget and the source is never
      // reached. Measured on this repository: 100 matches, none from `src`.
      const files = {
        "dist/bundle.js": "needle",
        "node_modules/pkg/index.js": "needle",
        ".git/COMMIT_EDITMSG": "needle",
        "coverage/report.html": "needle",
        "src/real.ts": "needle"
      }
      const out = yield* withSandbox(files, H.search({ pattern: "needle" }, ctx))
      assertString(out)
      assert.include(out, "src/real.ts:")
      assert.notInclude(out, "dist/")
      assert.notInclude(out, "node_modules")
      assert.notInclude(out, ".git/")
      assert.notInclude(out, "coverage/")
      assert.include(out, "Found 1 matches")
    })
  )

  it.effect("searches an ignored directory when asked to explicitly", () =>
    Effect.gen(function* () {
      // The rule is about what the walk descends into, not about what may be
      // searched: pointing `path` at `dist` is an explicit request.
      const out = yield* withSandbox(
        { "dist/bundle.js": "needle", "src/real.ts": "needle" },
        H.search({ pattern: "needle", path: "dist" }, ctx)
      )
      assertString(out)
      assert.include(out, "dist/bundle.js:")
      assert.notInclude(out, "src/real.ts")
    })
  )

  it.effect("still skips an ignored directory nested inside a searched one", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "src/a.ts": "needle", "src/node_modules/dep/i.js": "needle" },
        H.search({ pattern: "needle", path: "src" }, ctx)
      )
      assertString(out)
      assert.include(out, "src/a.ts:")
      assert.notInclude(out, "node_modules")
    })
  )

  it.effect("skips binary files rather than failing on them", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "a.ts": "needle here" },
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.Current
          // Bytes containing NUL, and the word, in a file that is not text.
          yield* sandbox.write(
            yield* Sandbox.path("blob.bin"),
            new Uint8Array([110, 101, 101, 100, 108, 101, 0, 1, 2])
          )
          return yield* H.search({ pattern: "needle" }, ctx)
        })
      )
      assertString(out)
      assert.include(out, "a.ts:")
      assert.notInclude(out, "blob.bin")
    })
  )

  it.effect("include filters by glob", () =>
    Effect.gen(function* () {
      const files = {
        "src/a.ts": "needle",
        "src/b.js": "needle",
        "src/deep/c.ts": "needle",
        "notes.md": "needle"
      }
      const ts = yield* withSandbox(files, H.search({ pattern: "needle", include: "*.ts" }, ctx))
      assertString(ts)
      // A pattern with no slash matches the file's name at any depth.
      assert.include(ts, "src/a.ts:")
      assert.include(ts, "src/deep/c.ts:")
      assert.notInclude(ts, "src/b.js")
      assert.notInclude(ts, "notes.md")

      const braces = yield* withSandbox(
        files,
        H.search({ pattern: "needle", include: "*.{ts,js}" }, ctx)
      )
      assertString(braces)
      assert.include(braces, "src/b.js:")
      assert.include(braces, "src/a.ts:")
      assert.notInclude(braces, "notes.md")

      // A pattern with a slash is anchored to the path, so depth matters.
      const shallow = yield* withSandbox(
        files,
        H.search({ pattern: "needle", include: "src/*.ts" }, ctx)
      )
      assertString(shallow)
      assert.include(shallow, "src/a.ts:")
      assert.notInclude(shallow, "src/deep/c.ts")

      /**
       * R58 -- a refused filter is said out loud.
       *
       * The alternative is a search that matched nothing, which reads exactly
       * like a search that found nothing -- and the model, which wrote the
       * pattern, has no way to tell the two apart or to correct it.
       */
      const refused = yield* Effect.flip(
        withSandbox(
          files,
          H.search({ pattern: "needle", include: "{a,{b,{c,{d,{e,f}}}}}.ts" }, ctx)
        )
      )
      assert.include(String(refused), "Refusing to search")
      assert.include(String(refused), "braces")
    })
  )

  it.effect("caps a very long matching line", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "min.js": `needle${"z".repeat(ReadFormat.MAX_LINE_LENGTH + 200)}` },
        H.search({ pattern: "needle" }, ctx)
      )
      assertString(out)
      assert.include(out, ReadFormat.MAX_LINE_SUFFIX)
      assert.isBelow(out.length, ReadFormat.MAX_LINE_LENGTH + 300)
    })
  )

  it.effect("reports every matching line in a file, not just the first", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox(
        { "a.ts": "hit\nhit\nhit\nhit" },
        H.search({ pattern: "hit" }, ctx)
      )
      assertString(out)
      assert.include(out, "  Line 1: hit")
      assert.include(out, "  Line 2: hit")
      assert.include(out, "  Line 3: hit")
      assert.include(out, "  Line 4: hit")
    })
  )

  it.effect("does not invent a match on the empty line a trailing newline suggests", () =>
    Effect.gen(function* () {
      // "a\n" is one line. A pattern matching anything must not report a
      // second, empty one -- and its line number would be past the file's end.
      const out = yield* withSandbox({ "a.ts": "alpha\n" }, H.search({ pattern: ".*" }, ctx))
      assertString(out)
      assert.include(out, "Found 1 matches")
      assert.include(out, "  Line 1: alpha")
      assert.notInclude(out, "Line 2")
    })
  )
})

describe("glob matching", () => {
  const cases: ReadonlyArray<readonly [pattern: string, path: string, expected: boolean]> = [
    ["*.ts", "a.ts", true],
    ["*.ts", "src/deep/a.ts", true],
    ["*.ts", "a.js", false],
    ["*.{ts,tsx}", "a.tsx", true],
    ["*.{ts,tsx}", "a.js", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/deep/a.ts", false],
    ["src/**/*.ts", "src/deep/a.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["**/*.ts", "a.ts", true],
    ["a?c.ts", "abc.ts", true],
    ["a?c.ts", "ac.ts", false],
    ["a.b.ts", "axbxts", false],
    ["", "anything.ts", true],
    // Regex metacharacters are literal text, not pattern syntax. Without
    // escaping, "a+b.ts" would match "aab.ts" and "a(b).ts" would not match
    // itself at all.
    ["a+b.ts", "a+b.ts", true],
    ["a+b.ts", "aab.ts", false],
    ["a(b).ts", "a(b).ts", true],
    ["a$b.ts", "a$b.ts", true],
    ["a[b].ts", "a[b].ts", true],
    // Brace alternation, including across two groups.
    ["{a,b}.{ts,js}", "a.js", true],
    ["{a,b}.{ts,js}", "c.js", false],
    // `**` crosses directories; a bare `*` never does.
    ["src/**", "src/x/y.ts", true],
    ["src/**", "other/a.ts", false],
    ["dir/*", "dir/a.ts", true],
    ["dir/*", "dir/sub/a.ts", false],
    // Matching is case-sensitive, as ripgrep's globs are.
    ["*.TS", "a.ts", false],
    // A malformed pattern matches nothing rather than throwing: the caller
    // sees an empty result it can correct, not a failed tool.
    ["unclosed{a", "x", false]
  ]
  for (const [pattern, path, expected] of cases) {
    it(`${pattern || "(empty)"} vs ${path} is ${expected}`, () => {
      assert.strictEqual(Glob.matches(pattern, path), expected)
    })
  }

  /**
   * R58 -- an adversarial `include` is refused before it is compiled.
   *
   * Nested brace alternations become nested alternation groups, and a modest
   * pattern can then take seconds to match a single filename; a review
   * measured roughly three seconds for a 121-character glob. A JavaScript
   * regular expression runs synchronously and cannot be interrupted, so
   * neither an Effect timeout nor cancellation helps once matching starts --
   * the only defence is not to build it.
   *
   * Asserted structurally rather than by elapsed time: a timing test on a
   * fast machine passes with the limit removed, which is the exact failure
   * mode that makes a test worse than none.
   */
  it("refuses a pattern that nests braces too deeply", () => {
    const nested = "{a,{b,{c,{d,{e,f}}}}}.ts"
    const refused = Glob.compile(nested)
    assert.strictEqual(refused._tag, "Refused")
    if (refused._tag === "Refused") assert.include(refused.reason, "braces")

    // At the limit it still compiles: the bound is above any glob a person
    // writes, and refusing an ordinary one would be its own defect.
    const allowed = Glob.compile("src/**/{a,{b,c}}.{ts,tsx}")
    assert.strictEqual(allowed._tag, "Matcher")
    if (allowed._tag === "Matcher") {
      assert.isTrue(allowed.matches("src/deep/b.tsx"))
      assert.isFalse(allowed.matches("src/deep/z.tsx"))
    }
  })

  it("refuses a pattern longer than the cap", () => {
    const long = `${"a".repeat(Glob.MAX_PATTERN_LENGTH)}.ts`
    const refused = Glob.compile(long)
    assert.strictEqual(refused._tag, "Refused")
    if (refused._tag === "Refused") assert.include(refused.reason, "longer than")
  })

  /**
   * And compiling happens once, not once per path.
   *
   * `search` filtered with `Glob.matches`, which rebuilds the regular
   * expression on every call -- so a walk over a thousand files compiled a
   * thousand identical expressions, multiplying both the ordinary cost and an
   * adversarial one by the size of the tree.
   */
  it("compiles once and matches many", () => {
    const compiled = Glob.compile("*.ts")
    assert.strictEqual(compiled._tag, "Matcher")
    if (compiled._tag === "Matcher") {
      assert.isTrue(compiled.matches("a.ts"))
      assert.isTrue(compiled.matches("src/deep/b.ts"))
      assert.isFalse(compiled.matches("a.js"))
    }
  })
})

describe("CodingToolkit bash: bounded output and honest failures", () => {
  /** An exec script returning fixed output. */
  const emitting = (stdout: string, stderr = ""): Sandbox.Sandbox["exec"] => () =>
    Effect.succeed({ exitCode: 0, stdout, stderr })

  it.effect("passes short output through untouched", () =>
    Effect.gen(function* () {
      const out = yield* withSandbox({}, H.bash({ command: "echo hi" }, ctx), emitting("hi\n"))
      assert.deepStrictEqual(out, { exit_code: 0, stdout: "hi\n", stderr: "" })
    })
  )

  it.effect("keeps the end of a long output, not the start, and saves the whole of it", () =>
    Effect.gen(function* () {
      // A build log: the failure is at the bottom, which is the part a tail
      // keeps and a head would throw away.
      const noise = Array.from({ length: 5000 }, (_, i) => `step ${i}`).join("\n")
      const full = `${noise}\nFATAL: the thing broke`
      const out = yield* withSandbox(
        {},
        Effect.gen(function* () {
          const result = yield* H.bash({ command: "build" }, ctx)
          // Read the saved file back from the *same* sandbox the tool wrote it
          // to. Reading it from a fresh one would only prove the sandbox can
          // round-trip a string.
          const sandbox = yield* Sandbox.Current
          const saved = yield* sandbox.list(yield* Sandbox.path(Truncate.OUTPUT_DIR))
          const first = saved[0]?.path
          const contents = first === undefined
            ? undefined
            : yield* Sandbox.readText(sandbox)(first)
          return { result, saved, contents }
        }),
        emitting(full)
      )
      assert.include(out.result.stdout, "FATAL: the thing broke")
      assert.notInclude(out.result.stdout, "step 0\n")
      assert.include(out.result.stdout, "...output truncated...")
      assert.include(out.result.stdout, "Full output saved to: ")
      // Exactly one file, named in the message, holding the complete output --
      // including the beginning that the bounded view dropped.
      assert.strictEqual(out.saved.length, 1)
      assert.include(out.result.stdout, out.saved[0]?.path ?? "")
      assert.strictEqual(out.contents, full)
      assert.include(out.contents ?? "", "step 0")
    })
  )

  it.effect("bounds stderr as well as stdout", () =>
    Effect.gen(function* () {
      const noisy = Array.from({ length: 4000 }, (_, i) => `warn ${i}`).join("\n")
      const out = yield* withSandbox({}, H.bash({ command: "x" }, ctx), emitting("", noisy))
      assert.include(out.stderr, "...output truncated...")
      assert.include(out.stderr, `warn ${4000 - 1}`)
    })
  )

  it.effect("a timeout says how to retry", () =>
    Effect.gen(function* () {
      const out = yield* Effect.flip(
        withSandbox(
          {},
          H.bash({ command: "sleep 100", timeout_ms: 500 }, ctx),
          () => Effect.fail(new Sandbox.TimeoutError({ executable: "bash", timeoutMillis: 500 }))
        )
      )
      assertString(out)
      assert.include(out, "exceeding timeout 500 ms")
      assert.include(out, "retry with a larger timeout value in milliseconds")
    })
  )

  it.effect("still bounds output when the workspace cannot be written to", () =>
    Effect.gen(function* () {
      const noise = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")
      const out = yield* withSandbox(
        {},
        Effect.gen(function* () {
          const base = yield* Sandbox.Current
          const readOnly: Sandbox.Sandbox = {
            ...base,
            write: (path) =>
              Effect.fail(new Sandbox.PermissionDeniedError({ path, operation: "write" }))
          }
          return yield* H.bash({ command: "x" }, ctx).pipe(
            Effect.provideService(Sandbox.Current, readOnly)
          )
        }),
        emitting(noise)
      )
      // Bounded, and honest: it does not name a file that was never written.
      assert.include(out.stdout, "...output truncated...")
      assert.notInclude(out.stdout, "Full output saved to")
      assert.include(out.stdout, `line ${5000 - 1}`)
    })
  )
})

describe("output truncation", () => {
  it("returns short text unchanged", () => {
    assert.deepStrictEqual(Truncate.tail("a\nb\nc"), { text: "a\nb\nc", cut: false })
  })

  it("keeps the last lines when the line budget runs out", () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n")
    const out = Truncate.tail(text, 3, Truncate.MAX_BYTES)
    assert.isTrue(out.cut)
    assert.strictEqual(out.text, "l7\nl8\nl9")
  })

  it("keeps the end of a single over-long line", () => {
    const out = Truncate.tail(`${"a".repeat(100)}TAIL`, 10, 10)
    assert.isTrue(out.cut)
    assert.strictEqual(out.text.length, 10)
    assert.isTrue(out.text.endsWith("TAIL"))
  })

  it("never splits a multi-byte character (I7)", () => {
    // Every budget across a range must yield text that survives an encode /
    // decode round trip unchanged -- a split character would decode to U+FFFD.
    for (const glyph of ["é", "€", "🎉", "日"]) {
      const line = glyph.repeat(400)
      for (let budget = 1; budget <= 64; budget++) {
        const out = Truncate.tail(line, 10, budget)
        assert.notInclude(out.text, "\uFFFD", `budget ${budget} split a ${glyph}`)
        const round = new TextDecoder().decode(new TextEncoder().encode(out.text))
        assert.strictEqual(round, out.text, `budget ${budget} corrupted a ${glyph}`)
        // And it never exceeds the budget it was given.
        assert.isAtMost(new TextEncoder().encode(out.text).length, budget)
      }
    }
  })

  it("counts the joining newline in the byte budget", () => {
    // Three 2-byte lines plus two newlines is 8 bytes; a 7-byte budget must
    // therefore drop one line rather than keeping all three.
    const out = Truncate.tail("aa\nbb\ncc", 10, 7)
    assert.isTrue(out.cut)
    assert.strictEqual(out.text, "bb\ncc")
  })
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
    /**
     * R54 -- the subtree, not the query.
     *
     * This pinned `"foo"`, the regular expression, as the resource. Searching
     * reads every eligible file below `path`; the regex is what is looked
     * *for*, not what is disclosed -- so a path-scoped policy could neither
     * authorize nor refuse the directory, and the approval prompt showed a
     * pattern where the sensitive thing was the location.
     */
    const search = Permission.projectionOf(CodingToolkit.Search)
    assert.strictEqual(search.action, "read")
    assert.strictEqual(search.resource({ pattern: "foo" }), ".")
    assert.strictEqual(search.resource({ pattern: "foo", path: "src/secrets" }), "src/secrets")
    // The question still names the query: a person deciding wants to know
    // what is being looked for as well as where.
    assert.strictEqual(
      search.describe?.({ pattern: "foo", path: "src/secrets" }),
      "foo in src/secrets"
    )
    const bash = Permission.projectionOf(CodingToolkit.Bash)
    assert.strictEqual(bash.action, "shell")
    assert.strictEqual(bash.resource({ command: "git push" }), "git push")
    return Effect.void
  })

  /**
   * R54, as a policy rather than as a string.
   *
   * The projection assertion above says what the resource *is*; this says why
   * it matters. One rule, one regex, two directories -- and the decision has
   * to differ, which it cannot if the resource is the pattern both calls
   * share.
   */
  it.effect("a path-scoped policy can allow one subtree and refuse another", () =>
    Effect.gen(function*() {
      const policy = Permission.rules(
        [{ action: "read", resource: /^src\/secrets/, decision: Permission.deny("private") }],
        { otherwise: Permission.allow }
      )
      const projection = Permission.projectionOf(CodingToolkit.Search)
      const ask = (path: string) =>
        policy.evaluate({
          sessionId: "s",
          toolCallId: "c",
          tool: { name: "search", params: {} },
          action: projection.action,
          resource: projection.resource({ pattern: "password", path }),
          intrinsicApproval: false,
          messages: []
        })

      assert.strictEqual((yield* ask("src/app"))._tag, "Allow")
      assert.strictEqual((yield* ask("src/secrets"))._tag, "Deny")
    }))

  /**
   * R56 -- an edit must not rewrite bytes it never touched.
   *
   * The edit path decoded with the default non-fatal decoder, so every
   * undecodable byte became U+FFFD, and then wrote the whole string back. One
   * latin-1 byte in a comment at the top of a file therefore corrupted itself
   * on any edit anywhere in that file -- and the binary heuristic does not
   * catch these, because they are text, just not this text.
   *
   * The fixture puts invalid bytes on both sides of an ASCII target, so a
   * partial fix that protected only what follows the edit fails too.
   */
  it.effect("refuses to edit a file that is not valid UTF-8", () =>
    Effect.gen(function*() {
      const before = new Uint8Array([0xff, 0xfe])
      const middle = new TextEncoder().encode("\nconst value = 1\n")
      const after = new Uint8Array([0xfd, 0xfc])
      const original = new Uint8Array([...before, ...middle, ...after])

      const outcome = yield* Effect.gen(function*() {
        const sandbox = yield* Sandbox.Current
        const path = yield* Sandbox.path("legacy.ts")
        yield* sandbox.write(path, original)
        const failure = yield* Effect.flip(
          CodingToolkit.handlers.edit_file(
            {
              path: "legacy.ts",
              old_string: "const value = 1",
              new_string: "const value = 2"
            },
            { preliminary: () => Effect.void }
          )
        )
        return { failure, now: yield* sandbox.read(path) }
      }).pipe(
        Effect.provide(
          Sandbox.currentLayer(ws).pipe(Layer.provide(MemorySandbox.layer({})))
        )
      )

      assert.include(String(outcome.failure), "not valid UTF-8")
      // And every byte is exactly as it was. A refusal that still wrote would
      // be the defect with a better error message.
      assert.deepStrictEqual([...outcome.now], [...original])
    }))
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
        const result = yield* session.prompt("try to edit")
        return { text: result.text, file: yield* fileNow, history: yield* session.history }
      }).pipe(Effect.provide(env(layer)), Effect.scoped)
      assert.strictEqual(out.text, "could not write")
      // The write was denied: the file is unchanged on disk.
      assert.strictEqual(out.file, "const value = 1")
      // The read actually ran (success, with the file content) and the write was
      // refused (failure, carrying the deny reason) -- not the read failing too.
      const toolResults = out.history.content.flatMap((m) => (m.role === "tool" ? m.content : []))
      const read = toolResults[0]
      assert.isTrue(read !== undefined && read.type === "tool-result" && !read.isFailure)
      assert.include(JSON.stringify(read), "const value = 1")
      const write = toolResults[1]
      assert.isTrue(write !== undefined && write.type === "tool-result" && write.isFailure)
      assert.include(JSON.stringify(write), "read-only session")
    })
  )
})

/**
 * R58, the regex half -- a model-supplied pattern can stop the process.
 *
 * `search` compiles `pattern` into a native `RegExp` and runs it over every
 * line of every eligible file. JavaScript's engine backtracks, so a quantifier
 * applied to something itself quantified or ambiguously alternated takes time
 * exponential in the line length -- and matching runs synchronously to
 * completion, so an `Effect.timeout` cannot preempt it, an interruption cannot
 * preempt it, and the event loop is gone for as long as it takes.
 *
 * The refusal is a *conservative syntactic check*, not a decision procedure,
 * and these tests are written to say so: they pin the shapes that are refused,
 * the ordinary patterns that are not, and -- explicitly -- that a safe pattern
 * matching the refused shape is refused too.
 *
 * Structural rather than timed. A timing test for this passes on a fast
 * machine with the check removed, which is the failure mode that makes a test
 * worse than none.
 */
describe("search pattern safety", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["(a+)+$", "another repetition"],
    ["(a*)*b", "another repetition"],
    ["(a|a)*$", "an alternation"],
    ["(\d+|\w+)*x", "another repetition"],
    ["(x|y){2,}", "an alternation"]
  ]

  for (const [pattern, because] of refused) {
    it(`refuses ${pattern}`, () => {
      const reason = RegexSafety.refuse(pattern)
      assert.isDefined(reason, `${pattern} should have been refused`)
      assert.include(reason ?? "", because)
    })
  }

  const allowed = [
    "needle",
    "^const \w+ = ",
    "foo|bar",
    "a+b+c+",
    "(abc)+",
    "[a-z]{2,4}",
    "\((a|b)\)",
    "(?:literal)+"
  ]

  for (const pattern of allowed) {
    it(`allows ${pattern}`, () => {
      assert.isUndefined(
        RegexSafety.refuse(pattern),
        `${pattern} is ordinary and must not be refused`
      )
    })
  }

  /**
   * The honest limit, pinned so nobody reads the check as a decision
   * procedure: `(ab)+` is perfectly safe and `(a|b)+` is refused, because
   * telling them apart needs to know whether the alternatives can match the
   * same text -- which a syntactic scan cannot.
   */
  it("refuses some patterns that are in fact safe", () => {
    assert.isDefined(RegexSafety.refuse("(a|b)+"))
    // And the model is told why, so it can write the version that is allowed.
    assert.include(RegexSafety.refuse("(a|b)+") ?? "", "exponential")
  })

  it("reports the refusal through the tool rather than searching anyway", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          withSandbox({ "a.ts": "aaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, H.search({ pattern: "(a+)+$" }, ctx))
        )
        assert.include(String(failure), "Refusing to search with this pattern")
      })
    ))
})
