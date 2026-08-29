# Design assessment after working in the library

Written 2026-08-28, after implementing and reviewing work across the kernel,
durability, transports, compaction, tool sources, sandboxes and reference
applications. This is a point-in-time judgment, not a new design authority and
not an implementation plan. `PLAN.md` still owns the design; where this note
disagrees with it, the right next step is to amend the plan explicitly rather
than quietly code around it.

## Short verdict

The library has a real, defensible core. Its best idea is not “agents in
Effect”; it is the precise execution model around an Effect AI call:

- one session-owned canonical history;
- ephemeral context derived for each turn;
- atomic turn commits;
- submissions, runs and turns with distinct meanings;
- steering and follow-ups admitted at explicit boundaries;
- structured interruption and scoped lifetime;
- one typed event record of what happened.

Those pieces fit together and have survived enough adversarial tests that they
feel like architecture rather than a promising sketch.

The weaker part is everything's presentation as one equally mature library.
There are now 42 published entry points, protocol adapters, two execution
strengths, coding batteries, deployment experiments and a very large manual.
That breadth is useful evidence that the seams work, but it also obscures which
parts are foundational and which are reference implementations. The project is
still described as a “small kernel”; the kernel is small conceptually, but the
package is now an ecosystem.

My strongest recommendation is therefore to **freeze the core vocabulary,
make maturity visible, and remove advanced implementation seams from the
ordinary user API before adding another foundational abstraction**.

## The architecture I see

The implementation is easiest to understand as three planes, rather than as a
flat list of modules:

```text
                         application / protocol
                                  |
                  commands        |       observations
                                  |
                         AgentSessionHost
                                  |
                         AgentSession handle
                                  |
             +--------------------+--------------------+
             |                                         |
    execution semantics                         event envelopes
   submission -> run -> turn              live stream / durable log
             |
       environment and policy
 model | toolkit | context | permission | elicitation | input channels
```

The command plane is `AgentSession` locally and `AgentSessionHost` across a
request boundary. The observation plane is `AgentEventEnvelope`, projected by
frontends or retained by a delivery log. The environment/policy plane is where
Effect is doing the most useful work: models, tool handlers, stores and external
capabilities arrive through Layers, while loops and transforms remain ordinary
values.

This division is coherent. New features should be explainable as a change in
one of these planes. If a proposal needs a second session registry, another
event model or a parallel definition of a turn, it is probably cutting across
the design rather than extending it.

## What is especially good

### Canonical history versus model-facing context

This is the library's load-bearing distinction. `ContextTransform` cannot
quietly rewrite the conversation record; compaction, memory and dynamic
instructions affect the next model call without corrupting what the session
actually committed. Keeping both `canonicalPrompt` and the progressively
derived `prompt` in the transform context makes composition honest.

This choice pays for much of the rest of the design: snapshots are meaningful,
replay can reproduce a session, compaction is reversible as a view, and a
streamed call can remain observational while the turn commits atomically.

### `Agent` is a value; `AgentSession` is the runtime

An agent not naming a provider is exactly right. It allows the same definition
to run under a real model, a test model, a model execution plan or a child
session without adding a provider-routing abstraction to the harness.

The method-bearing `AgentSession` handle is also a good compromise. Methods are
pleasant for application code, module functions compose well, and both reach
one implementation. The handle stays inert until its Effects run, so the API
does not smuggle an imperative runtime into Effect code.

### The submission/run/turn distinctions are real

These are not decorative names:

- a turn is one model call and the tool work it requested;
- a run is turns governed by one loop decision sequence;
- a submission is the externally awaited prompt plus accepted follow-ups;
- a session owns history and serializes submissions.

The distinctions explain otherwise awkward behavior, especially why steering
can require a continuation run without violating a hard per-run turn bound, and
why `prompt` does not resolve until follow-up work reaches quiescence.

### Effect is used for its semantics, not its branding

The code generally makes good choices about what is a value and what is a
service. `AgentLoop`, `ContextTransform`, permission decisions and execution
strategies are values. Models, stores, sandboxes and remote capabilities are
services. Scopes own sessions; fibers own active work; interruption is not
repackaged as a cancellation-token API.

The places where custom seams exist are mostly justified by replay or transport
requirements that Layer substitution alone cannot express. `InputChannel`, for
example, exists because a queue drain is nondeterministic input to a durable
interpreter, not because every `Queue` needed a project-specific wrapper.

### The type contract is unusually serious

