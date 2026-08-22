import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Agent from "../src/Agent.js"
import * as AgentEvent from "../src/AgentEvent.js"
import * as AgentLoop from "../src/AgentLoop.js"
import * as AgentSession from "../src/AgentSession.js"
import * as Elicitation from "../src/Elicitation.js"
import { ToolPermissionDeniedError } from "../src/Errors.js"
import * as Permission from "../src/Permission.js"
import * as ToolExecution from "../src/ToolExecution.js"
import { AgentProbe, TestLanguageModel } from "../src/testing/index.js"

/**
 * Permission (#9): the one decision between "the model asked" and "the
 * handler runs". The pure part -- decisions, combination, rules, grants --
 * is tested as values. The enforcement is tested through real sessions, where
 * the question is always the same: did the handler run, and who was told.
 */

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

describe("Permission decisions", () => {
  it.effect("combine is Deny > Ask > Allow and keeps the first reason at the winning level", () => {
    const { allow, ask, deny, combine } = Permission
    assert.deepStrictEqual(combine(allow), allow)
    assert.deepStrictEqual(combine(allow, ask("a")), ask("a"))
    assert.deepStrictEqual(combine(ask("a"), allow), ask("a"))
    assert.deepStrictEqual(combine(ask("a"), deny("d"), ask("b")), deny("d"))
    assert.deepStrictEqual(combine(deny("first"), deny("second")), deny("first"))
    assert.deepStrictEqual(combine(ask("first"), ask("second"), allow), ask("first"))
    // The floor table from the issue, exactly.
    const floor = (intrinsic: boolean, policy: Permission.Decision) =>
      combine(intrinsic ? ask() : allow, policy)._tag
    assert.strictEqual(floor(false, allow), "Allow")
    assert.strictEqual(floor(false, ask()), "Ask")
    assert.strictEqual(floor(false, deny()), "Deny")
    assert.strictEqual(floor(true, allow), "Ask")
    assert.strictEqual(floor(true, ask()), "Ask")
    assert.strictEqual(floor(true, deny()), "Deny")
    return Effect.void
  })

  it.effect("rules: every matching rule counts, conservatively; every given matcher must match; otherwise is explicit", () =>
    Effect.gen(function* () {
      const policy = Permission.rules(
        [
          { action: "shell", resource: /^git status/, decision: Permission.allow },
          { action: "shell", resource: /^git push/, decision: Permission.ask("pushing") },
          { action: "shell", resource: (r) => r.includes("rm -rf"), decision: Permission.deny("no") },
          { tool: "read", decision: Permission.allow },
          { action: "write", resource: "/workspace/.env", decision: Permission.deny("secrets") },
          { action: "write", decision: Permission.allow }
        ],
        { otherwise: Permission.ask("unlisted") }
      )
      const request = (action: string, resource: string, tool = "bash"): Permission.Request => ({
        sessionId: "s",
        toolCallId: "c",
        tool: { name: tool, params: {} },
        action,
        resource,
        intrinsicApproval: false,
        messages: []
      })
      assert.deepStrictEqual(yield* policy.evaluate(request("shell", "git status")), Permission.allow)
      assert.deepStrictEqual(yield* policy.evaluate(request("shell", "git push origin main")), Permission.ask("pushing"))
      assert.deepStrictEqual(yield* policy.evaluate(request("shell", "sudo rm -rf /")), Permission.deny("no"))
      // `git status && rm -rf /` matches both the allow and the deny rule.
      // Order is not load-bearing: a deny anywhere is a deny.
      assert.deepStrictEqual(yield* policy.evaluate(request("shell", "git status && rm -rf /")), Permission.deny("no"))
      // And an ask above a deny does not shadow it.
      const shadowed = Permission.rules(
        [
          { resource: /^git push/, decision: Permission.ask("remote") },
          { resource: /--force/, decision: Permission.deny("destructive") }
        ],
        { otherwise: Permission.allow }
      )
      assert.deepStrictEqual(yield* shadowed.evaluate(request("shell", "git push --force")), Permission.deny("destructive"))
      assert.deepStrictEqual(yield* shadowed.evaluate(request("shell", "git push")), Permission.ask("remote"))
      assert.deepStrictEqual(yield* policy.evaluate(request("tool", "read", "read")), Permission.allow)
      // `/workspace/.env` matches the deny and the broad write allow: deny wins.
      assert.deepStrictEqual(yield* policy.evaluate(request("write", "/workspace/.env")), Permission.deny("secrets"))
      assert.deepStrictEqual(yield* policy.evaluate(request("write", "/workspace/a.ts")), Permission.allow)
      assert.deepStrictEqual(yield* policy.evaluate(request("net", "example.com")), Permission.ask("unlisted"))
      // A string matcher is exact, never a prefix.
      assert.deepStrictEqual(yield* policy.evaluate(request("write", "/workspace/.env.local")), Permission.allow)
    })
  )

  it.effect("all merges conservatively across policies and fans remember out", () =>
    Effect.gen(function* () {
      const remembered = yield* Ref.make<Array<string>>([])
      const recording = (name: string, decision: Permission.Decision): Permission.Policy => ({
        evaluate: () => Effect.succeed(decision),
        remember: () => Ref.update(remembered, (all) => [...all, name])
      })
      const request: Permission.Request = {
        sessionId: "s",
        toolCallId: "c",
        tool: { name: "t", params: {} },
        action: "tool",
        resource: "t",
        intrinsicApproval: false,
        messages: []
      }
      const both = Permission.all(recording("a", Permission.allow), recording("b", Permission.ask("b")))
      assert.deepStrictEqual(yield* both.evaluate(request), Permission.ask("b"))
      const withDeny = Permission.all(both, Permission.denyAll)
      assert.deepStrictEqual(yield* withDeny.evaluate(request), Permission.deny())
      // No policies at all is Allow: there was nothing to object.
      assert.deepStrictEqual(yield* Permission.all().evaluate(request), Permission.allow)
      yield* both.remember!(request)
      assert.deepStrictEqual(yield* Ref.get(remembered), ["a", "b"])
    })
  )

  it.effect("remembered: a grant turns Ask into Allow for that exact action and resource, never a Deny", () =>
    Effect.gen(function* () {
      const policy = yield* Permission.remembered(
        Permission.rules([{ resource: "forbidden", decision: Permission.deny() }], {
          otherwise: Permission.ask()
        })
      )
      const request = (resource: string): Permission.Request => ({
        sessionId: "s",
        toolCallId: "c",
        tool: { name: "t", params: {} },
        action: "shell",
        resource,
        intrinsicApproval: false,
        messages: []
      })
      assert.strictEqual((yield* policy.evaluate(request("git push")))._tag, "Ask")
      yield* policy.remember!(request("git push"))
      assert.strictEqual((yield* policy.evaluate(request("git push")))._tag, "Allow")
      // Exact: a different resource is still asked about.
      assert.strictEqual((yield* policy.evaluate(request("git push --force")))._tag, "Ask")
      // And a Deny is not a question a grant can answer.
      yield* policy.remember!(request("forbidden"))
      assert.strictEqual((yield* policy.evaluate(request("forbidden")))._tag, "Deny")
    })
  )

  it.effect("projection: annotated tools project typed, unannotated fall back to tool/name", () => {
    const Bash = Permission.annotate(
      Tool.make("bash", { parameters: Schema.Struct({ command: Schema.String }), success: Schema.String }),
      { action: "shell", resource: ({ command }) => command }
    )
    const projection = Permission.projectionOf(Bash)
    assert.strictEqual(projection.action, "shell")
    assert.strictEqual(projection.resource({ command: "ls" }), "ls")
    // The annotation travels with the tool, through Effect AI's own clone.
    const stricter = Bash.setNeedsApproval(true)
    assert.strictEqual(Permission.projectionOf(stricter).action, "shell")
    const Plain = Tool.make("plain", { parameters: Schema.Struct({}), success: Schema.String })
    const fallback = Permission.projectionOf(Plain)
    assert.strictEqual(fallback.action, "tool")
    assert.strictEqual(fallback.resource({}), "plain")
    return Effect.void
  })
})

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

