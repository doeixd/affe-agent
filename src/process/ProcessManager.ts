import { Context, Deferred, Effect, Exit, FiberMap, Layer, Option, PubSub, Ref, Schema, Scope, Stream } from "effect"
import type { Duration } from "effect"
import * as Sandbox from "../sandbox/Sandbox.js"
import { WorkspaceManager } from "../sandbox/WorkspaceManager.js"

/**
 * A process that outlives the call that started it.
 *
 * `docs/effect-plan-2.txt` §8–§11, §21–§24. `Sandbox.exec` is a *bounded
 * command*: it runs inside the caller's scope, waits for the exit, and dies
 * with the tool call. That is the right shape for `git status` and the wrong
 * one for a dev server, a watch, or a test run the agent wants to come back
 * to. Those need an identity that is not a fibre, a lifetime that is not a
 * tool call, a place to read output from later, and a way for a second
 * caller to find them. That is all this adds -- and, by the plan's rule,
 * *only* that:
 *
 * ```text
 * stable ProcessId · listing · reacquisition · output history with cursors ·
 * ownership beyond the caller's scope · events
 * ```
 *
 * ## What it is built on, and why not `ChildProcess`
 *
 * §11 asked for a spike before building a process manager on Effect's own
 * `ChildProcess`, and the spike (`evaluation-sandbox-effect-platform.md`,
 * re-run as `test/ProcessSpike.test.ts`) found the sandbox's local adapter
 * keeps two guarantees Effect's spawner does not: a finished command's
 * *descendants* are killed rather than left holding its stdio, and the
 * workspace boundary is checked with `lstat` and a native `realpath`. So a
 * managed process runs through `Sandbox.execStream` -- every provider,
 * local or remote, and every guarantee the conformance suite pins -- and
 * this module never touches a process API directly. It is portable for that
 * reason: there is no `/process/local`, because the local part *is*
 * `/sandbox/local`.
 *
 * ## Ownership
 *
 * The manager's scope owns every process, through a `FiberMap` (§10). A
 * `ManagedProcess` handle owns nothing: dropping it changes nothing, and two
 * callers holding handles to one process are holding one process. That is
 * the whole difference from a fibre, and it is why `WorkspaceManager` --
 * reference-counted, released when the last holder goes -- is the wrong
 * owner for a process and the right owner for its *workspace*: each process
 * holds its workspace for exactly as long as it runs (§12–§13), so a dev
 * server keeps the directory alive between the tool calls that read it.
 *
 * Closing the manager terminates what is still running. A process is not a
 * daemon; it belongs to the application that started it.
 *
 * ## What it deliberately does not do
 *
 * - **No stdin.** `Sandbox` has no `write` to a running command, so neither
 *   does this. §21's `process.write` projection waits for that primitive.
 * - **No persistence.** Identity and output live in memory, with the
 *   manager. §38 phase 9 (metadata and output persistence) comes after
 *   this, and a store shaped before a second backend exists would be
 *   guessed.
 * - **No pagination on `list`.** One consumer, in-process, over a bounded
 *   set; §9's `ProcessPage` arrives with the store that would make it mean
 *   something.
 * - **No timeout default.** A managed process is defined by outliving the
 *   call, so the sandbox's 10-second default would be wrong and an infinite
 *   one is a leak with a nicer name. The caller names the ceiling.
 */

// ---------------------------------------------------------------------------
// Identity

/**
 * The manager's own identity for a process. Not the operating system pid:
 * `ChildProcessSpawner.ProcessId` is a branded pid, and this deliberately is
 * not that, because a remote provider's process has no local pid and a pid
 * is reused the moment the process is gone.
 */
export const ProcessId = Schema.String.pipe(
  Schema.brand("affe-agent/process/ProcessId")
)
export type ProcessId = typeof ProcessId.Type

/** Construct an id the manager minted; the brand is a validator, not a guess, so this is the one place it is applied. */
const processId = (value: string): ProcessId => value as ProcessId

// ---------------------------------------------------------------------------
// The request and what is known about a process

