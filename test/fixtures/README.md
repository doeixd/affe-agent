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
| `error-tags-manifest.json` | `758ac4e` | `test/Namespace.test.ts` | Every bare `_tag` a `Schema.TaggedError` in `src` carries, recorded once from the definitions (decision 3 of `plan-two-decisions.md`, item 61). Asserted equal to what the code defines, both ways, with no tag shared. A new entry is a new error; a missing one is a rename. |
| `prompt-response.json` | `baf0897` | `test/InputWire.test.ts` | `AgentProtocol.PromptResponse` for an untyped agent, before every agent had a `Value` (step 5). Asserted equal to the response after, plus exactly one field, `value`. |

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