“No cast in end-user code” is producing better API design, not merely cleaner
examples. The typed reference agent, exact error channels, inference assertions
and cast inventory catch failures that ordinary compilation would bless. In
particular, the project correctly treats `any` as a failed proof and test code
as user code.

`Agent.toolkit` is a good example of convenience earning its place: it removes
a real two-toolkit identity trap while preserving handler inference. The same
is true of `AgentLoop.bounded` and the small context-transform helpers.

### Protocol-neutral session hosting is the right transport seam

`AgentClient` separates a session from how it is reached. `AgentProtocol`
separates friendly in-memory inputs from the schema-owned wire contract.
`AgentSessionHost` centralizes identity, authorization, capacity and request
idempotency for adapters. Those are different jobs, and keeping all three is
not needless layering.

The shared host should be the default for every new frontend. The current MCP
exception is instructive: its old registry has an idle-eviction policy while
the host refuses at capacity. That is an observable policy conflict, not a
reason to abandon the host or silently call the migration a refactor.

### The tests are part of the design

The deterministic race tests, exact event sequences, real protocol peers,
portable bundle checks and Effect language-service diagnostics are unusually
good. They have repeatedly found semantic bugs—admission windows, owner-fiber
lifetime, response encoding, request replay—that a collection of happy-path
unit tests would miss.

The public-export snapshots and the package-import smoke test are also valuable.
They make “public” and “portable” executable claims.

## API assessment

### The happy path is good

The ordinary authoring path is compact and readable:

```ts
const toolkit = Agent.toolkit([Search], {
  search: ({ query }) => Effect.succeed({ hits: [query] })
})

const agent = Agent.make({
  instructions: "Research carefully.",
  toolkit,
  loop: AgentLoop.bounded(20)
})

const answer = yield* Effect.scoped(
  Effect.flatMap(AgentSession.make(agent), (session) =>
    session.prompt("Find the answer")
  )
)
```

Nothing important is hidden: the model remains an environmental requirement,
the session has a scope, and the result/error types are inferred.

The object form of `Agent.make` should remain the primary authoring form. Pipe
combinators are useful for reusable bundles and cross-cutting concerns, but
TypeScript cannot contextually infer an inline piped loop's concrete tool set as
well as it can infer fields of one object. The two forms need not be marketed as
equally suitable for every case.

### `Agent.make` is at its complexity limit

The nine generic parameters, invariant tool record and internal erased assembly
are evidence that the definition carries all the cross-cutting concerns it can
comfortably hold. The existing rule—new cross-cutting behavior is a combinator,
not another `Config` parameter—is correct and should be enforced aggressively.

Even combinators should meet a high bar. `withExecutionPlan` is justified
because it changes the session's model requirement, but its sophisticated
conditional signature is a warning about the cost of making `AgentDefinition`
carry more type-level state. A new feature should first try to be a Layer, a
toolkit, a context transform or an adapter.

### Some implementation API leaks into the public surface

There are two concrete leaks worth cleaning before 1.0:

1. `AgentRun` and `AgentSubmission` are root namespaces, and both export an
   `execute` function whose argument is the private internal `Session` shape.
   Users can name the function but cannot legitimately construct its input.
   Their IDs and result types are useful vocabulary; their engine entry points
   are not public operations. Export a narrow facade or keep execution internal.
2. `AgentSession.MakeOptions.beforeClose` is explicitly a deterministic test
   seam. `submissionIds`, `channels` and `eventSink` are interpreter wiring too.
   The latter three may deserve an advanced construction path, but a test-only
   synchronization hook should not appear in every user's session options.
   Split ordinary options from an internal/interpreter constructor instead of
   documenting the leak forever.

This is not a request to hide extensibility. It is a request to distinguish the
application API from the interpreter SPI.

### The namespace style works; the maturity story does not yet

Namespaced modules (`AgentSession.prompt`, `Compaction.make`,
`AgentHttp.serverLayer`) are consistent and discoverable. Subpath exports keep
host dependencies out of portable imports. I would keep that shape.

What needs work is prominence. Forty-two entry points in a `0.0.1` package do
not all have the same stability or audience, but the package map makes them
look like peers. A user choosing the kernel should not have to assess the
maturity of A2A, two MCP SDK generations, Durable Streams, plugins, coding
tools and deployment hosts at the same time.

Do not split into many npm packages merely for neatness yet; subpaths already
provide dependency and portability boundaries. Instead label them clearly:

- **core contract** — `Agent`, `AgentSession`, events, loop, context, errors;
- **supported infrastructure** — client/host, HTTP/RPC, sandbox surface,
  testing;
