import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import * as MemorySandbox from "../src/sandbox/memory.js"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import * as WorkspaceManager from "../src/sandbox/WorkspaceManager.js"

/**
 * Workspace lifetime (`docs/effect-plan-2.txt` §12–13).
 *
 * Identity is the whole subject, so the assertions are on identity. The memory
 * provider hands back a *new* `Sandbox` object per acquisition over a world
 * shared by workspace label, which makes `===` mean "the same build" and `!==`
 * mean "built again" -- exactly the distinction reference counting is supposed
 * to control, and one that a "was it released" flag could not express.
 *
 * Holder lifetimes are explicit `Scope`s rather than `Effect.scoped` blocks,
 * because what is under test is what happens *between* them.
 */

const ws = Sandbox.workspace

/**
 * A provider that counts builds and gives each one its own world.
 *
 * `MemorySandbox` keys its world by workspace label and shares it across
 * acquisitions regardless of who acquired it, so under it a correctly shared
 * workspace and a rebuilt one look identical. Counting builds is the only way
 * to tell reference counting from a plain expiring cache.
 */
const counting = (built: Ref.Ref<number>) =>
  Layer.succeed(Sandbox.SandboxProvider)({
    acquire: (workspace: Sandbox.Workspace) =>
      Effect.acquireRelease(
        Ref.update(built, (n) => n + 1),
        () => Ref.update(built, (n) => n - 1)
      ).pipe(
        Effect.flatMap(() =>
          Effect.provide(Sandbox.acquire(workspace), MemorySandbox.layer())
        )
      )
  })

const withCounting = <A, E>(
  use: (
    manager: WorkspaceManager.Service,
    built: Ref.Ref<number>
  ) => Effect.Effect<A, E, Scope.Scope>,
  options?: WorkspaceManager.Options
) =>
  Effect.gen(function* () {
    const built = yield* Ref.make(0)
    return yield* Effect.scoped(
      Effect.flatMap(WorkspaceManager.make(options), (manager) =>
        use(manager, built))
    ).pipe(Effect.provide(counting(built)))
  })

const withManager = <A, E>(
  use: (manager: WorkspaceManager.Service) => Effect.Effect<A, E, Scope.Scope>,
  options?: WorkspaceManager.Options
) =>
  Effect.scoped(
    Effect.flatMap(WorkspaceManager.make(options), use)
  ).pipe(Effect.provide(MemorySandbox.layer()))

/** Acquire into a scope the test owns, so it decides when the holder goes. */
const holder = (
  manager: WorkspaceManager.Service,
  workspace: Sandbox.Workspace
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const sandbox = yield* Effect.provideService(
      manager.acquire(workspace),
      Scope.Scope,
      scope
    )
    return { sandbox, release: Scope.close(scope, Exit.void) }
  })

