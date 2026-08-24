# Plan: snapshotting and export

Fourth in the series, after [plan-opencode-tools-port.md](./plan-opencode-tools-port.md),
[plan-pi-toolkit.md](./plan-pi-toolkit.md) and
[plan-session-tree.md](./plan-session-tree.md).

Sources read directly: Pi's session storage
(`packages/agent/src/harness/session/jsonl/`) at commit
`dcd461925db2edf69a43c8135db1180d418afd54`; our `AgentSession.Snapshot`,
`DurableSessionStore`, `TestLanguageModel`, `/evals`.

## The distinction this plan rests on

**`Snapshot` and "export" are different things, and conflating them would spoil
both.**

`AgentSession.Snapshot` is `{ sessionId, history }`, and its docstring is
emphatic about why: *"Deliberately only the conversation."* It is the **restore
contract** — the minimum needed to rebuild a live session in a process that
already knows which agent, model and tools are involved. It is right as it is,
and nothing here proposes changing it.

**Export is the other problem**: a transcript that *leaves* the process, to be
read by a different build, a different machine, a person, or a test six months
later. That artefact has to be self-describing, and `{ sessionId, history }`
is not. Bolting provenance onto `Snapshot` would tax every restore with data
restore does not need; the answer is an envelope that *contains* a snapshot.

Pi separates these the same way: entries are the log, and a **header line**
carries `version`, `id`, `createdAt`, `cwd`, `parentSessionId` and `metadata`.

## Suggestions

### 1. A versioned, self-describing envelope

