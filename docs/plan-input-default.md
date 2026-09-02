# Plan: every agent has an input, and the prompt is the default

**Status: specified 2026-09-02, not started.** Sequenced after the session and
process management work (`remaining-work.md` 26l, 26n, 26p) lands, because it
touches the same signatures those tracks are extending. Tracked as item 46.

Written from the review that closed typed input phase 2 and issue #81, which
found that every awkwardness the work hit had one cause, and from the design
pass recorded in this session (`status-history.md`, 2026-09-02).

---

## 1. The cause

`AgentDefinition` spells "this agent takes a prompt" as `Input = never`, and
`AgentSession.PromptInput<Input>` turns that back into `Prompt.RawInput` with
a conditional type:

```ts
export type PromptInput<Input> = [Input] extends [never] ? Prompt.RawInput : Input
```

`never` is the bottom type and `Input` is invariant (`in out`, deliberately,
so a typed agent cannot be handed to something that will send it raw text).
The two together mean nothing generic over `Input` can unify with the untyped
case, which is why:

- `Agent.InputOf` needs a guard against `never`, and phase 1's compile-time
  assertions were vacuous until the guard was added;
- `src/internal/inputBoundary.ts` holds one internal widening, and its
  `admit` has four branches (prompt to typed, typed to prompt, and the two
  that fit) where a decode would do;
- the wire carries two shapes, `PromptWire.Prompt` and the tagged
  `AgentInput.Typed`, and every adapter passes the union through;
- ninety-seven signatures in `src/` carry `Value, Input` parameters, most of
  them only to thread the special case.

The design itself -- value plus rendering declared on the agent, the host
decoding with the session's schema, the value on the fibre and only the
rendering in history -- is right, and `effect-agent.com` arrived at the same
shape independently. This plan removes the encoding, not the design.

## 2. The decision

**Every agent has an input. The default is the prompt.**

- `AgentInput.prompt: AgentInput<Prompt.RawInput, PromptWire, never, never>`:
  the schema is the prompt wire codec that already exists
  (`Schema.toCodecJson(PromptWire.Prompt)` is used at every boundary today),
  the render is `Prompt.make`. The identity, in the shape the system already
  speaks.
- `AgentDefinition<Tools, E, R, Model, Value, Input = Prompt.RawInput>`, and
  `Agent.make` fills `input` with `AgentInput.prompt` when the field is
  absent. `definition.input` becomes `AgentInput<Input, any, E, R>`, never
  `Option`.
- `PromptInput<Input>` is deleted. `prompt`, `submit`, `Agent.run`,
  `Subagent`, `Scheduling`, `DurableAgent` and the client take `Input`.
  `InputOf` is a plain extraction.

**One rule for the wire.** The wire carries the session's encoded input; the
host decodes with the session's schema. For an untyped agent the encoded
input *is* today's prompt wire, byte for byte, so no external client changes.
`AgentInput.Typed` and its `_tag` are deleted; `AgentProtocol.Input` is
`Schema.Unknown` decoded at the host, not a union decoded at the router. The
two "wrong kind" refusals in `admit` go away because there is no second kind;
a value the schema rejects is still `AgentInvalidRequestError` (400).

**The fibre reference always holds the encoded input.** `AgentInput.Current`
is set around every submission, for an untyped agent to the encoded prompt. A
tool that asks `AgentInput.current(Ticket)` on an agent that declares
`AgentInput.prompt` gets the schema's own error, which is the honest answer
and the same one it gets today when wired into the wrong typed agent.
`None` now means exactly "not inside a submission".

**Output second, the same way.** `Value = never` for an agent without
`AgentOutput` is the identical pattern on the other side (twenty-one
signatures; `Result.value: Option`, `settle` filling `Option.none()`). A
default `AgentOutput.text` -- schema `Schema.String`, value the final text --
gives every agent a `Result.value`, lets `RemoteResult` and `Outcome` carry
it uniformly (finishing item 35 as a consequence rather than a separate
mechanism), and deletes the second conditional. It is step 5 below, after
input has proved the shape, and it is the only step that may be dropped
without undoing the rest.

## 3. What stays exactly as it is

- History holds only the rendering. The value never enters the transcript,
  the export, or the model's context.
- The value reaches tools, permission policies and context transforms
  through `AgentInput.Current`, the encoded form, decoded on request.
- `Input` stays `in out`. A function that accepts any agent is generic in
  `Input`; a function that wants a prompt-taking agent names
  `Prompt.RawInput`; nothing else typechecks, which is the point.
