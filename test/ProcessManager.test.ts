import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as LocalSandbox from "../src/sandbox/local.js"
import * as Permission from "../src/Permission.js"
import * as ProcessManager from "../src/process/ProcessManager.js"
import * as ProcessTools from "../src/process/ProcessTools.js"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as WorkspaceManager from "../src/sandbox/WorkspaceManager.js"

/**
 * `docs/effect-plan-2.txt` §8–§13, §21–§23, and the invariants §39 names
 * for processes: a handle owns nothing, the workspace lives as long as the
 * process, start approval does not approve stop.
 *
 * The provider is scripted: `execStream` is whatever the test hands it, so
 * every test below is deterministic and synchronises on the events it means.
 * The one real process is at the end, through `/sandbox/local`, because the
 * tree-kill the manager relies on is that adapter's and not this module's.
 */

// ---------------------------------------------------------------------------
// Type-level: what a caller gets is precise, not `any`. Break by changing
// `NotAny<...>` to a type that is `any`; the `Assert` fails to compile.

type Assert<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false
type Started = Effect.Success<ReturnType<ProcessManager.Service["start"]>>
type StartError = Effect.Error<ReturnType<ProcessManager.Service["start"]>>
type WaitError = Effect.Error<ProcessManager.ManagedProcess["wait"]>
export type _StartNotAny = Assert<IsAny<Started> extends false ? true : false>
export type _StartErrorNamed = Assert<StartError extends Sandbox.ProviderError ? true : false>
export type _WaitErrorNamed = Assert<
  Exclude<WaitError, ProcessManager.ProcessFailedError | ProcessManager.ProcessTerminatedError> extends never ? true : false
>
export type _ToolkitHandlersTyped = Assert<
  IsAny<Parameters<typeof ProcessTools.handlers.start_process>[0]["timeout_ms"]> extends false ? true : false
>

const ws = Sandbox.workspace
const bytes = (text: string) => new TextEncoder().encode(text)
const out = (text: string): Sandbox.ExecEvent => Sandbox.outputEvent("stdout", bytes(text))
const exit = (code: number): Sandbox.ExecEvent => Sandbox.exitEvent(code)
const decode = (output: ProcessManager.Output) => new TextDecoder().decode(output.bytes)

/** A scripted provider whose command output is driven by the test. */
const scripted = (execStream: Sandbox.Sandbox["execStream"]) =>
  MemorySandbox.layer({ execStream })

/** A provider that counts live workspace builds, over the scripted one. */
const counting = (built: Ref.Ref<number>, execStream: Sandbox.Sandbox["execStream"]) =>
  Layer.succeed(Sandbox.SandboxProvider)({
    acquire: (workspace: Sandbox.Workspace) =>
      Effect.acquireRelease(
        Ref.update(built, (n) => n + 1),
        () => Ref.update(built, (n) => n - 1)
      ).pipe(
        Effect.flatMap(() => Effect.provide(Sandbox.acquire(workspace), scripted(execStream)))
      )
  })