export interface Request {
  /** Where it runs. Held by the process for as long as it runs. */
  readonly workspace: Sandbox.Workspace
  readonly command: Sandbox.Command
  /**
   * Kill it if it runs longer. Required: see the module note.
   */
  readonly timeout: Duration.Input
  /** Kill it if it emits more combined output. The provider's default otherwise. */
  readonly maxOutputBytes?: number | undefined
  /** A name for a person; the id is the name for a program. */
  readonly label?: string | undefined
}

export type Status =
  | { readonly _tag: "Running" }
  | { readonly _tag: "Exited"; readonly exitCode: number; readonly signal: Option.Option<string> }
  /** The provider could not run it, or stopped it: a launch failure, the timeout, the output limit. */
  | { readonly _tag: "Failed"; readonly reason: string }
  /** Stopped by `terminate`, or by the manager closing. */
  | { readonly _tag: "Terminated" }

export interface Info {
  readonly id: ProcessId
  readonly label: Option.Option<string>
  readonly workspace: Sandbox.Workspace
  readonly command: Sandbox.Command
  readonly status: Status
  /** Combined bytes of output produced so far. */
  readonly outputBytes: number
}

/** One chunk of output, numbered so a reader can resume after the last one it saw. */
export interface Output {
  readonly sequence: number
  readonly stream: "stdout" | "stderr"
  readonly bytes: Uint8Array
}

export interface ProcessExit {
  readonly exitCode: number
  readonly signal: Option.Option<string>
}

export type Event =
  | { readonly _tag: "Started"; readonly id: ProcessId }
  | { readonly _tag: "Exited"; readonly id: ProcessId; readonly exitCode: number; readonly signal: Option.Option<string> }
  | { readonly _tag: "Failed"; readonly id: ProcessId; readonly reason: string }
  | { readonly _tag: "Terminated"; readonly id: ProcessId }

// ---------------------------------------------------------------------------
// Errors

export class ProcessNotFoundError extends Schema.TaggedError<ProcessNotFoundError>()(
  "affe-agent/process/ProcessNotFoundError",
  { id: ProcessId }
) {
  override get message() {
    return `No process ${this.id}`
  }
}

/** `wait` on a process the provider failed to run or stopped. */
export class ProcessFailedError extends Schema.TaggedError<ProcessFailedError>()(
  "affe-agent/process/ProcessFailedError",
  { id: ProcessId, executable: Schema.String, reason: Schema.String }
) {
  override get message() {
    return `Process ${this.id} ("${this.executable}") failed: ${this.reason}`
  }
}

/** `wait` on a process that was terminated before it exited. */
export class ProcessTerminatedError extends Schema.TaggedError<ProcessTerminatedError>()(
  "affe-agent/process/ProcessTerminatedError",
  { id: ProcessId, executable: Schema.String }
) {
  override get message() {
    return `Process ${this.id} ("${this.executable}") was terminated before it exited`
  }
}

export type WaitError = ProcessFailedError | ProcessTerminatedError

// ---------------------------------------------------------------------------
// The handle and the service

export interface ManagedProcess {
  readonly id: ProcessId
  readonly info: Effect.Effect<Info>
  /**
   * Its output: everything already produced after `after`, then -- with
   * `follow` (the default) -- live output until it ends. A reader that saw
   * up to sequence `n` resumes with `{ after: n }` and misses nothing.
   * `follow: false` is a snapshot: what exists now, then the end, which is
   * what a tool answering a model wants.
   */
  readonly output: (
    options?: { readonly after?: number | undefined; readonly follow?: boolean | undefined } | undefined
  ) => Stream.Stream<Output>
  /** Its exit. Fails if it never exits: a provider failure or a termination. */
  readonly wait: Effect.Effect<ProcessExit, WaitError>
  /**
   * Stop it. The sandbox ends the whole process tree. A no-op once it is
   * over. This is a separate model-initiated act from starting it (§23), and
   * `ProcessTools` projects it as one.
   */
  readonly terminate: Effect.Effect<void>
}

