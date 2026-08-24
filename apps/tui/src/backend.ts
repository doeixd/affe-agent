import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import * as LocalSandbox from "../../../src/sandbox/local.js"
import * as MemorySandbox from "../../../src/sandbox/memory.js"
import * as Sandbox from "../../../src/sandbox/Sandbox.js"
import { TestLanguageModel } from "../../../src/testing/index.js"

/**
 * What the harness runs against: a model and a workspace.
 *
 * The two are chosen together and in one place, because they have to agree
 * about what is real. A live model pointed at a memory sandbox would confidently
 * describe a workspace that does not exist -- three seeded files and a `bash`
 * that always prints `hi` -- and the transcript would look plausible while
 * being fiction. So this is one choice with two halves, not two options.
 *
 * The scripted backend is the default, deliberately. It needs no key and no
 * network, which is what makes the smoke suite deterministic and runnable
 * anywhere; it is also why the TUI has been demonstrable all along without
 * being able to do any work.
 */

export type Kind = "scripted" | "live"

export interface Backend {
  readonly kind: Kind
  /**
   * Exactly the two services the harness needs, and no requirement of its own.
   *
   * Typed rather than left as `Layer<any, any, any>`: the seam's whole job is
   * that a live backend and a scripted one are interchangeable, and a loose
   * type would let one of them quietly stop providing something the other
   * does -- discovered at runtime, in a terminal, as an unhandled fibre
   * failure.
   */
  readonly layer: Layer.Layer<
    LanguageModel.LanguageModel | Sandbox.Current,
    unknown,
    Scope.Scope
  >
  /** Shown in the footer, so it is never a guess which one is running. */
  readonly label: string
}

// ---------------------------------------------------------------------------
// Scripted: no key, no network, no filesystem
// ---------------------------------------------------------------------------

/**
 * A fixed conversation, replayed in order.
 *
 * Every reply is scripted, so typing something else does not change the
 * answer. That is the point under test -- the renderer, the projection, the
 * approval flow -- and it is also the reason this is labelled in the footer:
 * a demo that looks like an agent is worse than one that says it is a demo.
 */
const scriptedModel = Layer.unwrap(
  Effect.map(
    TestLanguageModel.script([
      { toolCalls: [{ id: "t1", name: "list_files", params: {} }] },
      // Chunked, so the streaming path is exercised rather than assumed.
      {
        text: "That is what the workspace holds.",
        chunks: ["That is ", "what the ", "workspace holds."]
      },
      { toolCalls: [{ id: "t2", name: "bash", params: { command: "echo hi" } }] },
      TestLanguageModel.text("The command ran."),
      {
        toolCalls: [{
          id: "t3",
          name: "edit_file",
          params: {
            path: "src/index.ts",
            old_string: "hello",
            new_string: "greetings",
            replace_all: true
          }
        }]
      },
      TestLanguageModel.text("Renamed it."),
      {
        toolCalls: [{
          id: "t5",
          name: "edit_file",
          params: {
            path: "src/drift.ts",
            old_string: "const value = 1;\n",
            new_string: "const value = 2;\n"
          }
        }]
      },
      TestLanguageModel.text("Bumped it."),
      { toolCalls: [{ id: "t4", name: "bash", params: { command: "rm -rf /" } }] },
      TestLanguageModel.text("I did not run that."),
      TestLanguageModel.text(
        "I am a scripted model. Run with --live to use a real one."
      ),
      // Headroom, so a prompt after a rewind has something to answer with.
      // The script is a flat sequence and a rewind does not rewind it, which
      // is a property of this stub rather than of the tree.
      TestLanguageModel.text("Answering from the rewound branch."),
      TestLanguageModel.text("And again.")
    ]),
    ({ layer }) => layer
  )
)

const scriptedSandbox = Sandbox.currentLayer(Sandbox.workspace("tui")).pipe(
  Layer.provide(
    MemorySandbox.layer({
      seed: {
        "README.md": "# demo workspace\n\nSeeded so the tools have something to find.\n",
        "src/index.ts": "export const hello = () => \"hello\"\n",
        // Trailing spaces the scripted model will not reproduce, so the
        // second edit matches fuzzily and `matched` differs from what was
        // asked for -- which is the case the two-sided body exists to show.
        "src/drift.ts": "const value = 1;   \n"
      },
      exec: () => Effect.succeed({ exitCode: 0, stdout: "hi\n", stderr: "" })
    })
  )
)

export const scripted: Backend = {
  kind: "scripted",
  layer: Layer.mergeAll(scriptedModel, scriptedSandbox),
  label: "scripted"
}

// ---------------------------------------------------------------------------
// Live: a real model over a real directory
// ---------------------------------------------------------------------------

/**
 * A real provider, and the working directory it is allowed to touch.
 *
 * `workspaceRoot` rather than a temporary directory, because an agent that
 * edits files nobody can find has not done the work. The sandbox seam still
 * holds the boundary: paths are relative and `..`-free, so "the directory you
 * pointed it at" is the whole of what it can reach.
 *
 * That is a real boundary and not a sufficient one. Everything under that
 * directory is writable and `bash` runs there, so the honest instruction is
 * the one the flag's help gives: point it at a working copy you can throw
 * away, not at your home directory.
 */
export const live = (options: {
  readonly workspaceRoot: string
  readonly model: string
}): Backend => ({
  kind: "live",
  label: `${options.model} · ${options.workspaceRoot}`,
  layer: Layer.mergeAll(
    AnthropicLanguageModel.layer({ model: options.model }).pipe(
      Layer.provide(
        AnthropicClient.layerConfig({
          apiKey: Config.redacted("ANTHROPIC_API_KEY")
        })
      ),
      Layer.provide(FetchHttpClient.layer)
    ),
    Sandbox.currentLayer(Sandbox.workspace("tui")).pipe(
      Layer.provide(LocalSandbox.layer({ workspaceRoot: options.workspaceRoot }))
    )
  )
})

/**
 * Read the backend from argv.
 *
 * `--live` is opt-in and takes the directory explicitly. Neither half is
 * defaulted: defaulting the workspace to the current directory would make the
 * dangerous case the easy one, and inferring "live" from the presence of an
 * API key would mean an exported key silently changes what a demo does.
 */
export const fromArgv = (argv: ReadonlyArray<string>): Backend => {
  if (!argv.includes("--live")) return scripted
  const at = argv.indexOf("--workspace")
  const workspaceRoot = at === -1 ? undefined : argv[at + 1]
  if (workspaceRoot === undefined || workspaceRoot.startsWith("--")) {
    throw new Error(
      "--live needs --workspace <dir>: the directory the agent may read and write.\n" +
        "Point it at a working copy you can throw away."
    )
  }
  const modelAt = argv.indexOf("--model")
  const model = modelAt === -1 ? "claude-sonnet-4-5" : argv[modelAt + 1]!
  return live({ workspaceRoot, model })
}