- **experimental interpreters/adapters** — durable, cluster, protocol
  frontends;
- **reference batteries** — coding, Pi, skills, memory, plugins and similar.

Promotion between tiers should require conformance tests and an explicit API
review, not just implementation completeness.

## Primitive-by-primitive judgment

| Primitive | Judgment | Direction |
| --- | --- | --- |
| `AgentDefinition` | Essential declarative value. | Freeze its role; resist more fields and type parameters. |
| `AgentSession` | The primary runtime API and strongest public primitive. | Keep methods plus module functions; simplify its ordinary construction options. |
| submission / run / turn | Correct internal execution vocabulary. | Keep the semantics; stop exposing engine-only `execute` functions as ordinary public API. |
| `AgentLoop` | Small, composable and genuinely replaceable. | Keep. Add policies only after repeated use. |
| `ContextTransform` | One of the most valuable seams. | Keep canonical/derived meanings rigid. |
| `AgentEventEnvelope` | The observation contract all frontends can share. | Keep provider-neutral and serializable; do not make the live stream a durability claim. |
| `ToolExecution` | Necessary policy around Effect AI's tool handlers. | Keep scheduling and failure policy narrow; retries/timeouts stay on handler Effects. |
| `Permission` | Correctly separate from physical sandboxing. | Keep projection, policy and remembered grant explicit. Avoid growing into an IAM framework. |
| `Elicitation` | Correct generalization of approval and external answers. | Keep separate from interruption and permission. Typed answer schemas belong at the consumer. |
| `InputChannel.Factory` | Justified durable-interpreter seam, not an everyday concept. | Treat as interpreter SPI and lower its prominence. |
| `AgentClient` | Necessary transport-neutral session handle. | Keep friendly domain inputs and typed remote failures. |
| `AgentProtocol` | Necessary schema/wire contract. | Keep distinct from `AgentClient`; do not make wire concerns infect the local handle. |
| `AgentSessionHost` | Correct shared adapter boundary. | New adapters use it. Keep one capacity policy unless a second real consumer justifies a policy seam. |
| durable wrappers | Implementation machinery, not domain vocabulary. | Contain them and test against the same session contract; do not let every core feature require a parallel public noun. |
| `ToolSource` | Honest boundary for external catalogs. | Preserve the distinction between statically typed extraction and runtime-discovered tools. |
| `Sandbox` | Good portable capability boundary. | Keep filesystem/process mechanisms here; shell dialect and model-facing tools remain above it. |

## Is a primitive missing?

Not in the local kernel today. `Effect.Fiber` is already the handle for a local
prompt that should run independently, and adding a project-specific
`SubmissionHandle` would duplicate it.

There is, however, recurring pressure for an **asynchronous remote mutation
ticket**: start a prompt, return an id, and await or inspect it later without
restarting it. MCP start/await wants this; A2A task execution and other
long-running frontends solve closely related problems. `AgentSessionHost`
already owns the hard part—host-scoped execution plus idempotent request
joining—but adapters currently build their own ticket/result bookkeeping.

That is a candidate host/protocol primitive, not yet a core session primitive.
Before adding it:

1. compare the MCP and A2A requirements against the existing host request
   table;
2. prove two adapters can share one contract without losing their protocol
   semantics;
3. specify completed-result retention and eviction, because re-running an
   evicted request is the dangerous failure mode;
4. only then name and export it.

This follows the project's own “two independent consumers” rule. The pressure
is real, but the right abstraction is not proven yet.

## The largest design risks now

### Breadth can turn reference implementations into permanent contracts

Every adapter is useful validation of the seams. Every exported adapter also
adds versioning, upstream-protocol and optional-dependency obligations. The
library should keep building references, but call them references until users
and conformance suites establish the stable subset.

The key metric should no longer be “how many roadmap boxes exist.” It should be
“how many independent features were added without changing the kernel, and how
many public contracts can we confidently support.”

### The durable interpreter is the highest-maintenance boundary

Durability is real here, not a store bolted onto a local session. That is a
strength, but model/tool wrappers, activities, durable channels and failure
projection create a second execution path whose drift cost is high. The casts
licensed for closed Effect AI service methods are a symptom of that boundary,
not necessarily a defect.

Future kernel changes should be required to pass one behavioral contract under
both local and durable execution. Prefer new features that enter through
existing seams. If a feature needs duplicate local and durable orchestration,
pause and ask whether an input or effect boundary is still hidden inside the
engine.

### Documentation has become a source of false authority