Pi's header is at `version: 4` — they have migrated three times, and their
decoder rejects a version it does not know (*"has unsupported session
version"*) rather than failing later on a missing field. An export format
without a version is a format that can only ever be written once.

```
Export = {
  version: number
  exportedAt: number
  session: Snapshot                 // unchanged, embedded
  provenance: {
    harnessVersion: string
    agent?: { name?, instructionsHash? }
    model?: { provider, modelId }
    tools?: ReadonlyArray<string>   // names only
    cwd?: string
    parent?: { sessionId, nodeId? } // lineage, as Pi carries parentSessionId
  }
}
```

Schema-defined like everything else, so it decodes with real errors.

### 2. Provenance answers a question types cannot

The session-tree research found that a snapshot is not bound to the agent that
produced it, and that types cannot fix it — `Snapshot` is Schema-defined so it
can be serialised, and a phantom parameter does not survive a database.
Provenance is the runtime half of that answer: recording the tool names and
model means an import can **warn** that a transcript referencing `edit_file` is
being restored into an agent that has no such tool. Not a type error, but far
better than a confusing failure three turns later.

### 3. Redaction, because export is when secrets leave

One note before the substance: `/observability` already owns a redaction policy,
and `Redacted` is imported exactly once in the whole repository
([audit-effect-ecosystem.md](./audit-effect-ecosystem.md) E13). Export is the
second place secrets leave, so this plan and that package should share one
vocabulary rather than each grow a `redact` hook. A value that arrived as
`Redacted` should still be `Redacted` when an exporter meets it — that is the
cheapest version of this feature, because it fails closed by default.

The suggestion most likely to be skipped and most likely to be regretted. A
transcript contains tool results: file contents, environment output, command
output. Inside the process that is fine. **Export is the moment it stops being
fine** — a transcript pasted into a bug report is a transcript published.

An export takes an optional message transform, and the default is documented as
*no redaction* so the choice is visible rather than assumed:

```ts
Export.of(snapshot, { redact: Redact.toolResults(pattern) })
```

The library should ship the mechanism and one or two obvious matchers, not a
secret scanner — pretending to detect all secrets is worse than being clear
that it detects none.

### 4. One mechanism serves export and the tree's delta storage

The insight worth acting on. `History.commit` appends whole turns, so a session
is naturally **an append-only log of commits**. That single representation
gives:

- **Export**: JSONL, crash-safe, streamable, and listable by reading the first
  line — Pi's `metadataFromHeader` exists precisely so a session picker need not
  parse whole files.
- **The tree's T5 delta storage**: a node records what it appended to its
  parent, materialised by walking to the root. The session-tree plan wants this
  to remove quadratic write amplification.

These are the same log seen from two directions. Building the commit log once,
and deriving both, is much better than building a bespoke export writer and a
bespoke node store that happen to hold the same bytes.

**Two ecosystem checks before writing it**
([audit-effect-ecosystem.md](./audit-effect-ecosystem.md)):

- The commit log is a third hand-rolled log, after `DeliveryLog` and whatever
  T5 stores. `effect/unstable/eventlog` is being evaluated in
  [plan-durability-hardening.md](./plan-durability-hardening.md) H4b (audit E2);
  this plan should consume that verdict rather than run its own. If the answer
  is that `eventlog` fits, "build the commit log once" gets cheaper still. If it
  is no, the reason recorded there is also this plan's reason.
- A delta is a diff, and `JsonPatch` / `JsonPointer` exist (audit, Group 3).
  Worth a look for the tree's delta representation and for `/ag-ui`'s
  incremental state sync — but only if the diff is genuinely structural.
  `History.commit` appends whole turns, so the delta is usually an *append*, and
  an append expressed as a patch is a worse append. Recommend: use them for
  divergence *rendering* (§6, and the tree's T4 "what differs between these
  branches"), not for storage. Noted here so it is not rediscovered as a
  brilliant idea later.

### 5. Export as a replayable fixture (highest value, existing parts)

`TestLanguageModel.script` takes `ReadonlyArray<Turn>` where a `Turn` is
`{ text }` or `{ toolCalls }` — which is exactly what the assistant messages in
a transcript are. So an export can be mechanically turned into a deterministic
replay:

```ts
const turns = Replay.turnsOf(export_)      // assistant messages -> Turn[]
const { layer } = yield* TestLanguageModel.script(turns)
```

What that buys is out of proportion to its cost:

- **A real session becomes a regression test.** Reproduce a bug by exporting
  the session that hit it and committing the file.
- **`/evals` gets real fixtures** instead of hand-written scripts.
- **Model-free CI.** Replays cost nothing and cannot flake.

This is the piece to build first, because it makes the export format immediately
useful to us rather than only to users.

### 6. Export what the tree branches, not only single sessions

Once the tree exists, the useful units are a **branch path** (root to a node —
one conversation) and a **subtree** (a node and everything below it — an
exploration). Both are derivable from parent pointers, and both should be
expressible without exporting a whole tree, which is the thing nobody wants to
paste anywhere.

### 7. A gap our own tools introduced

`bash` now writes truncated output to `.effect-agent/tool-output/` and names the
path in the transcript. **An export carries the reference and not the file**, so
a restored transcript points at something that does not exist. Options, in
order of preference: leave it (the reference is honest, and the message says it
was truncated), let the exporter optionally inline referenced files, or make the
path relative and export the directory alongside. Worth deciding rather than
discovering.

### 8. Determinism, so exports diff

If exports are to be committed as fixtures, two exports of the same session must
be byte-identical: stable key order, no wall-clock in the payload beyond the
recorded timestamps, no ids that change per run. Otherwise every fixture update
is an unreadable diff.

### 9. One conformance suite

`test/DeliveryLogContract.ts` and `test/AgentClientContract.ts` are the existing
pattern: write the suite once against the interface, run it against every
implementation. It should cover the codec (round-trip, version rejection,
truncated file, unknown fields) and any store, so JSONL and SQL cannot drift.

## Invariants

**IE1 — Round-trip fidelity.** Decoding an export and restoring it yields the
same canonical history, byte for byte. (`test/Snapshot.test.ts` already proves
this for `Snapshot` itself; the envelope inherits the obligation.)

**IE2 — A version is always present, and an unknown one is refused.** An export
from a newer build fails with a message naming both versions, never by
misreading a field.

**IE3 — Redaction is total where applied.** A redacted export contains no
occurrence of the redacted content anywhere — including inside tool results and
truncation banners, which is exactly where a naive implementation misses it.

**IE4 — Export never mutates.** Producing an export leaves the session and its
history untouched, and works on an idle session only, inheriting `snapshot`'s
rule.

## Milestones

- **E1 — The envelope.** Schema, version, provenance, encode/decode, conformance
  suite. IE1, IE2.
- **E2 — Replay.** `Replay.turnsOf(export)` plus an example turning a session
  into a `TestLanguageModel` script; wire one real transcript into `/evals` as
  a fixture. IE4.
- **E3 — Redaction.** The transform hook, two matchers, and IE3's test.
- **E4 — The commit log.** Append-only JSONL writer/reader with a header, shared
  with the session tree's T5 node store; a session picker that reads only
  headers.
- **E5 — Tree-aware export.** Branch path and subtree selection, `parent` in
  provenance.

## Progress

**E1 and E2: landed (2026-08-24).** `@doeixd/effect-agent/export`, 15 tests.
IE1, IE2 and IE4 hold; each was broken once to confirm its test bites.

**The distinction this plan rests on survived contact.** `Export` embeds
`AgentSession.Snapshot` unchanged, so restoring from an export *is* restoring
from a snapshot -- there is a test that does exactly that, because it is the
claim that makes the envelope additive rather than a second format.

**Version before payload, and this is the whole reason a version exists.**
Decoding first reports a newer file as a missing field, which sends the reader
hunting for a bug in their data instead of telling them to upgrade. There is a
test with a newer file that is *also* structurally wrong for this build; it
must fail as `unsupported-version`.

**Determinism came from sorting keys, not from hoping.** Two exports of one
snapshot are byte-identical, which is what lets an export be committed as a
fixture without every update being an unreadable diff. `exportedAt` reads the
`Clock`, so a test can fix it.

**Open question settled: `cwd` is opt-in.** Pi records it unconditionally. An
absolute path routinely carries a username, and the first thing anyone does
with an export is paste it into a bug report -- so absent by default, and there
is a test that the string does not appear.

**Open question settled: where it lives.** Its own subpath, next to `/tree`.
It has the two consumers the scope rule wants -- fixtures, and eventually the
tree's storage -- and putting it beside `/evals` would have made the format
look like test infrastructure rather than a thing users can rely on.

**Replay reproduces the model, not the world, and says so.** Tool *results* are
not scripted: they came from handlers that ran against a real filesystem and
shell, and playing a recorded result back would quietly turn a test of the
agent into a test of nothing. The tools run again against whatever the test
provides, and the difference between those answers and the recorded ones is
frequently the bug being chased.

`Replay.toolsUsed` reads the conversation rather than provenance, deliberately:
provenance says what the agent *had*, this says what the transcript actually
*used*, and when they disagree the second decides whether a replay can run.

**Not yet done:** E3 (redaction), E4 (the commit log), E5 (tree-aware export).
Note that E4's premise has shifted -- T5 landed a `NodeStore` over
`KeyValueStore` with whole snapshots, so the shared append-only log is now a
change to one module rather than a new one. Suggestion 7 (`bash` output files
referenced but not carried) is still undecided.

## Risks and open questions

- **Format gravity.** An export format is a promise. E1 should ship the smallest
  envelope that is honest, and E2 should prove it is useful before E4 makes it
  a storage format as well.
- **Provenance is advisory.** Recording tool names does not stop a mismatched
  import; it only explains one. Do not let it look like a guarantee.
- **Open: is `cwd` provenance or a leak?** Pi records it. An absolute path can
  itself be sensitive (usernames), so it may belong behind redaction rather than
  in the header by default.
- **Open: does export belong in the core package or beside `/evals`?** It has
  two consumers already (fixtures, and the tree's storage), which clears the
  scope rule — but where it lives is a packaging decision worth making once.
