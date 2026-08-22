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
  /** The conversation leading up to the call. */
  readonly messages: ReadonlyArray<Prompt.Message>
}

// ---------------------------------------------------------------------------
// Projection: how a tool describes its operation to policy
// ---------------------------------------------------------------------------

/**
 * What a tool call *is*, for policy purposes.
 *
 * The tool author knows that `bash({ command })` is the action `shell` on the
 * resource `command`; the policy engine must not. A tool carries this as an
 * Effect AI annotation, read when the call is evaluated.
 *
 * `resource` is a pure function of the decoded parameters. A projection that
 * throws is a bug in the tool, and the call dies rather than being evaluated
 * against a resource nobody computed.
 */
export interface Projection<Params = unknown> {
  readonly action: string
  readonly resource: (params: Params) => string
}

/** The annotation key. */
export class ProjectionKey extends Context.Service<ProjectionKey, Projection<any>>()(
  "@doeixd/effect-agent/Permission/Projection"
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

const matches = (matcher: Matcher | undefined, value: string): boolean =>
  matcher === undefined
    ? true
    : typeof matcher === "string"
      ? matcher === value
      : matcher instanceof RegExp
        ? matcher.test(value)
        : matcher(value)

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

// ---------------------------------------------------------------------------
// Remembered grants
// ---------------------------------------------------------------------------

/** How a remembered grant is keyed: the exact action and resource. */
export const grantKey = (request: Request): string =>
  `${request.action} ${request.resource}`

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
  resource: Schema.String,
  reason: Schema.optional(Schema.String)
})
export type ApprovalDetail = typeof ApprovalDetail.Type
