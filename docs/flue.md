# Flue, mapped onto an Effect-native harness

Research note, undated (pre 2026-08-27). Committed to the repository on
2026-09-01; previously a local file the plans cited as `flue.md`.


Yes. **Theoretically, an Effect-native Agent Harness could match essentially all of Flue’s expressive power—and in some dimensions exceed it—while remaining more type-safe and more deeply composable.**

The main caveat is important:

> **Flue gives you that power as a cohesive framework today. Effect Harness would give you the primitives from which that power can be constructed.**

So “same power” does not mean “same amount of code for the user” unless you also build the higher-level packages.

A rough correspondence looks like this:

| Flue capability          | Effect Harness equivalent                            |
| ------------------------ | ---------------------------------------------------- |
| dynamic agent definition | effectful context/tool/capability resolution         |
| `useTool()`              | Effect AI `Toolkit` + Layer-provided handlers        |
| `useModel()`             | `LanguageModel` Service / Layer                      |
| persistent state         | `Ref` + persistence package                          |
| durable state            | Workflow/EventLog-backed durable package             |
| sandbox                  | `Sandbox` Service + provider Layer                   |
| subagents                | scoped child `AgentSession`s                         |
| streaming                | `Stream<AgentEvent>`                                 |
| cancellation             | Fiber interruption                                   |
| concurrency              | Fibers / `Effect.all` / Semaphore                    |
| retries                  | `Schedule` / `Effect.retry`                          |
| timeouts                 | `Effect.timeout`                                     |
| approvals                | blocking Effect / Service / future interrupt package |
| dynamic instructions     | `ContextTransform`                                   |
| skills                   | skill registry + Toolkit/context transforms          |
| hooks                    | usually Effects, Services, event Streams, transforms |
| channels                 | transport adapters over sessions/events              |
| persistence              | `AgentStore`                                         |
| durability               | Effect Workflow / EventLog integration               |
| deployment               | infrastructure Layers / adapters                     |

The biggest advantage is that many things Flue must expose as **framework concepts** become ordinary **programming semantics** in Effect.

For example, Flue needs something conceptually like:

```ts
function Agent() {
  const user = useState(...)
  useModel(...)
  useTool(...)

  if (user.verified) {
    useTool(refund)
  }
}
```

An Effect-native system could express the same idea as:

```ts
const capabilities = Effect.gen(function* () {
  const user = yield* CurrentUser
  const permissions = yield* Permissions

  return permissions.canRefund(user)
    ? RefundToolkit
    : BasicToolkit
})
```

The requirements are visible in the type:

```text
Effect<
  Toolkit,
  PermissionError,
  CurrentUser | Permissions
>
```

That is where the type-safety story gets particularly strong.

## Effect gives you a capability algebra

A higher-level Flue-like agent might require:

```text
LanguageModel
| Sandbox
| Memory
| CurrentUser
| Database
| Approval
```

and fail with:

```text
ModelError
| SandboxError
| MemoryError
| DatabaseError
```

Those dependencies/errors can propagate through the type system automatically.

You don't need an agent-specific:

```ts
dependencies: [...]
```

registry.

The Effect type itself carries:

```text
Effect<Success, Error, Requirements>
```

That is a major architectural advantage.

---

## Fibers make agent trees especially compelling

Suppose an agent delegates to three subagents.

A conventional framework often needs to define:

```text
SubagentManager
TaskGroup
CancellationToken
ChildLifecycle
ConcurrencyLimit
TimeoutPolicy
```

Effect already has the underlying semantics.

```text
Parent Agent Fiber
       │
       ├── Research Tool Fiber
       │      └── Child Agent Scope
       │             └── Child Run Fiber
       │
       ├── Reviewer Tool Fiber
       │      └── Child Agent Scope
       │             └── Child Run Fiber
       │
       └── Analyst Tool Fiber
              └── Child Agent Scope
                     └── Child Run Fiber
```

Then:

```ts
Effect.all(tasks, {
  concurrency: 3
})
```

gives concurrency.

If the parent is interrupted, structured concurrency gives you a principled way for the children to be interrupted too.

If one needs a timeout:

```ts
child.pipe(
  Effect.timeout("2 minutes")
)
```

If one should retry:

```ts
child.pipe(
  Effect.retry(policy)
)
```

That's an enormous amount of “agent framework” behavior coming from Effect rather than Effect Harness.

---

## Services/Layers may be the biggest architectural win

Imagine the same coding agent:

```ts
const Coder = Agent.make(...)
```

Running locally:

```text
LanguageModel → OpenAI
Sandbox       → Local
Database      → SQLite
Memory        → InMemory
```

Tests:

```text
LanguageModel → ScriptedFake
Sandbox       → TestSandbox
Database      → InMemory
Memory        → TestMemory
```

Production:

```text
LanguageModel → Claude
Sandbox       → Daytona
Database      → Postgres
Memory        → Redis/vector store
```

The Agent does not change.

Only the Layer graph does:

```text
                Coder
                  │
            Effect Harness
                  │
        required capabilities
                  │
      ┌───────────┼────────────┐
      ▼           ▼            ▼
LanguageModel   Sandbox      Database
      ▲           ▲            ▲
      │           │            │
   Layers      Layers        Layers
```

That is harder to achieve cleanly in an agent-specific dependency system.

---

## You could reproduce Flue's dynamic-agent idea

This is one area where we should explicitly design for parity.

Flue's big idea is that the **agent's available capability set can change during execution**.

Effect Harness can absolutely support that.

You could eventually define something like:

