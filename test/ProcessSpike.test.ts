import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"

/**
 * The §11 spike of `docs/effect-plan-2.txt`, re-run against the pinned
 * `effect` so the decision it records ("retain the sandbox's own process
 * adapter; do not build the process manager on `ChildProcess`") stays a
 * measured fact rather than a remembered one.
 *
 * `evaluation-sandbox-effect-platform.md` names two gaps. Each assertion
 * below pins the gap as it is *today*; when Effect closes one, the assertion
 * fails, which is the signal to re-open the evaluation. That is the point:
 * a test that passes forever would not be a spike.
 */
describe("effect-plan-2 §11 spike", () => {
  it.live("gap 1: a successful child leaves a stdout-holding descendant in charge of the stream", () =>
    Effect.gen(function* () {
      // The child prints, starts a detached grandchild that inherits stdout
      // and lives 4s, then exits 0. The sandbox adapter returns when the
      // child exits; the question is whether Effect's spawner does.
      const script =
        "const { spawn } = require('child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', detached: true, cwd: require('os').tmpdir() }).unref(); console.log('parent done')"
      const began = Date.now()
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(process.execPath, ["-e", script])
          return yield* Stream.runCollect(Stream.decodeText(handle.stdout))
        })
      ).pipe(
        Effect.timeoutOption("2500 millis"),
        Effect.provide(NodeServices.layer)
      )
      const elapsed = Date.now() - began
      // Pinned: collecting stdout waits on the grandchild -- the collection
      // does not finish inside the budget even though the child is long gone.
      // If this starts failing, gap 1 has closed upstream.
      assert.isTrue(outcome._tag === "None", `stdout collection finished in ${elapsed}ms; gap 1 may have closed`)
    })
  )

  it.effect("gap 2: FileSystem still has no lstat", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // Pinned as a runtime fact so a widened service is noticed here, not
      // when the workspace boundary is next reconsidered.
      assert.isFalse("lstat" in fs, "FileSystem gained lstat; re-open evaluation-sandbox-effect-platform.md")
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
})