const Bash = Permission.annotate(
  Tool.make("bash", {
    parameters: Schema.Struct({ command: Schema.String }),
    success: Schema.String
  }),
  { action: "shell", resource: ({ command }) => command }
)

/** One session with a recording bash handler. */
const fixture = <PR = never>(
  turns: ReadonlyArray<TestLanguageModel.Turn>,
  options: {
    readonly permission?: Permission.Policy<PR>
    readonly toolDenialPolicy?: ToolExecution.FailurePolicy
    readonly tool?: typeof Bash
    readonly loop?: number
  } = {}
) =>
  Effect.gen(function* () {
    const ran = yield* Ref.make<Array<string>>([])
    const toolkit = yield* Agent.toolkit([options.tool ?? Bash], {
      bash: ({ command }) => Ref.update(ran, (all) => [...all, command]).pipe(Effect.as(`ran ${command}`))
    })
    const { layer, recorder } = yield* TestLanguageModel.script(turns)
    const agent = Agent.make({
      toolkit,
      loop: AgentLoop.bounded(options.loop ?? 6),
      ...(options.permission === undefined ? {} : { permission: options.permission }),
      ...(options.toolDenialPolicy === undefined ? {} : { toolDenialPolicy: options.toolDenialPolicy })
    })
    return { ran, layer, recorder, agent }
  })

