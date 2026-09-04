# Permissions

Between "the model asked for a tool call" and "the handler runs" there is one
decision, and `Permission` is where it is made. It is deliberately not the
sandbox (the physical boundary of what a call can affect -- an approval never
widens it) and not `Elicitation` (how an undecided question gets its answer).
A policy says one of three things about one invocation:

```text
Allow   run it
Ask     someone outside decides; the run pauses on an Elicitation
Deny    refuse it
```

```ts
import { Agent, Permission, ToolExecution } from "affe-agent"

// The tool says what it *is*, for policy purposes; the policy never parses
// a parameter schema. Without an annotation the action is "tool" and the
// resource is the tool's name.
const Bash = Permission.annotate(
  Tool.make("bash", { parameters: Schema.Struct({ command: Schema.String }), success: Schema.String }),
  { action: "shell", resource: ({ command }) => command }
)

const agent = Agent.make({
  toolkit: Agent.toolkit([Bash, Read], { ... }),
  permission: Permission.rules(
    [
      { action: "shell", resource: /^git (status|diff)/, decision: Permission.allow },
      { action: "shell", resource: /^git push/, decision: Permission.ask("remote write") },
      { action: "shell", resource: /rm -rf/, decision: Permission.deny("destructive") },
      { tool: "read", decision: Permission.allow }
    ],
    { otherwise: Permission.ask() }   // required: nothing is allowed by omission
  ),
  // What a refusal does: fail the run (default), or tell the model so it
  // can take another route. The call never runs either way.
  toolDenialPolicy: ToolExecution.ReturnToModel
})
```

A carve-out from a broad rule reads better as an exception than as a
double-negated matcher. `Permission.except(base, exceptions)` lets a matching
exception replace the base decision — so "deny all writes, except inside
`/workspace/src`" is written directly:

```ts
Permission.except(
  Permission.rules([{ action: "write", decision: Permission.deny("outside the workspace") }], {
    otherwise: Permission.ask()
  }),
  [{ action: "write", resource: /^\/workspace\/src\//, decision: Permission.allow }]
)
```

Exceptions combine conservatively among themselves (a `deny` exception still
wins over an `allow` one), an exception `allow` overrides the base `deny`, and
the intrinsic `needsApproval` floor still applies on top.

The rules, exactly:

- **Conservative combination.** `Deny > Ask > Allow`, everywhere decisions
  meet: `Permission.combine`, `Permission.all`, and within `Permission.rules`,
  where every matching rule counts and the order of the list is never
  load-bearing -- an `ask` listed above a `deny` cannot shadow it.
- **The tool's own `needsApproval` is a floor.** It is *evaluated* -- a
  function of the parameters and the conversation, as Effect AI defines it,
  not treated as `true` because it is a function -- and the result is at
  least an `Ask` whatever the policy says. No option lowers it.
- **A policy cannot fail.** `evaluate` has no error channel; a policy that
  cannot decide decides `Deny` and says why. A projection that throws is a
  bug and the call dies.
- **`Ask` is an `Elicitation`** of kind `tool-approval`, whose detail carries
  the tool, the call id, the action, the resource and the policy's reason.
  Locally it is a `Deferred`; under `/durable` a `DurableDeferred`, so a
  question asked today can be answered tomorrow from another process.
- **"Allow always" is two things**: the answer to this question, and a grant
  the policy keeps. A granted answer with `value: { remember: true }` calls
  the policy's `remember`; `Permission.remembered(policy)` keeps grants in
  memory, keyed by exact action and resource, and a grant never overrides a
  `Deny`. A refused answer records nothing.
- **Decisions are journalled under `/durable`** (`DurablePermission`), like
  tool calls: a replay after process loss sees the decisions it made, so a
  policy tightened overnight cannot "deny" a call whose side effect already
  happened. New calls get the policy now in force.

What belongs elsewhere: who may *control* the agent (answer this question,
read that session) is transport authorization, on the client and adapters;
what an approved call can physically touch is the sandbox.

## Across a delegation

A subagent is a tool that opens a child session (`Subagent.tool`), and the
child has its own policy: a denying child blocks its own tool, and the parent
is asked only about the delegation. Approving `research` is not approving what
`research` then does.

A child's tool marked `needsApproval` is the case to decide, because nobody
can answer it: the child has no elicitor. The default is to refuse such a
child **at construction** -- `Subagent.tool` throws, the way `Agent.make`
refuses two toolkits -- so the fault is found before the agent starts rather
than as a string in the parent model's context three delegations in.

To let someone answer, forward:

```ts
const research = Subagent.tool("research", Researcher, {
  description: "Research a question and return findings.",
  provide: ResearcherModel,
  inherit: { approval: "parent" }
})
```

The child's approval is then asked of the parent session's elicitor, announced
on the parent's event stream, and answered with `AgentSession.respond` on the
parent exactly as the parent's own approvals are. The request's `detail.via`
names the delegating tool (`["research"]`, or the path through nested
delegations), so the person asked is told who is asking. It is opt-in because
that is a real question to put to a person: approve a tool call from an agent
they cannot see, named by a tool they did not choose.

A child whose tools come from an MCP server is the one the construction-time
check cannot see -- the server's `requiresApproval` annotation becomes
`needsApproval` only when the server is listed -- and forwarding is the answer
for that child too.

Budget crosses by default (`inherit.budget`: the engine records every turn
against the `Budget` in context, see `Budget.record`); principal
crosses because a fibre reference does. The table in
[conformance-matrix.md](./conformance-matrix.md) has every concern against
every context.
