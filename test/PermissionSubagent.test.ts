import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Elicitation from "../src/Elicitation.js"
import * as Permission from "../src/Permission.js"
import { Subagent } from "../src/subagent/index.js"
import { AgentProbe } from "../src/testing/index.js"
import * as FakeModel from "./FakeModel.js"

/**
 * Approval, across a delegation.
 *
 * A parent decides what its own tools may do. A child is a second agent with
 * its own toolkit and its own policy, reached through a tool call the parent
 * *did* approve -- so the question is what governs the child's tools, and
 * whose answer counts.
 *
 * This is worth asking rather than assuming, because both plausible answers
 * are bad in different ways. If a child's dangerous tool is governed by the
 * parent's policy, then approving `research` silently approves whatever
 * `research` decides to do. If it is governed by nothing, then a policy is a
 * wall with a door next to it.
 */

const Wipe = Tool.make("wipe", {
  parameters: Schema.Struct({}),
  success: Schema.String
}).setNeedsApproval(true)

describe("approval across a delegation", () => {
  it.live("a child's tool is governed by the child's policy, not the parent's", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const parentAsked = yield* Ref.make<ReadonlyArray<string>>([])

      // A plain tool, deliberately: this row measures whose *policy* governs
      // a child's tool, and a tool marked `needsApproval` can no longer be
      // delegated at all (the rows below). The policy question is the same
      // either way.
      const PlainWipe = Tool.make("wipe", { parameters: Schema.Struct({}), success: Schema.String })
      const wipe = Agent.tool(PlainWipe, () => Effect.as(Ref.update(wiped, (n) => n + 1), "wiped"))

      // The child denies everything. If the parent's policy governed the
      // child's tools, the parent's `allowAll` would override this.
      const child = Agent.make({
        instructions: "child",
        tools: [wipe],
        permission: Permission.denyAll,
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "w1", name: "wipe", params: {} }] },
        { text: "the child gave up" }
      ])

      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer,
        onError: "return"
      })

      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        // The parent allows everything *it* is asked about, and records what
        // it was asked, so "the parent was never consulted" is measurable.
        permission: Permission.make((request) =>
          Effect.as(
            Ref.update(parentAsked, (all) => [...all, request.tool.name]),
            Permission.allow
          )
        ),
        loop: AgentLoop.bounded(4)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      const result = yield* Agent.run(parent, "go").pipe(
        Effect.scoped,
        Effect.provide(parentModel)
      )

      assert.strictEqual(result.text, "the parent answered")
      // The child's own policy governed its own tool.
      assert.strictEqual(yield* Ref.get(wiped), 0, "the child's denied tool ran anyway")
      // And the parent was asked about the delegation, not about what the
      // child then wanted to do -- which is the part worth knowing.
      assert.deepStrictEqual(
        yield* Ref.get(parentAsked),
        ["research"],
        "the parent's policy was consulted about a tool it does not own"
      )
    }),
    30_000
  )

  /**
   * The finding, and what was decided about it.
   *
   * A tool marked `needsApproval` asks for an approval, and a session answers
   * that from its elicitation seam. `Subagent.tool` opens the child with
   * `Agent.run`, which has no elicitor to give it -- the parent's is not
   * passed down and nothing else supplies one -- so the request is refused
   * and the tool never runs. The child's *policy* is not what decides it:
   * `allowAll` makes no difference, which is exactly what separates this
   * from an ordinary denial. A tool marked as needing approval was not so
   * much protected as disabled, and the only report was a string the parent
   * model read.
   *
   * Item 53 recorded that. `plan-seams.md` B decided the first half: not
   * *who* should answer -- asking the parent's user to approve a tool they
   * cannot see is a real question -- but *when* the fault is reported. It is
   * now refused at construction, the way `Agent.make` refuses two toolkits,
   * so a wiring fault is found before the agent starts rather than three
   * delegations in.
   *
   * The control from the original finding is kept: same child, same policy,
   * one tool marked `needsApproval` and one not. The plain child delegates
   * and its tool runs; the approving child cannot be made into a tool at all.
   */
  it.live("a child holding an approval-requiring tool is refused at construction", () =>
    Effect.gen(function* () {
      const plainRan = yield* Ref.make(0)

      const approvingChild = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.succeed("did it"))],
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(3)
      })
      const approvingModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])

      // Refused by throwing, at the call, before any run exists.
      assert.throws(
        () =>
          Subagent.tool("research", approvingChild, {
            description: "Delegate research.",
            provide: approvingModel.layer
          }),
        /"wipe"/,
        "a child with an unanswerable approval was accepted: its tool would be refused on every call, and nobody told anyone"
      )

      // The control: the same thing, without the annotation, delegates.
      const Plain = Tool.make("plain", { parameters: Schema.Struct({}), success: Schema.String })
      const plainChild = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Plain, () => Effect.as(Ref.update(plainRan, (n) => n + 1), "did it"))],
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(3)
      })
      const plainModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "plain", params: {} }] },
        { text: "the child finished" }
      ])
      const plainResearch = Subagent.tool("research", plainChild, {
        description: "Delegate research.",
        provide: plainModel.layer
      })
      const withPlain = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])
      yield* Agent.run(
        Agent.make({
          instructions: "Delegate.",
          tools: [plainResearch],
          permission: Permission.allowAll,
          loop: AgentLoop.bounded(4)
        }),
        "go"
      ).pipe(Effect.scoped, Effect.provide(withPlain.layer))

      assert.strictEqual(
        yield* Ref.get(plainRan),
        1,
        "the control did not run, so the refusal above is measuring something other than approval"
      )
    }),
    30_000
  )

  it.live("`toolScoped` refuses the same child, before its layer is built", () =>
    Effect.gen(function* () {
      const builds = yield* Ref.make(0)
      const approvingChild = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.succeed("did it"))],
        loop: AgentLoop.bounded(3)
      })
      const model = yield* FakeModel.layer([{ text: "unused" }])
      const counted = Layer.effectDiscard(Ref.update(builds, (n) => n + 1)).pipe(
        Layer.provideMerge(model.layer)
      )

      const exit = yield* Effect.exit(
        Effect.scoped(
          Subagent.toolScoped("research", approvingChild, {
            description: "Delegate research.",
            provide: counted
          })
        )
      )

      assert.isTrue(exit._tag === "Failure", "an unanswerable approval was accepted by toolScoped")
      assert.include(
        exit._tag === "Failure" ? String(Cause.squash(exit.cause)) : "",
        "\"wipe\""
      )
      // A wiring fault should not cost a connection pool to discover.
      assert.strictEqual(yield* Ref.get(builds), 0, "the child's layer was built before the refusal")
    })
  )

  it.live("a `needsApproval` given as a function counts, because nobody could answer it either", () =>
    Effect.gen(function* () {
      // Asks only sometimes. Deciding at construction that it never will
      // would need the parameters, so it is treated as a tool that may ask.
      const Sometimes = Tool.make("sometimes", {
        parameters: Schema.Struct({ force: Schema.Boolean }),
        success: Schema.String
      }).setNeedsApproval((params) => params.force)
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Sometimes, () => Effect.succeed("did it"))],
        loop: AgentLoop.bounded(3)
      })
      const model = yield* FakeModel.layer([{ text: "unused" }])
      assert.throws(
        () => Subagent.tool("research", child, { description: "Delegate.", provide: model.layer }),
        /"sometimes"/
      )
    })
  )

  it.live("a child whose toolkit is resolved per turn cannot be inspected, and keeps the runtime refusal", () =>
    Effect.gen(function* () {
      /**
       * The one shape the construction-time check cannot reach: a toolkit
       * resolved per turn from runtime state, which declares nothing until it
       * has run. (`Agent.toolkit` and `tools: [...]` both declare, so this
       * has to be a bare Effect.) Pinned so the gap is a row rather than a surprise.
       * The tool is still dead -- this is the original item 53 behaviour --
       * and the test says so, in the direction that will fail if someone
       * closes the gap, so they come here and delete it.
       */
      const ran = yield* Ref.make(0)
      const child = Agent.make({
        instructions: "child",
        toolkit: Effect.suspend(() =>
          Agent.toolkit([Wipe], {
            wipe: () => Effect.as(Ref.update(ran, (n) => n + 1), "did it")
          })
        ),
        permission: Permission.allowAll,
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])
      // Accepted: there is nothing to read.
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer
      })
      const parentModel = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])
      const result = yield* Agent.run(
        Agent.make({ instructions: "Delegate.", tools: [research], loop: AgentLoop.bounded(4) }),
        "go"
      ).pipe(Effect.scoped, Effect.provide(parentModel.layer))

      assert.strictEqual(result.text, "the parent answered")
      assert.strictEqual(
        yield* Ref.get(ran),
        0,
        "the tool ran: someone is answering approvals for a delegated child now, and the construction-time refusal should go"
      )
    }),
    30_000
  )

  /**
   * B's second half: `inherit: { approval: "parent" }`.
   *
   * The child's approval is forwarded to the parent session's elicitor,
   * announced on the *parent's* event stream, and answered with
   * `AgentSession.respond` on the parent, exactly as the parent's own
   * approvals are. The request's `detail.via` names the delegating tool, so
   * the person asked is told who is asking. Opt-in, because it puts a real
   * question to a person about an agent they cannot see.
   */
  const forwardedRun = (answer: (detail: Permission.ApprovalDetail) => boolean) =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.as(Ref.update(wiped, (n) => n + 1), "wiped"))],
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])
      // Accepted at construction now: somebody can answer.
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer,
        inherit: { approval: "parent" }
      })
      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [research],
        loop: AgentLoop.bounded(4)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(parent, { elicitation: Elicitation.memory })
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))

          // On the parent's stream, which is the whole point: the parent's
          // consumers are the ones who can answer.
          const asked = yield* probe.awaitEvent("ElicitationRequested")
          const request = AgentEvent.is("ElicitationRequested")(asked) ? asked.event : undefined
          assert.isDefined(request)
          assert.strictEqual(request!.kind, "tool-approval")
          const detail = Schema.decodeUnknownSync(Permission.ApprovalDetail)(request!.detail)

          // Answerable on the parent, as any approval is.
          const answered = yield* AgentSession.respond(session, { id: request!.id, granted: answer(detail) })
          assert.isTrue(answered, "the parent's elicitor was not the one waiting")

          const result = yield* Fiber.join(running)
          const resolved = (yield* probe.events).filter(AgentEvent.is("ElicitationResolved"))
          return { detail, text: result.text, resolved: resolved.length }
        })
      ).pipe(Effect.provide(parentModel))

      return { ...outcome, wiped: yield* Ref.get(wiped) }
    })

  it.live("`approval: \"parent\"`: the child's approval is asked on the parent, told who is asking, and granted", () =>
    Effect.gen(function* () {
      const { detail, resolved, text, wiped } = yield* forwardedRun(() => true)
      assert.strictEqual(detail.toolName, "wipe")
      assert.deepStrictEqual(detail.via, ["research"], "the person asked was not told which delegation is asking")
      assert.strictEqual(wiped, 1, "granted on the parent, and the child's tool still did not run")
      assert.strictEqual(text, "the parent answered")
      assert.strictEqual(resolved, 1, "the answer was not announced on the parent's stream")
    }),
    30_000
  )

  it.live("`approval: \"parent\"`, refused: the child's tool does not run, and the parent is told", () =>
    Effect.gen(function* () {
      const { text, wiped } = yield* forwardedRun(() => false)
      assert.strictEqual(wiped, 0)
      // The child's denial policy is `FailRun`, so the child's run fails and
      // `onError: "return"` hands the parent model a string it can route
      // around -- which is a decision the parent model then made.
      assert.strictEqual(text, "the parent answered")
    }),
    30_000
  )

  it.live("a forwarded approval outside any session forwards to nobody, and refuses", () =>
    Effect.gen(function* () {
      /**
       * `Elicitation.Current` is `None` when the handler is not running under
       * a session's tool execution -- here, the tool's handler called
       * directly. The child must refuse rather than hang on an elicitor that
       * is not there.
       */
      const wiped = yield* Ref.make(0)
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.as(Ref.update(wiped, (n) => n + 1), "wiped"))],
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])
      const research = Subagent.tool("research", child, {
        description: "Delegate research.",
        provide: childModel.layer,
        inherit: { approval: "parent" }
      })
      const exit = yield* Effect.exit(research.handler({ prompt: "go" }, { preliminary: () => Effect.void }))
      assert.isTrue(exit._tag === "Failure", "the child ran an approval-requiring tool with nobody asked")
      assert.strictEqual(yield* Ref.get(wiped), 0)
    }),
    30_000
  )

  it.live("a delegation of a delegation: `via` is the path, outermost first, and one answer reaches the grandchild", () =>
    Effect.gen(function* () {
      const wiped = yield* Ref.make(0)
      const grandchild = Agent.make({
        instructions: "grandchild",
        tools: [Agent.tool(Wipe, () => Effect.as(Ref.update(wiped, (n) => n + 1), "wiped"))],
        loop: AgentLoop.bounded(3)
      })
      const grandchildModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "g1", name: "wipe", params: {} }] },
        { text: "the grandchild finished" }
      ])
      const child = Agent.make({
        instructions: "child",
        tools: [
          Subagent.tool("sub", grandchild, {
            description: "Delegate further.",
            provide: grandchildModel.layer,
            inherit: { approval: "parent" }
          })
        ],
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "sub", params: { prompt: "go" } }] },
        { text: "the child finished" }
      ])
      const parent = Agent.make({
        instructions: "Delegate.",
        tools: [
          Subagent.tool("research", child, {
            description: "Delegate research.",
            provide: childModel.layer,
            inherit: { approval: "parent" }
          })
        ],
        loop: AgentLoop.bounded(4)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        { toolCalls: [{ id: "r1", name: "research", params: { prompt: "go" } }] },
        { text: "the parent answered" }
      ])

      const via = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(parent, { elicitation: Elicitation.memory })
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          const asked = yield* probe.awaitEvent("ElicitationRequested")
          const request = AgentEvent.is("ElicitationRequested")(asked) ? asked.event : undefined
          assert.isDefined(request)
          const detail = Schema.decodeUnknownSync(Permission.ApprovalDetail)(request!.detail)
          yield* AgentSession.respond(session, { id: request!.id, granted: true })
          yield* Fiber.join(running)
          return detail.via
        })
      ).pipe(Effect.provide(parentModel))

      assert.deepStrictEqual(via, ["research", "sub"], "the path is not outermost first")
      assert.strictEqual(yield* Ref.get(wiped), 1, "the answer did not reach the grandchild")
    }),
    30_000
  )

  it.live("a forwarded request and the parent's own, asked at once, have distinct ids", () =>
    Effect.gen(function* () {
      /**
       * Elicitation ids are `submission-N:elicit-M`, both counters per
       * session -- so a child's first request has exactly the id of the
       * parent's own first request. Under parallel tool execution the parent
       * asks both at once, and an elicitor keeps one waiter per id. The
       * forwarded id is namespaced by the child session; this row is what
       * fails if that stops being so, and the failure was an overwritten
       * waiter and a run that hung.
       */
      const child = Agent.make({
        instructions: "child",
        tools: [Agent.tool(Wipe, () => Effect.succeed("wiped"))],
        loop: AgentLoop.bounded(3)
      })
      const childModel = yield* FakeModel.layer([
        { toolCalls: [{ id: "c1", name: "wipe", params: {} }] },
        { text: "the child finished" }
      ])
      const Own = Tool.make("own", { parameters: Schema.Struct({}), success: Schema.String })
        .setNeedsApproval(true)
      const parent = Agent.make({
        instructions: "Delegate, and act.",
        tools: [
          Subagent.tool("research", child, {
            description: "Delegate research.",
            provide: childModel.layer,
            inherit: { approval: "parent" }
          }),
          Agent.tool(Own, () => Effect.succeed("done"))
        ],
        loop: AgentLoop.bounded(4)
      })
      const { layer: parentModel } = yield* FakeModel.script([
        {
          toolCalls: [
            { id: "r1", name: "research", params: { prompt: "go" } },
            { id: "o1", name: "own", params: {} }
          ]
        },
        { text: "the parent answered" }
      ])

      const ids = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(parent, { elicitation: Elicitation.memory })
          // Two requests from one turn; subscribed before the prompt so
          // neither can be missed.
          const asked = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.take(Stream.filter(session.events, AgentEvent.is("ElicitationRequested")), 2)
            )
          )
          const running = yield* Effect.forkChild(session.prompt("go"))
          const ids = Array.from(yield* Fiber.join(asked)).map((envelope) =>
            AgentEvent.is("ElicitationRequested")(envelope) ? envelope.event.id : "?"
          )
          for (const id of ids) yield* AgentSession.respond(session, { id, granted: true })
          yield* Fiber.join(running)
          return ids
        })
      ).pipe(Effect.provide(parentModel))

      assert.notStrictEqual(ids[0], ids[1], "the child's request and the parent's own share an id")
    }),
    30_000
  )
})
