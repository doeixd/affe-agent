# Recorded wire and journal fixtures

A file here is bytes recorded from a named commit, read by a named test, so
that a change to what crosses a wire or sits in a journal is *measured*
against what it was rather than believed to be compatible. **A change to a
fixture is a wire or journal change and is reviewed as one.** Each fixture is
also pinned by a `verify: exists` line in `docs/remaining-work.md`, so a
fixture that goes missing fails the build rather than the test that reads it
going quiet.

| fixture | recorded from | read by | what it holds |
| --- | --- | --- | --- |
| `prompt-request.json` | `4ee770d` | `test/InputWire.test.ts` | `AgentProtocol.PromptRequest` for a text prompt and a multimodal one, encoded as every adapter encodes it, before the input wire became one shape (`plan-input-default.md` step 3). Asserted byte-identical after. |
| `compaction-checkpoint.json` | `d6e4a69` | `test/ContextRollover.test.ts` | A persisted `Compaction.Checkpoint` (a summary, with token measurements and usage) encoded by the store's own codec, before `Checkpoint` became a union of `Summary` and `Rollover` (item 60d). Asserted to decode as a `Summary` and to round-trip byte-identical. |
| `namespace-manifest.json` | `2d28f96` | `test/Namespace.test.ts` | Every wire-level and storage-level identifier the package minted -- `_tag`s, service keys, brands, table defaults, the persisted key prefix -- recorded from the literals *before* they moved to `src/internal/namespace.ts` (decision 1 of `plan-two-decisions.md`). Asserted equal to the set the code builds now, both ways. A new entry is a new wire or storage name; a missing one is a rename. |
| `namespace-manifest.json` (2026-09-06 additions) | `2006e32` | `test/Namespace.test.ts` | Three entries added by item 47c: `affe_history` (the value the host always used, now built from the root and so frozen), `affe_dispatch` (new: the dispatch-intent table), and the intents service key. |
| `error-tags-manifest.json` | `758ac4e` | `test/Namespace.test.ts` | Every bare `_tag` a `Schema.TaggedError` in `src` carries, recorded once from the definitions (decision 3 of `plan-two-decisions.md`, item 61). Asserted equal to what the code defines, both ways, with no tag shared. A new entry is a new error; a missing one is a rename. |
| `prompt-response.json` | `baf0897` | `test/InputWire.test.ts` | `AgentProtocol.PromptResponse` for an untyped agent, before every agent had a `Value` (step 5). Asserted equal to the response after, plus exactly one field, `value`. |
| `run-completed.json` | `d6778b3` | `test/Exhaustion.test.ts` | Two `RunCompleted` envelopes as the wire carries them: one from a custom policy that stopped without exhausting anything -- the shape every `RunCompleted` had before `exhaustion` existed -- and one from a `maxTurns` ceiling, which now classifies itself. Asserted that the older shape still decodes and reports no exhaustion, and that the newer one differs by exactly that one field. |
| `snapshot-unversioned.json` | `8bd14c3`, measuring `4acc464` | `test/BehaviorFixtures.test.ts` | An `AgentSession.Snapshot` as written before `version` existed. Asserted to decode as version 1, and that a snapshot written now is it plus exactly `version: 1`. |
| `code-mode-outcomes.json` | the same, measuring `a35673a` | `test/BehaviorFixtures.test.ts` | Code Mode results with the three per-call outcomes that existed before, and with the two added for an interrupted program (`uncertain`, `not-started`). Both asserted to decode. |
| `compaction-checkpoint-discarded.json` | the same, measuring `0b289f9` | `test/BehaviorFixtures.test.ts` | The `CompactionCheckpointDiscarded` event a consumer receives when a stored checkpoint does not decode. |
| `tool-activity-names.json` | the same, measuring `1a770eb` | `test/BehaviorFixtures.test.ts` | The journal activity names of one non-idempotent call: its start marker and the call. A change is a journal change: recorded runs look for these names. |
| `memory-recall-truncated.json` | the same, measuring `3783b93` | `test/BehaviorFixtures.test.ts` | The system message the model reads when `Memory.recall` was cut at its limit. |
| `control-tool-digests.json` | the same (item 107) | `test/ControlToolContracts.test.ts` | The contract digest of each built-in control tool (`new_context`, `search_context`, `read_context`, `context_remaining`, `discover_tools`). A change makes recorded runs that used the tool unreplayable unless the tool declares the old digest compatible (`ToolContracts.CompatibleWith`); an Effect upgrade that changes generated JSON Schema moves these too. |

To record one: write a throwaway test that runs the real path (a client, an
adapter, a store) at the commit *before* the change, encode with the same
codec the production path uses (`Schema.toCodecJson(...)` for the wire), write
the JSON here, and delete the test. Then write the permanent test that reads
the file, and say in its doc which commit and which change. A fixture that
asserts identity is the strongest kind; one that asserts "identical plus this
one difference" is the honest kind when the change was the point.

## The trailer

A commit that touches this directory must carry a `Behavior-Change:` trailer:
one sentence saying what changed for a caller, in the caller's terms.
`npm run verify:behavior-change` (in `check`) fails the build naming any
fixture-touching commit since `1c6b2bd` without one, and reports any commit
carrying the trailer that touched no fixture -- a behaviour change that
measured nothing has not been recorded. The rule applies from the commit the
convention landed in; earlier fixture commits predate it. A shallow clone
that cannot see the baseline fails the check rather than passing it.

```
Behavior-Change: an untyped agent's result now carries its text as `value`; the request bytes are unchanged.
```

The trailers are also what `CHANGELOG.md` publishes: `npm run
changelog:behavior-changes` regenerates the behaviour-changes block under
`## [Unreleased]` from every trailer since the last release tag, naming the
commit and the fixture that measured it, and `npm run verify:changelog` (in
`check`) fails when that block is out of date.