- Durable claims and payloads keep `prompt` so every journal written so far
  decodes, and always carry `input` from now on. Replay re-renders from
  `input`; an Effect-valued `render` is already an activity. `Prompt.make`
  is pure, so the untyped path is trivially deterministic.
- `Agent.make` grows no type parameter. It loses none either; the defaults
  are what change.

## 4. Sequence

Each step compiles, tests green, and is committed on its own. Reviewed after
committing per `CLAUDE.md`.

1. **Assertions first.** Before any signature moves, `test/AgentInput.test.ts`
   and `examples/typed-agent.ts` pin, at the type level: `InputOf<Support>` is
   the ticket type; `InputOf<Untyped>` is `Prompt.RawInput`; a string is
   refused for `Support`; a ticket is refused for `Untyped`; a typed agent is
   refused where `AgentDefinition<..., Prompt.RawInput>` is named. Each
   written so that `never` and `any` both fail it (the phase 1 lesson: an
   `infer` through an invariant parameter silently yields `never`). Broken
   once each.
2. **`AgentInput.prompt`, and the default.** Add the value; make
   `Agent.make` fill it; change the default parameter; delete `PromptInput`.
   Fix what breaks, which is the ninety-seven sites, almost all by deleting a
   conditional or a `never`. `AgentSession` sets `Current` on every
   submission. The `test/AgentInput.test.ts` case "`None` under an agent
   without an input" becomes "the encoded prompt under an agent without a
   declared input".
3. **One wire shape.** Delete `AgentInput.Typed`; `AgentProtocol.Input`
   becomes the unknown the host decodes; `inputBoundary.admit` becomes a
   decode with the declared schema plus the error mapping. The HTTP, RPC,
   AG-UI, A2A, MCP, OpenAI and Slack adapters lose their union handling.
   `AgentClient.typed` stays as the ergonomic entry (it encodes with the
   agent's schema) but is no longer a separate code path: the untyped client
   is `typed(agent)` for an agent whose input is the prompt. Pin that the
   bytes an untyped client sends are unchanged from `HEAD~` with a recorded
   fixture.
4. **Journals.** `DurableSubmission.Payload.input` and `Claim.input` become
   required for new writes and optional on read; `Scheduling`'s persisted
   job carries the encoded input; the cluster entity and the Cloudflare
   alarm dispatcher follow. A journal written before this plan still
   decodes and replays (pin with a fixture captured from `HEAD~`).
5. **Output.** `AgentOutput.text` as the default `Value`; `Result.value`
   always `Some`; `RemoteResult` and `Outcome` gain an opaque encoded
   `value` decoded at the edge with the agent's output schema, the way
   `AgentA2A.typed` already does it (item 35's decided design). Delete the
   `Value = never` conditionals.
6. **Docs.** `docs/guide-sessions.md` "Typed input and output" rewritten
   around the one rule; `plan-effect-agent-comparison.md` §3.4 and
   `plan-structured-output.md` get a pointer here; `STATUS.md` one line;
   `MODULES.md` if entry points changed (they should not).

## 5. Acceptance

- `grep -rn 'PromptInput\|Input = never\|AgentInput.Typed' src test examples`
  finds nothing.
- The count of signatures carrying an explicit `Input` parameter falls; the
  remaining ones are the ones genuinely generic over it.
- `examples/typed-agent.ts` and `examples/getting-started.ts` keep their
  zero-cast, zero-annotation property, and the getting-started example's
  text does not change at all -- an untyped agent must read exactly as it
  did.
- A recorded HTTP request body from an untyped client before the change is
  byte-identical to one after.
- A durable journal recorded before the change replays to identical history
  after it.
- The full suite, `lint`, `lint:portability`, `verify:package` green.

## 6. Deliberately not this plan

- **Naming the schema on the wire.** One endpoint serving several shapes
  needs a registry and a second source of truth for what a session accepts.
  Not needed while an agent has one input.
- **A per-prompt input schema.** The instructions and the shape are written
  together; `AgentOutput` is on the agent for the same reason.
- **Rendering at the client.** The renderer may need services the client
  lacks, and the value would travel separately for tools anyway.
- **The value in history as a structured part.** That is the leak the split
  exists to prevent.
- **A default render for a typed schema** (e.g. JSON of the value). A typed
  input must say what the model sees; the default exists only for the
  prompt, where the answer is obvious.

## Related

- [plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md) §3.4
  -- typed input, phases 1 and 2.
- [plan-structured-output.md](./plan-structured-output.md) -- `AgentOutput`,
  and the "value is local to the session" boundary step 5 removes.
- `remaining-work.md` items 35 (typed output across boundaries; finished by
  step 5), 41 and 41b (typed input; the work this plan simplifies).