export interface Service {
  /**
   * Start a process. Returns once the workspace is held and the process is
   * launching; a launch failure is observed through `wait` or `info`, not
   * here, because the process is already a thing with an id by then.
   */
  readonly start: (request: Request) => Effect.Effect<ManagedProcess, Sandbox.ProviderError>
  readonly get: (id: ProcessId) => Effect.Effect<ManagedProcess, ProcessNotFoundError>
  /** Every process the manager knows, running or finished, in start order. */
  readonly list: Effect.Effect<ReadonlyArray<Info>>
  /**
   * Lifecycle events for every process, from the moment of subscription.
   *
   * An `Effect` rather than a bare `Stream` on purpose: a stream subscribes
   * when it is *run*, and a fibre forked to run it has not necessarily done
   * so by the time the forking fibre continues -- so "fork the collector,
   * then start the process" would race, and the `Started` event could be
   * missed. Here the subscription exists once this effect has, in the
   * calling scope; the stream it returns replays nothing and misses nothing
   * published after that point.
   */
  readonly events: Effect.Effect<Stream.Stream<Event>, never, Scope.Scope>
}

export class ProcessManager extends Context.Service<ProcessManager, Service>()(
  "affe-agent/process/ProcessManager"
) {}

// ---------------------------------------------------------------------------
// Implementation

/** What travels on a process's own bus: its output, then one end marker. */
type Chunk = { readonly _tag: "Output"; readonly output: Output } | { readonly _tag: "End" }

interface Entry {
  readonly id: ProcessId
  readonly request: Request
  readonly status: Ref.Ref<Status>
  readonly history: Ref.Ref<ReadonlyArray<Output>>
  readonly outputBytes: Ref.Ref<number>
  readonly bus: PubSub.PubSub<Chunk>
  readonly exit: Deferred.Deferred<ProcessExit, WaitError>
  /** The process's own scope: holds the workspace, forked from the manager's. */
  readonly scope: Scope.Closeable
}

const isRunning = (status: Status) => status._tag === "Running"

