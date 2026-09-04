import { Context, Option } from "effect"

/**
 * Who asked, on the fibre that acts
 * (`docs/plan-principal-on-tool-fibre.md`, decided 2026-08-31).
 *
 * A `Context.Reference`, not a kernel noun: the kernel neither reads nor
 * requires it, no session or tool signature changes, and a session run
 * outside any host reads the default `None` and behaves exactly as before
 * -- the same reasoning that keeps `MinimumLogLevel` out of every effect's
 * type. What makes it *work* is already true of the kernel: a submission
 * forks from the fibre that called `prompt`/`submit`, so a value provided
 * around that call is visible to the whole run -- model calls, tool
 * handlers, permission evaluation -- and the session's captured environment
 * cannot clobber a key it never held.
 *
 * The value is an opaque **subject string**, produced by the application's
 * own projection (`AgentSessionHost`'s `principal.subject`, the same shape
 * `AgentA2A` takes). Deliberately not a rich principal object: tools and
 * credential bindings key on a stable string, and identity-bearing objects
 * stay on the host where they were resolved.
 *
 * Semantics: the *submitter's* subject governs the whole submission. A
 * steer or follow-up from someone else changes what the run is told, not
 * who it acts as. `respond` also sets it -- an approval's authority is the
 * approver's.
 */
export const CurrentPrincipal = Context.Reference<Option.Option<string>>(
  "affe-agent/CurrentPrincipal",
  { defaultValue: () => Option.none() }
)