const withManager = <A, E>(
  provider: Layer.Layer<Sandbox.SandboxProvider>,
  use: (manager: ProcessManager.Service) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(Effect.flatMap(ProcessManager.make(), use)).pipe(
    Effect.provide(WorkspaceManager.layer({ idleTimeToLive: "1 second" })),
    Effect.provide(provider)
  )

const request = (command = Sandbox.command("tool")): ProcessManager.Request => ({
  workspace: ws("w"),
  command,
  timeout: "1 hour"
})

/** Collect the manager's events from now until `n` have arrived. Subscribed before it returns. */
const eventsTaken = (manager: ProcessManager.Service, n: number) =>
  Effect.flatMap(manager.events, (events) => Effect.forkScoped(Stream.runCollect(Stream.take(events, n))))

describe("ProcessManager", () => {
  it.effect("a process runs to its exit: output, events, wait, info", () =>
    withManager(
      scripted(() => Stream.make(out("one"), out("two"), exit(3))),
      (manager) =>
        Effect.gen(function* () {
          const events = yield* eventsTaken(manager, 2)
          const process = yield* manager.start(request(Sandbox.command("tool", ["--x"])))

          const result = yield* process.wait
          assert.deepStrictEqual(result, { exitCode: 3, signal: Option.none() })

          const outputs = yield* Stream.runCollect(process.output())
          assert.deepStrictEqual(outputs.map(decode), ["one", "two"])
          assert.deepStrictEqual(outputs.map((o) => o.sequence), [1, 2])

          const info = yield* process.info
          assert.deepStrictEqual(info.status, { _tag: "Exited", exitCode: 3, signal: Option.none() })
          assert.strictEqual(info.outputBytes, 6)
          assert.deepStrictEqual(info.command, { executable: "tool", args: ["--x"] })

          assert.deepStrictEqual(yield* Fiber.join(events), [
            { _tag: "Started", id: process.id },
            { _tag: "Exited", id: process.id, exitCode: 3, signal: Option.none() }
          ])
        })
    ))

  it.effect("a handle owns nothing: the process outlives the scope that started it", () =>
    withManager(
      scripted(() => Stream.concat(Stream.make(out("ready")), Stream.never)),
      (manager) =>
        Effect.gen(function* () {
          // The starter's scope closes; the pump is the manager's, not the
          // starter's, so nothing is interrupted.
          const id = yield* Effect.scoped(Effect.map(manager.start(request()), (p) => p.id))
          const listed = yield* manager.list
          assert.deepStrictEqual(listed.map((i) => [i.id, i.status._tag]), [[id, "Running"]])

          // Reacquired by id, the same process.
          const again = yield* manager.get(id)
          const first = yield* Stream.runCollect(Stream.take(again.output(), 1))
          assert.deepStrictEqual(first.map(decode), ["ready"])
        })
    ))

  it.effect("the workspace is held while the process runs, and released once it ends", () =>
    Effect.gen(function* () {
      const built = yield* Ref.make(0)
      const ended = yield* Deferred.make<void>()
      const execStream: Sandbox.Sandbox["execStream"] = () =>
        Stream.concat(Stream.make(out("up")), Stream.fromEffect(Deferred.await(ended)).pipe(Stream.map(() => exit(0))))
      yield* withManager(counting(built, execStream), (manager) =>
        Effect.gen(function* () {
          // The starter releases its workspace hold; the process keeps its own.
          const process = yield* Effect.scoped(manager.start(request()))
          yield* TestClock.adjust("5 seconds")
          assert.strictEqual(yield* Ref.get(built), 1, "the process holds the workspace after the starter is gone")

          yield* Deferred.succeed(ended, undefined)
          yield* process.wait
          yield* TestClock.adjust("5 seconds")
          assert.strictEqual(yield* Ref.get(built), 0, "released after exit and the idle window")
        }))
    }))

  it.effect("output resumes from a cursor, and a late reader gets the history then the end", () =>
    Effect.gen(function* () {
      const more = yield* Deferred.make<void>()
      const execStream: Sandbox.Sandbox["execStream"] = () =>
        Stream.concat(
          Stream.make(out("a"), out("b")),
          Stream.fromEffect(Deferred.await(more)).pipe(Stream.flatMap(() => Stream.make(out("c"), exit(0))))
        )
      yield* withManager(scripted(execStream), (manager) =>
        Effect.gen(function* () {
          const process = yield* manager.start(request())
          const first = yield* Stream.runCollect(Stream.take(process.output(), 2))
          assert.deepStrictEqual(first.map(decode), ["a", "b"])

          // A reader that saw up to 2 starts after 2, and is live: it sees
          // `c`, then the end.
          const resumed = yield* Effect.forkScoped(Stream.runCollect(process.output({ after: 2 })))
          // A snapshot reader sees exactly what exists now.
          const snapshot = yield* Stream.runCollect(process.output({ follow: false }))
          assert.deepStrictEqual(snapshot.map(decode), ["a", "b"])

          yield* Deferred.succeed(more, undefined)
          yield* process.wait
          assert.deepStrictEqual((yield* Fiber.join(resumed)).map(decode), ["c"])

          // After the exit, a full read is the whole history and ends.
          const all = yield* Stream.runCollect(process.output())
          assert.deepStrictEqual(all.map(decode), ["a", "b", "c"])
        }))
    }))

  it.effect("terminate ends a running process: status, wait, events, and its output stream", () =>
    withManager(
      scripted(() => Stream.concat(Stream.make(out("up")), Stream.never)),
      (manager) =>
        Effect.gen(function* () {
          const events = yield* eventsTaken(manager, 2)
          const process = yield* manager.start(request())
          const reader = yield* Effect.forkScoped(Stream.runCollect(process.output()))
          yield* process.terminate

          assert.deepStrictEqual((yield* process.info).status, { _tag: "Terminated" })
          const waited = yield* Effect.flip(process.wait)
          assert.strictEqual(waited._tag, "affe-agent/process/ProcessTerminatedError")
          assert.deepStrictEqual((yield* Fiber.join(reader)).map(decode), ["up"])
          assert.deepStrictEqual((yield* Fiber.join(events)).map((e) => e._tag), [
            "Started",
            "Terminated"
          ])
          // Idempotent.
          yield* process.terminate
        })
    ))

  it.effect("a provider failure is a failed process, not a lost one", () =>
    withManager(
      scripted((command) =>
        Stream.fail(new Sandbox.TimeoutError({ executable: command.executable, timeoutMillis: 5 }))),
      (manager) =>
        Effect.gen(function* () {
          const process = yield* manager.start(request())
          const waited = yield* Effect.flip(process.wait)
          assert.strictEqual(waited._tag, "affe-agent/process/ProcessFailedError")
          assert.include(waited.message, "exceeded 5ms")
          const info = yield* process.info
          assert.strictEqual(info.status._tag, "Failed")
          assert.deepStrictEqual((yield* manager.list).map((i) => i.status._tag), ["Failed"])
        })
    ))

  it.effect("closing the manager terminates what is still running", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<ProcessManager.Status>>([])
      const handle = yield* withManager(
        scripted(() => Stream.concat(Stream.make(out("up")), Stream.never)),
        (manager) =>
          Effect.gen(function* () {
            const process = yield* manager.start(request())
            const status = (yield* process.info).status
            yield* Ref.update(seen, (all) => [...all, status])
            return process
          })
      )
      // The manager's scope has closed; the pump was interrupted and the
      // process recorded as terminated, not left "Running" forever.
      const after = yield* handle.info
      assert.deepStrictEqual(yield* Ref.get(seen), [{ _tag: "Running" }])
      assert.deepStrictEqual(after.status, { _tag: "Terminated" })
    }))

  it.effect("an unknown id is a typed error", () =>
    withManager(scripted(() => Stream.make(exit(0))), (manager) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(manager.get(Schema.decodeSync(ProcessManager.ProcessId)("process-99")))
        assert.strictEqual(error._tag, "affe-agent/process/ProcessNotFoundError")
        assert.strictEqual(error.message, "No process process-99")
      })))

  it.effect("start approval does not approve stop: the projections are different acts", () =>
    Effect.gen(function* () {
      // A policy written for the start of `npm test` and nothing else.
      const policy = Permission.rules(
        [{ action: "process:start", resource: "npm test", decision: Permission.allow }],
        { otherwise: Permission.ask() }
      )
      const requestFor = (tool: Parameters<typeof Permission.projectionOf>[0], params: unknown): Permission.Request => {
        const projection = Permission.projectionOf(tool)
        return {
          sessionId: "s",
          toolCallId: "c",
          tool: { name: tool.name, params },
          action: projection.action,
          resource: projection.resource(params),
          intrinsicApproval: false,
          messages: []
        }
      }
      const start = yield* policy.evaluate(
        requestFor(ProcessTools.StartProcess, { executable: "npm", args: ["test"], timeout_ms: 1000 })
      )
      const stop = yield* policy.evaluate(requestFor(ProcessTools.StopProcess, { process_id: "process-1" }))
      assert.deepStrictEqual(start, Permission.allow)
      assert.strictEqual(stop._tag, "Ask")
    }))

  it.live("through the local sandbox, terminate ends a real process tree", () =>
    Effect.gen(function* () {
      // The assertion is that nothing still holds the workspace once the
      // manager is closed, and that is deliberate. Two weaker forms were
      // tried first and both passed while the process was still running:
      // the reported `status`, which `finish` writes whether or not the
      // operating system agreed, and a file the child writes later, which
      // the workspace's own one-second idle cleanup deletes before it can
      // be read. Windows will not remove a directory that a live process
      // has as its cwd, so removing it with no retries is a question only
      // a dead process can answer yes to.
      const base = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "process-manager-")))
      // The child outlives every timeout in this test if it is left alone,
      // so a pass cannot come from waiting it out.
      const script = "console.log('ready'); setTimeout(() => {}, 30000)"
      const began = Date.now()
      const status = yield* withManager(LocalSandbox.layer({ root: base }), (manager) =>
        Effect.gen(function* () {
          const started = yield* manager.start({
            workspace: ws("live"),
            command: Sandbox.command(globalThis.process.execPath, ["-e", script]),
            timeout: "1 minute"
          })
          const first = yield* Stream.runCollect(Stream.take(started.output(), 1))
          assert.strictEqual(first.map(decode).join("").trim(), "ready")
          yield* started.terminate
          return (yield* started.info).status
        }))
      assert.deepStrictEqual(status, { _tag: "Terminated" })

      // A two-second budget: enough for Windows to release the handle of a
      // process that has just died, nowhere near the thirty the child would
      // live for if `terminate` had not ended it. Zero retries is too strict
      // -- the directory is briefly EBUSY after the tree goes -- and the
      // generous retry loop this replaced was what hid the bug, because it
      // simply waited the child out and passed.
      const removed = yield* Effect.promise(() =>
        fs.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).then(
          () => "ok",
          (error) => String(error)
        )
      )
      assert.strictEqual(removed, "ok", "the workspace is still held: the process outlived terminate")
      assert.isBelow(Date.now() - began, 15_000, "waited for the child to exit on its own")
    }).pipe(Effect.scoped))
})