const call = (id: string, command: string): TestLanguageModel.Turn => ({
  toolCalls: [{ id, name: "bash", params: { command } }]
})

const decodeDetail = Schema.decodeUnknownSync(Schema.toCodecJson(Permission.ApprovalDetail))

/** The next approval question on a session, decoded, optionally skipping one already seen. */
const nextAsk = (session: AgentSession.AgentSession<any, any>, exclude?: string) =>
  Stream.runHead(
    session.events.pipe(
      Stream.filter(
        (e) => AgentEvent.is("ElicitationRequested")(e) && e.event.id !== exclude
      )
    )
  ).pipe(
    Effect.flatMap((head) =>
      head._tag === "Some" && AgentEvent.is("ElicitationRequested")(head.value)
        ? Effect.succeed({
            id: head.value.event.id,
            detail: decodeDetail(head.value.event.detail)
          })
        : Effect.die(new Error("no elicitation"))
    )
  )

describe("Permission enforcement", () => {
  it.effect("without a policy the handler runs, exactly as before", () =>
    Effect.gen(function* () {
      const f = yield* fixture([call("c1", "ls"), TestLanguageModel.text("done")])
      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(f.agent), (s) => s.prompt("go"))
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(result.text, "done")
      assert.deepStrictEqual(yield* Ref.get(f.ran), ["ls"])
    })
  )

  it.effect("Deny: the handler never runs, the run fails with the action, resource and reason", () =>
    Effect.gen(function* () {
      const f = yield* fixture([call("c1", "rm -rf /"), TestLanguageModel.text("never")], {
        permission: Permission.rules(
          [{ action: "shell", resource: /rm -rf/, decision: Permission.deny("destructive") }],
          { otherwise: Permission.allow }
        )
      })
      const { events, error } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent)
          const probe = yield* AgentProbe.make(session)
          const error = yield* Effect.flip(session.prompt("go"))
          return { events: yield* probe.events, error }
        })
      ).pipe(Effect.provide(f.layer))
      assert.instanceOf(error, ToolPermissionDeniedError)
      if (error instanceof ToolPermissionDeniedError) {
        assert.strictEqual(error.toolName, "bash")
        assert.strictEqual(error.toolCallId, "c1")
        assert.strictEqual(error.action, "shell")
        assert.strictEqual(error.resource, "rm -rf /")
        assert.strictEqual(error.reason, "destructive")
      }
      assert.deepStrictEqual(yield* Ref.get(f.ran), [])
      // Nothing was asked; the model was not consulted again.
      const tags = events.map((e) => e.event._tag)
      assert.notInclude(tags, "ElicitationRequested")
      const failed = events.find(AgentEvent.is("ToolCallFailed"))
      assert.isDefined(failed)
      if (failed !== undefined && AgentEvent.is("ToolCallFailed")(failed)) {
        assert.strictEqual(failed.event.failure.tag, "ToolPermissionDeniedError")
        assert.isFalse(failed.event.returnedToModel)
      }
      assert.strictEqual(yield* f.recorder.calls, 1)
    })
  )

  it.effect("Deny with ReturnToModel: the model is told and takes another route; the handler still never runs", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        [call("c1", "rm -rf /"), call("c2", "ls"), TestLanguageModel.text("used ls instead")],
        {
          permission: Permission.rules(
            [{ resource: /rm -rf/, decision: Permission.deny("destructive") }],
            { otherwise: Permission.allow }
          ),
          toolDenialPolicy: ToolExecution.ReturnToModel
        }
      )
      const { result, history } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent)
          const result = yield* session.prompt("go")
          return { result, history: yield* session.history }
        })
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(result.text, "used ls instead")
      assert.deepStrictEqual(yield* Ref.get(f.ran), ["ls"])
      // The refusal is in the transcript as a failed tool result the model
      // could read, with the reason.
      const toolResults = history.content.flatMap((m) =>
        m.role === "tool" ? m.content : []
      )
      assert.strictEqual(toolResults.length, 2)
      const refusal = toolResults[0]
      assert.isTrue(refusal !== undefined && refusal.type === "tool-result" && refusal.isFailure)
      assert.include(JSON.stringify(refusal), "destructive")
      assert.strictEqual(yield* f.recorder.calls, 3)
    })
  )

  it.effect("Ask: the run pauses on an elicitation carrying action, resource and reason; granted runs, refused fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        [call("c1", "git push origin main"), call("c2", "git push --force"), TestLanguageModel.text("never")],
        {
          permission: Permission.rules(
            [{ action: "shell", resource: /^git push/, decision: Permission.ask("remote write") }],
            { otherwise: Permission.allow }
          )
        }
      )
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent, { elicitation: Elicitation.memory })
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(Effect.exit(session.prompt("go")))

          const first = yield* nextAsk(session)
          assert.deepStrictEqual(first.detail, {
            toolName: "bash",
            toolCallId: "c1",
            action: "shell",
            resource: "git push origin main",
            reason: "remote write"
          })
          // Paused: nothing ran yet, and the run is still in flight.
          assert.deepStrictEqual(yield* Ref.get(f.ran), [])
          assert.strictEqual(yield* session.status, "running")
          yield* AgentSession.respond(session, { id: first.id, granted: true })

          const second = yield* nextAsk(session, first.id)
          assert.strictEqual(second.detail.resource, "git push --force")
          yield* AgentSession.respond(session, { id: second.id, granted: false })

          const exit = yield* Fiber.join(running)
          return { exit, events: yield* probe.events }
        })
      ).pipe(Effect.provide(f.layer))
      // The first was granted and ran; the second was refused and failed the run.
      assert.deepStrictEqual(yield* Ref.get(f.ran), ["git push origin main"])
      assert.isTrue(outcome.exit._tag === "Failure")
      const tags = outcome.events.map((e) => e.event._tag)
      assert.strictEqual(tags.filter((t) => t === "ElicitationRequested").length, 2)
      assert.strictEqual(tags.filter((t) => t === "ElicitationResolved").length, 2)
    })
  )

  it.effect("needsApproval is evaluated, not assumed: a dynamic requirement is asked only when it says so", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<Array<{ command: string; toolCallId: string; messages: number }>>([])
      const Dynamic = Bash.setNeedsApproval((params, context) =>
        Ref.update(seen, (all) => [
          ...all,
          { command: params.command, toolCallId: context.toolCallId, messages: context.messages.length }
        ]).pipe(Effect.as(params.command.startsWith("git push")))
      )
      const f = yield* fixture(
        [call("c1", "git status"), call("c2", "git push"), TestLanguageModel.text("done")],
        { tool: Dynamic }
      )
      const { result, asked } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent, { elicitation: Elicitation.memory })
          const running = yield* Effect.forkChild(session.prompt("go"))
          const asked = yield* nextAsk(session)
          yield* AgentSession.respond(session, { id: asked.id, granted: true })
          const result = yield* Fiber.join(running)
          return { result, asked: asked.detail.resource }
        })
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(result.text, "done")
      // `git status` ran without a question; only `git push` was asked about.
      assert.deepStrictEqual(yield* Ref.get(f.ran), ["git status", "git push"])
      assert.strictEqual(asked, "git push")
      const calls = yield* Ref.get(seen)
      assert.deepStrictEqual(calls.map((c) => [c.command, c.toolCallId]), [["git status", "c1"], ["git push", "c2"]])
      // The conversation reached the function: the user message, then the
      // assistant's call, growing by a tool round per turn.
      assert.isTrue(calls[0]!.messages >= 2)
      assert.isTrue(calls[1]!.messages > calls[0]!.messages)
    })
  )

  it.effect("the intrinsic floor: allowAll cannot lower a tool's needsApproval below Ask", () =>
    Effect.gen(function* () {
      const f = yield* fixture([call("c1", "anything"), TestLanguageModel.text("never")], {
        tool: Bash.setNeedsApproval(true),
        permission: Permission.allowAll
      })
      // No elicitor: the default answers "no", so the floor holds by failing closed.
      const error = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(f.agent), (s) => Effect.flip(s.prompt("go")))
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(error._tag, "ToolApprovalRequiredError")
      assert.deepStrictEqual(yield* Ref.get(f.ran), [])
      // The policy saw the floor too.
      const sawIntrinsic = yield* Ref.make<boolean | undefined>(undefined)
      const spy = Permission.make((request) =>
        Ref.set(sawIntrinsic, request.intrinsicApproval).pipe(Effect.as(Permission.allow))
      )
      const g = yield* fixture([call("c1", "x"), TestLanguageModel.text("never")], {
        tool: Bash.setNeedsApproval(true),
        permission: spy
      })
      yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(g.agent), (s) => Effect.flip(s.prompt("go")))
      ).pipe(Effect.provide(g.layer))
      assert.strictEqual(yield* Ref.get(sawIntrinsic), true)
    })
  )

  it.effect("allow always: a granted answer with remember:true stops the next identical ask", () =>
    Effect.gen(function* () {
      const policy = yield* Permission.remembered(Permission.askAll)
      const f = yield* fixture(
        [call("c1", "git push"), call("c2", "git push"), call("c3", "git pull"), TestLanguageModel.text("done")],
        { permission: policy }
      )
      const asked = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent, { elicitation: Elicitation.memory })
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          const first = yield* nextAsk(session)
          yield* AgentSession.respond(session, { id: first.id, granted: true, value: { remember: true } })
          // c2 is the same action and resource: no second question. c3 is
          // different and is asked.
          const third = yield* nextAsk(session, first.id)
          yield* AgentSession.respond(session, { id: third.id, granted: true })
          yield* Fiber.join(running)
          return {
            resource: third.detail.resource,
            count: (yield* probe.events).filter(AgentEvent.is("ElicitationRequested")).length
          }
        })
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(asked.resource, "git pull")
      assert.strictEqual(asked.count, 2)
      assert.deepStrictEqual(yield* Ref.get(f.ran), ["git push", "git push", "git pull"])
    })
  )

  it.effect("a malformed remember value is an answer for this call only", () =>
    Effect.gen(function* () {
      const policy = yield* Permission.remembered(Permission.askAll)
      const f = yield* fixture([call("c1", "x"), call("c2", "x"), TestLanguageModel.text("done")], {
        permission: policy
      })
      const count = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent, { elicitation: Elicitation.memory })
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          const first = yield* nextAsk(session)
          yield* AgentSession.respond(session, { id: first.id, granted: true, value: { remember: "yes" } })
          const second = yield* nextAsk(session, first.id)
          yield* AgentSession.respond(session, { id: second.id, granted: true })
          yield* Fiber.join(running)
          return (yield* probe.events).filter(AgentEvent.is("ElicitationRequested")).length
        })
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(count, 2)
    })
  )

  it.effect("a refused answer never records a grant, even with remember:true", () =>
    Effect.gen(function* () {
      const policy = yield* Permission.remembered(Permission.askAll)
      const f = yield* fixture([call("c1", "x"), call("c2", "x"), TestLanguageModel.text("done")], {
        permission: policy,
        toolDenialPolicy: ToolExecution.ReturnToModel
      })
      const count = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent, { elicitation: Elicitation.memory })
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          const first = yield* nextAsk(session)
          yield* AgentSession.respond(session, { id: first.id, granted: false, value: { remember: true } })
          const second = yield* nextAsk(session, first.id)
          yield* AgentSession.respond(session, { id: second.id, granted: true })
          yield* Fiber.join(running)
          return (yield* probe.events).filter(AgentEvent.is("ElicitationRequested")).length
        })
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(count, 2)
      assert.deepStrictEqual(yield* Ref.get(f.ran), ["x"])
    })
  )

  it.effect("parallel calls are decided independently: one denied, one asked, one allowed", () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        [
          {
            toolCalls: [
              { id: "a", name: "bash", params: { command: "ls" } },
              { id: "b", name: "bash", params: { command: "git push" } },
              { id: "c", name: "bash", params: { command: "rm -rf /" } }
            ]
          },
          TestLanguageModel.text("done")
        ],
        {
          permission: Permission.rules(
            [
              { resource: "ls", decision: Permission.allow },
              { resource: "git push", decision: Permission.ask() },
              { resource: "rm -rf /", decision: Permission.deny("no") }
            ],
            { otherwise: Permission.deny("unlisted") }
          ),
          toolDenialPolicy: ToolExecution.ReturnToModel
        }
      )
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* AgentSession.make(f.agent, { elicitation: Elicitation.memory })
          const probe = yield* AgentProbe.make(session)
          const running = yield* Effect.forkChild(session.prompt("go"))
          const asked = yield* nextAsk(session)
          yield* AgentSession.respond(session, { id: asked.id, granted: true })
          const result = yield* Fiber.join(running)
          const failed = (yield* probe.events).filter(AgentEvent.is("ToolCallFailed"))
          return { text: result.text, failed: failed.map((e) => e.event.id) }
        })
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(result.text, "done")
      assert.deepStrictEqual([...(yield* Ref.get(f.ran))].sort(), ["git push", "ls"])
      assert.deepStrictEqual(result.failed, ["c"])
    })
  )

  it.effect("a policy that needs a service makes it a requirement of the session", () =>
    Effect.gen(function* () {
      class Audit extends Context.Service<Audit, { readonly log: (line: string) => Effect.Effect<void> }>()(
        "Audit"
      ) {}
      const lines = yield* Ref.make<Array<string>>([])
      const auditing = Permission.make((request) =>
        Effect.flatMap(Audit, (audit) =>
          audit.log(`${request.action} ${request.resource}`).pipe(Effect.as(Permission.allow))
        )
      )
      const f = yield* fixture([call("c1", "ls"), TestLanguageModel.text("done")], { permission: auditing })
      // The requirement is visible in the type, not just satisfiable: the
      // session's service set names `Audit`. Break the policy's `R` and this
      // turns `false`.
      type Requires =
        ReturnType<typeof AgentSession.make<any, never, typeof f.agent extends Agent.AgentDefinition<any, any, infer R> ? R : never>> extends
          Effect.Effect<unknown, unknown, infer S>
          ? S
          : never
      const _auditRequired: Audit extends Requires ? true : false = true
      void _auditRequired
      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(f.agent), (s) => s.prompt("go"))
      ).pipe(
        Effect.provide(f.layer),
        Effect.provideService(Audit, { log: (line) => Ref.update(lines, (all) => [...all, line]) })
      )
      assert.strictEqual(result.text, "done")
      assert.deepStrictEqual(yield* Ref.get(lines), ["shell ls"])
    })
  )

  it.effect("a projection that throws dies rather than deciding", () =>
    Effect.gen(function* () {
      const Broken = Permission.annotate(
        Tool.make("bash", { parameters: Schema.Struct({ command: Schema.String }), success: Schema.String }),
        { action: "shell", resource: () => { throw new Error("oops") } }
      )
      const f = yield* fixture([call("c1", "ls"), TestLanguageModel.text("never")], {
        tool: Broken,
        permission: Permission.allowAll
      })
      const exit = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(f.agent), (s) => Effect.exit(s.prompt("go")))
      ).pipe(Effect.provide(f.layer))
      assert.isTrue(exit._tag === "Failure")
      assert.deepStrictEqual(yield* Ref.get(f.ran), [])
    })
  )

  it.effect("withPermission and withToolDenialPolicy compose onto an existing definition", () =>
    Effect.gen(function* () {
      const f = yield* fixture([call("c1", "ls"), call("c2", "pwd"), TestLanguageModel.text("done")])
      const stricter = f.agent.pipe(
        Agent.withPermission(Permission.rules([{ resource: "ls", decision: Permission.deny() }], { otherwise: Permission.allow })),
        Agent.withToolDenialPolicy(ToolExecution.ReturnToModel)
      )
      const result = yield* Effect.scoped(
        Effect.flatMap(AgentSession.make(stricter), (s) => s.prompt("go"))
      ).pipe(Effect.provide(f.layer))
      assert.strictEqual(result.text, "done")
      assert.deepStrictEqual(yield* Ref.get(f.ran), ["pwd"])
    })
  )
})
