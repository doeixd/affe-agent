# Plan: messaging, monitors and supervision

Status: **in progress.**
- §2 (peer messaging) is **built, 2026-09-26**.
- §3 (monitors) is next (item 136).
- §4 (an in-process supervisor) follows it (item 137).
- §5 (a durable supervisor) is parked behind item 133 (item 138).

Written 2026-09-26, after a source review of `danieljvdm/effect-agent`
([plan-architecture-review.md](./plan-architecture-review.md) §7). The owner
asked for its messaging, and for OTP-style supervision built on top of it.

## 1. The mapping, and the rule it keeps

| OTP | here |
| --- | --- |
| process | a **session**: a stable id, with history as its state |
| registered name | the session id; `SessionDirectory` lists them |
| mailbox | **`SessionInbox`**: persisted, deduplicated by item id. A delivery starts a new submission on an idle session and never joins one in flight |
| `send`, reply | **§2, `Messaging`**: fixed routes, authorization, provenance |
| monitor | **§3, `Monitor`**: a terminal outcome becomes a `down` item in the watcher's inbox |
| supervisor | **§4**: a value (strategy, intensity, child specs) and a host that runs it |
| gen_server across nodes | a cluster `Entity`, keyed by session id (**§5**) |

**The rule.** None of this is a second execution model:
- a message is an inbox item;
- a monitor reads a session's ordinary events;
- a supervisor starts sessions and submits prompts through the same APIs an
  application uses.

No piece reaches inside the engine.

**Why it clears "two independent features".** Three things need delivery with
provenance: peer agents, monitors and supervisor escalation. Supervision
itself has two kinds of child: agent sessions, and `/process`'s managed
processes.

## 2. Peer messaging

`effect-agent` routes messages between threads through fixed peer routes,
behind an authorizer that denies by default. It records sender and reply-to
provenance itself, and gives each message a delivery status. The version here
keeps those properties and adds no store the inbox does not already have.

**A message is an inbox item.**
- **Kind.** It is a `SessionInbox` item of kind `"framework"`: a peer's
  message is not the application user's input, and a typed-input session can
  still receive one.
- **Source.** `source` is `{ kind: "peer", id: <sender session> }`.
- **Delivery.** It is exactly the inbox's: idle sessions only, never into a
  submission in flight, retried while the target is busy.

**Routes are fixed at construction.** A route has a name and a target: a
session id, or a function from the sender's id to one. The model names a
route, never a session. A tool is built per route, so an agent can only
message the peers its toolkit was given.

**Authorization is required.** `authorize({ operation, route, sender, target,
principal })` answers `true` or `false`. There is no default; `allowAll` is
the explicit opt-out. This follows item 110's rule for network-facing hosts,
and a message crosses between two parties exactly as a request does.

**A reply goes to a recorded sender, never a chosen one.**
- `Messaging` keeps a ledger of the messages it enqueued: id, sender, target
  and route.
- A reply names a received message id. It is refused unless the replying
  session is that message's target.
- The reply goes back to that message's sender, and is authorized as a
  `"reply"`.
- An incoming message grants the recipient no right to send on its own.

**Peer text is labelled, not trusted.**
- A message is committed as one system message that the harness writes. It
  names the sender, the route and the message id, and it says that the text
  quoted after it is that agent's output, not an instruction from the user or
  the system.
- A system role is what `AgentSession.framework` asks for, because "a plain
  string would read as the person's input". `reportToParent` already renders
  a child's output this way.
- The risk is plain: another model's text arrives with the harness's voice
  around it. The framing is the mitigation, and a `render` option lets an
  application choose its own.

**Ids.**
- A send made through a tool gets a random id (`message:<uuid>`). One tool
  call is one observation. A durable tool call runs its handler once, and
  its result is journalled, so the send is never repeated.
- A programmatic send takes the caller's key (`message:<route>:<key>`). An
  application resending after a crash must produce the same item, which the
  inbox then drops.
- This is the inbox's rule, "two observations of one event, one id", applied
  to each case.

**Status** is `pending` (enqueued), `delivered` (a submission was admitted),
or `undeliverable` (with the inbox's reason). There is no `processed`: the
inbox's answer ends at admission (item 97), and the target's result belongs
to the target.

**The ledger is in memory in this slice.** The inbox is durable, so a
message survives a restart. The ledger does not, so a reply to a message
received before the restart is refused as unknown. That is the conservative
direction, since it never misroutes. It is the same order `/process` took:
a store is shaped after its second backend exists, not before.

**There is no run loop.** `SessionInbox` removed its own, and the reasons
still hold. `Messaging.deliver` makes one delivery and records its status,
and the application loops with its own schedule, as `reportToParent` does.

## 3. Monitors

`Monitor.watch({ watcher, target })` reads the target session's events
through `AgentClient`. On `SubmissionFailed`, `SubmissionInterrupted` or
`SessionClosed`, it enqueues a framework item into the watcher's inbox.

- **Id.** The item id is `down:<target>:<submission>`, or
  `down:<target>:closed` for a close. It comes from the event, so seeing the
  same event twice enqueues once.
- **What does not count as down.** A completed submission is not a `down`.
  OTP monitors fire on exit, and an agent that answered has not exited.
- **This slice watches live.** The watcher sees what happens after it
  attaches. Over a client whose `events({ after })` resumes, which is the
  durable client, the caller can pass a cursor. Making the cursor itself
  durable belongs to §5.

## 4. An in-process supervisor

This section is specified here and built after §2 and §3.

**Child spec.**
- An `id`.
- How to start the child: an agent, and the prompt it runs.
- A restart type:
  - `permanent`: restart after any end;
  - `transient`: restart after an abnormal end only;
  - `temporary`: never restart.
- A restart mode:
  - `fresh`: a new session seeded from the spec, which is OTP's restart;
  - `resubmit`: the same session, asked again;
  - `rewind`: a branch from the last good node, through `/tree`.

**Strategies:** `one_for_one`, `one_for_all` and `rest_for_one`, as OTP has
them.

**Intensity** is N restarts within T, **and** a budget ceiling. A restart
costs money as well as time, which is the one way an agent differs from a
process here.

**Classification.** Restart is not the only answer, and the failure decides:

| failure | answer |
| --- | --- |
| a transient model error, or an `Infrastructure` outcome | restart |
| exhaustion, invalid output, a refused permission | escalate |
| an unknown tool outcome (`DurableToolUnresolvedError`) | **never restart**; escalate |

Restarting after an unknown outcome would repeat the side effect that the
whole durable design exists to prevent.

**Escalation.** A supervisor past its intensity stops its children and
reports up:
- to its own supervisor;
- or, at the top, to an *agent*: an `escalated` item in that agent's inbox,
  read by a model with `restart_child`, `replace_child` and `give_up` tools.

That last one is what OTP does not have. The deterministic policy runs
below, and judgement is applied where the policy gives up.

## 5. A durable supervisor (parked)

A supervisor as a cluster `Entity`:
- restart history lives in entity state;
- children are durable sessions reached through `DurableAgentClient`;
- monitor cursors are stored with the entity.

**Gated on item 133.** An auto-restarting durable child must first be able
to park an unknown outcome instead of dying, or every such crash either
restarts unsafely or ends the tree.