```ts
const context = AgentContext.make({
  instructions: Effect.gen(function* () {
    const account = yield* Account
    return account.premium
      ? premiumInstructions
      : basicInstructions
  }),

  toolkit: Effect.gen(function* () {
    const auth = yield* Authorization

    return auth.admin
      ? AdminTools
      : PublicTools
  })
})
```

And resolve it at every turn:

```text
Turn begins
    ↓
Effect environment
    ↓
resolve instructions
resolve tools
resolve policies
resolve contextual data
    ↓
derive model-facing context
    ↓
model call
```

So capabilities can vary by:

* session
* user
* tenant
* auth state
* prior tool results
* persistent state
* feature flags
* environment
* current run
* current turn

Effect doesn't need Flue's hook renderer to achieve this.

---

# And it could actually be more general than Flue

Because there's no requirement that an Effect Harness agent execute only through some prescribed framework lifecycle.

An AgentSession could live inside:

```text
Effect Workflow
Effect HTTP handler
Effect RPC service
Effect Cluster entity
Durable Object
CLI
desktop app
server process
test
another agent
```

For example, an ordinary business workflow:

```ts
Effect.gen(function* () {
  const order = yield* Orders.get(id)

  const fraudResult =
    yield* FraudAgent.run(order)

  yield* Approval.request(fraudResult)

  yield* Orders.capturePayment(order)
})
```

Here the agent isn't orchestrating the application.

It's just **one effect inside a larger typed application**.

That is something I particularly like about the architecture.

---

# The type-safe tool story could be excellent

Suppose:

```ts
const GetOrder = Tool.make("getOrder", {
  parameters: Schema.Struct({
    id: OrderId
  }),
  success: Order
})
```

and its handler requires:

```text
Orders
```

Then the system knows statically:

```text
model-visible input:
{ id: OrderId }

model-visible output:
Order

runtime dependency:
Orders

possible error:
OrderError
```

You potentially preserve typing from:

```text
Schema
  ↓
Tool
  ↓
Toolkit
  ↓
handler Effect
  ↓
Layer requirements
  ↓
Agent requirements
  ↓
application
```

That's much better than:

```ts
Record<string, any>
```

tool registries.

---

# But Flue would still have one advantage

**High-level ergonomics.**

Flue can make something sophisticated feel like:

```ts
function SupportAgent() {
  useModel(...)
  useTool(...)
  usePersistentState(...)
  useSubagent(...)
  useSandbox(...)

  return "..."
}
```

That's very approachable.

Raw Effect Harness might look more like:

```text
Agent
+ Toolkit
+ Layers
+ ContextTransform
+ Services
+ Persistence
+ Sandbox
```

which is more explicit, but initially more verbose.

That's where higher-level packages—or perhaps eventually a **Flue-like convenience layer built on Effect Harness**—could help.

You could even eventually have:

```text
@effect-harness/framework
```

that provides the batteries-included experience:

```ts
const SupportAgent = Agent.define({
  instructions: ...,
  model: ...,
  tools: ...,
  memory: ...,
  persistence: ...,
  sandbox: ...,
  skills: ...
})
```

while compiling down to the same smaller primitives.

So you'd get:

```text
             High-level Effect Agent Framework
                       ↓
                Effect Harness
                       ↓
                  Effect AI
                       ↓
                    Effect
```

Users who want convenience use the top.

Library/framework authors use the middle.

---

# There are a few places Effect could exceed Flue conceptually

**Typed dependency requirements.**

Flue can validate config and TypeScript APIs, but Effect can propagate runtime capability requirements through `R`.

**Typed failures.**

Agent infrastructure can distinguish expected failure, defect, and interruption rather than funneling everything into thrown exceptions.

**Structured concurrency.**

Fiber trees give very strong semantics for subagents, tools and nested work.

**Resource safety.**

A sandbox, browser, temporary workspace or remote process can be scoped:

```ts
Effect.acquireRelease(...)
```

and automatically cleaned up.

**Testing.**

Swap entire production Layer graphs for deterministic test implementations.

**Distributed systems.**

Effect Cluster/Workflow/RPC/Persistence/EventLog give a plausible path from:

```text
embedded AgentSession
```

all the way to:

```text
distributed durable agent runtime
```

without changing programming universes.

---

# The architectural ceiling is extremely high

You can picture the eventual stack:

```text
┌──────────────────────────────────────────┐
│ High-level agent frameworks              │
│                                          │
│ coding / support / research / commerce  │
└────────────────────┬─────────────────────┘
                     │
        ┌────────────┴─────────────┐
        │                          │
   Skills / Memory            Sandbox / Coding
   Compaction / Evals         AG-UI / Channels
        │                          │
        └────────────┬─────────────┘
                     │
              Effect Harness
                     │
        ┌────────────┴─────────────┐
        │                          │
    Effect AI                 Effect runtime
        │                          │
 LanguageModel                Fibers
 Toolkit                      Services
 Prompt                       Layers
 Schema                       Scope
                              Stream
                              Schedule
                              RPC
                              Workflow
                              Persistence
                              Cluster
```

So yes: **theoretically it can have the full expressive power of Flue while also inheriting Effect's much larger computational model.**

The thing I'd protect fiercely is this:

> Don't achieve Flue parity by copying every Flue feature into the harness.

Instead:

> **Use Effect to make most Flue features emerge from composition, and only add abstractions where genuine agent-specific semantics remain.**

If you succeed at that, you don't end up with “Flue, but Effect.”

You end up with something closer to **an Effect-native substrate on which a Flue-class framework is just one possible library**.
