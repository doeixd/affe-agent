# Remaining work

Rewritten 2026-08-29 from an audit of every plan in `/docs` against what ships
at `b554458` (four read-only passes: kernel/durability plans, transport/server
plans, tools/toolkit plans, and the progress files themselves). This is the
live list; `STATUS.md` is what is true now, `docs/status-history.md` the
chronology, and `ROADMAP.md` the capability view.

**An entry that makes a claim about the code carries the check that falsifies
it** (`plan-seams.md` F, 2026-09-04), as a `verify:` line in a fenced block:
`grep "literal" path`, `no-grep "literal" path`, `exists path`, `absent path`.
`npm run verify:remaining-work` runs every one and `npm run check` includes
it, so a claim that has gone stale -- open work that landed, done work that
was undone -- fails the build until the text is fixed. This file misdirected
twice in one day before that existed. Fix the text, not the check.

State of play, re-measured 2026-09-03: every issue through #80 is closed, #4
(the roadmap tracker) last, on 2026-08-30. `npm test` is green at **2071 tests
in 189 files** (1820 in 168 on 2026-09-01; 1466 in 131 when this was written),
zero Effect diagnostics, portability and the workerd bundle pass, and
`npm run verify:durability` shows D1–D7 biting (D4b survives by construction).

Two things that number hides, both worth knowing before trusting a red run:

- ~~The suite is flaky under process pressure on Windows.~~ **Diagnosed
  2026-09-01: the suite assumes it owns the machine.** Nine consecutive solo
  runs passed; two run concurrently both failed (6 and 8 files, one losing two
  files entirely to a worker that died before reporting). `0xC0000142` is
  machine-global handle exhaustion, and `CLAUDE.md` says other agents work here
  at the same time, so two concurrent runs are normal rather than misuse.
  `vitest.config.ts` caps `maxWorkers` at 8: about 29% slower solo, and two
  concurrent suites drop to one failure each. Eleven files spawn real processes
  (~247 tests), not the four previously named. Two residual load-sensitive
  tests were **not** fixed by this and wanted their own entries.
  `DurableStreams`' "linear, not quadratic" is **fixed 2026-09-03**
  (`ffd8b69`): it folded one log and asserted a wall-clock threshold, which is
  a claim about the machine rather than the algorithm, and it now folds n and
  2n and compares them, because load is exactly what a ratio cancels. The
  bound and the size are both measured -- at half the size the same regression
  hides inside a fold dominated by parsing, which an earlier draft discovered
  by passing with the bug restored. `ClusterMultiNode` remains, and **the fix recorded for
  it does not work.** H7 said move it to `TestClock`; it cannot go. It drives
  a real two-node cluster -- HTTP runners, liveness pings, shared SQL storage
  -- and the durable suites already run `it.live` because the engine's timers
  do not advance under a test clock. Nor is it sleeping on fixed durations:
  it already polls on conditions every 10ms, which is the pattern one would
  migrate *to*.

  Its load sensitivity is inherent rather than a defect. The cluster's windows
  are real timeouts, so a node starved for longer than `shardLockExpiration`
  genuinely loses its shards and the scenario under test becomes a different
  one. The honest options are to widen those windows in the fixture, trading
  duration for headroom, or to accept that this one wants a quiet machine.
  Neither is `TestClock`, and nobody should spend a session discovering that
  again.

  ```text
  verify: grep "it.live" test/ClusterMultiNode.test.ts
  ```
- ~~The count includes work that is not committed.~~ No longer true as of
  2026-09-01: item 27's working-tree changes were committed as `be75b83`.

**Closed entries live in [remaining-work-closed.md](./remaining-work-closed.md)**
(2026-09-05, `plan-after-seams.md` 2.8), verbatim and still checked, so this
file is the list of what is open and nothing else. A struck heading here
means an entry closed since the split and not yet moved; move it. Item
numbers are stable across the two files and are never reused, so a plan
that cites "item 41" and finds no 41 here will find it in the ledger.

Audit 2026-09-08: the product plans and omitted integration tails are now
tracked below. Historical closed sections moved to the ledger. The recorded
owner decision permits continued feature work.

## Ranked

Grouped by dependencies, implementation and usage evidence. Each row says why
it is still open, so the next pass does not have to re-derive it.

### Larger, correctly parked