describe("WorkspaceManager", () => {
  it.effect("two holders of one workspace share one build", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = yield* holder(manager, ws("shared"))
        const second = yield* holder(manager, ws("shared"))

        assert.strictEqual(first.sandbox, second.sandbox)

        yield* first.release
        yield* second.release
      })))

  it.effect("different workspaces never share a build", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const a = yield* holder(manager, ws("alpha"))
        const b = yield* holder(manager, ws("beta"))

        assert.notStrictEqual(a.sandbox, b.sandbox)

        yield* a.release
        yield* b.release
      })))

  it.effect("the workspace survives the first holder leaving", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        // The §12 case: one tool call ends while another still holds the
        // workspace. Releasing on first drop rather than last would tear it
        // down here, and the survivor would be holding a directory that no
        // longer exists.
        const first = yield* holder(manager, ws("shared"))
        const second = yield* holder(manager, ws("shared"))
        yield* first.release

        const third = yield* holder(manager, ws("shared"))
        assert.strictEqual(third.sandbox, second.sandbox)

        yield* second.release
        yield* third.release
      })))

  it.effect("it outlives the gap between two holders, up to the idle window", () =>
    withManager(
      (manager) =>
        Effect.gen(function* () {
          // Nobody holds it in between. Reference counting alone drops to zero
          // the instant the first holder releases, so without an idle window
          // two consecutive tool calls would get two different workspaces --
          // which is the bug this module exists to prevent, not a detail of it.
          const first = yield* holder(manager, ws("gap"))
          yield* first.release

          yield* TestClock.adjust("5 seconds")

          const second = yield* holder(manager, ws("gap"))
          assert.strictEqual(second.sandbox, first.sandbox)
          yield* second.release
        }),
      // Deliberately not the default: set to 30s, deleting the option
      // entirely would change nothing observable.
      { idleTimeToLive: "10 seconds" }
    ))

  it.effect("a live holder keeps it past the idle window", () =>
    withCounting(
      (manager, built) =>
        Effect.gen(function* () {
          // The assertion the rest of this file was missing, and without it
          // the whole module is indistinguishable from an expiring cache: no
          // other test holds a workspace *across* the window, so every
          // "shared" result they check is satisfied by the cache alone. An
          // `acquire` that took no reference at all passed all eight.
          const held = yield* holder(manager, ws("held"))
          yield* TestClock.adjust("11 seconds")

          assert.strictEqual(yield* Ref.get(built), 1)
          const second = yield* holder(manager, ws("held"))
          assert.strictEqual(second.sandbox, held.sandbox)
          assert.strictEqual(yield* Ref.get(built), 1)

          yield* second.release
          yield* held.release
        }),
      { idleTimeToLive: "10 seconds" }
    ))

  it.effect("the default idle window is the documented one", () =>
    withCounting((manager, built) =>
      Effect.gen(function* () {
        // Pins `defaultIdleTimeToLive`, which nothing else reads: every other
        // test passes its own, so the constant the docstring argues for was
        // free to be anything at all.
        const first = yield* holder(manager, ws("default"))
        yield* first.release

        yield* TestClock.adjust("29 seconds")
        assert.strictEqual(yield* Ref.get(built), 1)

        yield* TestClock.adjust("2 seconds")
        assert.strictEqual(yield* Ref.get(built), 0)
      })))

  it.effect("and is released once the window passes", () =>
    withManager(
      (manager) =>
        Effect.gen(function* () {
          const first = yield* holder(manager, ws("expiring"))
          yield* first.release

          yield* TestClock.adjust("11 seconds")

          const second = yield* holder(manager, ws("expiring"))
          // Asserted as a *different build*, not as a "released" flag: the
          // flag is trivially satisfiable and this is not.
          assert.notStrictEqual(second.sandbox, first.sandbox)
          yield* second.release
        }),
      { idleTimeToLive: "10 seconds" }
    ))

  it.effect("`invalidate` rebuilds without revoking from a live holder", () =>
    withCounting((manager, built) =>
      Effect.gen(function* () {
        const first = yield* holder(manager, ws("forced"))
        yield* manager.invalidate(ws("forced"))

        const second = yield* holder(manager, ws("forced"))
        assert.notStrictEqual(second.sandbox, first.sandbox)

        // The existing holder keeps what it was handed. Asserted as *two live
        // builds*, because the previous version of this compared a variable to
        // itself under three lines of comment claiming it proved exactly this,
        // and would have passed an implementation that tore the workspace out
        // from under the holder.
        assert.strictEqual(yield* Ref.get(built), 2)

        // An invalidated entry still honours the idle window on its way out --
        // it is unkeyed, not force-closed. Checked rather than assumed: the
        // first version of this comment claimed immediate release and was
        // wrong.
        yield* first.release
        assert.strictEqual(yield* Ref.get(built), 2)
        yield* TestClock.adjust("31 seconds")
        assert.strictEqual(yield* Ref.get(built), 1)

        yield* second.release
      })))

  it.effect("`layer` and `acquire` are the same workspace, not two", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        // The wiring path and the calling path have to agree, or an
        // application that uses `layer` for its tools and `acquire` for
        // something else silently gets two directories.
        const direct = yield* holder(manager, ws("both"))

        const scope = yield* Scope.make()
        const viaLayer = yield* Effect.provideService(
          Layer.build(manager.layer(ws("both"))),
          Scope.Scope,
          scope
        )

        assert.strictEqual(
          Context.get(viaLayer, Sandbox.Current),
          direct.sandbox
        )

        yield* Scope.close(scope, Exit.void)
        yield* direct.release
      })))

  it.effect("closing the manager releases every workspace it built", () =>
    Effect.gen(function* () {
      // The manager owns them; nothing else does. If its own scope did not
      // release them, an application that tore down its sandbox wiring would
      // leak every workspace it had ever opened.
      const built = yield* Ref.make(0)
      const counting = Layer.succeed(Sandbox.SandboxProvider)({
        acquire: (workspace: Sandbox.Workspace) =>
          Effect.acquireRelease(
            Ref.update(built, (n) => n + 1),
            () => Ref.update(built, (n) => n - 1)
          ).pipe(
            Effect.flatMap(() =>
              Effect.provide(Sandbox.acquire(workspace), MemorySandbox.layer())
            )
          )
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* WorkspaceManager.make()
          const first = yield* holder(manager, ws("owned"))
          yield* first.release
          assert.strictEqual(yield* Ref.get(built), 1)
        })
      ).pipe(Effect.provide(counting))

      assert.strictEqual(yield* Ref.get(built), 0)
    }))
})