export const make = (): Effect.Effect<Service, never, Scope.Scope | WorkspaceManager> =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceManager
    const managerScope = yield* Effect.scope
    const pumps = yield* FiberMap.make<ProcessId>()
    const events = yield* PubSub.unbounded<Event>()
    const entries = yield* Ref.make<ReadonlyArray<Entry>>([])
    const counter = yield* Ref.make(0)

    const find = (id: ProcessId) =>
      Effect.map(Ref.get(entries), (all) =>
        Option.fromNullishOr(all.find((entry) => entry.id === id)))

    const infoOf = (entry: Entry): Effect.Effect<Info> =>
      Effect.gen(function* () {
        return {
          id: entry.id,
          label: Option.fromNullishOr(entry.request.label),
          workspace: entry.request.workspace,
          command: entry.request.command,
          status: yield* Ref.get(entry.status),
          outputBytes: yield* Ref.get(entry.outputBytes)
        }
      })

    /**
     * Move a process to a final status exactly once. Every way a process can
     * end goes through here, so the bus's end marker, the event and the
     * `wait` result are always all sent, and never twice.
     */
    const finish = (
      entry: Entry,
      status: Exclude<Status, { _tag: "Running" }>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const changed = yield* Ref.modify(entry.status, (current) =>
          isRunning(current) ? [true, status] : [false, current])
        if (!changed) return
        yield* PubSub.publish(entry.bus, { _tag: "End" })
        const executable = entry.request.command.executable
        switch (status._tag) {
          case "Exited":
            yield* Deferred.succeed(entry.exit, { exitCode: status.exitCode, signal: status.signal })
            yield* PubSub.publish(events, { _tag: "Exited", id: entry.id, exitCode: status.exitCode, signal: status.signal })
            return
          case "Failed":
            yield* Deferred.fail(entry.exit, new ProcessFailedError({ id: entry.id, executable, reason: status.reason }))
            yield* PubSub.publish(events, { _tag: "Failed", id: entry.id, reason: status.reason })
            return
          case "Terminated":
            yield* Deferred.fail(entry.exit, new ProcessTerminatedError({ id: entry.id, executable }))
            yield* PubSub.publish(events, { _tag: "Terminated", id: entry.id })
            return
        }
      })

    const pump = (entry: Entry, sandbox: Sandbox.Sandbox): Effect.Effect<void> =>
      Stream.runForEach(
        sandbox.execStream(entry.request.command, {
          timeout: entry.request.timeout,
          maxOutputBytes: entry.request.maxOutputBytes
        }),
        (event) =>
          event._tag === "Output"
            ? Effect.gen(function* () {
              const sequence = yield* Ref.modify(entry.history, (history) => {
                const next: Output = { sequence: history.length + 1, stream: event.stream, bytes: event.bytes }
                return [next.sequence, [...history, next]]
              })
              yield* Ref.update(entry.outputBytes, (n) => n + event.bytes.byteLength)
              yield* PubSub.publish(entry.bus, { _tag: "Output", output: { sequence, stream: event.stream, bytes: event.bytes } })
            })
            : finish(entry, { _tag: "Exited", exitCode: event.exitCode, signal: Option.fromNullishOr(event.signal) })
      ).pipe(
        Effect.catch((error) => finish(entry, { _tag: "Failed", reason: error.message })),
        // A stream that ended without an `Exit` is a provider bug; `finish`
        // is a no-op if the exit already arrived, so this only ever covers
        // interruption -- `terminate`, or the manager closing.
        Effect.ensuring(finish(entry, { _tag: "Terminated" })),
        Effect.ensuring(Scope.close(entry.scope, Exit.void))
      )

    const handle = (entry: Entry): ManagedProcess => ({
      id: entry.id,
      info: infoOf(entry),
      output: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the snapshot, so nothing published
            // between the two is missed; the sequence filter drops what the
            // snapshot already carried.
            const subscription = yield* PubSub.subscribe(entry.bus)
            const status = yield* Ref.get(entry.status)
            const history = yield* Ref.get(entry.history)
            const after = options?.after ?? 0
            const replay: Stream.Stream<Output> = Stream.fromIterable(
              history.filter((output) => output.sequence > after)
            )
            const seen = Math.max(history.length, after)
            const live: Stream.Stream<Output> = isRunning(status) && (options?.follow ?? true)
              ? Stream.fromSubscription(subscription).pipe(
                Stream.takeWhile((chunk): chunk is Extract<Chunk, { _tag: "Output" }> => chunk._tag === "Output"),
                Stream.map((chunk) => chunk.output),
                Stream.filter((output) => output.sequence > seen)
              )
              : Stream.empty
            return Stream.concat(replay, live)
          })
        ).pipe(Stream.scoped),
      wait: Deferred.await(entry.exit),
      terminate: Effect.gen(function* () {
        if (!isRunning(yield* Ref.get(entry.status))) return
        // Interrupting the pump interrupts `execStream`, and the sandbox ends
        // the tree; the pump's `ensuring` records the termination.
        yield* FiberMap.remove(pumps, entry.id)
        yield* finish(entry, { _tag: "Terminated" })
      })
    })

    const start: Service["start"] = Effect.fn("ProcessManager.start")(function*(request) {
      const n = yield* Ref.updateAndGet(counter, (n) => n + 1)
      const id = processId(`process-${n}`)
      yield* Effect.annotateCurrentSpan("processId", id)
      yield* Effect.annotateCurrentSpan("executable", request.command.executable)
      const scope = yield* Scope.fork(managerScope)
      const sandbox = yield* Scope.provide(workspaces.acquire(request.workspace), scope).pipe(
        Effect.tapError(() => Scope.close(scope, Exit.void))
      )
      const entry: Entry = {
        id,
        request,
        status: yield* Ref.make<Status>({ _tag: "Running" }),
        history: yield* Ref.make<ReadonlyArray<Output>>([]),
        outputBytes: yield* Ref.make(0),
        bus: yield* PubSub.unbounded<Chunk>(),
        exit: yield* Deferred.make<ProcessExit, WaitError>(),
        scope
      }
      yield* Ref.update(entries, (all) => [...all, entry])
      yield* PubSub.publish(events, { _tag: "Started", id })
      yield* FiberMap.run(pumps, id, pump(entry, sandbox))
      return handle(entry)
    })

    return {
      start,
      get: (id) =>
        Effect.flatMap(find(id), Option.match({
          onNone: () => Effect.fail(new ProcessNotFoundError({ id })),
          onSome: (entry) => Effect.succeed(handle(entry))
        })),
      list: Effect.flatMap(Ref.get(entries), Effect.forEach(infoOf)),
      events: Effect.map(PubSub.subscribe(events), Stream.fromSubscription)
    }
  })

export const layer = (): Layer.Layer<ProcessManager, never, WorkspaceManager> =>
  Layer.effect(ProcessManager, make())