19. **Real workerd / Durable Object host** — the core landed 2026-08-30:
    `apps/worker` is a real host (one DO per session, `/http` over
    `HttpRouter.toWebHandler`, history persisted to DO SQLite per completed
    submission, events journaled to the `DeliveryLog`, `events?after=N`
    gapless across the runtime's death), proven on real workerd by
    `test/WorkerDurableObject.test.ts` through miniflare, and the
    `/durable`-on-DO decision is recorded (no: the engine's resume machinery
    stalls on workerd -- measured minimal repro in `status-history.md`).
    `examples/deploy-cloudflare/` holds the Alchemy stack and, since
    2026-09-02, a `wrangler.jsonc` that mirrors it. **Deployed for real
    2026-09-02** (`worker-without-code-mode.ts` as `affe-agent-free`, from
    a Workers free plan; the HTTPS smoke matched the miniflare test). Left:
    the code tool needs Dynamic Workers, which is paid-plan only (error
    10195), so `apps/worker` as checked in deploys once the account is
    upgraded. Rivet is closed as adopter-triggered (ledger, decision 4 of
    `plan-two-decisions.md`). The deployment plan's §6.2 gateway claim -- one
    `AgentServer` with a DO-backed mount and an in-process one, indistinguishable
    from outside -- is exercised by `test/GatewayMounts.test.ts` (2026-09-06). **A real model landed 2026-09-06** as the first slice
    of the deployment milestone (scoped with a second reviewer, decision
    record in `plan-two-decisions.md` §3): `worker-real-model.ts` with the
    key in a Worker secret, `wrangler.real.jsonc`, the README quickstart,
    `test/WorkerRealModel.test.ts` proving the exact entry on workerd with
    the provider substituted at miniflare's outbound boundary, and the
    opt-in `npm run smoke:cloudflare` against a deployment. The live smoke
    has **not** been run from this machine (no account here); the README's
    quickstart is the procedure, and a sanitized result belongs in the
    ledger when someone runs it.
    `Sandbox.fromExec` / `fromOperations` landed 2026-08-30 (a remote
    sandbox for the Worker is now one exec function away); a real remote
    provider (E2B/Daytona) still needs an account. The two upstream findings
    are filed in `docs/upstream/` (`effect-workflow-on-workerd.md`,
    `effect-sqlite-do-nested-migration-tx.md`). `plan-deployment.md`'s status
    line, §7, §9 and §10 were corrected 2026-09-01 — they still described the
    worker as unbuilt, which was the reverse of the truth. **D1 and the
    DO-storage `NodeStore` (that plan's §7 item 2) were never built and are
    not blocking anything**; DO SQLite covered history and the delivery log.
20. **Presets, `ref-declarative`, batteries** (`plan-primitives.md` steps
    4–6). Step 3 landed 2026-08-31: `examples/ref-gateway.ts` is the
    integration axis' acceptance test, runs in CI, and found nothing
    missing (findings in `STATUS.md`). Step 2 completed the same day with
    the credentials plan, and step 6's code-mode battery is `/code`. Step 4 landed
    2026-08-31: `affe-agent/presets` (`Presets.coding`,
    `Presets.gateway`), derived from what the two references had written
    by hand, and both references rewritten on top of them as the
    acceptance test. A chat preset waits for a caller. Step 5 landed the same day:
    `examples/ref-declarative.ts` substantiates the ergonomics claim --
    state, its rendering, capability rules and reactions each declared as
    data -- and records the boundary it found (a toolkit is fixed at
    construction; what follows live state is the policy, per call). What
    remains: **step 6's batteries** (LSP, truncation as a service,
    rendered prompts), each gated on a caller (decision 4 of
    `plan-two-decisions.md`, 2026-09-06): LSP on a coding caller that needs
    diagnostics, references or rename that existing tools cannot supply;
    truncation on a shell, search or MCP result measured over a caller's
    budget; rendered prompts on a caller that needs runtime workspace, model
    or task values in its prompt. None is built speculatively.
    **`plan-primitives.md` steps 1–5 are complete.**
### Product work restored to the tracker — 2026-09-08

81. **Workbench W0–W9** ([plan-workbench.md](./plan-workbench.md)).
    First W0: conversation identity/store, a directory over an existing
    `AgentClient`, a pure conversation projection and scoped presenter, then
    a plain browser client proving streaming, interruption, elicitation and
    reconnect. W1 adds persistence; later milestones add complete chat,
    workspace inspection, artifacts, agent configuration, connections,
    knowledge/projects and distribution. Build outside the portable kernel.
    W0's UI-independent half is in `apps/workbench` (2026-09-14): branded
    ids, an in-memory `ConversationStore`, an `AgentDirectory` over item 82's
    resolver (a conversation keeps the revision it was created on,
    decisions-2026-09-11.md D6), `ConversationSessions`,
    `ConversationProjection` and a
    scoped `ConversationPresenter`, tested through the in-process client for
    streaming, reasoning, tool progress, interruption, elicitation and
    reopen-from-history, with a boundary test for acceptance 8. It imports
    only published `affe-agent` subpaths. Reconnect is tested over the
    durable client: a presenter opened later resumes after the delivery
    log's latest sequence and follows the next submission. The browser half
    landed too: a `useConversation` hook and a plain `ConversationPage`
    (rendered in happy-dom: streaming, tool progress, approve, stop),
    `AgentDirectory.http` over `AgentHttp`, a localStorage conversation
    store (`ConversationStore.fromStorage`, still tested, no longer what
    the browser composes since W1's HTTP stores replaced it), a Vite entry
    (`workbench:dev` beside `workbench:server`), and `smoke:workbench`,
    which drives the page's transport over a real socket. W0's plain
    client is complete, and its *separate adapter proof* in assistant-ui
    landed 2026-09-23: `src/assistant-ui/` drives the same
    `useConversation` view through assistant-ui's external-store runtime
    (prompt on new, interrupt on cancel) and renders questions through the
    shared `ui-core/Question`, on its own page (`assistant-ui.html`). The
    plan's acceptance was checked literally: with the folder and its test
    removed, the workbench typechecks and its other tests pass, and a
    boundary rule keeps it that way (nothing outside the folder imports it
    or assistant-ui). That rule found the boundary test had never walked
    `.tsx` files; it does now, and they pass. Building the second page also
    found the dev proxy forwarding only four of the server's route prefixes
    -- sign-in, tasks and the inbox were unreachable under `workbench:dev` --
    now fixed and held by `test/DevProxy.test.ts`. W1's product
    shell landed (2026-09-14): `WorkbenchApi`
    serves conversations and agents from the server's SQLite database
    (product records only; execution stays on `AgentHttp`), the browser
    composes `ConversationSessions` from HTTP-backed stores, and the
    acceptance -- reload and continue the exact same conversation -- is
    tested against a real server with a second, fresh client stack. Agent
    configuration now takes effect on the server: a routing `AgentClient`
    sends each session to the resolved client of its conversation's pinned
    revision, against the deployment's model and capability bindings, and
    conversation records are written before their sessions (a missing
    session is made on open). The server's agent clients are durable
    (2026-09-15): `AgentResolver` takes an `AgentClientFactory`, and the
    server's builds `DurableAgentClient` over SQL channels, session store and
    delivery log with a single-runner workflow engine, on the same SQLite
    file as the product records -- tested that a restarted server reopens a
    conversation with its history and continues it. Workflow handlers register
    on first access to a revision after restart, and since 2026-09-22 the
    server reaches them itself: at startup it reopens, through the host and
    as each owner, every conversation the session index says was running
    work, so a run in flight at a restart resumes and its events reach the
    read models with nobody opening it (`test/Resume.test.ts`: a task
    stopped mid-tool completes after a restart; without the step it stays
    "running" for ever). The model catalog and the
    settings UI landed 2026-09-22: `Catalog` (`runtime/Catalog.ts`) names
    the model profiles, capabilities and skills the deployment binds, read
    from `AgentBindings` on the server and over `GET /catalog` in the
    browser, so a form can only offer what the resolver will accept; and
    `AgentSettingsPage` creates an agent or saves a new revision from a
    form whose choices are that catalog (the policy is carried over; a new
    agent starts permissive). The browser routes `#agents/new` and
    `#agents/<id>` to it. Tested in happy-dom (create, revise with the old
    revision kept, unknown agent) and over a server; emptying the catalog
    fails the page tests. **W1 is complete.** Still no UI for renaming,
    archiving or deleting a conversation, or archiving an agent (the API
    supports all). W2 has begun (2026-09-22) with pending approvals and
    error and retry states: `ui-core/Question.ts` describes what an agent
    asks from the request's detail -- for a tool approval the kernel's
    `Permission.ApprovalDetail`, so the page says which tool wants to do
    what, with the reason and any delegation it came through; anything
    else, or a detail that does not decode, is shown by kind and text,
    never hidden. The view keeps the last submission's `failure` until the
    next one starts, the page says why a run failed and offers Retry of the
    person's last message, and a send the session refuses puts the text
    back in the box. Tested in happy-dom and as pure functions; dropping
    the failure or the approval decoding fails the named tests. The
    sidebar followed: `react/ConversationList` renames, archives (with a
    "show archived" toggle) and deletes conversations -- delete asks twice
    on the page, since a browser `confirm` blocks everything -- and starts
    a new one on the agent picked; the inbox lists each question by what it
    asks. Tested in happy-dom; a one-click delete or an ignored pick fails
    the test. Feedback followed: `FeedbackStore` (memory and SQL), one
    rating per person per reply -- a reply named by its index in history,
    the only stable name it has -- with thumbs on each settled reply in the
    chat page, toggled off by a second press, and owner-only routes. Tested
    on both backends, in happy-dom and over a server; dropping the owner
    check or the un-rate fails the named test. A keyboard and
    accessibility pass on the chat page followed: Enter sends, Shift+Enter
    is a new line (and an IME's Enter is left alone), Escape stops a running
    reply; a question takes the focus, since the run waits on it; the
    transcript is a polite live region marked busy while a reply streams,
    and the status is a status role; each settled reply has a Copy action;
    and the shell, chat column and board wrap on a narrow screen. Tested in
    happy-dom; letting Shift+Enter send or dropping the focus fails the
    named test. Attachments followed: inline, as file parts of the prompt,
    which the kernel already carries intact (item 116's by-reference path
    is not reached for), so the cost is size and there is a cap -- 5 MB a
    file, 5 a message, refused with a reason before anything is sent
    (`ui-core/Attachments.ts`). The composer attaches and removes files; a
    refused send gives them back; Retry resends them; a message shows the
    files history says it carried. Tested as pure functions, in happy-dom,
    and over a server, where the bytes come back from the durable history
    exactly (base64-encoded, a form a file part allows); sending text
    without the files or dropping the cap fails the named tests.
    Edit-and-resend followed (2026-09-23), after a kernel change:
    `AgentClient.createSession` takes a `history` seed, carried by every
    client and the create-session wire, and held by the conformance suite.
    Editing a message branches: `ConversationSessions.branch` makes a new
    conversation on the source's *pinned revision* (D6 holds), seeded with
    the source's history up to that message, and the edit is sent there;
    the source is untouched. The workbench's routing client dropped the
    seed on its way to the durable client -- found by the server test once
    it branched past the first exchange -- and now passes the options
    through. Tested as pure functions, in happy-dom and over a server;
    cutting the whole history, or dropping the seed in the workbench or
    in the router, each fail the named test. The model picker followed,
    with D6 kept rather than loosened: a conversation's model is chosen
    when it starts and pinned on its record beside the revision
    (`modelProfile`, `None` for the agent's own and for records written
    before it), so it never changes under a conversation; "continue on
    another model" is a branch at the end of its history. The resolver runs
    a revision on a chosen profile, and the directory keeps one client per
    revision and model -- a separate durable workflow name, so two
    configurations never answer for each other's sessions. The route
    refuses a model the deployment does not bind (`ModelNotOfferedError`)
    before anything is made; the demo server binds a second `alternate`
    profile so the choice is visible. Tested over a server (chosen, kept on
    reopen, continued on another, kept by a branch, refused), in happy-dom,
    and against a record from before the field; ignoring the choice in the
    resolver, sharing one client across models, or accepting any model
    each fail the named test. Starter prompts followed, as the prompt
    catalog: a revision may carry `starters` (optional, so every earlier
    revision decodes), edited one per line in settings; an empty idle
    conversation offers its *pinned* revision's starters in both adapters --
    buttons on the plain page, assistant-ui's own suggestions in the other,
    from the one `ui-core/Starters` rule -- and one click sends it.
    Offering them regardless of state, or not deduplicating, fails the
    named tests. A command registry followed: `ui-core/Commands` parses a
    composer line into a message or an action (/help, /retry, /stop,
    /model <name>), `//` sends a literal slash, and an unknown command is
    refused by name rather than sent to the model. Both adapters perform
    the same actions from the one parser, each refusing plainly what it
    cannot do (assistant-ui has no navigation, so no /model); the plain
    page lists matching commands as they are typed. Sending an unknown
    command, or the page skipping commands, fails the named tests. Still
    open in W2: source cards, mentions, and appearance.

    ```text
    verify: exists apps/workbench/src/ui-core/Branch.ts
    verify: grep "readonly history?: Prompt.Prompt | undefined" src/client/AgentClient.ts
    ```

    ```text
    verify: exists apps/workbench/src/ui-core/ConversationPresenter.ts
    verify: grep "test:workbench" package.json
    ```

82. **Persistent-agent control plane, Phase 0–8**
    ([plan-agent-product-control-plane.md](./plan-agent-product-control-plane.md)).
    Coordinate with 81: first `AgentSpec`/`AgentRevision`, an in-memory
    registry and a resolver through public APIs; revision N must keep running
    unchanged after N+1 is created. Then product persistence, tasks/Needs You,
    browser/computer, connections/OAuth, automation, artifacts and knowledge.
    Reuse the existing session directory and projection. `SessionInbox` is
    background input, not the product's human approval inbox. Neither product
    plan justifies a second execution runtime.
    Phase 0 is in `apps/workbench` beside item 81 (2026-09-14): `AgentSpec`
    and immutable `AgentRevision`s as data, an in-memory `AgentRegistry`, and
    an `AgentResolver` that binds a revision's model, capability, skill and
    recorded-permission references into an `AgentClient.Service` using public
    combinators only. Tested: two revisions both resolve with their own
    configuration, an edit made mid-run leaves the run on its revision, the
    recorded policy is enforced, and an unbound reference is refused by name.
    It needed no kernel change. The workbench's conversations now run on it,
    pinned to their revision. Phase 1 has begun: SQL `AgentRegistry` and
    `ConversationStore` beside the memory ones, one contract for both, and
    the §6 acceptance tested -- an agent defined as data survives a restart
    and runs the same revision. Auth landed with the workbench shell
    (2026-09-15): bearer tokens (`WORKBENCH_TOKENS`, default the one local
    person) resolve once into the user every product route acts as and the
    principal `AgentSessionHost` authorizes, and a session is authorized by
    its conversation's owner; tested that one person cannot list, open,
    prompt or change another's conversation over either API. The session
    index landed 2026-09-22 (§10): the server keeps a kernel
    `SessionDirectory` current from `hostEvents` under its own indexer
    principal, the one host-wide operation the authorization policy grants
    and to no one else; a conversation is indexed under its owner's
    namespace at creation, naming its agent and revision as attributes; and
    `WorkbenchApi` answers one conversation's session summary and the
    caller's running sessions (`apps/workbench/src/store/SessionIndex.ts`).
    Tested over a real server that a session blocked on an approval is
    listed as running, only for its owner, and that removing the follower
    fails the test. Organizations and membership landed the same day (§5):
    an `OrganizationStore` (memory and SQL) whose invariants are its own --
    the creator is the first owner and the last owner can be neither
    demoted nor removed; an agent optionally shared with one organization
    (`AgentSpec.organizationId`, decoded as `None` for rows written before
    it); and `Access`, the pure rules every handler decides by: a member
    uses a shared agent and runs it in a conversation of their own, an
    admin or owner also revises, archives and creates in the organization,
    only an owner grants or takes ownership, and nobody else learns the
    agent exists. Routes for organizations and members on `WorkbenchApi`,
    HTTP store beside the others. Tested for every role combination, both
    store backends, an old agent row, and end to end over a server with
    three people; breaking manage-equals-use or the last-owner rule fails
    the named tests. Real identity landed last, the same day: a person is
    someone who knows a password (PBKDF2 under a fresh salt, in
    `IdentityStore`, memory and SQL) and a bearer token is one the server
    issued to them and has not ended -- 32 random bytes the holder keeps
    and the store knows by digest, with a TTL (`serve({ identity })`,
    default 30 days). `POST /login` is the one route a stranger may call;
    accounts are made by a signed-in caller (`POST /users`), a password
    change (`PUT /me/password`) ends every token it had opened, and
    `POST /logout` ends the one named. Configured `WORKBENCH_TOKENS` keep
    working beside issued ones -- the local deployment is the same code
    path, and how the first account gets made; open sign-up is a
    deployment decision left unmade. One `TokenResolver` answers both
    `WorkbenchApi` and `AgentSessionHost`. The browser shows a sign-in
    form for a token the server does not know, and a sign-out button.
    Tested on both backends (wrong password and no account are one
    refusal, expiry under the test clock, revocation on logout and on
    password change, nothing secret in a row) and over a server (the
    issued token prompts the agent; logout and password change end it;
    the configured token survives). **Phase 1 is complete.** Phase 2 has
    begun with the Needs You inbox (§11, 2026-09-22): not an approval queue
    of its own but a durable reference to an unresolved elicitation --
    `InboxStore` (memory and SQL) kept current by `InboxProjection` from
    `hostEvents` under the same indexer principal, by three rules: a
    request appears for the conversation's owner, it settles when
    resolved, and everything a session had open settles when its
    submission does (which is what an interrupted run needs, since its
    questions never resolve). `GET /inbox` lists the caller's, oldest
    first; answering stays on the session, and the browser's nav shows
    "Needs you (n)" linking to the conversations. Tested on both backends,
    against a hand-made event stream for each rule, and over a server
    where a question is in its owner's inbox alone until answered;
    dropping either settling rule fails the named test. Tasks followed
    (§8, 2026-09-22): `Task` / `Attempt` as data and a `TaskStore` (memory
    and SQL) where starting an attempt marks the task running in the same
    write; a `TaskRunner` whose attempt is an ordinary conversation on the
    task's agent plus one submission of its description, begun through
    `TaskAttempts` -- on the server, the session host itself, as the owner,
    so the attempt is observed like any session a person opens (a session
    made on the resolved client directly emitted no host events and its
    task never settled, which is how the seam was found); the attempt is
    recorded *before* the submit so a question asked at once finds it, and
    the submission id is stamped after. Status comes back from the host's
    events and nowhere else: waiting while a question is open, running
    otherwise, completed / failed / canceled as the submission settles; a
    finished task can be run again as a new attempt. Routes for the
    caller's tasks, start and cancel; a board page by column (backlog,
    ready, running, needs you, done) with add, start, stop and a link to
    each attempt's conversation. Tested on both backends, in happy-dom,
    and over a server (completed; waiting with the question in the inbox;
    canceled by interruption; run again and answered); dropping the
    interruption rule fails the named test. The operational queue closed
    Phase 2 (§9, 2026-09-22): `WorkQueue` (memory and SQL), its own store
    rather than the kernel's `JobStore`, whose note rules leases out --
    one item per task, claimed by priority then age under a lease, released
    with a backoff when the start failed, reclaimable by anyone once the
    lease has run out, dropped after `maxClaims` with the task marked
    failed; and `TaskWorker`, polling on the server under the indexer's
    name as its lease, whose only job is to *start* an attempt reliably
    (at-least-once for starting, safe because a task already attempted
    refuses a second start). `POST /tasks/:id/queue` marks a task ready
    for it; cancel takes a ready task back off the queue. Tested: claim
    order, leases and take-over on both backends; under the test clock,
    retry with backoff then success, give-up at `maxClaims`, two workers
    starting a task once, and a lease that ran out under an attempt already
    made; over a server, a queued task is started by the server's worker
    and completes. Not built, and not planned here: assignment to an
    agent other than the task's own, tasks for organizations rather than
    people, and an approval UI beyond the chat page's own.

    ```text
    verify: exists apps/workbench/src/runtime/AgentResolver.ts
    verify: exists src/sessions/SessionDirectory.ts
    verify: exists src/sessions/SessionProjection.ts
    verify: exists src/sessions/SessionInbox.ts
    ```

### Integration and design work recovered from plan tails — 2026-09-08

*(83 and 84 were written here on 2026-09-08 and never committed; the same
work was ranked again on 2026-09-11 as items 116 and 114–115, which carry
it now.)*

85. **MCP frontend remainder.** Finite durable-backed reads landed as item 88
    (ledger). Skills as prompts still need an authenticated permission-aware
    load path. Resource subscriptions, progress and native HTTP elicitation
    remain tied to the pinned upstream server's capabilities; do not implement
    an authorization bypass to fill the prompt surface.

86. ~~**Client capability discovery: resolve the proposal.**~~ **Declined
    2026-09-11.** `plan-streaming-followups.md` §3 proposed construction-time
    streaming and replay capabilities. The refusal at first use is typed, and
    the conformance suite asserts both answers of each option, so a client
    that mis-declares fails there; a record on `AgentClient.Service` would be
    a permanent obligation on every custom client for a reader nobody has.
    Reopens when a host must choose between clients at wiring time. The
    proposals to shrink `RemoteSession` and encode delegated envelopes
    opaquely were rejected, not unfinished implementation.

    ```text
    verify: grep "readonly resumesEvents?: boolean" src/testing/AgentClientConformance.ts
    verify: grep "readonly streamsSubmissions?: boolean" src/testing/AgentClientConformance.ts
    ```

87. **Description extensions, gated on a consumer.**
    `plan-context-lessons.md` §5.2: compaction policy descriptions, a wire
    schema for agent descriptions, and `describe_myself`. Loop/permission
    descriptions and `Agent.describe` already ship. The wire form waits for
    an actual CLI, host or product consumer.

89. ~~**effect-uai adapter: Phase 2 streaming acceptance, then the rest of Phase 3.**~~ **DONE 2026-09-11, as far as effect-uai allows.**
    Phases 0 and 1 landed 2026-09-08:
    [plan-effect-uai-compatibility-contract.md](./plan-effect-uai-compatibility-contract.md)
    is the contract, `src/effect-uai` the adapter (`affe-agent/effect-uai`,
    `@effect-uai/core` an optional peer), `test/EffectUaiModel.test.ts` its
    conformance rows, and `test/EffectUaiMockProvider.test.ts` the same rows
    against effect-uai's own fixture, so the protocol reading is checked by
    their code rather than only by ours.

    **Phase 3's gate is cleared for the reasoning signature.**
    `test/ProviderContinuation.test.ts` audits response -> canonical history ->
    `PromptWire` -> snapshot/restore -> durable replay -> next request, and it
    holds. The durable hop had no coverage before it: the existing replay test
    compares a history shape that renders reasoning as an empty detail.
    **Since:** Phase 2's streaming acceptance landed (`4bda60b`), and images
    and citations cross (`86d1193`), provider options too (`81a1d6f`).
    Checked 2026-09-11: prompt-cache metadata crosses (cache reads and
    writes, and reasoning tokens, into `usage`; now a row), and provider
    response ids cannot -- effect-uai's `Turn` carries items, usage and a
    stop reason and no response id, so there is nothing to map until
    upstream adds one. The last two are the same kind of answer: effect-uai's
    input content is `input_text` and `input_image` only, so a non-image
    file has nowhere to go and its refusal (pinned) is correct, not owed;
    and provider-defined tools are refused on purpose (pinned), because a
    provider executing a tool would bypass Affe's tool execution, so there
    is no metadata to carry. Reopens when upstream adds a file input or a
    response id.

    Dynamic tools (a raw JSON schema rather than an Effect `Schema`) are
    tested since 2026-09-11: described to effect-uai by exactly the schema
    given, and a call arrives with its arguments parsed. No network test
    against a real effect-uai provider exists yet, and is the strongest
    remaining evidence gap; it needs a provider key, which the owner
    declined for now (decisions-2026-09-11 D4).

    ```text
    verify: exists test/ProviderContinuation.test.ts
    ```

90. **`run`/`stream`/`start` plan: P7 only, and it is adopter-triggered.**
    [plan-run-stream-start.md](./plan-run-stream-start.md) P1–P5 landed
    2026-09-08: `Agent.start` with a bounded replay handle, `Agent.stream`,
    the per-submission tool-progress budget, `AgentLoop.Exhaustion` on
    `Result` and `RunCompleted`, and `onExhaustion`.

    **P6 was audited and deliberately not built.** §8.1 asks whether telemetry
    can already receive a recovered tool failure's original `Cause` exactly
    once per attempt without changing run semantics; it can, through
    `Effect.tapCause` on the handler, joined to `ToolCallFailed` on the tool
    call id for the correlation and disposition the handler cannot see. The
    route is documented in `guide-batteries.md`, the combinator is in
    `examples/observability.ts`, and `test/ToolFailureObservation.test.ts` is
    the audit as tests so the decision fails loudly if it stops being true.
    Reopen only if something needs a failure the harness raises *around* a
    call -- a permission denial, an approval refusal, the progress ceiling --
    which never enters the handler and so is not tapped.

    P7 (`*Unknown` one-shot helpers) is convenience the plan itself ranks
    last and gates on an adopter. Not built speculatively.

    ```text
    verify: exists test/ToolFailureObservation.test.ts
    ```

### Tool exposure, terminal work and failure routes — 2026-09-10 — [plan-exposure-and-terminal-work.md](./plan-exposure-and-terminal-work.md)

*From `danieljvdm/effect-agent` #395–#424. Order of work, not priority:
91 first (small, closes a live side-effect hazard), 92 builds on it, 93 is
the largest and wants 100's harness to be judged. The plan carries each
item's invariants and acceptance tests; the entries here say what is open
and pin the state it starts from.*

93. **Visibility, progressive exposure and discovery (plan E3, §3) -- first
    slice landed 2026-09-10.** `ToolExposure` (kernel): `eager` or
    `progressive({ pinned, maxTools, maxResults })`, each with an optional
    `visible(tool, principal)` rule -- declared on the agent, decided per
    caller (Q1). The model is sent pinned ∪ latest discovery selection ∪
    protocol tools as `toolChoice.oneOf`, so the provider sees only those
    schemas while the response still decodes against the whole toolkit; a
    call outside the exposed set is refused with `ToolNotExposedError`; a
    hidden tool is absent from requests and discovery even when pinned; the
    selection is read from history, and a durable crash after discovery
    recovers it. `maxSchemaBytes` bounds what one discovery selects by
    the UTF-8 size of the parameter schemas, skipping a match too large to
    fit and saying `more`; the exposure bounds are rows in `limits.md`.
    Measured by 100's scenario: over 100 tools, eager sends 2 requests, 200
    tool entries and ~45 KB of schema; progressive 3, 17 and ~3.5 KB, for
    one more model call. Composes with `/tool-source`: thirty tools a
    source declares as JSON Schema start unexposed, discovery finds one, and
    its call reaches the source (T3.7). T3.9, a `ToolExposureChanged`
    event, **declined 2026-09-11**: the selection is a function of history
    (`ToolExposure.selectionFrom`), and the discovery's own
    `ToolCallSucceeded` carries its `Discovery` -- found, selected, and the
    query -- which is exactly "why a tool appeared". An event would journal
    the same state twice and give every consumer of the tolerant event
    union one more variant. Reopens if exposure ever changes by something
    other than discovery. Still open: a live-model cost run before the
    guide recommends progressive, which waits on a key the owner declined.

    ```text
    verify: exists src/ToolExposure.ts
    verify: grep "readonly toolExposure: ToolExposure.ToolExposure" src/Agent.ts
    verify: grep "readonly maxSchemaBytes: Option.Option<number>" src/ToolExposure.ts
    ```

97. ~~**Acknowledgement vocabulary (plan E5, §8)**~~ **DONE 2026-09-11** (documented 2026-09-10).
    `guide-sessions.md`'s "What a success means" table gives each
    submit-like API the state its success guarantees -- handed over,
    persisted, accepted, settled -- and what a crash after it costs; the
    three ambiguous `void`s say it where they are declared
    (`AgentDispatcher.dispatch`, `RelayClient.send`, `SessionInbox`'s
    `Delivered`). The two rows that could lose work were items 95 and 96.
    **T8.2 done 2026-09-11:** `AgentBusyError` names the submission that
    holds the session (`submissionId`, optional on the wire), on every
    client -- the durable one from the incumbent claim, which it used to
    drop -- so a caller refused without an idempotency key awaits the
    incumbent instead of retrying blind (a conformance case; the durable
    row fails with the id removed; `test/fixtures/busy-error.json`). A8.2,
    two concurrent submits under one key, is `DurableAgentClient.test.ts`'s
    concurrent `req-1` row. **A8.1 done 2026-09-11:** each row of the table
    now has a test that loses the destination after success and asserts what
    the row says survives -- or, for the "handed over" rows, that it is
    lost, so the guide cannot quietly promise more than happens:
    `SessionInbox.enqueue` (persisted: a fresh inbox delivers it once),
    `deliver`'s `Delivered` (accepted, not settled: not redelivered),
    `queued` dispatch after a worker's claim (lost, at most once), a
    connector's 200 (received, not persisted: no reply), and
    `RelayClient.send` (handed over: a dropped target's queue is gone).
    Already covered: `DurableAgentClient.submit` (`DurableEquivalence`'s
    crash rows submit, kill the process and finish in another), `queued`
    before the claim, and `local` dispatch. `prompt`'s "settled" is every
    `prompt` test, and an in-process `submit` dying with its process is what
    in-memory means.

    ```text
    verify: grep "## What a success means" docs/guide-sessions.md
    verify: grep "submissionId: Ids.submissionId(outcome.claim.submissionId)" src/durable/DurableAgentClient.ts
    verify: exists test/fixtures/busy-error.json
    ```

100. **Matched release→main benchmark suite (plan E8, §10) -- first slice
     landed 2026-09-10.** `npm run bench` (`scripts/bench.mjs` over
     `bench/run.ts`): base and head each in their own worktree -- the
     "release" is a git ref, `v0.0.1` by default, since nothing is published
     -- with that ref's own dependencies (linked when the lockfile matches,
     `npm ci` when it does not; v0.0.1 against today's modules fails), head's
     scenarios copied in, runs interleaved in rounds, median and IQR with raw
     samples and exact commit/src/lockfile identities, and no percentage when
     the artifacts are identical. Deterministic scenarios over the scripted
     model; the exposure pair also records requests, tools and schema bytes
     sent (100 tools: eager 2 requests / 200 tools / ~45 KB, progressive 3 /
     17 / ~3.5 KB). First observations, not verdicts, on a machine shared with
     other test runs (identical refs differed by ~20% at small samples):
     streaming 1024 chunks read +42% in one run and +0.8% in the next --
     noise; the forty-prompt history scenario was slower than v0.0.1 in all
     three runs (+20%, +114%, +33%), the one signal worth investigating
     (`docs/reports/bench-2026-09-10.json`). Not from this week's work:
     `c5ed5dc` vs `e096b7b` on that scenario alone, 24 samples a side, is
     -0.4%, so it lies somewhere in the 514 commits before. **Attributed in
     part, 2026-09-10:** a bisect was misled by noise near its threshold;
     timing each commit in one install put a step of ~5 ms at `97f6f7c`
     (every submission encoding its input through the schema, a full
     `PromptWire` encode for the default prompt). `2be0bbf` builds a text
     prompt's encoding directly, pinned to the schema by test: v0.0.1 vs
     HEAD on that scenario went from +65% to +34%
     (`docs/reports/bench-2026-09-10-dbe2fecd-*.json`, before and after).
     What remains is a fixed per-submission cost -- a one-turn run is +68%,
     1.7 → 2.8 ms, four tool rounds +51% -- and a profile of a bundled
     one-turn run (source-mapped by esbuild's file markers) finds no hotspot
     of ours: the time is Effect's run loop, i.e. more effect steps per
     submission as features landed, plus ~8% schema work of which the
     largest piece is Effect AI rebuilding `Response.Part`'s union on every
     `LanguageModel` call (upstream). It is also confounded: v0.0.1 runs on
     its own lockfile with an older Effect RC, so some of the gap may be the
     dependencies, and v0.0.1's source cannot run against today's to
     separate them. Treated as the cost of the features, not a regression,
     unless a scenario shows one. A first durable scenario exists: two tool
     rounds through the durable client over a fresh SQLite file (~0.7 s a
     submission on this machine, mostly engine and schema start-up; refs
     without the harness report it unavailable). DeliveryLog catch-up too:
     500 events appended to SQLite, then read after offset 0 whole and in
     pages of 100 -- ~8.5 ms either way, the appends (one transaction each,
     ~2 s) dominating the wall time, so the read is reported as `readMs`.
     The effect-uai adapter's cost: the 1024-chunk stream through a scripted
     effect-uai provider and `EffectUaiModel` takes ~24 ms against ~17 ms
     native -- ~7 µs a chunk, well above this size's ~5% noise. Still open:
     more durable scenarios (settlement replay, SQLite contention), and a
     live-model cost run for item 93. **Decided 2026-09-11**
     ([decisions-2026-09-11.md](./decisions-2026-09-11.md)): the two
     scenarios are cold recovery against history length -- N = 10, 100,
     1000 settled submissions on SQLite, a fresh process timed until the
     session accepts its next submission; past ~1 s at N = 1000, item 112
     is unparked -- and write contention -- one, two and four processes on
     different sessions in one file; any `SQLITE_BUSY` reaching a caller is
     a bug with its own item, not a row. The live run waits on a capped key
     (D4 there), which the owner declined.

     **Both built and measured 2026-09-11** (`bench/run.ts`, this machine):
     cold recovery -- a second process reading the session back -- took
     11 ms after 10 submissions, 16 ms after 100 and 24 ms after 1000
     (100 and 1000 opt-in, `BENCH_RECOVERY_LARGE=1`: minutes of setup), so
     **item 112 stays parked**: the threshold was ~1 s. The first prompt
     after recovery grows more (≈360 ms at 10 and 100, 750 ms at 1000),
     mostly the dead runner's shard lock but not only; worth a look if a
     session of thousands of submissions ever matters. Contention became
     *sessions*, not processes: `SingleRunner`s sharing a file contend for
     shard locks rather than forwarding, and multi-process is the
     HTTP-runner cluster. One, two and four sessions submitting at once
     through one client and file: 2.1, 2.7 and 2.7 submissions a second,
     no failures, no `SQLITE_BUSY` -- the file serialises the writes, and
     past two sessions concurrency buys nothing. A second run the same day
     agreed (13, 12 and 25 ms; 2.3, 2.5 and 2.8 a second). Left: a
     settlement-replay scenario, and the live cost run.

     ```text
     verify: grep "durable: cold recovery after" bench/run.ts
     verify: grep "sessions submitting at once over SQLite" bench/run.ts
     ```
     Variance is characterised (2026-09-11, HEAD against itself, 24 samples
     a side, `docs/reports/bench-2026-09-11-a4cdcea7-a4cdcea7.json`): with
     identical code, scenarios under ~5 ms moved their medians by up to
     ~25% (one-turn 2.6 vs 2.1 ms, 64 chunks 4.7 vs 3.5 ms) and those of
     20 ms and more by under ~5%. A gate on this machine would need
     per-scenario thresholds above that, or only the larger scenarios.

     ```text
     verify: exists scripts/bench.mjs
     verify: exists bench/run.ts
     ```

102. **Cloudflare AI Gateway option (plan E10, §12).** An optional model
     option in `/cloudflare`. Adopter-triggered; not built speculatively.

*Part II of the plan (durability and correctness, from #376–#391). The
near-term priorities across both parts are five: 93 (exposure), 91+92
(terminal work), 103+104 (exact-response recovery and the equivalence
oracle), 105 (host scheduling and authority capture), 106 (continuity
evaluation). Work order: 91 and 103 first, then 104, whose oracle is the
acceptance test for 105, 107 and 108.*

113. **A durable delegation whose child forwards an approval hung the
     process (found 2026-09-11; refused by name since, the design open).**
     Now: `DurableToolkit` marks a tool call's handler as running inside an
     activity (`InsideToolActivity`), and both durable elicitors -- the
     client's projected one and `DurableElicitation` -- die with
     `DurableElicitationInToolCallError` there, whose message says to ask
     before or after the call or give the child its own policy.
     `test/DurableDelegationApproval.test.ts` fails in seconds where it used
     to hang (the guard removed, it hangs again). Open: the real design --
     what a suspension should do to a call in flight -- so a child's
     approval can be forwarded durably. What was found: A durable parent with
     `Subagent.tool(..., { inherit: { approval: "parent" } })`, whose child
     calls a `needsApproval` tool: the straight run -- no crash -- never
     finishes. The event loop is starved from the start (no timer fires,
     not even an `Effect.timeout`; a V8 tick profile is ~80% in `ntdll`,
     most likely GC under growing memory), and under vitest the worker's
     memory grows until it dies. Not SQLite: the in-memory engine
     (`TestRunner`, memory stores) dies the same way. Not today's start
     marker: disabling it hangs the same way. The same
     delegation without the approval completes, and a parent-level
     approval over the same harness completes. Suspected: the child's
     elicitation reaches the parent's *durable* elicitor, which awaits a
     `DurableDeferred` -- suspending the workflow -- from inside the
     parent's delegation tool call, itself a running activity; the in-process
     path (`PermissionSubagent.test.ts`) is the only one tested. Needs a
     decision as much as a fix: what should suspending a workflow mean for a
     child running inside an activity? Repro: `DurableEquivalence.straight`
     over SQLite with that agent and `answer: (r) => ({ id: r.id, granted:
     true })`. Medium.

     ```text
     verify: grep "readonly answer?:" src/testing/DurableEquivalence.ts
     verify: exists test/fixtures/admission-descriptions.json
     ```

     Found in review, part of the same design: the engine re-executes an
     activity that *suspended*, and that replays item 98's start marker, so
     a non-idempotent handler that suspends legitimately (a durable sleep, a
     child workflow) would resume as `Unresolved`. Probed 2026-09-11 with a
     cast (a throwaway test, not kept): the suspension is a self-interrupt,
     which `DurableToolkit`'s interruption branch cannot catch, so nothing
     is journalled at the suspension -- and over `DurableEquivalence`'s
     SQLite cluster a durable sleep inside a handler did not resume within
     20 s, idempotent or not. Latent, not live: a handler's requirements
     are `never`, so no handler can name `WorkflowEngine` to sleep or await
     a deferred without a cast, and the library's only in-call suspensions
     -- the two elicitors -- are refused. Whatever lets a handler suspend
     must tell a suspended attempt from a dead one. Sketched: a marker per
     attempt, and a `DurableDeferred` saying attempt k suspended, completed
     from an interrupt finalizer that sees the activity's instance marked
     `suspended` (a self-interrupt cannot be caught, but finalizers run); a
     re-execution walks k, runs the handler past a suspended attempt, and
     refuses at one that simply stopped.

     **Decided 2026-09-11** ([decisions-2026-09-11.md](./decisions-2026-09-11.md),
     D5): the refusal stays; the design of record, built when an adopter
     needs forwarded approval across a durable delegation, is delegation as
     a *child workflow* -- the delegating tool starts the child's durable
     submission instead of running the child in its handler, so the
     child's approval parks the child and the engine suspends the parent
     behind it. General suspendable handlers (and the per-attempt marker
     sketched above) are refused: they would hand engine semantics to every
     tool author to serve one pattern the child workflow serves alone.
     **Scoped 2026-09-24** (`plan-subagent-execution-forms.md`, form 2): the
     handler *cannot* start the child — it is `never`-requirement and runs
     inside an `Activity` — so the design is a *marked* delegation that
     `DurableToolkit.handle` runs in the **workflow body** via
     `WorkflowEngine.execute` + `Workflow.suspend`, not as an activity. The
     probe holds (`test/ChildWorkflow.test.ts`): a body is given
     `WorkflowEngine` and executes a child, completing with its result; and a
     child that parks on a durable deferred, with the parent awaiting it,
     resumes and completes. What is left is the `DurableToolkit` seam and how
     the parent's user reaches the child's parked elicitation.

112. **Recovery snapshots for O(suffix) cold recovery (plan E20, §24).**
     Parked until 100 measures a session where cold recovery cost matters;
     104's oracle is its acceptance test. The trigger, decided 2026-09-11:
     cold recovery past ~1 s at 1000 settled submissions (item 100). Measured
     the same day: 24 ms. Stays parked.

### Open plan phases that were not on this list — added 2026-09-11

*A sweep of every plan on 2026-09-11 found these phases open in their plans
and on no list here; the owner asked that everything open be tracked in one
place. The workbench, control-plane, MCP-frontend and streaming-follow-up
plans are items 81, 82, 85 and 86 above -- written 2026-09-08, left
uncommitted in the working tree, and landed 2026-09-11 once it was clear no
one else was working on them.*

114. ~~**A2A bridges over the relay**~~ **DONE 2026-09-11**
     ([plan-a2a-layers-bridges.txt](./plan-a2a-layers-bridges.txt), step 5).
     It needed no new code, which is the finding:
     `test/A2ABridgeOverRelay.test.ts` runs, on a "desktop", an agent whose
     tool is the Claude Code bridge (`AgentA2A.tool` over
     `ClaudeCodeA2A.remote`, the CLI scripted through `Sandbox.execStream`),
     served over the relay by `AgentRpc`; a "VPS" that knows only the
     desktop's peer id prompts it through `RelayRpc.clientProtocol`, the
     model delegates, and the CLI's answer comes back across the relay. The
     OpenCode bridge is the same `RemoteAgent` to `AgentA2A.tool`, so the
     composition holds for it unchanged. Not added: the bridge's own
     `RemoteAgent` surface (tasks, cancel) carried across the relay directly
     -- a caller delegates to an agent that holds the bridge. Reopens if a
     caller needs that surface.

     ```text
     verify: exists test/A2ABridgeOverRelay.test.ts
     ```

115. **`ClaudeCode.languageModel`, then a decision on OpenCode's
     ([plan-a2a-layers-bridges.txt](./plan-a2a-layers-bridges.txt), steps
     6–7).** An experiment first: can Claude Code be held to one response,
     without acting on its own, and implement `LanguageModel` faithfully?
     Only then decide whether `OpenCode.languageModel` is worth shipping --
     the plan leans no, as OpenCode is plainly an agent. Medium.

     ```text
     verify: no-grep "languageModel" src/a2a/claudeCode.ts
     verify: no-grep "languageModel" src/a2a/openCode.ts
     ```

116. **Media externalized at the boundaries
     ([plan-filetypes.txt](./plan-filetypes.txt), steps 6–7).**
     `BlobWire.externalize` exists and nothing outside `src/blob` calls it:
     transports and durable stores still inline an oversized file part.
     Step 6: the adapters and durable stores externalize at their own
     boundary, over a threshold. Step 7: the relay carries references, not
     bytes. They rode with umbrella item 26, which closed without them.
     **Specified 2026-09-11** (the plan's step 6 note: threshold, access,
     lifetime), **and its first slice built:** the durable session store's
     history rows -- rewritten whole at every finish -- take
     `blobs: { store, maxInlineBytes }` on `memoryStoreWith` and
     `sqlStore(WithTables)`. A file over the threshold is written to the
     blob store and the row holds a reference; every read resolves it back
     to the exact inline encoding, so no caller, retry comparison or replay
     sees a reference. The session-store conformance suite passes over both
     blob-backed stores; a 4 KB image leaves a 4 KB-smaller row
     (`test/fixtures/history-blob-row.json`) that reads back identical, and
     a second store over the same database reads the same. **The transport
     half specified 2026-09-14** (the plan's second step-6 note): a host
     opted in answers history and event reads with references, and a
     receiver fetches through a session-scoped route
     (`GET /sessions/:id/blobs/:blobId`, and the same `AgentRpc` operation,
     which the relay then carries), authorised as a read of that session
     and served only for a blob that session's history references -- so a
     guessed hash from another session is refused, with no signed URLs and
     no second permission model. Not built: it adds a protocol operation,
     and waits for a caller whose transcripts carry files large enough to
     matter. Medium.

     ```text
     verify: grep "readonly blobs?: HistoryBlobs | undefined" src/durable/DurableSessionStore.ts
     verify: exists test/fixtures/history-blob-row.json
     verify: no-grep "externalize" src/http/AgentHttp.ts
     verify: no-grep "BlobWire" src/relay/RelayRpc.ts
     ```

117. **Relay operations ([plan-relay.txt](./plan-relay.txt), phases
     13–16).** **13 done 2026-09-11, scoped to what only HTTP adds:**
     `RelayAdmin.layer({ authorize })` mounts credential administration --
     issue a peer's credential (the plaintext shown once), count what speaks
     for a peer (never the secrets), revoke one (the token in the body, not
     a URL a log would keep) -- behind a required operator check
     (`RelayAdmin.operatorToken`, compared as digests). Not added: a peer
     directory route, since any authenticated peer reads the directory
     through the relay's `peers` call, and a status route, since the
     counters go to whatever exporter a deployment runs
     (`test/RelayAdmin.test.ts`: a minted credential authenticates and, once
     revoked, does not; nobody but the operator reaches a route).
     **14 done 2026-09-11:** `RelayServer.layer` takes `sendRate` -- a token
     bucket per authenticated sender; past it, `send` fails with the new
     `RelayRateLimitedError` and its `retryAfterMs`, checked before
     authorization so a flood of forbidden sends is limited too -- and
     `audit`, told of every connection and every refused send with its
     reason (unauthenticated, rate-limited, forbidden, offline); its own
     failure is logged, never the sender's. `RelayServer.metrics` counts
     sends by outcome and connections opened. Both options are absent by
     default, so an existing relay behaves as before
     (`test/RelayOperations.test.ts`). 15: an E2EE spike, optional. 16:
     several relay nodes, parked until one node is not enough.

     ```text
     verify: exists test/RelayAdmin.test.ts
     verify: grep "readonly sendRate?:" src/relay/RelayServer.ts
     verify: exists test/RelayOperations.test.ts
     ```

118. **effect-uai past the model adapter
     ([plan-effect-uai-integration.md](./plan-effect-uai-integration.md),
     phases 4–6).** Phases 0–3 shipped (`src/effect-uai`). 4: non-model
     capability adapters -- web search and read first, then embeddings,
     then a sandbox -- each passing the Affe seam's own conformance. 5: a
     Toolkit import experiment, promoted only if its typed tier keeps the
     no-cast rule. 6: whether a deeper model substrate is justified,
     decided only on the evidence the plan lists; the default is to stop at
     the adapter. 4 and 5 medium; 6 a decision. What phase 3 still owes
     (provider response ids, prompt-cache and provider-defined tool
     metadata, files) is item 89.

     ```text
     verify: exists src/effect-uai/EffectUaiModel.ts
     verify: no-grep "Toolkit" src/effect-uai/index.ts
     ```

119. **A real remote sandbox provider, then tier 2
     ([plan-integrations.md](./plan-integrations.md), steps 4 and 7).** E2B
     or Daytona through `Sandbox.fromOperations`, passing
     `SandboxConformance` in CI, which measures the residue against Flue's
     ~250-line Daytona adapter. Needs a provider account. Step 7, the
     declarative REST tier, comes after the tool-source request binder
     exists, and only for a provider whose surface is genuinely REST.
     Medium; blocked on an account.

     ```text
     verify: absent src/sandbox/e2b.ts
     verify: absent src/sandbox/daytona.ts
     ```

120. ~~**Failpoints for the channels and the relay**~~ **DONE 2026-09-11**
     ([plan-failure-paths.md](./plan-failure-paths.md) §3.2). The design
     gave each subsystem its own closed set of failpoints. `DeliveryLog`,
     the turn, compaction, the event bus and the Cloudflare dispatch had
     them. **`DurableChannels` has one now, and it found a bug:** a drain's
     activity took its rows out of the SQL store in its own transaction,
     and a process lost before the engine journalled the activity left them
     gone -- the replacement's re-execution took again from an empty store,
     and an accepted steer never reached the model
     (`test/DurableChannelsCrash.test.ts`; fails with the fix removed).
     Drains now claim rows instead of deleting them, and a re-execution
     under the same claim takes the same rows; the channel table gains a
     `claimed_by` column (`sqlStoreWithTable` adds it to an older table).
     **`RelayRpc` gets none, deliberately:** a failpoint marks the window
     between two durable writes, and `RelayRpc` has no durable write -- it
     moves frames, and its teardown is covered by `test/Relay.test.ts`'s
     tear-down-and-redial rows. A boundary no test could meaningfully crash
     at would be the finding `Failpoints.covered` exists to report. What
     reading it for this did find is item 124.

     ```text
     verify: grep "store.takeAll(key, claim)" src/durable/DurableChannels.ts
     verify: exists test/fixtures/channel-input-table.json
     ```

121. **TUI gaps ([plan-tui-port.md](./plan-tui-port.md), "Still not
     implemented").** Expanding a running tool body clipped at twelve lines
     -- the one the plan ranked first -- **done 2026-09-11**: ctrl+o toggles
     every live body between clipped and whole, the clipped line names the
     key and the footer names the way back; `smoke:tui` checks all three
     and fails with the binding removed. Left: syntax highlighting, and
     switching workspaces in one TUI. Each small; each waits for use to say
     it matters.

     ```text
     verify: grep "No syntax highlighting" docs/plan-tui-port.md
     verify: grep "ctrl+o to expand" apps/tui/src/App.tsx
     ```

*(122 duplicated item 90, which was written first and carries P1–P6's
history; 90 holds it.)*

123. ~~**A ~12 s shard-lock stall when a replacement starts a moment later**~~
     (found 2026-09-11). `test/DurableAgentClientSql.test.ts`'s R173 row
     runs in about 1 s at HEAD. Add one statement to process B's start-up --
     a bare `SELECT 1` in `DurableChannels.sqlStoreWithTable`, touching no
     table -- and it takes 13 s, logging "Shard lock storage is unhealthy
     TimeoutError". So the takeover has a timing window that turns a
     sub-second recovery into one bounded by some ~10 s timeout, not by the
     1 s lock expiration the test configures. Found because R173 was the
     one row there without its own budget; it now has its siblings' 30 s,
     which hides the stall from the suite but not from a user waiting on a
     recovery. Next: find which timeout it is -- the runner's lock-storage
     health check is the first suspect -- and whether production's 35 s
     lock expiration makes it worse. Medium.

     **Explained the same day, by reading `effect/unstable/cluster`'s
     `Sharding.ts`; closed as a fixture artifact.** A runner refreshes its
     shard locks with a deadline of `min(shardLockRefreshInterval,
     shardLockExpiration / 3)`; a refresh that misses it -- its own retries
     are five, 50 ms apart -- marks lock storage unhealthy, force-releases
     every shard, and waits for a probe to succeed before acquiring again:
     that is the stall and its log line. The durable test fixtures shorten
     the timings so a takeover is quick (refresh 200 ms, expiration 1 s), so
     the deadline is 200 ms -- less than the retry schedule -- and one busy
     moment in the shared SQLite file misses it; process B's start-up shifts
     where that moment falls. Production's defaults (10 s and 35 s) give a
     10 s deadline, fifty times the margin. Not worth changing the fixtures:
     a longer refresh would slow every takeover test to buy nothing but a
     quieter log. Reopen if a deployment that shortens those timings reports
     the error.

     ```text
     verify: grep "Item 123 is that stall" test/DurableAgentClientSql.test.ts
     ```

124. ~~**A relay caller that dies before its `Eof` leaks a server client**~~
     (found reading `RelayRpc` for item 120, 2026-09-11). The serving side
     releases a (peer, channel) client on the caller's `Eof`, or when a send
     to that caller fails with `RelayPeerOfflineError`. A caller process
     that dies after settling its own requests and before its finalizer's
     `Eof` -- or with a request whose handler has not yet sent anything --
     is released by neither: the entry and `RpcServer`'s state for it stay
     until the serving node restarts. Bounded by crashed callers, not by
     traffic, so small; but a long-lived relay server accumulates them.
     **Done 2026-09-11:** `RelayRpc.serve` sweeps its clients against
     `RelayClient.peers` (`sweepInterval`, default 30 s) and releases one
     only when its peer is listed `offline` -- a peer missing from the
     listing is kept, and a listing that fails releases nothing. Seen
     through the handler, since releasing a client interrupts what it had in
     flight: `test/Relay.test.ts` kills a caller before its `Eof` and the
     handler is interrupted; with a one-hour sweep it is not (the old
     behaviour), and with the release disabled the row fails.

     ```text
     verify: grep "const listed = yield* relay.peers" src/relay/RelayRpc.ts
     verify: grep "released by the sweep" test/Relay.test.ts
     ```

### Architecture review — 2026-09-26 — [plan-architecture-review.md](./plan-architecture-review.md)

*A review of the whole architecture after `docs/architecture.md` was written.
Its main finding: the tool-call pipeline and the session's nondeterministic
steps are each rebuilt, whole or in part, wherever they are needed. The plan
holds the argument. Two items conflict with `PLAN.md` and wait on the
owner. Client capabilities were considered and left declined (item 86).*

126. **One internal path for every tool call (plan 1a).** Extract the
     per-call stages (strategy slot, host scheduling, decide, approval,
     handler and progress, settlement) from `ToolExecution.execute` into one
     internal function. Code mode, subagents and the A2A bridges then call
     that function instead of rebuilding a subset.
     - Tools are still defined with Effect AI, which keeps within `PLAN.md`
       §17.
     - Open question: do nested calls emit their own correlated tool-call
       events, or stay on the progress channel?

     Item 125 (closed) routed code mode's nested handlers through host
     scheduling directly; this would make that one shared path. Medium.

     ```text
     verify: grep "ToolExecution.decide(tool, {" src/code/CodeMode.ts
     ```

127. **A public tool middleware chain (plan 1b). Gated on the owner amending
     `PLAN.md` §17.** §17 says "Do not create a large tool middleware
     system" and "Do not create parallel harness-specific tool abstractions."
     - The case: convert the toolkit once at the edge into an owned,
       `Tools`-typed representation, with each stage a
       `(call, next) => Effect`.
     - Durable journaling, test counting and redaction become middleware, not
       casts over a closed type. 17 of the 24 inventoried erasing casts come
       from wrapping or merging Effect AI's closed toolkit and model types.
     - Needs a spike to show that the owned representation retires those
       casts, and rules for the order of permission relative to middleware
       that rewrites arguments.

     Large.

     ```text
     verify: grep "Do not create a large tool middleware system." PLAN.md
     verify: grep "as unknown as Toolkit.WithHandler<Tools>[\"handle\"]" src/durable/DurableToolkit.ts
     ```

128. **The session state machine as one pure reducer (plan 3).** Admission
     (`Claimed` / `Busy` / `Missing`) is written in `AgentSession`'s `claim`,
     in `DurableSessionStore`'s memory store and in its SQL store. The
     dispatch outbox exists twice: the cluster's channel rows and
     Cloudflare's `affe_dispatch`.
     - Proposal: a synchronous `(state, command) → (state, effects)` with one
       transition suite, run inside each store's own atomic section.

     Medium.

     ```text
     verify: grep "SubscriptionRef.modify(self.state" src/AgentSession.ts
     verify: grep "if (found === undefined) return [{ _tag: \"Missing\" }, all]" src/durable/DurableSessionStore.ts
     ```

129. **A `Journal` seam in place of the durable wrapper set (plan 2). Gated
     on the owner's reading of `PLAN.md` §30.1.** Today `/durable` swaps
     about eight things in the workflow body, and the assembly is written
     twice (`DurableAgent`, `DurableSubmission`). `ExecutionPlan` is refused,
     and Cloudflare cannot use Workflow at all.
     - Proposal: `step(name, schema, effect)`, where the local default runs
       the effect directly, `/durable` backs it with an Activity and
       Cloudflare with DO SQLite.
     - §30.1: "Do not add `AgentExecution` until a durable implementation
       demonstrates interception that the Layer boundary cannot express."
       The plan argues that Cloudflare meets that condition.

     Large.

     ```text
     verify: grep "A durable agent cannot carry an ExecutionPlan" src/durable/DurableAgent.ts
     verify: grep "Workflow stalls on workerd" src/cloudflare/index.ts
     ```

130. **One event-retention seam (plan 4).** Three mechanisms retain events
     today: the host's bounded tail (default 256), `Agent.start`'s trace,
     and `DeliveryLog`. The in-process client cannot resume at all.
     - Proposal: an `EventLog` on the session, with a bounded ring by
       default, which refuses rather than serve a gap. `DeliveryLog` becomes
       its durable implementation.

     Medium.

     ```text
     verify: grep "options.maxRetainedEvents ?? 256" src/client/internal/sessionHost.ts
     verify: grep "this session has no delivery log, so events cannot be resumed from a sequence" src/client/AgentClient.ts
     ```

131. **Version the core apart from experimental subpaths (plan 6). Gated on
     the owner's release plans; decide before 1.0.** One package, one
     version, 53 import subpaths, most labelled experimental, so the "core"
     label carries no semver promise of its own.

     ```text
     verify: no-grep "\"workspaces\"" package.json
     ```

132. **Doc drift found by the review.**
     - The erasing-cast count: `AGENTS.md` says "seven files", `STATUS.md`
       says "six files", and the enforced inventory in `test/Casts.test.ts`
       has nine.
     - `docs/transport.md` lists only `ask_agent` for the MCP server.
     - The README's host modules omit `/cloudflare`.
     - `docs/plan-workbench.md` says "specified, not implemented".

     Trivial.

     ```text
     verify: grep "Twenty-four erasing casts exist, in seven files" AGENTS.md
     verify: grep "(six files)" STATUS.md
     ```

### The next milestone (2026-09-06) — [plan-next-milestone.md](./plan-next-milestone.md)

*Available usage and release work. The owner declined the proposed feature
freeze on 2026-09-06; these items do not gate the implementation backlog.
User recruitment requires a person and explicit authorization for outreach.*

63. **A daily consumer: the post-commit review assistant.** A separate
    consumer of the packed library that reviews a commit -- diff, the source
    and tests it needs, findings with evidence, challengeable, interruptible.
    The maintainer's own workflow is the baseline. Measured by reviewed
    commits, accepted findings, false positives and abandonments, not by
    tools exercised. First slice: one commit, one diff-to-findings path, a
    review of the next real commit beside the current one. In parallel,
    five Effect users invited to a specific trial. Medium.

    **First slice built 2026-09-14:** `examples/review-assistant.ts`, from
    `affe-agent/*` only. Given a commit (default `HEAD`), it takes the diff
    through the sandbox (`git show`, not the shell tool the model is
    refused), reads source and tests read-only over the real repository,
    and records a typed review whose every finding carries its file, line
    and quoted evidence; `--challenge "..."` re-examines in the same
    session; Ctrl+C interrupts the run. A live review appends a line to
    `.review-log.jsonl` -- the measure's raw data. With no key (and in
    `npm run check`, via `--scripted`) the same path runs over the scripted
    model and asserts the challenge revised the review. **Open: the
    observable** -- a live review of the next real commit beside the
    current one -- which needs an `ANTHROPIC_API_KEY` the owner has not
    provided; the five-user trial needs a person.

    ```text
    verify: exists examples/review-assistant.ts
    verify: grep "smoke:review-assistant" package.json
    ```

64. **Observe a newcomer before touching the docs.** Someone who has never
    seen the repository follows the README to a running agent, adds one tool,
    handles one failure, watched silently. Time to first result, every
    detour, every rescue, provider friction kept separate from library
    friction. The README keeps one obvious route; the package map stays as
    reference. Wrong to restructure if the participant sails through. Needs
    a person; recorded as missing evidence until one is found. Small.

    ```text
    verify: no-grep "Newcomer audit" docs/getting-started.md
    ```

65. **The public promises, reviewed.** Every published subpath inspected for the
    caller's job, the dependency boundary, maturity and evidence of intended
    use; accidental exports and duplicate spellings go, optional batteries
    stay provisional. Timeboxed, and run after 63 has a caller to say which
    promises matter. The one promise known to be broken -- the durable
    workflow layer's erased requirement -- is fixed (ledger). Medium.

    ```text
    verify: no-grep "## Public promises" STATUS.md
    ```

67. **The journal compatibility promise.** State whether cross-version replay
    of a durable journal is supported before anyone consumes a new version:
    if yes, a prior-version journal becomes a recorded fixture replayed
    against the candidate; if no, an incompatible journal is detected and
    refused clearly. A `Behavior-Change:` trailer records intent, not
    compatibility. Decided when 63 produces a journal worth keeping. Small.

    ```text
    verify: no-grep "journal compatibility" docs/guide-durable.md
    ```

### Known, deliberately left

- **D4b** survives the falsification harness by construction:
  `instance.suspended` carries the correctness and the two remaining
  disjuncts in `DurableAgent`'s `catchCause` are defence in depth. Recorded in
  `plan-durability-hardening.md` and `scripts/falsify.mjs`; nobody has decided
  to delete them, and the harness will say so if that changes.
- **Legacy MCP cancellation id mismatch** — upstream; the official client's
  cancel cannot interrupt the server.
- **MCP progress notifications** (`notifications/progress` for a running
  `agent_*` tool call) cannot be sent from this adapter: upstream's
  `McpServer` hands a tool handler only its payload, so the request's
  `_meta.progressToken` never reaches it, and the server's notification
  client is internal to its constructor. Ledger, item 71. Reopens when
  upstream exposes either.
- **Anthropic example** has never been run live with a key.
- **`ClusterMultiNode` on real time** (~15 s) — real cluster liveness needs
  real timers. A TestClock migration is not a valid fix; load headroom is a
  fixture/runtime tradeoff, as recorded above.
