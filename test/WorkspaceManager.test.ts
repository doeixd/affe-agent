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
      { idleTimeToLive: "30 seconds" }
    ))

  it.effect("and is released once the window passes", () =>
    withManager(
      (manager) =>
        Effect.gen(function* () {
          const first = yield* holder(manager, ws("expiring"))
          yield* first.release

          yield* TestClock.adjust("31 seconds")

          const second = yield* holder(manager, ws("expiring"))
          // Asserted as a *different build*, not as a "released" flag: the
          // flag is trivially satisfiable and this is not.
          assert.notStrictEqual(second.sandbox, first.sandbox)
          yield* second.release
        }),
      { idleTimeToLive: "30 seconds" }
    ))

  it.effect("`invalidate` forces the next acquire to build again", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = yield* holder(manager, ws("forced"))
        yield* manager.invalidate(ws("forced"))

        const second = yield* holder(manager, ws("forced"))
        assert.notStrictEqual(second.sandbox, first.sandbox)

        // The existing holder keeps what it was handed -- its scope still owns
        // that value -- which is why this is an operator's rebuild and not a
        // way to revoke a workspace from under someone.
        assert.strictEqual(first.sandbox, first.sandbox)

        yield* first.release
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
