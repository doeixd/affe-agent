import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { Config, Context, Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import * as LocalSandbox from "../../../src/sandbox/local.js"
import * as MemorySandbox from "../../../src/sandbox/memory.js"
import * as Sandbox from "../../../src/sandbox/Sandbox.js"
import { TestLanguageModel } from "../../../src/testing/index.js"
import * as NodeStore from "../../../src/tree/NodeStore.js"

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

/**
 * What building a backend can fail with.
 *
 * Named rather than erased to `unknown`. The seam existed to make a scripted
 * and a live backend interchangeable, and a widened error channel hides
 * exactly the difference that matters between them: the live one needs a key
 * and a directory and can fail to get either. `unknown` also puts this seam
 * outside the repository's typed-error contract for no gain, since the only
 * thing downstream did with it was print a pretty cause.
 */
export type BackendError = Config.ConfigError | Sandbox.ProviderError

export interface Backend {
  readonly kind: Kind
  /**
   * Where the conversation lives between launches, if anywhere.
   *
   * Part of the backend rather than a separate flag, for the same reason the
   * model and the workspace are one choice: state that outlives the process
   * belongs *to* a workspace. Resuming a live session against a different
   * directory would restore a conversation about files that are not there.
   *
   * Absent for the scripted backend, which should leave nothing behind.
   */
  readonly store?: Effect.Effect<
    NodeStore.NodeStore<NodeStore.StoreError>,
    PlatformError,
    Scope.Scope
  > | undefined
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
    BackendError,
    Scope.Scope
  >
  /** Shown in the footer, so it is never a guess which one is running. */
  readonly label: string
  /** Said once at startup, when there is something a user needs to know. */
  readonly warning?: string | undefined
  /**
   * What produced a transcript, for an export's provenance.
   *
   * From the backend because the backend is what knows: an exporter guessing
   * at the model would be writing a field whose whole purpose is to be
   * trusted by a reader who has no other way to find out.
   */
  readonly model: { readonly provider: string; readonly modelId: string }
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
const defaultTurns: ReadonlyArray<TestLanguageModel.Turn> = [
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
]

/**
 * A scripted backend over a given conversation.
 *
 * Exported so a test can script the *exact* sequence it needs -- the same tool
 * call twice, say -- instead of walking the default script to reach a
 * situation it happens to contain. A test that has to get through six
 * unrelated turns first is a test that breaks when any of them changes.
 */
export const scriptedWith = (
  turns: ReadonlyArray<TestLanguageModel.Turn>
): Backend => ({
  kind: "scripted",
  label: "scripted",
  // Named honestly: an export from a scripted run is a recording of a fixture,
  // and a reader six months later has no other way to know that.
  model: { provider: "test", modelId: "scripted" },
  layer: Layer.mergeAll(
    Layer.unwrap(Effect.map(TestLanguageModel.script(turns), ({ layer }) => layer)),
    scriptedSandbox
  )
})

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

export const scripted: Backend = scriptedWith(defaultTurns)

// ---------------------------------------------------------------------------
// Live: a real model over a real directory
// ---------------------------------------------------------------------------

/**
 * A real provider, and a working directory.
 *
 * `workspaceRoot` rather than a temporary directory, because an agent that
 * edits files nobody can find has not done the work.
 *
 * ## What that directory does and does not bound
 *
 * **File tools are confined to it.** `read_file`, `write_file`, `edit_file`,
 * `list_files` and `search` go through the sandbox seam, which requires
 * relative, `..`-free paths and resolves symlinks -- so for those, the
 * directory really is the whole of what the agent can reach.
 *
 * **`bash` is not confined to it, at all.** `LocalSandbox` runs the child with
 * its `cwd` set to the workspace and nothing else: the process keeps this
 * program's full privileges. An approved `bash` call can read absolute paths,
 * write outside the workspace, reach the network, and read credentials. It is
 * host execution that happens to start in a directory.
 *
 * An earlier version of this comment said the sandbox held the boundary "for
 * the whole of what it can reach", which was true of the file tools and false
 * of the shell -- the more dangerous half. Saying so precisely matters more
 * than a shorter sentence, because the sentence is what a reader decides on.
 *
 * The policy asks before every shell call, so nothing runs unapproved. That is
 * the actual protection here; the directory is not.
 */
export const live = (options: {
  readonly workspaceRoot: string
  readonly model: string
}): Backend => ({
  kind: "live",
  label: `${options.model} · ${options.workspaceRoot}`,
  model: { provider: "anthropic", modelId: options.model },
  /**
   * Shown once at startup, where a user will see it.
   *
   * A warning that lives only in a docstring warns the person who already read
   * the source.
   */
  warning: "live: file tools stay inside the workspace; an approved `bash` runs"
    + " as you, anywhere on this machine",
  /**
   * Under the workspace, so the conversation travels with the code it is
   * about -- and so deleting the working copy deletes the transcript with it,
   * which is what someone deleting a throwaway checkout means.
   */
  /**
   * `Layer.build`, not `Effect.provide`.
   *
   * `Effect.provide(effect, layer)` owns the layer for *that effect only* --
   * it does not hand it to the caller's scope. So extracting the service and
   * returning it produced a store closing over something already released, and
   * the comment claiming it "lives exactly as long as the tree" described the
   * opposite of what happened. A filesystem store has no meaningful close, so
   * nothing broke; a pooled or locked provider would have been handed back
   * shut.
   *
   * `Layer.build` requires a `Scope` and keeps the layer alive for it, so the
   * lifetime is the harness's program scope -- which is what was meant.
   */
  store: Effect.map(
    Layer.build(
      KeyValueStore.layerFileSystem(
        `${options.workspaceRoot}/.effect-agent/session`
      ).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
    ),
    (context) => NodeStore.keyValue(Context.get(context, KeyValueStore.KeyValueStore))
  ),
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
      "--live needs --workspace <dir>: where the agent works.\n" +
        "\n" +
        "File tools are confined to that directory. An approved `bash` call is\n" +
        "not: it runs with this program's privileges and can reach anything on\n" +
        "the machine. Every shell call is asked about first.\n" +
        "\n" +
        "Point it at a working copy you can throw away."
    )
  }
  const modelAt = argv.indexOf("--model")
  const model = modelAt === -1 ? "claude-sonnet-4-5" : argv[modelAt + 1]!
  return live({ workspaceRoot, model })
}
