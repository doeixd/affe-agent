import { Context, Effect, Option, Ref, Schema } from "effect"
import type { Prompt, Tool } from "effect/unstable/ai"

/**
 * Whether an agent may attempt an action.
 *
 * One narrow abstraction between "the model asked for a tool call" and "the
 * handler runs". It is not the sandbox -- that is the physical boundary of
 * what a call can affect, and an approval never widens it -- and it is not
 * elicitation, which is how an undecided question obtains an answer. A policy
 * only ever says one of three things about one invocation:
 *
 * - `Allow`: run it.
 * - `Ask`: someone outside must decide; the run pauses on an `Elicitation`.
 * - `Deny`: refuse it.
 *
 * Decisions combine conservatively, `Deny > Ask > Allow`, and the tool's own
 * `needsApproval` is a floor: a tool that declares it needs approval is at
 * least asked about, whatever an application policy says. There is no switch
 * that erases that; a tool author's intrinsic requirement is not an
 * application's to waive by precedence.
 *
 * A policy is a plain value with an `evaluate` that cannot fail. A policy
 * that cannot decide -- the database is down -- decides `Deny` and says why.
 * There is deliberately no third channel through which "I do not know"
 * becomes "go ahead".
 */

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const Decision = Schema.Union([
  Schema.TaggedStruct("Allow", {}),
  Schema.TaggedStruct("Ask", { reason: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Deny", { reason: Schema.optional(Schema.String) })
])
export type Decision = typeof Decision.Type

export const allow: Decision = { _tag: "Allow" }
export const ask = (reason?: string): Decision =>
  reason === undefined ? { _tag: "Ask" } : { _tag: "Ask", reason }
export const deny = (reason?: string): Decision =>
  reason === undefined ? { _tag: "Deny" } : { _tag: "Deny", reason }

const severity = (decision: Decision): number =>
  decision._tag === "Deny" ? 2 : decision._tag === "Ask" ? 1 : 0

/**
 * The conservative merge: the most restrictive decision wins, and the first
 * one at that level supplies the reason.
 */
export const combine = (
  first: Decision,
  ...rest: ReadonlyArray<Decision>
): Decision => {
  let result = first
  for (const decision of rest) {
    if (severity(decision) > severity(result)) result = decision
  }
  return result
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * One invocation, as a policy sees it.
 *
 * `action` and `resource` are the semantic projection a rule is written
 * against -- `shell` / `git push origin main`, `write` / `/workspace/.env`.
 * They come from the tool's `Projection` annotation, and fall back to
 * `"tool"` and the tool's name for a tool that declares none, so a rule can
 * always be written and a policy never has to parse a parameter schema.
 */
export interface Request {
  readonly sessionId: string
  readonly toolCallId: string
  readonly tool: {
    readonly name: string
    readonly params: unknown
  }
  readonly action: string
  readonly resource: string
  /**
   * Whether the tool itself requires approval for this call -- its
   * `needsApproval`, evaluated. Visible so a policy can *tighten* on it; the
   * harness applies it as a floor regardless of what the policy returns.
   */
  readonly intrinsicApproval: boolean
  /**
   * The invocation as a person should see it, when narrower than `resource`.
   *
   * Present only when the tool's projection says the two differ. A policy is
   * free to ignore it -- it exists so the *question* can be specific while
   * the remembered answer stays coarse.
   */
  readonly subject?: string | undefined
  /** The conversation leading up to the call. */
  readonly messages: ReadonlyArray<Prompt.Message>
}

// ---------------------------------------------------------------------------
// Projection: how a tool describes its operation to policy
// ---------------------------------------------------------------------------

/**
 * What a tool call *is*, for policy purposes.
 *
 * The tool author knows that `shell({ command })` is the action `shell` on the
 * resource `command`; the policy engine must not. A tool carries this as an
 * Effect AI annotation, read when the call is evaluated.
 *
 * `resource` is a pure function of the decoded parameters. A projection that
 * throws is a bug in the tool, and the call dies rather than being evaluated
 * against a resource nobody computed.
 *
 * A constraint that comes with deciding on *decoded* parameters: the tool's
 * parameter codec is run twice for one call -- once here, to authorize, and
 * once by `Toolkit.handle`, which has no entry point taking a value that has
 * already been decoded. Schema decoding is an Effect with a requirement
 * channel, so a codec backed by a service or by mutable state can return one
 * value to the policy and a different one to the handler, and the permission
 * decision would then be about something that never ran.
 *
 * So a parameter codec used with permission must be a deterministic,
 * side-effect-free function of its input. Requiring a service to *read* is
 * fine and is tested; requiring one whose answer can change between two
 * evaluations of the same input is not. `test/PermissionDecodingServices.test.ts`
 * pins the count at two so this cannot quietly become a different number.
 */
export interface Projection<Params = unknown> {
  readonly action: string
  readonly resource: (params: Params) => string
  /**
   * What to *show* a person being asked, when that differs from the scope.
   *
   * `resource` is the key an answer is remembered under, and a good key is
   * often deliberately coarse: `web_fetch` keys on the origin so that "allow
   * example.com" means what it says. But coarse is exactly wrong for the
   * question itself -- `https://example.com/upload?token=<secret>` was shown
   * as `https://example.com`, so the approval concealed the data it was
   * approving.
   *
   * Optional, and defaulted to `resource`: for a tool whose scope already is
   * the thing being done -- `shell` on a command -- the two are the same
   * string and there is nothing to separate.
   */
  readonly describe?: ((params: Params) => string) | undefined
}

/** The annotation key. */
export class ProjectionKey extends Context.Service<ProjectionKey, Projection<any>>()(
  "affe-agent/Permission/Projection"
) {}

/** Attach a projection to a tool, typed against the tool's own parameters. */
export const annotate = <T extends Tool.Any>(
  tool: T,
  projection: Projection<Tool.Parameters<T>>
): T =>
  // `annotate` returns the same tool type; Effect AI's signature widens it
  // to the structural `Tool<Name, Config, Requirements>`, which is `T`.
  tool.annotate(ProjectionKey, projection) as T

/** The fallback for a tool without one: the action is `tool`, the resource its name. */
export const defaultProjection = (name: string): Projection<unknown> => ({
  action: "tool",
  resource: () => name
})

/** Read a tool's projection, or the default. */
export const projectionOf = (tool: {
  readonly name: string
  readonly annotations: Context.Context<never>
}): Projection<unknown> =>
  Option.getOrElse(Context.getOption(tool.annotations, ProjectionKey), () =>
    defaultProjection(tool.name)
  )

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/**
 * The seam.
 *
 * `evaluate` is infallible: failure to decide is `Deny`. `remember` is how an
 * answer of "allow always" reaches the policy -- the elicitation answered the
 * one call; the policy, if it keeps grants, records the rest. A policy that
 * does not keep grants leaves it undefined and "always" means "once".
 */
export interface Policy<R = never> {
  readonly evaluate: (request: Request) => Effect.Effect<Decision, never, R>
  readonly remember?: ((request: Request) => Effect.Effect<void, never, R>) | undefined
}

export const make = <R = never>(
  evaluate: (request: Request) => Effect.Effect<Decision, never, R>
): Policy<R> => ({ evaluate })

export const allowAll: Policy = make(() => Effect.succeed(allow))
export const askAll: Policy = make(() => Effect.succeed(ask()))
export const denyAll: Policy = make(() => Effect.succeed(deny()))

/**
 * Every policy consulted, their decisions merged conservatively. A `remember`
 * reaches all of them.
 */
export const all = <R = never>(...policies: ReadonlyArray<Policy<R>>): Policy<R> => ({
  evaluate: (request) =>
    Effect.map(
      Effect.forEach(policies, (policy) => policy.evaluate(request)),
      (decisions) => combine(allow, ...decisions)
    ),
  remember: (request) =>
    Effect.forEach(
      policies,
      (policy) => (policy.remember === undefined ? Effect.void : policy.remember(request)),
      { discard: true }
    )
})

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** How a rule matches an action, a resource or a tool name. */
export type Matcher = string | RegExp | ((value: string) => boolean)

/**
 * Does this matcher accept this value -- the same answer every time?
 *
 * A `RegExp` with `g` or `y` carries `lastIndex` between calls, so
 * `/secret/g.test(x)` alternates true and false for the same `x`. A deny rule
 * written that way denied the first call and let the second through, which
 * with an allow default is a permission decision made by call order. Tested
 * against a fresh expression rather than by resetting the caller's: a policy
 * is not entitled to mutate the rules it was handed.
 */
const matches = (matcher: Matcher | undefined, value: string): boolean =>
  matcher === undefined
    ? true
    : typeof matcher === "string"
      ? matcher === value
      : matcher instanceof RegExp
        ? stateless(matcher).test(value)
        : matcher(value)

const stateless = (pattern: RegExp): RegExp =>
  pattern.global || pattern.sticky
    ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
    : pattern

/**
 * One rule. Every matcher given must match; an omitted one matches anything.
 * A `string` matches exactly, a `RegExp` by `test`, a function by its word.
 * No glob language: a pattern a policy author cannot read is not a policy.
 */
export interface Rule {
  readonly action?: Matcher | undefined
  readonly resource?: Matcher | undefined
  readonly tool?: Matcher | undefined
  readonly decision: Decision
}

/**
 * Every matching rule is consulted and the decisions combine conservatively;
 * `otherwise` decides what no rule covered.
 *
 * Not first-match-wins. Ordering is exactly the thing a rule author gets
 * wrong -- an `ask` for `git push` listed above a `deny` for `--force` let
 * `git push --force` through as a question -- and a permission system whose
 * safety depends on list order is not one. Here a deny anywhere is a deny,
 * an ask anywhere is at least an ask, and the list can be read in any order.
 * An exception to a broad rule is written as a narrower matcher on the
 * broad rule, not as an earlier line.
 *
 * `otherwise` is required. A rule set that silently allows what it did not
 * mention is the classic permission bug; making the default explicit is
 * cheaper than debugging it.
 */
export const rules = (
  list: ReadonlyArray<Rule>,
  options: { readonly otherwise: Decision }
): Policy =>
  make((request) => {
    let decision: Decision | undefined
    for (const rule of list) {
      if (
        matches(rule.action, request.action) &&
        matches(rule.resource, request.resource) &&
        matches(rule.tool, request.tool.name)
      ) {
        decision = decision === undefined ? rule.decision : combine(decision, rule.decision)
      }
    }
    return Effect.succeed(decision ?? options.otherwise)
  })

/**
 * A carve-out from a broad policy.
 *
 * `rules` combines conservatively, which is the right default but cannot say
 * "deny all writes, *except* inside `/workspace/src`" without a
 * double-negated predicate an author gets backwards. `except` says it
 * directly: a matching exception replaces the base decision.
 *
 * ```ts
 * Permission.except(
 *   Permission.rules([{ action: "write", decision: Permission.deny("outside the workspace") }], {
 *     otherwise: Permission.ask()
 *   }),
 *   [{ action: "write", resource: /^\/workspace\/src\//, decision: Permission.allow }]
 * )
 * ```
 *
 * The exact rule, pinned in tests:
 *
 * - **No exception matches**: the base decision stands.
 * - **Exceptions match**: they combine conservatively among themselves
 *   (`Deny > Ask > Allow` -- one exception cannot widen another's `Deny`)
 *   and that decision *replaces* the base. So an exception `Allow` overrides
 *   a base `Deny` (the carve-out), and an exception `Deny` overrides a base
 *   `Allow` (an extra restriction).
 * - The intrinsic `needsApproval` floor is applied by the harness *after*
 *   the policy, so an exception `Allow` on a tool that declares it needs
 *   approval is still floored to `Ask`. No exception can lower that.
 *
 * `remember` passes through to the base, so a grant recorded by a
 * `remembered(except(...))` reaches the underlying policy.
 */
export const except = <R>(
  base: Policy<R>,
  exceptions: ReadonlyArray<Rule>
): Policy<R> => ({
  evaluate: (request) => {
    let override: Decision | undefined
    for (const rule of exceptions) {
      if (
        matches(rule.action, request.action) &&
        matches(rule.resource, request.resource) &&
        matches(rule.tool, request.tool.name)
      ) {
        override = override === undefined ? rule.decision : combine(override, rule.decision)
      }
    }
    return override === undefined ? base.evaluate(request) : Effect.succeed(override)
  },
  ...(base.remember === undefined ? {} : { remember: base.remember })
})

// ---------------------------------------------------------------------------
// Remembered grants
// ---------------------------------------------------------------------------

/**
 * How a remembered grant is keyed: the exact tool, action and resource.
 *
 * Length-prefixed rather than delimited. A NUL separator was here, and
 * neither field forbids one: `{ action: "a", resource: "b c" }` and
 * `{ action: "a b", resource: "c" }` produce the same key, and a resource is
 * frequently model-controlled text. Any single delimiter has that defect --
 * NUL only makes the colliding input unusual, not impossible. A length prefix
 * has no such input.
 *
 * The tool name is part of the identity, deliberately. Actions are a shared
 * vocabulary: two tools can both project `net.fetch` on an origin, and a
 * grant given while approving one is not an answer about the other. The cost
 * is that a grant does not transfer between tools that genuinely mean the
 * same thing, which is the safe direction to be wrong in.
 */
export const grantKey = (request: Request): string =>
  [request.tool.name, request.action, request.resource]
    .map((part) => `${part.length}:${part}`)
    .join("")

/**
 * "Allow always", kept in memory for the life of the policy.
 *
 * A granted `(action, resource)` pair is allowed without consulting the
 * underlying policy's `Ask` again -- but a `Deny` from it still stands: a
 * grant answers the question "may I?", it does not override "no". The tool's
 * intrinsic floor stands too. Grants are per process; a durable agent wanting
 * grants that survive it supplies a policy backed by its own store.
 */
export const remembered = <R>(
  underlying: Policy<R>
): Effect.Effect<Policy<R>> =>
  Effect.map(Ref.make(new Set<string>()), (grants) => ({
    evaluate: (request) =>
      Effect.flatMap(underlying.evaluate(request), (decision): Effect.Effect<Decision> =>
        decision._tag === "Ask"
          ? Effect.map(Ref.get(grants), (set) =>
              set.has(grantKey(request)) ? allow : decision
            )
          : Effect.succeed(decision)
      ),
    remember: (request) =>
      Ref.update(grants, (set) => new Set(set).add(grantKey(request))).pipe(
        Effect.andThen(
          underlying.remember === undefined ? Effect.void : underlying.remember(request)
        )
      )
  }))

// ---------------------------------------------------------------------------
// The approval answer
// ---------------------------------------------------------------------------

/**
 * What a `tool-approval` elicitation's `value` may carry.
 *
 * Absent or anything else: the answer covers this call only. `remember: true`
 * on a granted answer asks the policy to allow the same action on the same
 * resource from now on, if it keeps grants.
 */
export const ApprovalValue = Schema.Struct({ remember: Schema.Boolean })
export type ApprovalValue = typeof ApprovalValue.Type

/** What a `tool-approval` elicitation describes. */
export const ApprovalDetail = Schema.Struct({
  toolName: Schema.String,
  toolCallId: Schema.String,
  action: Schema.String,
  /** The scope an answer applies to, and the key a remembered grant uses. */
  resource: Schema.String,
  /**
   * The invocation itself, when it is narrower than the scope.
   *
   * Absent when it would repeat `resource`. A caller rendering a question
   * should prefer this and fall back to `resource`; see `Projection.describe`
   * for why the two are not the same string.
   */
  subject: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  /**
   * The delegations this request came through, outermost first, when it did
   * not come from the session being asked.
   *
   * A child agent's approval forwarded to its parent (`Subagent.tool`,
   * `inherit.approval: "parent"`) names the delegating tool here -- so a
   * person asked to approve `wipe` is at least told it is `research` asking,
   * on behalf of an agent they cannot see. Absent for the session's own
   * tools, which is every request that existed before delegation could ask.
   */
  via: Schema.optional(Schema.Array(Schema.String))
})
export type ApprovalDetail = typeof ApprovalDetail.Type