The repository currently has about forty files and roughly nineteen thousand nonblank
lines under `docs/`, plus a roughly three-thousand-line `PLAN.md`, a long
chronological `STATUS.md`, and a root README approaching two thousand lines.
The reasoning is often excellent; the retrieval problem is not.

Contradictions now arise because a dated plan describes an intended pure
refactor while tests prove an observable policy difference. More prose will not
solve that. The docs need lifecycle:

- `PLAN.md`: current invariants and decisions, amended when contradicted;
- short ADRs: one decision, alternatives and consequences;
- `STATUS.md`: current shipped inventory, not an append-only engineering diary;
- dated research/reviews: historical evidence, clearly non-authoritative;
- one live queue of work, with completed items moved out rather than dominating
  the page.

The root README should return to installation, the mental model, one complete
example, stability and links. Per-protocol and per-battery manuals belong in
focused docs. A long README is not more welcoming; it makes the primary API
harder to see.

### Cross-product behavior is more dangerous than isolated features

Most remaining bugs will be interactions: streaming plus interruption,
elicitation plus durability, request replay plus retention, two adapters plus
one host, compaction plus multimodal prompts. The existing end-to-end tests are
the right response. New work should name the interactions it can perturb and
add a contract test at that boundary, not only unit tests for the new module.

## What I would do next

In priority order:

1. **Freeze the kernel vocabulary for a while.** Treat a requested new core
   noun as a design review, not a normal implementation task.
2. **Clean the public/SPI boundary.** Remove test-only construction options and
   engine-only `execute` functions from the ordinary public surface before
   users depend on them.
3. **Publish a maturity map.** Keep subpaths, but label core, supported,
   experimental and reference surfaces in the README and package docs.
4. **Turn adapter behavior into one conformance matrix.** Session creation,
   continuation, capacity, authorization, interruption, idempotency and event
   resumption should be comparable across HTTP, RPC, AG-UI, A2A and MCP.
5. **Build further MCP work on the additive host path.**
   `AgentMcp.serverLayer({ host })` has landed. Keep the legacy registry until
   its eviction-versus-refusal policy is decided explicitly; do not disguise
   deletion as a behavior-preserving refactor.
   The elicitation slice strengthens that conclusion: `agent_status` and
   `agent_respond` are the transport-independent contract, while native MCP
   elicitation is a capability/transport optimization. The pinned stdio
   transport can reverse-call; Streamable HTTP currently cannot do so without
   hanging. The adapter should keep the honest manual path instead of making a
   kernel feature depend on one protocol transport's duplex behavior.
6. **Keep remote tickets adapter-owned for now.** MCP now proves the narrower
   need with a private bounded deferred table. A2A's protocol task store owns
   task state and history, so the two consumers do not yet justify a shared
   host/core primitive.
7. **Compress the authorities.** Amend plans when implementation falsifies
   them, and move chronological detail out of the documents users consult to
   decide what is true now.
8. **Finish falsification and boundary-limit evidence before adding breadth.**
   The remaining durability acceptance work is more valuable than another
   adapter whose happy path works.

## What I would not do

- I would not introduce a generic `ProcessManager`, `SessionInbox`, event-sourced
  aggregate framework or job engine merely because several plans can be drawn
  in those terms. Build the reference consumer first and extract only the
  repeated contract.
- I would not fork Effect's `PersistedQueue` or `PersistedQueueFactory` until a
  failing executable requirement proves that adaptation cannot work. Owning a
  fork is a permanent compatibility obligation.
- I would not add a universal registry or plugin abstraction above Layers and
  toolkits. The existing mechanisms are still doing the job.
- I would not unify `Permission`, `Elicitation` and `Sandbox`. They answer
  different questions: may this run, who decides, and what can it physically
  affect.
- I would not make events the command path or canonical state. They are an
  observation/delivery contract; the session state machine remains the owner.
- I would not remove legacy MCP behavior until capacity semantics are chosen in
  public, testable terms.
- I would not split the repository into many packages only to reduce visual
  size. First establish maturity and dependency boundaries; split when release
  cadence or dependency ownership actually differs.

## Bottom line

The project should be confident about the kernel and more conservative about
the ecosystem around it. The session semantics, Effect integration and type
discipline are the durable value. The large collection of batteries and
frontends is useful proof, but it should validate the kernel rather than define
an ever-growing one.

The next phase is less about inventing primitives and more about editing:
sharpening what is public, making maturity visible, consolidating behavioral
contracts, and letting two real consumers prove the next abstraction before it
gets a name.
