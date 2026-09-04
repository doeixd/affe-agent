# Code mode

Extracted from the README on 2026-09-02; the boundary list is pinned by
`test/CodeModeThreatModel.test.ts`, which checks every cited test exists.


`affe-agent/code` gives the model one `execute` tool whose
description carries a budgeted catalog of the real tools, and the model
answers with a *program* -- a small JavaScript function that loops, branches
and combines results without a round trip per call. Every nested call is a
tool call: it passes the same `Permission` decision a direct call would,
including an `Ask` that pauses the program on the host's elicitor.
[`examples/code-mode.ts`](../examples/code-mode.ts) runs it against the
scripted model.

```ts
import { CodeTool } from "affe-agent/code"

const execute = yield* CodeTool.tool({
  tools: { github: githubToolkit },
  permission: Permission.rules([...], { otherwise: Permission.ask() }),
  limits: { maxToolCalls: 40 }
})
```

## What the boundary is

Say it plainly, because a reader coming from a code mode that runs each
program in a fresh isolate will assume the same here, and it is not the same.

**The program is confined by construction of the language, and authority is
decided per call by `Permission`.** The interpreter is an owned tree-walker
over a JavaScript subset: nothing a program can reach closes over host
authority except the one `invoke` hook the host supplied, and the routes from
a value to the `Function` evaluator are refused on every access. It is **not
an OS or isolate boundary**: a program runs on the host's fibre, in the
host's process, and a bug in the interpreter is a bug in the host process.
What keeps that honest is that the interpreter is small, every confinement
below has a test, and the *authority* boundary -- what a call may do -- is
the same `Permission` policy the rest of the harness uses, so a program is
never a cheaper path to a tool than calling it directly.

The confinements, each cited from the test that pins it
(`test/CodeModeThreatModel.test.ts` checks that every citation below still
names a test that exists):

- `test/CodeInterpret.test.ts`: "the prototype escape is closed on every route"
- `test/CodeInterpret.test.ts`: "everything outside the subset is refused naming the fix"
- `test/CodeInterpret.test.ts`: "runaway recursion is a call-depth diagnostic, not a stack overflow"
- `test/CodeInterpret.test.ts`: "the program catches its own throws, and a tool's failure, but never a diagnostic"
- `test/CodeHardening.test.ts`: "runaway expression nesting is a parse refusal, not a stack overflow"
- `test/CodeHardening.test.ts`: "a defecting tool handler never leaks its cause to the program"
- `test/CodeHardening.test.ts`: "maxOutputBytes counts bytes, not UTF-16 units"
- `test/CodeMode.test.ts`: "a denied call throws into the program; an allowed one runs — the same policy as direct calls"
- `test/CodeMode.test.ts`: "a literal unknown path is refused before the program runs"
- `test/CodeMode.test.ts`: "limits refuse with the fix named: tool calls, output size, timeout"
- `test/CodeMode.test.ts`: "an Ask pauses for approval; granted, the call runs and the detail describes it"
- `test/CodeMode.test.ts`: "with no elicitor an Ask fails closed, saying why"

What that buys and what it does not: a model-written program cannot reach
the filesystem, the network, `process`, or any tool the host did not hand it,
and cannot escalate a `Deny` into a call. It *can* consume CPU up to the
limits and exercise the interpreter, which is why the limits exist and why
the interpreter is the part of `src/` most worth a second reader. An
isolate-per-program executor with no outbound network is a stronger physical
boundary; the `CodeExecutor` seam admits one, and it is planned for the
Cloudflare host ([docs/plan-effect-agent-comparison.md](./plan-effect-agent-comparison.md)
§3.5). On Node there is no honest equivalent -- `vm` is not a security
boundary and its documentation says so -- and this library does not pretend
one.

## A read-only code mode

Some code modes admit only read-only tools and no approvals. That is a
`Permission` policy here, not a mode: annotate the tools with what they
*are*, allow the reading actions, and deny everything else.

```ts
const Search = Permission.annotate(SearchTool, { action: "read", resource: ({ index }) => index })
const Delete = Permission.annotate(DeleteTool, { action: "write", resource: ({ index }) => index })

const execute = yield* CodeTool.tool({
  tools: { search: Agent.toolkit([Search, Delete], handlers) },
  permission: Permission.rules(
    [{ action: "read", decision: Permission.allow }],
    { otherwise: Permission.deny("code mode is read-only") }
  )
})
```

A program that calls `delete` gets a refusal thrown into it, catchably, and
the call never runs -- the same answer a direct call would get under the same
policy. Leaving the tool in the catalog is deliberate: the model can see what
exists and learn from the refusal which route is open.

