# Plan — automatic model routing (`AutoModel`)

Status: **proposal, not started.** Gated on a second caller (see "Gate"). This
plan weighs the options and records the recommendation; it does not commit to
building.

Written 2026-09-23, from the `danieljvdm/effect-agent` subagent surface, whose
`AutoModel` "selects from each new child's delegated task automatically" with
"a shared selection store [that] retains the child's choice for follow-ups;
sibling threads select independently."

## The problem

Choosing a model is a wiring-time decision here. An agent names no model
(`README.md`, "The mental model"); the application supplies one as a `Layer`
where the agent runs. That is right, and it means the choice is made once, for
a whole run or a whole child:

- `Subagent.tool(name, child, { provide })` fixes the child's model at the
  delegation. A "cheap model for research, strong model for edits" needs two
  delegation tools.
- The workbench fixes a model per *conversation* (`modelProfile`, pinned on
  the record; `decisions-2026-09-11.md` D6) and resolves a revision on it.

What neither does is choose a model *from the work*. The snippet's idea is a
router that reads a new child's delegated task, picks a model for it, and
remembers the choice so follow-ups to that child keep it — with siblings
choosing independently.

## What already exists, and why it is not this

- **`/model`** is *metadata*: context window, max output, modalities, cost per
  million with `cacheRead`/`cacheWrite` priced apart, plus `preflight`. It
  describes a model; it does not choose one.
- **`ExecutionPlan`** is fallback and retry *ladders* over providers, and it
  discharges `LanguageModel` from the agent's requirements. It handles "the
  provider failed"; it does not handle "which provider is right for this
  task".
- **The workbench's `AgentResolver` + `Catalog`** bind a model *profile* to an
  agent *revision*, per conversation. That is a product-level, per-thread
  choice, not a per-request one.

None of these reads the request to choose.

## Options

### A. Do nothing (the current gate)

The workbench covers per-conversation pinning; a delegation can name its
model at `provide`. No caller has yet asked for a model chosen from the
content of a request.

### B. A routing `LanguageModel` layer (recommended)

A battery that *is* a `LanguageModel.LanguageModel`: it holds N already-built
model layers, a pure `choose` function from the request to one of them, and a
selection store. The README already names this shape — "a routing layer" — as
something an agent can run against, and `ExecutionPlan` proves the seam is
composable.

```ts
const routed = ModelRouter.layer({
  models: { cheap: cheapLayer, strong: strongLayer },
  // Pure, from the request alone. Not a model call: see "Determinism".
  choose: (request) => request.prompt.content.length > 20_000 ? "strong" : "cheap",
  store: ModelSelection.memoryStore     // or SQL
})

const research = Subagent.tool("research", Researcher, {
  description: "…",
  provide: routed
})
```

Why this shape over the alternatives:

- **It is one seam, not a subagent feature.** Any agent — a lead, a child, a
  coding agent with a cheap search tool — runs on it. Selection is a property
  of the *model*, not of delegation.
- **The store is where "retains the child's choice for follow-ups" lives.**
  Keyed by session id: a follow-up is the same session, so it reads its
  recorded choice; two siblings are different sessions, so they choose
  independently. That is the whole of the snippet's store semantics, and it
  needs no new kernel noun.
- **`Subagent.tool` needs no change.** `provide` already takes any
  `Layer<LanguageModel>`, so the router drops in without touching
  `Subagent`.

### C. A `model` option on `Subagent.tool`

`Subagent.tool(name, child, { model: AutoModel({ … }) })`. Narrower, but it
duplicates B's machinery and couples a general concern to delegation, which
is the opposite of the seam discipline (`ROADMAP.md`: a package adds a
capability, never a parallel execution model). Rejected.

## The decision this plan is really about: determinism

A router that *reads the request to choose* has to answer a durability
question before it has an API. Two ways:

1. **A pure `choose` function.** The choice is a function of the request, so
   a replay computes the same answer with no journal. This is the only form
   that is free of a new durable write, and it is the recommendation.
2. **A model-classified choice.** "Ask a small model which model to use" is a
   model call. Under `/durable` it must be journaled, or the replay picks a
   different model and the run diverges — the same class of bug the budget
   occurrence key fixed (`conformance-matrix.md` footnote 1). If a caller
   ever needs this, the classification is a run input and belongs in the
   journal, not in a `Layer`'s closure.

The plan recommends (1) first, and refuses to hide (2) behind a default.

## Gate

A second caller. Today there is one (the workbench's per-conversation
pinning is adjacent but not this). A coding agent whose search tool wants a
cheap model while its editor wants a strong one would be the second; so would
a lead that routes a "summarise" delegation to a small model and a "review
this diff" delegation to a large one. Until then this stays a plan.

## Acceptance, when built

- Two delegations in one parent run, with different tasks, select different
  models by a pure `choose`.
- A follow-up to one child keeps that child's model (same session, same
  selection).
- Two siblings select independently (different sessions, different records).
- Under `/durable`, a replay selects the same model with no extra journal
  entry (form 1), or from the recorded classification (form 2, if ever).
- A model the router does not offer is refused by name, as the workbench's
  route refuses an unbound profile.
